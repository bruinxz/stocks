/**
 * RestrictedShareWatchdog — US-089
 *
 * **限售解禁日历风控** — 每日扫描所有持仓股，若 5 个交易日内即将解禁的
 * 累计市值 > 当前流通市值 10% → 写 `RiskAlert(level='MEDIUM')` 提示用户
 * 提前规避（解禁前后股价常有压力）。
 *
 * 与 US-047/US-048/US-049/US-050/US-051/US-052/US-053 / US-054 互补的
 * **第 9 类风控形态** ——
 *   - US-047 PositionLimitGuard：pre-trade inline 单股 / 单行业上限（订单期）；
 *   - US-048 TrailingStopGuard：per-position 追踪止损（持有期）；
 *   - US-049 DrawdownCircuitBreaker：portfolio-level cascade（组合期）；
 *   - US-050 MarketRegimeAlertService：market-level 指数信号（大盘期）；
 *   - US-051 PerStockStopLossGuard：per-position 硬止损（成本期）；
 *   - US-052 IndustryConcentrationGuard：post-trade 行业聚合（持有期）；
 *   - US-053 BlackSwanWatchdog：event-driven 个股黑天鹅（ST / 停牌 / 新闻 NLP）；
 *   - US-054 MorningRiskCheckup：每日开盘前体检快照；
 *   - **US-089 RestrictedShareWatchdog**：**前瞻型** 解禁日历预警 —— 与
 *     US-053 BlackSwanWatchdog 同属 event-driven 但**时间方向相反**：
 *     BlackSwan 看"昨日已发生的利空"（reactive 反应式），
 *     RestrictedShare 看"未来 5 个交易日即将发生的解禁压力"（proactive 预警式）。
 *
 * AC 关键点：
 *   1. 数据：新增 RestrictedShareRelease 模型 + Python helper +
 *      RestrictedShareClient + RestrictedShareSyncService + CLI 已在
 *      sibling 文件完成；
 *   2. 在风控 watchdog 中：持仓股若 5 个交易日内解禁市值 > 当前流通市值
 *      10% → RiskAlert MEDIUM；
 *   3. 新增单元测试 + typecheck pass + tests pass。
 *
 * 触发流程：
 *   `evaluateAfterOpen(user_id?, dry_run?, asOfDate?)` — 每日开盘后定时任务
 *   - 默认 scope = 所有有 PaperTradingPortfolio 的用户；user_id 限定单 user；
 *   - 单 user 失败 try/catch 隔离（同 US-047 ... US-053 一致）；
 *   - 流程：
 *     (a) 计算窗口 [asOfDate, asOfDate + ~7 自然日] 覆盖 5 个交易日 +
 *         周末缓冲（不严格依赖交易日历）；
 *     (b) 一次性 fetch 该窗口内全市场解禁 records 跨用户共享；
 *     (c) per-user 取持仓 → 按 stock_code 聚合解禁市值；
 *     (d) 与持仓股的 *当前* 流通市值（Stock.circulating_market_cap）做比；
 *     (e) 比例 > threshold (默认 0.10 = 10%) → 写 RiskAlert(level='MEDIUM') +
 *         去重 signature 避免一日内重复推；
 *
 * 设计约束 — 沿用 US-047/US-048/US-049/US-051/US-052/US-053 的 7 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + RestrictedShareClient + 测试 fake）；
 *   - 纯函数 helper 全 export 让单测无需 DB / 无需 AKShare（
 *     normalizeRestrictedShareConfig / computeWindowEndDate /
 *     aggregateReleaseByStock / computeReleaseRatio /
 *     signatureForRelease / mergeSeenSignatures 等）；
 *   - 配置在 User.risk_config.restricted_share JSONB + Object.freeze 默认；
 *   - 触发 → RiskAlert(level='MEDIUM')（轻量预警；区别 US-053 黑天鹅 HIGH）；
 *   - 写 RiskAlert 失败 try/catch + logger.warn 不掩盖 trigger 返回；
 *   - 单 user 失败 try/catch 隔离不阻塞剩余 user；
 *   - 不破坏 facade 收敛 — guard 只输出 alert，调用方决定是否撮合。
 *
 * 边界与坑：
 *   - **窗口覆盖 5 交易日 ≈ 7 自然日**：A 股一周 5 个交易日 + 周末，简单加 7
 *     自然日已经覆盖；如遇春节十一 7+ 天长假可能多算 1-2 个交易日的解禁
 *     （宁可多报不可漏报，watchdog 提示性质宽松误报无害）；
 *   - **当前流通市值缺失** → 该持仓跳过（无法分母，conservative skip）；
 *   - **AKShare release_pct_of_float 不可信**：源数据按"解禁前流通市值"
 *     算，与当前可能不同（行情驱动 market cap 漂移），我们用 *当前* 流通
 *     市值重算保持口径一致；
 *   - **多批次解禁同股聚合**：同股同窗口可能有多个解禁日 / 多个股东，
 *     watchdog 把 release_market_value SUM 到 stock 后再除当前流通市值；
 *   - **股票代码格式**：持仓 symbol 形态 '600519.SH'，AKShare 返回 6 位
 *     '600519'，需 stripSymbolSuffix() 对齐；
 *   - **去重 signature**：`RESTRICTED::<symbol>::<window_end>` —— 同窗口
 *     同股不重复推；窗口推进自然让 signature 改变恢复触发；
 *   - **enabled=false**：整 user 跳过（returns NONE 不写任何 alert）；
 *   - **AKShare 数据空 → fail-OPEN**：fetchReleases() 抛或返 [] → 当日 watchdog
 *     无 trigger（不阻塞其他风控），同 US-050/US-053 fail-OPEN 模式；
 *   - **未持仓 stock 不发 alert**：watchdog 只关心用户持仓，全市场前瞻
 *     扫描留给后续 dashboard 类 UI feature。
 */

