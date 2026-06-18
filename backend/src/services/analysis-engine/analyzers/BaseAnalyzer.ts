/**
 * BaseAnalyzer — 公共基类
 *
 * 每个 analyzer 继承本类, 实现:
 *   - readonly key: AnalyzerKey
 *   - async run(ctx): Promise<{ score, evidence, data_sources, confidence, data_missing? }>
 *
 * 基类负责:
 *   1. 总 timeout (5s) 包裹 run().
 *   2. try/catch 把抛出错误转成 `{ error, confidence:0, score:0 }` 输出 (不让 Promise.all 全挂).
 *   3. 计时.
 *   4. 校验 score / confidence 数值范围 (越界强制 clamp + warn).
 *   5. data_missing 量化: 单 analyzer data_missing 占其声明 required 字段 ≥50% → confidence=0.
 */

import { logger } from '../../../utils/logger';
import type {
  AnalyzerContext,
  AnalyzerKey,
  AnalyzerOutput,
  DataSourceRef,
  EvidenceItem,
} from '../AnalyzerTypes';

export interface RawAnalyzerResult {
  score: number;
  evidence: EvidenceItem[];
  data_sources: DataSourceRef[];
  confidence: number;
  data_missing?: string[];
  event_action?: AnalyzerOutput['event_action'];
  event_score_multiplier?: number;
}

export const DEFAULT_ANALYZER_TIMEOUT_MS = 5000;

export abstract class BaseAnalyzer {
  abstract readonly key: AnalyzerKey;
  /**
   * 该 analyzer 声明的"必备字段"列表. data_missing 占比 ≥50% 时 confidence 强制归零.
   * 默认空 — 子类按需重写.
   */
  protected requiredFields: readonly string[] = [];

  protected timeoutMs: number = DEFAULT_ANALYZER_TIMEOUT_MS;

  /** 子类实现 — 不要 try/catch, 抛出由基类捕获. */
  protected abstract run(ctx: AnalyzerContext): Promise<RawAnalyzerResult>;

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerOutput> {
    const start = Date.now();
    try {
      const result = await this.withTimeout(this.run(ctx), this.timeoutMs);
      return this.finalize(result, start);
    } catch (err: any) {
      const elapsed = Date.now() - start;
      const code =
        err?.code || (err?.message === 'analyzer_timeout' ? 'TIMEOUT' : 'INTERNAL_ERROR');
      const msg = err?.message || String(err) || 'analyzer failed';
      logger.warn(`[analysis-engine] ${this.key} failed (${elapsed}ms): ${msg}`);
      return {
        analyzer_key: this.key,
        score: 0,
        evidence: [],
        data_sources: [],
        confidence: 0,
        data_missing: [],
        error: { code, message: msg },
        elapsed_ms: elapsed,
      };
    }
  }

  private finalize(result: RawAnalyzerResult, start: number): AnalyzerOutput {
    const elapsed = Date.now() - start;
    const dataMissing = result.data_missing || [];

    let confidence = clamp01(result.confidence);
    // data_missing ≥50% 的必备字段 → confidence 归零
    if (this.requiredFields.length > 0) {
      const missingRequired = dataMissing.filter(f => this.requiredFields.includes(f)).length;
      if (missingRequired / this.requiredFields.length >= 0.5) {
        confidence = 0;
      }
    }

    return {
      analyzer_key: this.key,
      score: clampScore(result.score),
      evidence: result.evidence,
      data_sources: result.data_sources,
      confidence,
      data_missing: dataMissing,
      error: null,
      elapsed_ms: elapsed,
      event_action: result.event_action,
      event_score_multiplier: result.event_score_multiplier,
    };
  }

  private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('analyzer_timeout')), ms);
      p.then(v => {
        clearTimeout(timer);
        resolve(v);
      }).catch(e => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

export function clampScore(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-100, Math.min(100, x));
}

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * 把 factor z-score (通常 [-3, +3]) 转 [-100, +100].
 * z=1 → ~33, z=2 → ~67, z=3 → 100.
 */
export function zScoreToScore(z: number | null | undefined): number | null {
  if (z === null || z === undefined || !Number.isFinite(z)) return null;
  return clampScore((z / 3) * 100);
}

/**
 * 简单加权平均 (skip null).
 */
export function weightedMean(
  items: Array<{ value: number | null; weight: number }>
): number | null {
  let sumW = 0;
  let sumV = 0;
  for (const { value, weight } of items) {
    if (value === null || !Number.isFinite(value) || weight <= 0) continue;
    sumW += weight;
    sumV += value * weight;
  }
  return sumW > 0 ? sumV / sumW : null;
}

export function directionFromScore(score: number): EvidenceItem['direction'] {
  if (score > 15) return 'bullish';
  if (score < -15) return 'bearish';
  return 'neutral';
}
