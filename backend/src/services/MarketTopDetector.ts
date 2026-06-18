/**
 * MarketTopDetector — Phase 8 市场顶部前瞻预警
 *
 * 与 DrawdownCircuitBreaker (回撤后熔断) 互补 — 这个是"在崩盘前先看到信号"的
 * 前瞻预警。综合 5 维信号给出 top_score 0-100：
 *
 *   1. RSI 顶背离 (price 创新高 + RSI 不创新高) ........ 20 分
 *   2. 涨跌家数恶化 (advancer_pct < 30% 持续 ≥2 日)..... 25 分
 *   3. 新高/新低反转 (new_high < new_low × 0.5) ......... 15 分
 *   4. 高位震荡 (close 在 60d 90%+ 分位运行 > 10 日)..... 20 分
 *   5. 量价背离 (price 涨 vs volume 缩量, 20 日趋势)..... 20 分
 *
 * top_score:
 *   - >= 60 → top_warning_high (写 RiskAlert MEDIUM)
 *   - >= 40 → top_warning_medium (UI 黄色)
 *   - < 40 → no_warning
 *
 * 设计:
 *   - 纯函数 helpers 全 export
 *   - 数据源注入 (DailyBar + MarketBreadthService)
 *   - 缺数据保守 score=0 (不触发误报)
 */

import { Op } from 'sequelize';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { marketBreadthService } from './MarketBreadthService';

// ============================================================
// Types
// ============================================================

export interface MarketTopSignal {
  signal: string;
  triggered: boolean;
  score_contribution: number;
  detail: string;
}

export interface MarketTopReport {
  generated_at: string;
  benchmark_symbol: string;
  asOf: string;
  top_score: number;
  level: 'no_warning' | 'top_warning_medium' | 'top_warning_high';
  signals: MarketTopSignal[];
  /** 可读 summary */
  summary_message: string;
}

// ============================================================
// 纯函数 helpers (export 单测脱 DB)
// ============================================================

/**
 * 简化 RSI(14) 算法 — 与 backtest engine 用的一致。
 * 输入: close 序列；输出: 最新 RSI (0-100)；< period+1 返 null。
 */
export function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += -diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

/**
 * 检测 RSI 顶背离: price 创新高 + RSI 没创新高。
 *
 * 逻辑:
 *   - 最新 close 是过去 N 日新高 (close == max(closes[-N:]))
 *   - 但最新 RSI < lookback 期间最大 RSI
 *
 * @returns true = 触发顶背离
 */
export function detectRsiTopDivergence(closes: number[], lookbackDays = 20): boolean {
  if (closes.length < lookbackDays + 14) return false;
  const recent = closes.slice(-lookbackDays);
  const latestClose = closes[closes.length - 1];
  const maxClose = Math.max(...recent);
  // price 不是新高 → 不算背离
  if (latestClose < maxClose - 0.001) return false;

  // 算 lookback 区间每个点的 RSI，找历史最大
  const latestRsi = computeRsi(closes);
  if (latestRsi === null) return false;
  let maxHistoricalRsi = -Infinity;
  for (let i = closes.length - lookbackDays; i < closes.length - 1; i++) {
    const r = computeRsi(closes.slice(0, i + 1));
    if (r !== null && r > maxHistoricalRsi) maxHistoricalRsi = r;
  }
  // price 新高但 RSI 低于历史最大 → 背离
  return latestRsi < maxHistoricalRsi - 2; // 2 个百分点 buffer 防噪音
}

/**
 * 检测高位震荡: close 持续在 60d 90%+ 分位运行 > N 日。
 */
export function detectHighRangeOscillation(
  closes: number[],
  consecutiveDays = 10,
  percentile = 0.9
): boolean {
  if (closes.length < 60 + consecutiveDays) return false;
  const recent60 = closes.slice(-60);
  const sorted = [...recent60].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * percentile)];
  // 检查最近 N 日是否都在 threshold 之上
  const lastN = closes.slice(-consecutiveDays);
  return lastN.every(c => c >= threshold);
}