import { Op } from 'sequelize';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { Stock } from '../../models/Stock';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { RestrictedShareRelease } from '../../models/RestrictedShareRelease';
import { logger } from '../../utils/logger';
import {
  RestrictedShareClient,
  RestrictedShareReleaseRow,
  restrictedShareClient,
} from '../../data/sources/RestrictedShareClient';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface RestrictedShareConfig {
  /** 是否启用（false = 跳过整个 guard）。 */
  enabled: boolean;
  /**
   * 解禁累计市值 / 当前流通市值 触发阈值（小数，0.10 = 10%）。
   * AC 默认 0.10。用户可调严（0.05 = 5%）或调松（0.20 = 20%）。
   */
  release_threshold: number;
  /**
   * 前瞻窗口（交易日数），默认 5 —— 含义"未来 5 个交易日内解禁"。
   * 服务实际查询时按自然日加 buffer 简化（见 computeWindowEndDate）。
   */
  lookforward_trading_days: number;
  /**
   * 是否启用去重（默认 true）。同窗口同股已发过 alert 后跳过，依赖
   * User.risk_config.restricted_share_seen JSONB array (LRU 200 条)。
   */
  dedupe_enabled: boolean;
}

/**
 * 默认配置（AC 指定）：启用 + 10% 阈值 + 5 交易日 + 去重。
 *
 * `Object.freeze` 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const DEFAULT_RESTRICTED_SHARE_CONFIG: RestrictedShareConfig = Object.freeze({
  enabled: true,
  release_threshold: 0.1,
  lookforward_trading_days: 5,
  dedupe_enabled: true,
});

/** LRU dedup buffer 上限 — 防 JSONB 无限增长（US-053 同款）。 */
export const RESTRICTED_SHARE_SEEN_LRU_LIMIT = 200;

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** 单条 trigger payload。 */
export interface RestrictedShareTrigger {
  user_id: number;
  position_id: number;
  symbol: string;
  name: string;
  /** 6 位 stock_code（去后缀） */
  stock_code: string;
  /** 解禁市值合计（元） */
  total_release_market_value: number;
  /** 当前流通市值（元） */
  current_float_market_cap: number;
  /** 比例（小数，e.g. 0.15 = 15%） */
  release_ratio: number;
  /** 窗口起 ISO YYYY-MM-DD */
  window_start: string;
  /** 窗口止 ISO YYYY-MM-DD */
  window_end: string;
  /** 该窗口内 release batch 数量 */
  batch_count: number;
  /** 该窗口内最早解禁日 ISO YYYY-MM-DD */
  earliest_ex_date: string;
  /** signature 用于去重。 */
  signature: string;
  /** 中文消息（已渲染）。 */
  message: string;
}

