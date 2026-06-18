/**
 * PortfolioConstructionAdapter — Sprint 29: 自动模拟盘组合构建适配层
 *
 * 把 PortfolioConstructionService (services/portfolio/) 接入
 * PaperTradingAutomationService 的 buy-decision loop, 但不直接嵌入 — 通过本
 * adapter 隔离, 让 loop 主干只新增 5 行调用. 三种 mode (per User config):
 *
 *   - 'off' (默认): adapter 直接返回 null, loop 行为零变化 (向后兼容)
 *   - 'shadow': adapter 跑构建 + 返回 targetWeights, loop 仅 log + 注入到
 *     metadata.portfolio_construction (供 ActivationDashboard 展示), 但**不**
 *     替换 effectiveTargetPct. 让用户能"预演"组合构建效果零行为变化.
 *   - 'hard': adapter 跑构建 + 让 loop 用 weight × equity 替换 per-signal
 *     effectiveTargetPct. 真正切换为"候选池 → 组合权重 → 调仓订单" 形态.
 *
 * 设计要点:
 *   - 纯 adapter 模式: 不依赖 facade / 不持有数据库连接 (DataSource DI 风格)
 *   - 优雅降级: candidates < 2 时退化为 equal_weight; 历史数据不足时 service
 *     本身已退化, adapter 只透传
 *   - 5 个纯函数全 export, 单测独立
 *   - fail-open: construct 失败时 adapter 返回 null + log, loop 走原流程
 *
 * 不在本 sprint 范围:
 *   - 'hard' mode 的 effectiveTargetPct 替换逻辑 — 留给后续 sprint, 因涉及
 *     buy-decision loop 主干重构 + per-signal sizing 互动 + A/B 灰度
 *   - 候选池策略 ranking — 当前直接用所有 candidate, 后续可加 alpha_score
 *     top-N 截断
 */

import { logger } from '../../utils/logger';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { normalizeSymbol } from '../../utils/stockSymbol';
import {
  portfolioConstructionService,
  type ConstructionResult,
  type ConstructionMethod,
} from '../../services/portfolio/PortfolioConstructionService';

/** Sprint 29: 接入模式. 默认 off 保证向后兼容. */
export type ConstructionMode = 'off' | 'shadow' | 'hard';

/** 用户级 config, 存 User.risk_config.portfolio_construction (JSONB) */
export interface PortfolioConstructionConfig {
  mode: ConstructionMode;
  method: ConstructionMethod;
  /** 历史收益序列回看天数, 默认 60 (LedoitWolf 需要 ≥ T>>N) */
  lookback_days: number;
  /** 候选池最大入选 (按 alpha_score 降序), 0=无限制 */
  max_candidates: number;
  /** 单股权重上限 (override service default 0.15) */
  max_weight?: number;
  /** 行业权重上限 (override service default 0.40) */
  max_industry_weight?: number;
}

export const DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG: Readonly<PortfolioConstructionConfig> =
  Object.freeze({
    mode: 'off' as ConstructionMode,
    method: 'risk_parity' as ConstructionMethod,
    lookback_days: 60,
    max_candidates: 30,
    max_weight: 0.15,
    max_industry_weight: 0.4,
  });

/** Adapter 单 candidate 入参 — 用 signal 的最小子集 */
export interface AdapterCandidate {
  signal_id: number;
  symbol: string;
  alpha_score?: number | null;
  industry?: string | null;
}

/** Adapter 输出: target weights 按 signal_id 索引 */
export interface AdapterResult {
  mode: ConstructionMode;
  method: ConstructionMethod;
  total_candidates: number;
  used_candidates: number;
  /** signal_id → target weight (0-1); 不在 map = service 算出 weight=0 跳过 */
  weights_by_signal_id: Map<number, number>;
  /** 完整 ConstructionResult, 用于 metadata 持久化 + dashboard */
  construction_result: ConstructionResult | null;
  /** dropped reason: data_shortage / construct_failed / sub_threshold */
  skipped_reason?: string;
}