/**
 * 量价背离: 最近 20 日 close 涨幅 > 0 但 volume 20 日均比 60 日均下降 > 15%。
 */
export function detectVolumeDivergence(
  closes: number[],
  volumes: number[],
  shortDays = 20,
  longDays = 60
): boolean {
  if (closes.length < longDays || volumes.length < longDays) return false;
  const closeRet =
    (closes[closes.length - 1] - closes[closes.length - shortDays]) /
    closes[closes.length - shortDays];
  if (closeRet <= 0) return false; // price 没涨 不算背离

  const shortAvgVol = volumes.slice(-shortDays).reduce((s, v) => s + v, 0) / shortDays;
  const longAvgVol = volumes.slice(-longDays).reduce((s, v) => s + v, 0) / longDays;
  if (longAvgVol <= 0) return false;
  // 短期均比长期均缩量 > 15%
  return (shortAvgVol - longAvgVol) / longAvgVol < -0.15;
}

/**
 * 综合 top_score 计算。
 *
 * @param signals 每个 signal 的 triggered 状态
 * @returns 0-100 (>= 60 high warning, >= 40 medium warning)
 */
export function computeTopScore(signals: {
  rsi_divergence: boolean;
  breadth_deterioration: boolean;
  new_high_low_reversal: boolean;
  high_range_oscillation: boolean;
  volume_divergence: boolean;
}): number {
  let score = 0;
  if (signals.rsi_divergence) score += 20;
  if (signals.breadth_deterioration) score += 25;
  if (signals.new_high_low_reversal) score += 15;
  if (signals.high_range_oscillation) score += 20;
  if (signals.volume_divergence) score += 20;
  return score;
}

export function scoreToLevel(score: number): MarketTopReport['level'] {
  if (score >= 60) return 'top_warning_high';
  if (score >= 40) return 'top_warning_medium';
  return 'no_warning';
}

export function buildSummaryMessage(report: {
  top_score: number;
  level: string;
  signals: MarketTopSignal[];
}): string {
  const triggered = report.signals.filter(s => s.triggered);
  const levelTag: Record<string, string> = {
    no_warning: '✅ 无顶部信号',
    top_warning_medium: '🟠 中等顶部风险',
    top_warning_high: '🔴 高顶部风险 — 建议减仓 / 谨慎加仓',
  };
  const head = `${levelTag[report.level] || '—'} (score=${report.top_score})`;
  if (triggered.length === 0) return head;
  return `${head} · 触发: ${triggered.map(s => s.signal).join(', ')}`;
}

// ============================================================
// Service
// ============================================================

const BENCHMARK_SYMBOL = 'sh.000300';