/** per-position evaluation result. */
export interface PositionRestrictedShareResult {
  position_id: number;
  symbol: string;
  status:
    | 'triggered'
    | 'skipped_seen'
    | 'no_release'
    | 'below_threshold'
    | 'skipped_disabled'
    | 'missing_market_cap';
  /** Trigger 详情（仅 triggered / skipped_seen 有）。 */
  release_ratio?: number;
  /** Trigger 触发的窗口结束日（去重 signature 用）。 */
  window_end?: string;
  /** 中文描述（用于审计 / dashboard）。 */
  reason?: string;
}

/** per-user evaluation result. */
export interface RestrictedShareUserResult {
  user_id: number;
  portfolio_id: number | null;
  enabled: boolean;
  open_positions_count: number;
  triggered_count: number;
  triggers: RestrictedShareTrigger[];
  per_position: PositionRestrictedShareResult[];
  error?: string;
}

/** 全局 evaluation result. */
export interface RestrictedShareEvaluationResult {
  scanned_users: number;
  triggered_users: number;
  /** 所有用户的 trigger 平铺。 */
  triggers: RestrictedShareTrigger[];
  per_user: RestrictedShareUserResult[];
  /** 本轮共拉到的解禁批次条数（跨用户共享）。 */
  market_release_batches: number;
  /** 本轮扫描的窗口起 ISO。 */
  window_start: string;
  /** 本轮扫描的窗口止 ISO。 */
  window_end: string;
  /** 是否 dry_run（无 alert 写入）。 */
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB, no AKShare)
// ---------------------------------------------------------------------------

/**
 * `'600519.SH'` → `'600519'`；`'600519'` → `'600519'`；其他 → 原值。
 * 用于将持仓 symbol (含 '.SH' 后缀) 与 AKShare 6 位 code 对齐。
 */
export function stripSymbolSuffix(symbol: string): string {
  if (typeof symbol !== 'string') return symbol as any;
  const idx = symbol.indexOf('.');
  if (idx < 0) return symbol;
  return symbol.slice(0, idx);
}

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）。
 *
 * - 非有限 / 负 / 0 → 默认；
 * - 非 boolean enabled / dedupe_enabled → 默认；
 * - release_threshold 必须 (0, 1] 之间小数（如 0.10 = 10%）；
 * - lookforward_trading_days 必须正整数；
 *
 * 与 US-047 ... US-053 normalize 同款"沉默退回默认不 4xx"。
 */
export function normalizeRestrictedShareConfig(raw: any): RestrictedShareConfig {
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const safePosInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  const safeRatio = (v: any, dflt: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 1) return dflt;
    return n;
  };
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_RESTRICTED_SHARE_CONFIG.enabled),
    release_threshold: safeRatio(
      raw?.release_threshold,
      DEFAULT_RESTRICTED_SHARE_CONFIG.release_threshold
    ),
    lookforward_trading_days: safePosInt(
      raw?.lookforward_trading_days,
      DEFAULT_RESTRICTED_SHARE_CONFIG.lookforward_trading_days
    ),
    dedupe_enabled: safeBool(raw?.dedupe_enabled, DEFAULT_RESTRICTED_SHARE_CONFIG.dedupe_enabled),
  };
}

/**
 * 计算窗口结束日 ISO YYYY-MM-DD（asOfDate + ~7 自然日覆盖 5 个交易日）。
 *
 * **不严格依赖交易日历** —— A 股一周 5 个交易日 + 周末，简单加自然日
 * 已经覆盖；春节十一长假可能多算 1-2 个交易日的解禁，但 watchdog
 * 是宽松预警 —— 宁可多报不可漏报。
 *
 * 公式：windowEndDate = asOfDate + ceil(lookforward_trading_days * 7/5) 自然日。
 * (5 个交易日 → 7 自然日；10 个交易日 → 14 自然日。)
 */