/** 归一化用户 config (lenient — invalid 字段退到 default) */
export function normalizePortfolioConstructionConfig(raw: any): PortfolioConstructionConfig {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const validModes: ConstructionMode[] = ['off', 'shadow', 'hard'];
  const validMethods: ConstructionMethod[] = [
    'risk_parity',
    'equal_weight',
    'min_variance',
    'max_sharpe',
    'hrp',
  ];
  return {
    mode: validModes.includes(obj.mode) ? obj.mode : DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.mode,
    method: validMethods.includes(obj.method)
      ? obj.method
      : DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.method,
    lookback_days:
      Number.isFinite(obj.lookback_days) && obj.lookback_days > 0
        ? Math.min(252, Math.max(20, Math.floor(obj.lookback_days)))
        : DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.lookback_days,
    max_candidates:
      Number.isFinite(obj.max_candidates) && obj.max_candidates >= 0
        ? Math.floor(obj.max_candidates)
        : DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.max_candidates,
    max_weight:
      Number.isFinite(obj.max_weight) && obj.max_weight > 0 && obj.max_weight <= 1
        ? obj.max_weight
        : DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.max_weight,
    max_industry_weight:
      Number.isFinite(obj.max_industry_weight) &&
      obj.max_industry_weight > 0 &&
      obj.max_industry_weight <= 1
        ? obj.max_industry_weight
        : DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG.max_industry_weight,
  };
}

/**
 * 截断 candidate 列表 (按 alpha_score 降序, 同分按 symbol asc stable tie-break).
 * max=0 → 不截断.
 */
export function pickTopCandidates(candidates: AdapterCandidate[], max: number): AdapterCandidate[] {
  if (max <= 0 || candidates.length <= max) {
    return candidates.slice();
  }
  return candidates
    .slice()
    .sort((a, b) => {
      const sa = Number(a.alpha_score ?? 0);
      const sb = Number(b.alpha_score ?? 0);
      if (sb !== sa) return sb - sa;
      return a.symbol.localeCompare(b.symbol);
    })
    .slice(0, max);
}

/**
 * 从 DailyBar 拉每个 candidate 的近 N 天 daily_returns. 返回 Map<symbol, returns[]>.
 * 任何 symbol 数据不足 → 从 map 中省略 (caller 自行决定如何处理).
 *
 * 性能: 用 IN (symbols) 一次性 query 所有 stock_id, 然后逐个 stock_id 查
 * DailyBar (不能 Single JOIN 因为每个股票要按 time DESC + limit).
 */
export async function loadCandidateReturns(
  symbols: string[],
  lookbackDays: number
): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  if (symbols.length === 0) return result;
  const normalized = symbols.map(normalizeSymbol);
  // bars 需要 lookbackDays + 1 根 (算 returns 要相邻两根 close 相除)
  const barLimit = Math.max(lookbackDays + 1, 21);
  const stocks = await Stock.findAll({
    where: { symbol: normalized },
    attributes: ['id', 'symbol'],
  });
  for (const stock of stocks) {
    try {
      const bars = (await DailyBar.findAll({
        where: { stock_id: (stock as any).id },
        attributes: ['close', 'time'],
        order: [['time', 'DESC']],
        limit: barLimit,
      })) as any[];
      if (bars.length < lookbackDays / 2) {
        // 数据严重不足, skip
        continue;
      }
      // bars 是 desc 顺序, reverse 成时间正向再算 returns
      bars.reverse();
      const returns: number[] = [];
      for (let i = 1; i < bars.length; i += 1) {
        const prev = Number(bars[i - 1].close);
        const curr = Number(bars[i].close);
        if (prev > 0 && Number.isFinite(curr) && Number.isFinite(prev)) {
          returns.push((curr - prev) / prev);
        }
      }
      if (returns.length >= Math.max(10, Math.floor(lookbackDays / 4))) {
        result.set(stock.symbol, returns);
      }
    } catch (_e) {
      // 单股查询失败 skip
      continue;
    }
  }
  return result;
}