export class MarketTopDetector {
  /**
   * 获取最新顶部检测报告。
   * @param benchmarkSymbol 默认沪深 300
   */
  async getReport(benchmarkSymbol = BENCHMARK_SYMBOL): Promise<MarketTopReport> {
    const asOf = new Date().toISOString().slice(0, 10);
    const signals: MarketTopSignal[] = [];

    // 1. RSI 顶背离 (拿 sh.000300 60 日 close)
    let rsiDiv = false;
    try {
      const stock = await Stock.findOne({
        where: { symbol: benchmarkSymbol },
        attributes: ['id'],
      });
      if (stock) {
        const since = new Date();
        since.setDate(since.getDate() - 90);
        const bars = await DailyBar.findAll({
          where: { stock_id: stock.id, time: { [Op.gte]: since } },
          attributes: ['time', 'close', 'volume'],
          order: [['time', 'ASC']],
        });
        const closes = bars.map(b => Number(b.close));
        const volumes = bars.map(b => Number(b.volume || 0));
        rsiDiv = detectRsiTopDivergence(closes, 20);
        signals.push({
          signal: 'rsi_divergence',
          triggered: rsiDiv,
          score_contribution: rsiDiv ? 20 : 0,
          detail: rsiDiv ? '指数创新高但 RSI 未创新高（顶背离）' : 'RSI 与 price 同步，无背离',
        });

        // 4. 高位震荡
        const highRange = detectHighRangeOscillation(closes, 10, 0.9);
        signals.push({
          signal: 'high_range_oscillation',
          triggered: highRange,
          score_contribution: highRange ? 20 : 0,
          detail: highRange
            ? '近 10 日指数都在 60d 90%+ 分位运行，高位震荡疲态'
            : '指数没有持续高位震荡',
        });

        // 5. 量价背离
        const volDiv = detectVolumeDivergence(closes, volumes, 20, 60);
        signals.push({
          signal: 'volume_divergence',
          triggered: volDiv,
          score_contribution: volDiv ? 20 : 0,
          detail: volDiv
            ? '指数上涨但 20 日均量较 60 日均量下降 > 15%（缩量上行）'
            : '量价同步，无背离',
        });
      } else {
        signals.push({
          signal: 'rsi_divergence',
          triggered: false,
          score_contribution: 0,
          detail: '基准数据缺失，跳过',
        });
        signals.push({
          signal: 'high_range_oscillation',
          triggered: false,
          score_contribution: 0,
          detail: '基准数据缺失，跳过',
        });
        signals.push({
          signal: 'volume_divergence',
          triggered: false,
          score_contribution: 0,
          detail: '基准数据缺失，跳过',
        });
      }
    } catch (err: any) {
      logger.warn(`[MarketTopDetector] benchmark load failed: ${err?.message || err}`);
    }

    // 2 + 3. breadth 相关 (调 marketBreadthService)
    let breadthBad = false;
    let highLowRev = false;
    try {
      const breadth = await marketBreadthService.getReport(7);
      const latest = breadth.latest;
      // breadth deterioration: 最近 2+ 日 advancer_pct < 30%
      const last2 = breadth.trend.slice(-2);
      breadthBad = last2.length >= 2 && last2.every(s => s.advancer_pct < 0.3);
      signals.push({
        signal: 'breadth_deterioration',
        triggered: breadthBad,
        score_contribution: breadthBad ? 25 : 0,
        detail: breadthBad
          ? `近 2 日上涨占比都 < 30% (latest: ${(latest.advancer_pct * 100).toFixed(1)}%)`
          : `近期上涨占比正常 (latest: ${(latest.advancer_pct * 100).toFixed(1)}%)`,
      });

      // new_high < new_low × 0.5
      highLowRev =
        latest.new_60d_high_count < latest.new_60d_low_count * 0.5 && latest.new_60d_low_count > 10;
      signals.push({
        signal: 'new_high_low_reversal',
        triggered: highLowRev,
        score_contribution: highLowRev ? 15 : 0,
        detail: highLowRev
          ? `新高 ${latest.new_60d_high_count} 远小于新低 ${latest.new_60d_low_count}`
          : `新高/新低正常 (${latest.new_60d_high_count} / ${latest.new_60d_low_count})`,
      });
    } catch (err: any) {
      logger.warn(`[MarketTopDetector] breadth load failed: ${err?.message || err}`);
      signals.push({
        signal: 'breadth_deterioration',
        triggered: false,
        score_contribution: 0,
        detail: 'breadth 服务失败，跳过',
      });
      signals.push({
        signal: 'new_high_low_reversal',
        triggered: false,
        score_contribution: 0,
        detail: 'breadth 服务失败，跳过',
      });
    }

    const topScore = computeTopScore({
      rsi_divergence: rsiDiv,
      breadth_deterioration: breadthBad,
      new_high_low_reversal: highLowRev,
      high_range_oscillation:
        signals.find(s => s.signal === 'high_range_oscillation')?.triggered || false,
      volume_divergence: signals.find(s => s.signal === 'volume_divergence')?.triggered || false,
    });
    const level = scoreToLevel(topScore);

    const report: MarketTopReport = {
      generated_at: new Date().toISOString(),
      benchmark_symbol: benchmarkSymbol,
      asOf,
      top_score: topScore,
      level,
      signals,
      summary_message: '',
    };
    report.summary_message = buildSummaryMessage(report);
    return report;
  }
}

export const marketTopDetector = new MarketTopDetector();