export function computeWindowEndDate(asOfDate: Date, lookforwardTradingDays: number): string {
  const safeDays =
    Number.isInteger(lookforwardTradingDays) && lookforwardTradingDays >= 1
      ? lookforwardTradingDays
      : DEFAULT_RESTRICTED_SHARE_CONFIG.lookforward_trading_days;
  const calendarDays = Math.ceil((safeDays * 7) / 5);
  const end = new Date(asOfDate.getTime() + calendarDays * 86_400_000);
  return end.toISOString().slice(0, 10);
}

/**
 * 按 stock_code 聚合解禁市值（跨日跨批次跨股东合并到 stock 维度）。
 *
 * - releases 输入是日期范围内全市场的解禁批次；
 * - 返回 Map<stock_code, { total_value, batch_count, earliest_ex_date }>；
 * - 非有限 release_market_value 当 0 处理；
 * - earliest_ex_date 取 batch 中最早一日 ISO（用于消息友好展示）。
 */
export function aggregateReleaseByStock(
  releases: Array<{
    stock_code: string;
    ex_date: string;
    release_market_value: number | null;
  }>
): Map<
  string,
  {
    total_value: number;
    batch_count: number;
    earliest_ex_date: string;
  }
> {
  const out = new Map<
    string,
    { total_value: number; batch_count: number; earliest_ex_date: string }
  >();
  for (const r of releases) {
    if (!r.stock_code) continue;
    const code = String(r.stock_code).trim();
    if (!code) continue;
    const mv = Number(r.release_market_value);
    const safeMV = Number.isFinite(mv) ? mv : 0;
    const existing = out.get(code);
    if (existing) {
      existing.total_value += safeMV;
      existing.batch_count += 1;
      if (r.ex_date && r.ex_date < existing.earliest_ex_date) {
        existing.earliest_ex_date = r.ex_date;
      }
    } else {
      out.set(code, {
        total_value: safeMV,
        batch_count: 1,
        earliest_ex_date: r.ex_date || '',
      });
    }
  }
  return out;
}

/**
 * 计算解禁 / 流通比例。
 *
 * - releaseValue ≤ 0 → 0（无解禁压力）；
 * - floatMarketCap ≤ 0 / null → null（无法判定 → caller 跳过）；
 * - 非有限值 → null；
 * - 否则返回 releaseValue / floatMarketCap（小数，e.g. 0.15 = 15%）。
 */
export function computeReleaseRatio(
  releaseValue: number,
  floatMarketCap: number | null | undefined
): number | null {
  if (!Number.isFinite(releaseValue)) return null;
  if (releaseValue <= 0) return 0;
  if (
    floatMarketCap === null ||
    floatMarketCap === undefined ||
    !Number.isFinite(Number(floatMarketCap)) ||
    Number(floatMarketCap) <= 0
  ) {
    return null;
  }
  return releaseValue / Number(floatMarketCap);
}

/**
 * 构造去重 signature：`RESTRICTED::<symbol>::<window_end>`。
 *
 * 同窗口同股不重复推；窗口推进自然让 signature 改变恢复触发
 * （不像 US-053 ST 的"长效"signature，本 signature 与时间窗绑定）。
 */
export function signatureForRelease(input: { symbol: string; window_end: string }): string {
  return `RESTRICTED::${input.symbol}::${input.window_end}`;
}

/**
 * 把新 signatures 合并到既有 seen array 中（FIFO LRU，最多 LIMIT 条）。
 * 与 US-053 BlackSwanWatchdog.mergeSeenSignatures 同款语义；
 * 这里独立实现保持文件无跨 layer 反向 import（同款 US-040 镜像 vs import 规则）。
 */
export function mergeSeenSignatures(
  existing: string[] | null | undefined,
  newOnes: string[],
  limit: number = RESTRICTED_SHARE_SEEN_LRU_LIMIT
): string[] {
  const exist = Array.isArray(existing) ? existing.filter(s => typeof s === 'string') : [];
  const seen = new Set(exist);
  const out: string[] = [...exist];
  for (const sig of newOnes) {
    if (typeof sig !== 'string') continue;
    if (seen.has(sig)) {
      const idx = out.indexOf(sig);
      if (idx >= 0) out.splice(idx, 1);
    } else {
      seen.add(sig);
    }
    out.push(sig);
  }
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : RESTRICTED_SHARE_SEEN_LRU_LIMIT;
  if (out.length > safeLimit) {
    return out.slice(out.length - safeLimit);
  }
  return out;
}

