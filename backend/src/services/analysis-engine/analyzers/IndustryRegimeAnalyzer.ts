/**
 * IndustryRegimeAnalyzer — 行业 + market regime + 龙头共振 (US-113 [AE-007]).
 *
 * 复用:
 *   - ctx.market_env (= MarketEnvironmentSnapshot)
 *   - factor.industry_momentum (z-score)
 *   - RegimeProbabilityService.classifyRegimeProbability (从 daily_bars 算)
 *   - **新增**: IndustryFlow.leader_stock_code / leader_stock_change_pct (龙头共振)
 *
 * "龙头共振" (dragon resonance) 语义 (US-113):
 *   - 同板块当日龙头股 (IndustryFlow.leader_stock_code) 涨幅强 → 行业有领涨 → 资金抱团信号.
 *   - 若分析标的就是龙头 → 顶格 bullish 共振 (+30, weight 0.15).
 *   - 若标的与龙头同向 (都涨 / 都跌) 且龙头涨幅显著 → 中度 bullish (+18~25).
 *   - 若龙头大涨 但标的下跌 → 显著背离 (bearish, -15~-20), 提示资金未及标的, 板块行情可能就龙头一家.
 *   - 数据缺 (industry==null / 加载失败 / 无龙头记录) → data_missing.push('industry_leader'),
 *     不阻塞其它 partial.
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

const MARKET_REGIME_SCORE: Record<string, number> = {
  bull: 35,
  rebound: 15,
  range: 0,
  bear: -45,
  stress: -60,
  volatile: -20,
  unknown: 0,
};

const INDUSTRY_REGIME_SCORE: Record<string, number> = {
  hot: 30,
  warm: 10,
  cold: -25,
  unknown: 0,
};

/**
 * 同行业当日龙头股快照 — IndustryRegimeAnalyzer 用来算龙头共振.
 * 取自 IndustryFlow (最近一交易日 ≤ as_of).
 */
export interface IndustryLeaderSnapshot {
  industry: string;
  trade_date: string;
  /** 行业当日龙头股代码 (6 位无后缀, 与 ctx.stock.code 比较时统一去后缀). */
  leader_stock_code: string;
  leader_stock_name?: string | null;
  /** 龙头股当日涨跌幅 (%) — 来自 IndustryFlow.leader_stock_change_pct. */
  leader_change_pct: number;
}

export interface IndustryLeaderSource {
  /**
   * 返回 industry 在 as_of (含) 之前最近一交易日的龙头快照.
   * - industry==null → 返 null (不算缺数据, 由 analyzer 判断).
   * - 无数据 / 异常 → 返 null, analyzer 在 industry!=null 时标 data_missing.
   */
  loadIndustryLeader(
    industry: string | null,
    as_of: string
  ): Promise<IndustryLeaderSnapshot | null>;
}

export const PRODUCTION_INDUSTRY_LEADER_SOURCE: IndustryLeaderSource = {
  async loadIndustryLeader(industry, as_of) {
    if (!industry) return null;
    try {
      // 懒加载 — 避免 analyzer 模块加载时引入 sequelize.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { IndustryFlow } = require('../../../models/IndustryFlow');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const row = await IndustryFlow.findOne({
        where: { industry_name: industry, trade_date: { [Op.lte]: as_of } },
        order: [['trade_date', 'DESC']],
        raw: true,
      });
      if (!row || !row.leader_stock_code) return null;
      const leaderChange =
        row.leader_stock_change_pct === null || row.leader_stock_change_pct === undefined
          ? null
          : Number(row.leader_stock_change_pct);
      if (leaderChange === null || !Number.isFinite(leaderChange)) return null;
      return {
        industry,
        trade_date: String(row.trade_date),
        leader_stock_code: String(row.leader_stock_code),
        leader_stock_name: row.leader_stock_name || null,
        leader_change_pct: leaderChange,
      };
    } catch (_err) {
      return null;
    }
  },
};

/**
 * 把 stock.code (sz.300750 / 600519.SH / sh600519) 统一成 6 位 — 与
 * IndustryFlow.leader_stock_code 对齐.
 */
export function toSixDigitStockCode(code: string | null | undefined): string {
  if (!code) return '';
  return String(code).replace(/[a-zA-Z.]/g, '');
}

/**
 * 计算 "目标股最近一交易日涨跌幅 (%)" — 从 ctx.daily_bars 末两根 close 取.
 * bars 不足 / 价格异常 → 返 null.
 */
