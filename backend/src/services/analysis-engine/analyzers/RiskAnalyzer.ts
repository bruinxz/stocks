/**
 * RiskAnalyzer — 个股风险硬指标 (流动性 / 低波 / ST 名 / 行情陈旧).
 *
 * 复用:
 *   - factor.liquidity (z-score, 越高越好)
 *   - factor.low_vol  (z-score, 越高越稳)
 *   - stNameUtils.isSTName(stock.name)
 *   - ctx.realtime_quote.as_of_ts → 计算 stale-ness
 *
 * 输出: 负分代表风险高. score < -80 触发 aggregator 硬否决.
 *
 * 注: 解禁/停牌/退市这类事件层信息走 EventAnalyzer; RiskAnalyzer 只看个股属性
 * 与行情质量, 避免与 EventAnalyzer 双重计入.
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

const STALE_QUOTE_THRESHOLD_MS = 30 * 60 * 1000;

export class RiskAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'risk';

  protected requiredFields: readonly string[] = ['factor.liquidity', 'factor.low_vol'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const factors = ctx.factor_snapshot || {};
    const evidence: EvidenceItem[] = [];
    const dataMissing: string[] = [];
    const partials: Array<{ value: number | null; weight: number }> = [];
    let veto = false;
    let vetoReason = '';

    // 1) Liquidity
    const liquidityZ = factors['liquidity'];
    if (liquidityZ === undefined || liquidityZ === null) {
      dataMissing.push('factor.liquidity');
    } else {
      const score = zScoreToScore(liquidityZ) ?? 0;
      partials.push({ value: score, weight: 0.3 });
      evidence.push({
        label: `流动性 z=${liquidityZ.toFixed(2)}`,
        metric_value: score,
        direction: score > 5 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: 0.3,
      });
      // 极低流动性 → 触发硬风险
      if (liquidityZ < -2.0) {
        veto = true;
        vetoReason = `极低流动性 (liquidity z=${liquidityZ.toFixed(2)})`;
      }
    }

    // 2) Low vol (高 z = 低波 = 利好)
    const lowVolZ = factors['low_vol'];
    if (lowVolZ === undefined || lowVolZ === null) {
      dataMissing.push('factor.low_vol');
    } else {
      const score = zScoreToScore(lowVolZ) ?? 0;
      partials.push({ value: score, weight: 0.25 });
      evidence.push({
        label: `低波动 z=${lowVolZ.toFixed(2)}`,
        metric_value: score,
        direction: score > 5 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: 0.25,
      });
    }

    // 3) ST 名 → 强负分 + veto
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { isSTName } = require('../../../utils/stNameUtils');
      if (isSTName(ctx.stock.name)) {
        veto = true;
        vetoReason = `ST 标的 (${ctx.stock.name})`;
        partials.push({ value: -100, weight: 0.3 });
        evidence.push({
          label: `ST 股 — ${ctx.stock.name}`,
          direction: 'bearish',
          weight: 0.3,
        });
      } else {
        partials.push({ value: 5, weight: 0.05 });
      }
    } catch (_e) {
      dataMissing.push('st_name_check');
    }

    // 4) 行情陈旧度
    //   Batch AO (2026-06-21): 复盘模式跳过这条 veto.
    //   "复盘模式" = caller 传了 ctx.as_of 且不是 today (例如分析 2026-06-18 收盘后,
    //   今天 6-21 周日跑) — 这种场景下 realtime_quote 必然是历史的, 阈值 30min veto
    //   会让所有事后分析永远 hold. 改为: 只有"当日盘中"(as_of=today) 才硬否决.
    //   盘中误用引擎拍板是真风险, 复盘不是.
    const q = ctx.realtime_quote;
    const todayIso = new Date().toISOString().slice(0, 10);
    const isReplayMode = ctx.as_of && ctx.as_of !== todayIso;
    if (!q) {
      dataMissing.push('realtime_quote');
    } else if (isReplayMode) {
      evidence.push({
        label: '复盘模式: 跳过行情陈旧 veto',
        direction: 'neutral',
        weight: 0,
      });
    } else {
      const ageMs = Date.now() - new Date(q.as_of_ts).getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0) {
        dataMissing.push('realtime_quote_invalid_ts');
      } else if (ageMs > STALE_QUOTE_THRESHOLD_MS) {
        veto = true;
        vetoReason = `行情陈旧 (${Math.round(ageMs / 60000)} 分钟前)`;
        partials.push({ value: -100, weight: 0.4 });
        evidence.push({
          label: `行情陈旧: ${Math.round(ageMs / 60000)} min ago`,
          metric_value: ageMs,
          direction: 'bearish',
          weight: 0.4,
        });
      } else {
        evidence.push({
          label: `行情新鲜: ${Math.round(ageMs / 1000)}s ago`,
          metric_value: ageMs,
          direction: 'neutral',
          weight: 0.05,
        });
      }
    }

    let score = weightedMean(partials) ?? 0;
    if (veto) {
      score = -100;
    }

    const totalReq = this.requiredFields.length;
    const haveReq = totalReq - dataMissing.filter(f => this.requiredFields.includes(f)).length;
    const confidence = totalReq > 0 ? haveReq / totalReq : 0.5;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'factor_scores.risk', as_of: ctx.as_of, is_realtime: false },
        { name: 'realtime_quote', as_of: ctx.as_of, is_realtime: true },
      ],
      confidence,
      data_missing: dataMissing,
      // RiskAnalyzer 用 event_action='veto' 让 aggregator 看到时硬否决.
      event_action: veto ? 'veto' : undefined,
      // 备注 vetoReason 到 evidence
      event_score_multiplier: veto ? 0 : undefined,
    } as RawAnalyzerResult;
    void vetoReason;
  }
}

export const riskAnalyzer = new RiskAnalyzer();