/**
 * 拼装解禁触发 message（中文）— 提示用户提前规避。
 *
 * 例：'600519（贵州茅台）未来 5 个交易日内将有 2 批限售股解禁，
 *      合计市值约 12.5 亿元，占当前流通市值 12.3%。最早解禁日：2026-06-15。
 *      建议提前评估持仓。'
 */
export function buildRestrictedShareMessage(input: {
  symbol: string;
  name: string;
  total_release_market_value: number;
  current_float_market_cap: number;
  release_ratio: number;
  batch_count: number;
  earliest_ex_date: string;
  lookforward_trading_days: number;
}): string {
  const valueYi = input.total_release_market_value / 1e8;
  const valueStr =
    valueYi >= 1 ? `${valueYi.toFixed(2)} 亿元` : `${(valueYi * 10000).toFixed(0)} 万元`;
  const ratioPct = (input.release_ratio * 100).toFixed(2);
  const earliest = input.earliest_ex_date || '近期';
  return (
    `${input.symbol}（${input.name}）未来 ${input.lookforward_trading_days} 个交易日内` +
    `将有 ${input.batch_count} 批限售股解禁，合计市值约 ${valueStr}，` +
    `占当前流通市值 ${ratioPct}%。最早解禁日：${earliest}。` +
    `建议提前评估持仓压力。`
  );
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface RestrictedShareDataSource {
  /** Load all users with at least one paper-trading portfolio. */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<RestrictedShareConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: RestrictedShareConfig): Promise<RestrictedShareConfig>;
  /** Load the user's portfolio header (just id). */
  loadPortfolioId(user_id: number): Promise<number | null>;
  /**
   * Load all open positions (quantity > 0) for the user, with name + current
   * float market cap (joined from Stock).
   */
  loadOpenPositionsWithMarketCap(user_id: number): Promise<
    Array<{
      id: number;
      portfolio_id: number;
      symbol: string;
      name: string;
      circulating_market_cap: number | null;
    }>
  >;
  /** Read User.risk_config.restricted_share_seen array (or []). */
  loadSeenSignatures(user_id: number): Promise<string[]>;
  /** Persist updated seen signatures (with LRU trim already applied). */
  saveSeenSignatures(user_id: number, signatures: string[]): Promise<void>;
  /**
   * Fetch all restricted-share release batches in [startDate, endDate] (inclusive).
   * Returned rows keyed by stock_code (no suffix). May either pull from local
   * RestrictedShareRelease table (default) or fall through to AKShare client
   * if table is empty (best-effort fail-OPEN).
   */
  fetchReleasesInWindow(
    startDate: string,
    endDate: string
  ): Promise<
    Array<{
      stock_code: string;
      ex_date: string;
      release_market_value: number | null;
    }>
  >;
  /** Write a single RiskAlert row (level='MEDIUM'). */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void>;
}

/**
 * Production DataSource — backed by Sequelize + RestrictedShareClient.
 */
export class DefaultRestrictedShareDataSource implements RestrictedShareDataSource {
  private readonly client: RestrictedShareClient;