export function computeTargetTodayChangePct(bars: AnalyzerContext['daily_bars']): number | null {
  if (!bars || bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const lastClose = Number(last?.close);
  const prevClose = Number(prev?.close);
  if (!Number.isFinite(lastClose) || !Number.isFinite(prevClose) || prevClose <= 0) return null;
  return ((lastClose - prevClose) / prevClose) * 100;
}

/**
 * 龙头共振计算结果. 纯函数, 易测.
 *   - resonance='self_leader': 本股即龙头 (顶格 +30).
 *   - resonance='strong_alignment': 龙头强势 (|Δ|≥5%) 且与本股同向 → +18~+25.
 *   - resonance='alignment': 二者同向但龙头弱 → +8.
 *   - resonance='divergence': 龙头大涨 / 大跌, 本股反向 → -15~-20.
 *   - resonance='leader_only': 龙头单涨 (≥3%) 本股近持平 (|Δ|<1%) → -8 (板块行情未扩散).
 *   - resonance='neutral': 其它 (含本股 change 缺失) → 0.
 */
export type DragonResonanceKind =
  | 'self_leader'
  | 'strong_alignment'
  | 'alignment'
  | 'divergence'
  | 'leader_only'
  | 'neutral';

export interface DragonResonanceResult {
  kind: DragonResonanceKind;
  /** 衍生分数, [-100, +100], 直接进 evidence/partials. */
  score: number;
  /** 给 evidence detail 用 — 例如 "龙头 600519 +6.2% vs 本股 +3.1%". */
  detail: string;
}

export function computeDragonResonance(
  myCode: string,
  leader: IndustryLeaderSnapshot,
  targetChangePct: number | null
): DragonResonanceResult {
  const leaderName = leader.leader_stock_name || leader.leader_stock_code;
  const leaderDeltaLabel = `${
    leader.leader_change_pct >= 0 ? '+' : ''
  }${leader.leader_change_pct.toFixed(2)}%`;
  const myLabel =
    targetChangePct === null
      ? '本股 Δ 缺失'
      : `本股 ${targetChangePct >= 0 ? '+' : ''}${targetChangePct.toFixed(2)}%`;

  // 1. 本股即龙头 — 顶格 bullish.
  if (myCode && myCode === leader.leader_stock_code) {
    return {
      kind: 'self_leader',
      score: 30,
      detail: `本股即行业龙头 (${leaderName} ${leaderDeltaLabel})`,
    };
  }

  if (targetChangePct === null || !Number.isFinite(targetChangePct)) {
    return {
      kind: 'neutral',
      score: 0,
      detail: `龙头 ${leaderName} ${leaderDeltaLabel} · ${myLabel}`,
    };
  }

  const ld = leader.leader_change_pct;
  const td = targetChangePct;
  const sameDir = (ld > 0 && td > 0) || (ld < 0 && td < 0);
  const leaderStrong = Math.abs(ld) >= 5;
  const leaderModerate = Math.abs(ld) >= 3;
  const targetFlat = Math.abs(td) < 1;

  // 2. 龙头大涨/大跌 + 本股反向 → divergence (bearish, 显著负面).
  if (leaderStrong && !sameDir && Math.abs(td) >= 1) {
    const sc = -18;
    return {
      kind: 'divergence',
      score: sc,
      detail: `龙头 ${leaderName} ${leaderDeltaLabel} 但 ${myLabel} → 显著背离`,
    };
  }

  // 3. 龙头单涨 (≥3%) 本股持平 → leader_only (-8, 板块行情未扩散).
  //    放在 strong_alignment 之前 — "leader +6%, me +0.5%" 语义上更接近
  //    "板块行情未扩散到本股" 而非 "强共振".
  if (leaderModerate && ld > 0 && targetFlat) {
    return {
      kind: 'leader_only',
      score: -8,
      detail: `龙头 ${leaderName} ${leaderDeltaLabel} 上涨, ${myLabel} 持平 → 板块行情未扩散`,
    };
  }

  // 4. 龙头强势 (≥5%) + 本股同向 (且本股 |Δ|≥1) → strong alignment (+20 / +25).
  if (leaderStrong && sameDir && Math.abs(td) >= 1) {
    const sc = Math.abs(td) >= 3 ? 25 : 20;
    return {
      kind: 'strong_alignment',
      score: ld > 0 ? sc : -sc,
      detail: `龙头 ${leaderName} ${leaderDeltaLabel} ${
        ld > 0 ? '领涨' : '领跌'
      }, ${myLabel} 同向共振`,
    };
  }

  // 5. 同向弱共振.
  if (sameDir && leaderModerate) {
    return {
      kind: 'alignment',
      score: ld > 0 ? 8 : -8,
      detail: `龙头 ${leaderName} ${leaderDeltaLabel}, ${myLabel} 同向`,
    };
  }

  return {
    kind: 'neutral',
    score: 0,
    detail: `龙头 ${leaderName} ${leaderDeltaLabel} · ${myLabel}`,
  };
}

export class IndustryRegimeAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'industry_regime';

  constructor(
    private readonly leaderSource: IndustryLeaderSource = PRODUCTION_INDUSTRY_LEADER_SOURCE
  ) {
    super();
  }

  // Batch AO (2026-06-21): factor.industry_momentum 在 prod 仍 std=0 (factor sync 没真算),
  // 严格要求会强制 conf=0. 改成只要 market_env 在即认为有信号 (industry_momentum 是 plus).
  protected requiredFields: readonly string[] = ['market_env'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];
    const partials: Array<{ value: number | null; weight: number }> = [];

    const env = ctx.market_env as
      | {
          market_regime?: string;
          market_regime_label?: string;
          industry?: { regime?: string; label?: string; relative_return_20d_pct?: number };
        }
      | null
      | undefined;

    if (!env) {
      dataMissing.push('market_env');
    } else {
      const mr = env.market_regime || 'unknown';
      const mrScore = MARKET_REGIME_SCORE[mr] ?? 0;
      partials.push({ value: mrScore, weight: 0.35 });
      evidence.push({
        label: `市场 regime: ${env.market_regime_label || mr}`,
        metric_value: mrScore,
        direction: mrScore > 5 ? 'bullish' : mrScore < -5 ? 'bearish' : 'neutral',
        weight: 0.35,
      });

      if (env.industry) {
        const ir = env.industry.regime || 'unknown';
        const irScore = INDUSTRY_REGIME_SCORE[ir] ?? 0;
        partials.push({ value: irScore, weight: 0.3 });
        evidence.push({
          label: `行业 regime: ${env.industry.label || ir}`,
          detail:
            env.industry.relative_return_20d_pct !== undefined
              ? `相对市场 20d=${env.industry.relative_return_20d_pct.toFixed(2)}%`
              : undefined,
          metric_value: irScore,
          direction: irScore > 5 ? 'bullish' : irScore < -5 ? 'bearish' : 'neutral',
          weight: 0.3,
        });
      } else {
        dataMissing.push('industry_regime');
      }
    }

    const z = ctx.factor_snapshot?.['industry_momentum'];
    if (z === undefined || z === null) {
      dataMissing.push('factor.industry_momentum');
    } else {
      const score = zScoreToScore(z) ?? 0;
      partials.push({ value: score, weight: 0.2 });
      evidence.push({
        label: `行业动量 z=${z.toFixed(2)}`,
        metric_value: score,
        direction: score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: 0.2,
      });
    }

    // ─── US-113 [AE-007]: 龙头共振 (dragon resonance) ───
    // industry==null → 不调 loader 直接 data_missing (与其它 analyzer 一致, 不静默假装无关).
    // loader 返 null (无 IndustryFlow 记录 / 龙头字段缺) → data_missing 但其它 partial 不阻塞.
    let leaderSnapshot: IndustryLeaderSnapshot | null = null;
    try {
      leaderSnapshot = await this.leaderSource.loadIndustryLeader(ctx.stock.industry, ctx.as_of);
    } catch (_e) {
      leaderSnapshot = null;
    }
    if (!leaderSnapshot) {
      dataMissing.push('industry_leader');
    } else {
      const myCode = toSixDigitStockCode(ctx.stock.code);
      const targetChange = computeTargetTodayChangePct(ctx.daily_bars);
      const resonance = computeDragonResonance(myCode, leaderSnapshot, targetChange);
      partials.push({ value: resonance.score, weight: 0.15 });
      evidence.push({
        label: `龙头共振: ${resonanceKindLabel(resonance.kind)}`,
        detail: resonance.detail,
        metric_value: resonance.score,
        direction: resonance.score > 5 ? 'bullish' : resonance.score < -5 ? 'bearish' : 'neutral',
        weight: 0.15,
      });
    }

    const score = weightedMean(partials) ?? 0;
    // confidence: market_env / industry_regime / momentum / leader 四件套覆盖率.
    // leader 缺不归零 confidence (与历史行为兼容), 但记入分母.
    const totalParts = 4;
    const havePartials = partials.length;
    const confidence = totalParts > 0 ? Math.max(0, havePartials / totalParts) : 0;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'market_environment', as_of: ctx.as_of, is_realtime: false },
        { name: 'factor_scores.industry_momentum', as_of: ctx.as_of, is_realtime: false },
        { name: 'industry_flows.leader', as_of: ctx.as_of, is_realtime: false },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

function resonanceKindLabel(kind: DragonResonanceKind): string {
  switch (kind) {
    case 'self_leader':
      return '本股即龙头';
    case 'strong_alignment':
      return '强共振';
    case 'alignment':
      return '弱共振';
    case 'divergence':
      return '背离';
    case 'leader_only':
      return '龙头独涨';
    case 'neutral':
    default:
      return '中性';
  }
}

export const industryRegimeAnalyzer = new IndustryRegimeAnalyzer();