/**
 * 把 ConstructionResult 转回 signal_id → weight map.
 * 输入: construction 输出 (按 symbol 顺序) + 原 candidate list (含 signal_id).
 */
export function mapWeightsToSignalIds(
  candidates: AdapterCandidate[],
  result: ConstructionResult
): Map<number, number> {
  const out = new Map<number, number>();
  // result.symbols 顺序 = construction 输入顺序; candidates 顺序未必一致
  const symbolToSignalId = new Map<string, number>();
  for (const c of candidates) {
    symbolToSignalId.set(normalizeSymbol(c.symbol), c.signal_id);
  }
  for (let i = 0; i < result.symbols.length; i += 1) {
    const symbol = normalizeSymbol(result.symbols[i]);
    const weight = result.weights[i];
    const signalId = symbolToSignalId.get(symbol);
    if (signalId && Number.isFinite(weight) && weight > 0) {
      out.set(signalId, weight);
    }
  }
  return out;
}

/**
 * 主入口 — buy-decision loop 在收集 candidateSignals 后立即调一次,
 * 返回 AdapterResult. mode='off' 时直接返回 null (零开销).
 *
 * fail-open: 任何子步骤失败都返回 null + log, 让 loop 走原流程.
 */
export async function buildPortfolioConstruction(input: {
  user_id: number;
  as_of_date: string;
  candidates: AdapterCandidate[];
  config: PortfolioConstructionConfig;
}): Promise<AdapterResult | null> {
  const { user_id, as_of_date, candidates, config } = input;
  if (config.mode === 'off') return null;
  if (candidates.length === 0) return null;

  try {
    // 1) 截 top-N
    const picked = pickTopCandidates(candidates, config.max_candidates);
    if (picked.length === 0) return null;

    // 2) 取历史 returns
    const symbols = picked.map(c => c.symbol);
    const returnsMap = await loadCandidateReturns(symbols, config.lookback_days);
    // 过滤掉没历史数据的 candidate
    const usableCandidates = picked.filter(c => returnsMap.has(normalizeSymbol(c.symbol)));
    if (usableCandidates.length === 0) {
      logger.warn(
        `[portfolio-construction-adapter] user=${user_id} 全部 ${picked.length} candidate 无历史数据, skip`
      );
      return {
        mode: config.mode,
        method: config.method,
        total_candidates: candidates.length,
        used_candidates: 0,
        weights_by_signal_id: new Map(),
        construction_result: null,
        skipped_reason: 'data_shortage',
      };
    }

    // 3) 构 service input
    const serviceCandidates = usableCandidates.map(c => ({
      symbol: c.symbol,
      alpha_score: c.alpha_score ?? null,
      industry: c.industry ?? null,
      daily_returns: returnsMap.get(normalizeSymbol(c.symbol)) || [],
    }));

    // 4) 调 service
    const result = await portfolioConstructionService.construct(
      {
        user_id,
        as_of_date,
        candidates: serviceCandidates,
      },
      {
        method: config.method,
        max_weight: config.max_weight,
        max_industry_weight: config.max_industry_weight,
        persist: true,
      }
    );

    // 5) 映回 signal_id
    const weightsBySignalId = mapWeightsToSignalIds(usableCandidates, result);
    return {
      mode: config.mode,
      method: config.method,
      total_candidates: candidates.length,
      used_candidates: usableCandidates.length,
      weights_by_signal_id: weightsBySignalId,
      construction_result: result,
    };
  } catch (err: any) {
    logger.warn(
      `[portfolio-construction-adapter] user=${user_id} 构建失败 (fail-open): ${
        err?.message || err
      }`
    );
    return {
      mode: config.mode,
      method: config.method,
      total_candidates: candidates.length,
      used_candidates: 0,
      weights_by_signal_id: new Map(),
      construction_result: null,
      skipped_reason: 'construct_failed',
    };
  }
}