  constructor(client: RestrictedShareClient = restrictedShareClient) {
    this.client = client;
  }

  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => Number(r.user_id)).filter(Number.isFinite);
  }

  async loadConfig(user_id: number): Promise<RestrictedShareConfig> {
    const user = await User.findByPk(user_id);
    const raw = (user?.risk_config as any)?.restricted_share;
    return normalizeRestrictedShareConfig(raw);
  }

  async saveConfig(user_id: number, config: RestrictedShareConfig): Promise<RestrictedShareConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error(`saveConfig: user ${user_id} not found`);
    const merged = {
      ...(user.risk_config || {}),
      restricted_share: {
        ...((user.risk_config as any)?.restricted_share || {}),
        ...config,
      },
    };
    user.risk_config = merged;
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadPortfolioId(user_id: number): Promise<number | null> {
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id },
      attributes: ['id'],
    });
    return portfolio ? Number(portfolio.id) : null;
  }

  async loadOpenPositionsWithMarketCap(user_id: number): Promise<
    Array<{
      id: number;
      portfolio_id: number;
      symbol: string;
      name: string;
      circulating_market_cap: number | null;
    }>
  > {
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id },
      attributes: ['id'],
    });
    if (!portfolio) return [];
    const positions = (await PaperTradingPosition.findAll({
      where: {
        portfolio_id: portfolio.id,
        quantity: { [Op.gt]: 0 },
      },
      raw: true,
    })) as any[];
    if (positions.length === 0) return [];

    const symbols = positions.map(p => String(p.symbol));
    const stocks = (await Stock.findAll({
      where: { symbol: { [Op.in]: symbols } },
      attributes: ['symbol', 'name', 'circulating_market_cap'],
      raw: true,
    })) as any[];
    const stockMap = new Map<string, { name: string; cap: number | null }>();
    for (const s of stocks) {
      const capRaw = s.circulating_market_cap;
      const cap = capRaw === null || capRaw === undefined ? null : Number(capRaw);
      stockMap.set(String(s.symbol), {
        name: String(s.name || s.symbol),
        cap: cap !== null && Number.isFinite(cap) ? cap : null,
      });
    }
    return positions.map(p => {
      const sym = String(p.symbol);
      const entry = stockMap.get(sym);
      return {
        id: Number(p.id),
        portfolio_id: Number(p.portfolio_id),
        symbol: sym,
        name: entry?.name ?? sym,
        circulating_market_cap: entry?.cap ?? null,
      };
    });
  }

  async loadSeenSignatures(user_id: number): Promise<string[]> {
    const user = await User.findByPk(user_id);
    const arr = (user?.risk_config as any)?.restricted_share_seen;
    if (!Array.isArray(arr)) return [];
    return arr.filter(s => typeof s === 'string');
  }

  async saveSeenSignatures(user_id: number, signatures: string[]): Promise<void> {
    const user = await User.findByPk(user_id);
    if (!user) return;
    const merged = {
      ...(user.risk_config || {}),
      restricted_share_seen: signatures,
    };
    user.risk_config = merged;
    user.changed('risk_config', true);
    await user.save();
  }

  /**
   * 优先从本地 RestrictedShareRelease 表读（CLI 已 sync 入库）；
   * 表为空时 best-effort 走 client 拉一次。失败 fail-OPEN 返 []。
   */
  async fetchReleasesInWindow(
    startDate: string,
    endDate: string
  ): Promise<
    Array<{
      stock_code: string;
      ex_date: string;
      release_market_value: number | null;
    }>
  > {
    try {
      const rows = (await RestrictedShareRelease.findAll({
        where: {
          ex_date: {
            [Op.gte]: startDate,
            [Op.lte]: endDate,
          },
        },
        attributes: ['ex_date', 'stock_code', 'release_market_value'],
        raw: true,
      })) as any[];
      if (rows.length > 0) {
        return rows.map(r => ({
          stock_code: String(r.stock_code),
          ex_date: String(r.ex_date),
          release_market_value:
            r.release_market_value === null || r.release_market_value === undefined
              ? null
              : Number(r.release_market_value),
        }));
      }
      // Fallback: try client (caller might not have run sync yet)
      const remote = await this.client.fetchForDateRange(startDate, endDate).catch(err => {
        logger.warn(
          `RestrictedShareWatchdog: fetchReleasesInWindow client failed (continuing): ${
            (err as Error).message
          }`
        );
        return [] as RestrictedShareReleaseRow[];
      });
      return remote.map(r => ({
        stock_code: String(r.stock_code),
        ex_date: String(r.ex_date),
        release_market_value:
          r.release_market_value === null || r.release_market_value === undefined
            ? null
            : Number(r.release_market_value),
      }));
    } catch (err) {
      logger.warn(
        `RestrictedShareWatchdog: fetchReleasesInWindow failed: ${(err as Error).message}`
      );
      return [];
    }
  }

  async writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void> {
    await RiskAlert.create({
      user_id: input.user_id,
      symbol: input.symbol,
      name: input.name,
      level: 'MEDIUM',
      message: input.message,
      // US-067 RealtimeAlertDispatcher dedup signature 用。
      rule_id: 'restricted_share',
      is_read: false,
    } as any);
  }
}

export const PRODUCTION_RESTRICTED_SHARE_DATA_SOURCE: RestrictedShareDataSource =
  new DefaultRestrictedShareDataSource();

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface EvaluateRestrictedShareOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the asOfDate (defaults to "now"). */
  asOfDate?: Date;
  /** If true, do NOT write RiskAlert rows + skip seen-signature persist (dry-run). */
  dry_run?: boolean;
}

export class RestrictedShareWatchdog {
  private source: RestrictedShareDataSource;

  constructor(source: RestrictedShareDataSource = PRODUCTION_RESTRICTED_SHARE_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * 每日评估所有用户的限售解禁压力。
   *
   * - 单 user 失败 try/catch 隔离（同 US-047 ... US-053）；
   * - disabled 用户跳过整个评估（returns enabled=false 不写 alert）；
   * - 解禁批次一次 fetch 跨用户共享（窗口跨用户相同）；
   * - dry_run=true 跳过 RiskAlert 写入 + seen-signature 持久化，但仍返回完整
   *   triggers list（UI 预演 / cron preview）。
   *
   * 数据源故障 → 该数据维度跳过（其他维度继续）— fail-OPEN，guard 不应该
   * 因数据外 dependency 故障 crash scheduler。
   */
  async evaluateAfterOpen(
    options: EvaluateRestrictedShareOptions = {}
  ): Promise<RestrictedShareEvaluationResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const dryRun = Boolean(options.dry_run);
    const windowStart = asOfDate.toISOString().slice(0, 10);

    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    // Pre-load market-wide releases for the widest possible window (use the
    // longest lookforward configured among users, or default 5 trading days).
    // For simplicity + cross-user sharing, we use the default window — per-user
    // config can re-filter from the shared snapshot.
    const defaultWindowEnd = computeWindowEndDate(
      asOfDate,
      DEFAULT_RESTRICTED_SHARE_CONFIG.lookforward_trading_days
    );
    const releases = await this.source.fetchReleasesInWindow(windowStart, defaultWindowEnd);
    const aggregateAll = aggregateReleaseByStock(releases);

    const result: RestrictedShareEvaluationResult = {
      scanned_users: userIds.length,
      triggered_users: 0,
      triggers: [],
      per_user: [],
      market_release_batches: releases.length,
      window_start: windowStart,
      window_end: defaultWindowEnd,
      dry_run: dryRun,
    };

    for (const user_id of userIds) {
      try {
        const userResult = await this.evaluateOneUser(
          user_id,
          asOfDate,
          windowStart,
          defaultWindowEnd,
          aggregateAll,
          dryRun
        );
        result.per_user.push(userResult);
        if (userResult.triggered_count > 0) {
          result.triggered_users += 1;
          result.triggers.push(...userResult.triggers);
        }
      } catch (err) {
        logger.warn(
          `RestrictedShareWatchdog: user=${user_id} evaluation failed: ${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          portfolio_id: null,
          enabled: false,
          open_positions_count: 0,
          triggered_count: 0,
          triggers: [],
          per_position: [],
          error: (err as Error).message,
        });
      }
    }
    return result;
  }

  /**
   * Evaluate a single user — pure orchestration over DataSource calls.
   */
  private async evaluateOneUser(
    user_id: number,
    _asOfDate: Date,
    windowStart: string,
    defaultWindowEnd: string,
    aggregateAll: Map<
      string,
      { total_value: number; batch_count: number; earliest_ex_date: string }
    >,
    dryRun: boolean
  ): Promise<RestrictedShareUserResult> {
    const config = await this.source.loadConfig(user_id);
    const portfolio_id = await this.source.loadPortfolioId(user_id);
    if (!config.enabled) {
      return {
        user_id,
        portfolio_id,
        enabled: false,
        open_positions_count: 0,
        triggered_count: 0,
        triggers: [],
        per_position: [],
      };
    }

    const positions = await this.source.loadOpenPositionsWithMarketCap(user_id);
    if (positions.length === 0) {
      return {
        user_id,
        portfolio_id,
        enabled: true,
        open_positions_count: 0,
        triggered_count: 0,
        triggers: [],
        per_position: [],
      };
    }

    const seen = config.dedupe_enabled ? await this.source.loadSeenSignatures(user_id) : [];
    const seenSet = new Set(seen);

    const triggers: RestrictedShareTrigger[] = [];
    const perPosition: PositionRestrictedShareResult[] = [];
    const newSignatures: string[] = [];

    for (const pos of positions) {
      const code = stripSymbolSuffix(pos.symbol);
      const agg = aggregateAll.get(code);
      if (!agg || agg.total_value <= 0) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'no_release',
          reason: '未来 5 个交易日无解禁',
        });
        continue;
      }
      const ratio = computeReleaseRatio(agg.total_value, pos.circulating_market_cap);
      if (ratio === null) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'missing_market_cap',
          reason: '当前流通市值缺失，无法计算解禁比例',
        });
        continue;
      }
      if (ratio <= config.release_threshold) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'below_threshold',
          release_ratio: ratio,
          reason: `解禁比例 ${(ratio * 100).toFixed(2)}% ≤ 阈值 ${(
            config.release_threshold * 100
          ).toFixed(0)}%`,
        });
        continue;
      }

      const signature = signatureForRelease({
        symbol: pos.symbol,
        window_end: defaultWindowEnd,
      });

      if (config.dedupe_enabled && seenSet.has(signature)) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'skipped_seen',
          release_ratio: ratio,
          window_end: defaultWindowEnd,
          reason: '本窗口已发过告警',
        });
        continue;
      }

      const message = buildRestrictedShareMessage({
        symbol: pos.symbol,
        name: pos.name,
        total_release_market_value: agg.total_value,
        current_float_market_cap: pos.circulating_market_cap ?? 0,
        release_ratio: ratio,
        batch_count: agg.batch_count,
        earliest_ex_date: agg.earliest_ex_date,
        lookforward_trading_days: config.lookforward_trading_days,
      });

      const trigger: RestrictedShareTrigger = {
        user_id,
        position_id: pos.id,
        symbol: pos.symbol,
        name: pos.name,
        stock_code: code,
        total_release_market_value: agg.total_value,
        current_float_market_cap: pos.circulating_market_cap ?? 0,
        release_ratio: ratio,
        window_start: windowStart,
        window_end: defaultWindowEnd,
        batch_count: agg.batch_count,
        earliest_ex_date: agg.earliest_ex_date,
        signature,
        message,
      };
      triggers.push(trigger);
      newSignatures.push(signature);
      perPosition.push({
        position_id: pos.id,
        symbol: pos.symbol,
        status: 'triggered',
        release_ratio: ratio,
        window_end: defaultWindowEnd,
        reason: `解禁比例 ${(ratio * 100).toFixed(2)}% > 阈值 ${(
          config.release_threshold * 100
        ).toFixed(0)}%`,
      });
    }

    // Write alerts + persist seen signatures (skip both on dry_run)
    if (!dryRun) {
      for (const t of triggers) {
        try {
          await this.source.writeAlert({
            user_id: t.user_id,
            symbol: t.symbol,
            name: t.name,
            message: t.message,
          });
        } catch (err) {
          logger.warn(
            `RestrictedShareWatchdog.writeAlert user=${user_id} symbol=${t.symbol}: ${
              (err as Error).message
            }`
          );
        }
      }
      if (config.dedupe_enabled && newSignatures.length > 0) {
        const merged = mergeSeenSignatures(seen, newSignatures);
        try {
          await this.source.saveSeenSignatures(user_id, merged);
        } catch (err) {
          logger.warn(
            `RestrictedShareWatchdog.saveSeenSignatures user=${user_id}: ${(err as Error).message}`
          );
        }
      }
    }

    return {
      user_id,
      portfolio_id,
      enabled: true,
      open_positions_count: positions.length,
      triggered_count: triggers.length,
      triggers,
      per_position: perPosition,
    };
  }
}

export const restrictedShareWatchdog = new RestrictedShareWatchdog();
