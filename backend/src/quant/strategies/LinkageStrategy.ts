import { Op } from 'sequelize';
import { QuantStrategy } from './QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../types/QuantTypes';
import { LimitUpStock } from '../../models/LimitUpStock';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { logger } from '../../utils/logger';
import { isSTName } from '../../utils/stNameUtils';

/**
 * LinkageStrategy — 行业联动股（US-027）
 *
 * 题材扩散短线策略：识别"行业内存在涨停龙头（涨幅 > 9%）"，在同行业内寻找
 * 流通市值小于龙头、自身昨日涨幅温和（< 5%）、当日开盘高开不大（< 3%）的
 * "未启动联动股"作为补涨标的。本质：龙头 + 题材外溢 + 跟风滞涨股的接力。
 *
 * 与同行业其他短线策略的差异：
 *   - 与 DragonHeadMomentumStrategy（短线龙头）的差异：DragonHead 抓的是"涨停板梯队
 *     内的二三连板龙头"，本策略相反 —— 抓"涨停板外的同行业未启动联动股"。
 *     龙头自己我们不买（已涨停），而是买跟风扩散标的。
 *   - 与 GameTraderRelayStrategy（游资接力）的差异：GameTrader 看龙虎榜资金面接
 *     力，本策略看行业题材+滞涨结构性扩散，不依赖龙虎榜数据。
 *
 * 与现有 QuantStrategy 基类的 evaluate() 兼容性：
 *   组合级策略；evaluate() 返回信息性 'hold'，真正入口是 generateSignals(date)。
 *
 * 默认参数（AC 指定值）：
 *   maxPositions=5  leaderMinChangePct=0.09  candidateMaxYesterdayChangePct=0.05
 *   candidateMaxOpenGapPct=0.03  holdingDaysLimit=3  exitNextDayDropPct=-0.03
 *   stopLossPct=-0.07  excludeST=true
 *
 * 入场 5 条件（全部 AND）：
 *   1. 候选股**所属行业**当日有股票涨停 且 涨幅 > leaderMinChangePct（默认 9%）
 *      —— 龙头股本身（已涨停）不参与买入，但确认行业题材已被点燃
 *   2. 候选股**昨日涨幅 < candidateMaxYesterdayChangePct（默认 5%）**
 *      —— 排除已经启动的票，找尚未启动的"未涨"标的
 *   3. 候选股 **流通市值 < 行业内龙头股流通市值**
 *      —— "联动股" = 体量小于龙头的同行业股，否则不算"跟风"
 *   4. 候选股**当日开盘高开 < candidateMaxOpenGapPct（默认 3%）**
 *      —— 排除已经被资金抢筹的高开标的，找开盘平静晚启动的票
 *   5. 候选股**非 ST / *ST**
 *
 * 出场优先级（按 A → C 排序）：
 *   A. 持有 ≥ holdingDaysLimit（默认 3 自然日）→ SELL 全部
 *   B. (close - entry_price) / entry_price ≤ stopLossPct（默认 -7%）→ SELL（个股止损）
 *   C. 持仓首日后，当日 hit 涨停 → SELL（已实现联动 take profit）
 *   D. 持仓首日后，当日跌幅 ≤ exitNextDayDropPct（默认 -3%）→ SELL（次日大跌止跌）
 *   E. 否则 HOLD
 *
 * Position 必须携带 entry_date + entry_price（exit 规则需要 holding_days / stop_loss）；
 * entry_industry 记录进场时归属行业（debug 用）。
 *
 * Universe 形态（第 10 种 — 行业题材联动）：与 SectorRotationLeader 的"两阶段选股"
 * 不同 —— 后者是"先选强行业再选龙头"，本策略是"以涨停龙头作为行业触发信号，
 * 然后在 *同行业其他股票* 中找联动滞涨股"。龙头本身被排除（已涨停不可买），
 * 候选池 = (有涨停行业的全部成份股) - (今日已涨停股)，规模介于全市场和指数受限之间。
 */

/** 默认参数（AC 指定值） */
export const DEFAULT_LINKAGE_PARAMS: Readonly<Required<LinkageParams>> = Object.freeze({
  maxPositions: 5,
  leaderMinChangePct: 0.09,
  candidateMaxYesterdayChangePct: 0.05,
  candidateMaxOpenGapPct: 0.03,
  holdingDaysLimit: 3,
  exitNextDayDropPct: -0.03,
  stopLossPct: -0.07,
  excludeST: true,
});

export interface LinkageParams {
  /** 最大同时持仓数（AC 默认 5） */
  maxPositions: number;
  /** 行业龙头判定的最小涨幅（AC 默认 0.09 = 9% — 接近涨停的强势行情） */
  leaderMinChangePct: number;
  /** 候选股昨日涨幅上限（AC 默认 0.05 = 5% — 找"未启动"标的） */
  candidateMaxYesterdayChangePct: number;
  /** 候选股当日开盘高开上限（AC 默认 0.03 = 3% — 排除已抢筹高开标的） */
  candidateMaxOpenGapPct: number;
  /** 持有 N 自然日强制 SELL（AC 默认 3） */
  holdingDaysLimit: number;
  /** 次日大跌出场阈值（AC 默认 -0.03 = -3%） */
  exitNextDayDropPct: number;
  /** 个股止损阈值（默认 -0.07 = -7%） */
  stopLossPct: number;
  /** 是否剔除 ST / *ST */
  excludeST: boolean;
}

/** 单只持仓的结构化记录（exit 规则需要 entry_date / entry_price） */
export interface LinkagePosition {
  stock_code: string;
  /** 进场日 ISO YYYY-MM-DD */
  entry_date: string;
  /** 进场价（用于止损与盈亏计算） */
  entry_price: number;
  /** 进场时归属行业（debug 用） */
  entry_industry?: string | null;
  /** 进场时锁定的"该行业龙头股代码"（debug 用） */
  entry_leader_code?: string | null;
}

export interface LinkageSignal {
  stock_code: string;
  name?: string | null;
  industry?: string | null;
  /** buy=新进入选；sell=全平；hold=保留 */
  signal: 'buy' | 'sell' | 'hold';
  reason: string;
  /** 期望成交价（BUY=当日收盘；SELL=次日开盘/盘中价） */
  reference_price?: number;
  /** 当日开盘高开比例（小数） */
  open_gap_pct?: number;
  /** 昨日涨幅（小数） */
  yesterday_change_pct?: number;
  /** 该候选所属行业的龙头股代码 */
  leader_stock_code?: string;
  /** 该候选流通市值 */
  circulating_market_cap?: number;
  /** 该行业龙头股流通市值 */
  leader_market_cap?: number;
}

/** 入场候选过滤维度统计 */
export interface LinkageFilteredStats {
  /** 当日总涨停股票数 */
  limit_up_stock_count: number;
  /** 当日有涨停龙头（涨幅 > 9%）的行业数 */
  hot_industry_count: number;
  /** 候选池（行业内非龙头非已涨停股）总规模 */
  candidate_pool_size: number;
  /** 缺元数据 / 没流通市值剔除数 */
  fail_meta_missing: number;
  /** ST 剔除数 */
  fail_st: number;
  /** 缺当日 quote 数据剔除数 */
  fail_missing_quote: number;
  /** 缺昨日 quote 数据剔除数 */
  fail_missing_yesterday: number;
  /** 昨日涨幅过大（已启动）剔除数 */
  fail_yesterday_change_too_high: number;
  /** 当日开盘高开过大（已抢筹）剔除数 */
  fail_open_gap_too_high: number;
  /** 流通市值 ≥ 龙头流通市值剔除数 */
  fail_cap_not_below_leader: number;
}

export interface LinkageSignalsResult {
  trade_date: string;
  /** 调仓后目标持仓（含已持有保留 + 新进 BUY；不含 SELL 剔除项） */
  target_positions: LinkagePosition[];
  /** 增量信号（BUY/SELL/HOLD） */
  signals: LinkageSignal[];
  /** 候选过滤维度统计 */
  filtered: LinkageFilteredStats;
  /** 实际生效参数（合并 default + override 后） */
  params: LinkageParams;
  /** 当日 eligible 入场候选总数（未受 maxPositions cap 前） */
  eligible_count: number;
  /** 当日识别出的热门行业 → 龙头股代码 */
  hot_industries: Array<{ industry: string; leader_stock_code: string; leader_change_pct: number }>;
}

export interface LinkageGenerateOptions {
  params?: Partial<LinkageParams>;
  /** 当前持仓（包含每只股票的 entry_date + entry_price）；不传视为首次评估（无 exit 流程） */
  currentPositions?: LinkagePosition[];
}

// ---------------------------------------------------------------------------
// DataSource 接口（便于测试用 fake 注入）
// ---------------------------------------------------------------------------

/**
 * 5 个 loader 方法 — 把所有 Sequelize 查询从策略主体抽离，便于单元测试 mock。
 *
 * 设计差异（vs GameTraderRelay 4 loader 与 SectorRotationLeader 3 loader）：
 *   - 必须分开 loadIndustryLimitUpStocks（当日涨停股，按行业归组）+
 *     loadIndustryConstituents（行业内所有成份股）—— 前者提供"题材点燃信号"，
 *     后者提供"联动候选池"，两个查询数据形状不同不能合并。
 *   - loadDailyQuotes 同时给出 today + yesterday 双日数据（候选股 entry 需要
 *     today open/close + yesterday close 算昨日涨幅）+ holding exit 需要
 *     today change_pct。
 *   - loadLimitUpStocks（exit 用）单独一个 loader 而不是复用入场的
 *     loadIndustryLimitUpStocks，因为 exit 阶段只需要"持仓股 stock_codes →
 *     是否涨停"的 Map<code, boolean>，数据形状与 entry 完全不同。
 */
export interface LinkageDataSource {
  /**
   * 给定 (tradeDate)，扫描当日所有涨停股（含其行业 + 涨幅），按行业归组返回。
   * 返回 Map<industry_name, Array<LimitUpInfo>>，每个 entry 是该行业内的涨停股
   * 列表。同行业有多个涨停股时取涨幅最大的为"龙头"。
   *
   * 注意：本 loader 同时承担"识别热门行业"职责，filter 仅传入 leaderMinChangePct
   * 让 service 层判定（DataSource 不知业务阈值）。
   */
  loadIndustryLimitUpStocks(tradeDate: string): Promise<Map<string, LinkageLimitUpInfo[]>>;

  /**
   * 给定 industry 列表，返回每个行业的成份股代码列表（剔除该行业当日已涨停股）。
   * 候选池由此产生。剔除涨停股的逻辑也在 DataSource 内完成，避免 service 重新查
   * 一次涨停表 —— 因为 loadIndustryLimitUpStocks 调用方已知所有涨停股代码。
   *
   * @param industries 热门行业名称列表
   * @param excludeLimitUpStocks 当日已涨停股代码 set，从候选池中剔除
   */
  loadIndustryConstituents(
    industries: string[],
    excludeLimitUpStocks: Set<string>
  ): Promise<Map<string, LinkageCandidateMeta[]>>;

  /**
   * 给定 (tradeDate, stockCodes)，返回当日 + 昨日双日行情。
   * 当日数据用于 entry 的 open_gap_pct 判定 + 出场的 change_pct 判定。
   * 昨日数据用于 entry 的 yesterday_change_pct 判定（昨日 close / 前日 close - 1）。
   *
   * 缺当日或缺昨日的 stock_code 可以不出现在返回 Map 中，service 层处理。
   */
  loadDailyQuotes(tradeDate: string, stockCodes: string[]): Promise<Map<string, LinkageQuote>>;

  /**
   * 给定 (tradeDate, stockCodes)，返回当日 hit 涨停的 stock_code set。
   * exit 阶段用：持仓首日后若 stock_code ∈ this set → SELL（联动已实现）。
   */
  loadLimitUpStocksOnDate(tradeDate: string, stockCodes: string[]): Promise<Set<string>>;
}

export interface LinkageLimitUpInfo {
  stock_code: string;
  stock_name?: string | null;
  industry: string;
  /** 当日涨幅（小数；0.10 = 10%） */
  change_pct: number;
  /** 流通市值（元） */
  circulating_market_cap?: number | null;
}

export interface LinkageCandidateMeta {
  stock_code: string;
  name?: string | null;
  industry: string;
  /** 流通市值（元） */
  circulating_market_cap?: number | null;
}

export interface LinkageQuote {
  /** 当日开盘价 */
  open: number;
  /** 当日收盘价 */
  close: number;
  /** 前一交易日收盘价（用于算当日 change_pct + 当日 open_gap） */
  prev_close: number;
  /** 当日涨幅（小数；缺则由 (close - prev_close)/prev_close 算） */
  change_pct: number;
  /** 当日开盘高开比例（小数；缺则由 (open - prev_close)/prev_close 算） */
  open_gap_pct: number;
  /** 昨日收盘价（用于算昨日涨幅） */
  yesterday_close?: number;
  /** 前日收盘价（与 yesterday_close 一起算昨日涨幅） */
  day_before_yesterday_close?: number;
  /** 昨日涨幅（小数；缺则由 (yesterday_close - day_before_yesterday_close)/... 算） */
  yesterday_change_pct?: number;
}

// ---------------------------------------------------------------------------
// 生产 DataSource 实现
// ---------------------------------------------------------------------------

/**
 * 默认数据源：直接走 Sequelize 模型。生产环境通过 PRODUCTION_DATA_SOURCE 单例
 * 使用；测试不应触碰这个类。
 */
export class DefaultLinkageDataSource implements LinkageDataSource {
  async loadIndustryLimitUpStocks(tradeDate: string): Promise<Map<string, LinkageLimitUpInfo[]>> {
    // Step 1: 拉当日 LimitUpStock 全部行
    const luRows = (await LimitUpStock.findAll({
      attributes: ['stock_code', 'stock_name', 'industry'],
      where: { trade_date: tradeDate },
      raw: true,
    })) as unknown as Array<{
      stock_code: string;
      stock_name: string | null;
      industry: string | null;
    }>;
    if (!luRows.length) return new Map();

    const codes = luRows.map(r => r.stock_code);
    // Step 2: 拉 Stock 元数据 (industry + cap) — 当 LimitUpStock.industry 缺失时回退
    const symbols = codes.map(c => guessStockSymbol(c));
    const stockRows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry', 'circulating_market_cap'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
      circulating_market_cap: number | string | null;
    }>;
    const stockMap = new Map<
      string,
      { name: string; industry: string | null; cap: number | null }
    >();
    for (const r of stockRows) {
      const code = stripSuffix(r.symbol);
      const cap =
        typeof r.circulating_market_cap === 'string'
          ? Number(r.circulating_market_cap)
          : r.circulating_market_cap;
      stockMap.set(code, {
        name: r.name ?? '',
        industry: r.industry ?? null,
        cap: cap != null && Number.isFinite(cap) ? cap : null,
      });
    }

    // Step 3: 拉昨日 close 算当日 change_pct（DailyBar 在 stocks 表 id 上 join）
    const idRows = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    const idToCode = new Map<number, string>();
    const stockIds: number[] = [];
    for (const r of idRows) {
      idToCode.set(r.id, stripSuffix(r.symbol));
      stockIds.push(r.id);
    }

    const lookbackStart = new Date(`${tradeDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 10);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'close', 'change_percent'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: {
          [Op.gte]: lookbackStart.toISOString(),
          [Op.lte]: `${tradeDate}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      close: number | string;
      change_percent: number | string | null;
    }>;

    const changeByCode = new Map<string, number>();
    const barsByStockId = new Map<
      number,
      Array<{ timeMs: number; timeIso: string; close: number; chg: number | null }>
    >();
    for (const b of bars) {
      const close = Number(b.close);
      if (!Number.isFinite(close)) continue;
      const tMs = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
      if (!Number.isFinite(tMs)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({
        timeMs: tMs,
        timeIso: tIso,
        close,
        chg:
          b.change_percent != null && Number.isFinite(Number(b.change_percent))
            ? Number(b.change_percent)
            : null,
      });
      barsByStockId.set(b.stock_id, arr);
    }
    for (const [sid, arr] of barsByStockId.entries()) {
      const code = idToCode.get(sid);
      if (!code) continue;
      arr.sort((a, b) => a.timeMs - b.timeMs);
      const todayIdx = arr.findIndex(b => b.timeIso === tradeDate);
      if (todayIdx < 0) continue;
      const today = arr[todayIdx];
      const prev = todayIdx > 0 ? arr[todayIdx - 1].close : null;
      const change = today.chg != null ? today.chg / 100 : prev ? (today.close - prev) / prev : 0.1;
      changeByCode.set(code, change);
    }

    // Step 4: 按行业归组
    const out = new Map<string, LinkageLimitUpInfo[]>();
    for (const lu of luRows) {
      const meta = stockMap.get(lu.stock_code);
      // 行业归属：LimitUpStock 行有就用，否则取 Stock.industry
      const industry = (lu.industry || meta?.industry || '').trim();
      if (!industry) continue;
      const cap = meta?.cap ?? null;
      const change = changeByCode.get(lu.stock_code) ?? 0.1;
      const arr = out.get(industry) ?? [];
      arr.push({
        stock_code: lu.stock_code,
        stock_name: lu.stock_name ?? meta?.name ?? null,
        industry,
        change_pct: change,
        circulating_market_cap: cap,
      });
      out.set(industry, arr);
    }
    return out;
  }

  async loadIndustryConstituents(
    industries: string[],
    excludeLimitUpStocks: Set<string>
  ): Promise<Map<string, LinkageCandidateMeta[]>> {
    if (!industries.length) return new Map();
    const rows = (await Stock.findAll({
      attributes: ['symbol', 'name', 'industry', 'circulating_market_cap'],
      where: { industry: { [Op.in]: industries } },
      raw: true,
    })) as unknown as Array<{
      symbol: string;
      name: string;
      industry: string | null;
      circulating_market_cap: number | string | null;
    }>;
    const out = new Map<string, LinkageCandidateMeta[]>();
    for (const r of rows) {
      const code = stripSuffix(r.symbol);
      if (excludeLimitUpStocks.has(code)) continue;
      const industry = (r.industry || '').trim();
      if (!industry) continue;
      const cap =
        typeof r.circulating_market_cap === 'string'
          ? Number(r.circulating_market_cap)
          : r.circulating_market_cap;
      const arr = out.get(industry) ?? [];
      arr.push({
        stock_code: code,
        name: r.name ?? null,
        industry,
        circulating_market_cap: cap != null && Number.isFinite(cap) ? cap : null,
      });
      out.set(industry, arr);
    }
    return out;
  }

  async loadDailyQuotes(
    tradeDate: string,
    stockCodes: string[]
  ): Promise<Map<string, LinkageQuote>> {
    if (!stockCodes.length) return new Map();
    const symbols = stockCodes.map(c => guessStockSymbol(c));
    const stocks = (await Stock.findAll({
      attributes: ['id', 'symbol'],
      where: { symbol: { [Op.in]: symbols } },
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    if (!stocks.length) return new Map();
    const idToCode = new Map<number, string>();
    const stockIds: number[] = [];
    for (const s of stocks) {
      idToCode.set(s.id, stripSuffix(s.symbol));
      stockIds.push(s.id);
    }

    // 拉 [asOfDate - 15 自然日, asOfDate] 的所有 bar，每只取 today + yesterday + day-before-yesterday
    const lookbackStart = new Date(`${tradeDate}T00:00:00Z`);
    lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 15);
    const bars = (await DailyBar.findAll({
      attributes: ['stock_id', 'time', 'open', 'close', 'change_percent'],
      where: {
        stock_id: { [Op.in]: stockIds },
        time: {
          [Op.gte]: lookbackStart.toISOString(),
          [Op.lte]: `${tradeDate}T23:59:59Z`,
        },
      },
      raw: true,
    })) as unknown as Array<{
      stock_id: number;
      time: Date | string;
      open: number | string;
      close: number | string;
      change_percent: number | string | null;
    }>;

    const barsByStockId = new Map<
      number,
      Array<{
        timeMs: number;
        timeIso: string;
        open: number;
        close: number;
        change_percent: number | null;
      }>
    >();
    for (const b of bars) {
      const open = Number(b.open);
      const close = Number(b.close);
      if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
      const tMs = b.time instanceof Date ? b.time.getTime() : new Date(b.time).getTime();
      if (!Number.isFinite(tMs)) continue;
      const tIso =
        b.time instanceof Date ? b.time.toISOString().slice(0, 10) : String(b.time).slice(0, 10);
      const arr = barsByStockId.get(b.stock_id) ?? [];
      arr.push({
        timeMs: tMs,
        timeIso: tIso,
        open,
        close,
        change_percent:
          b.change_percent != null && Number.isFinite(Number(b.change_percent))
            ? Number(b.change_percent)
            : null,
      });
      barsByStockId.set(b.stock_id, arr);
    }

    const out = new Map<string, LinkageQuote>();
    for (const [stockId, arr] of barsByStockId.entries()) {
      const code = idToCode.get(stockId);
      if (!code) continue;
      arr.sort((a, b) => a.timeMs - b.timeMs);
      const todayIdx = arr.findIndex(b => b.timeIso === tradeDate);
      if (todayIdx < 0) continue;
      const today = arr[todayIdx];
      const yesterdayIdx = todayIdx - 1;
      const dayBeforeIdx = todayIdx - 2;
      if (yesterdayIdx < 0) continue;
      const prevClose = arr[yesterdayIdx].close;
      if (!Number.isFinite(prevClose) || prevClose <= 0) continue;
      const yesterdayClose = arr[yesterdayIdx].close;
      const dayBeforeClose = dayBeforeIdx >= 0 ? arr[dayBeforeIdx].close : undefined;
      const changePct =
        today.change_percent != null
          ? today.change_percent / 100
          : (today.close - prevClose) / prevClose;
      const openGap = (today.open - prevClose) / prevClose;
      const yesterdayChange =
        dayBeforeClose != null && dayBeforeClose > 0
          ? (yesterdayClose - dayBeforeClose) / dayBeforeClose
          : arr[yesterdayIdx].change_percent != null
          ? arr[yesterdayIdx].change_percent! / 100
          : undefined;
      out.set(code, {
        open: today.open,
        close: today.close,
        prev_close: prevClose,
        change_pct: changePct,
        open_gap_pct: openGap,
        yesterday_close: yesterdayClose,
        day_before_yesterday_close: dayBeforeClose,
        yesterday_change_pct: yesterdayChange,
      });
    }
    return out;
  }

  async loadLimitUpStocksOnDate(tradeDate: string, stockCodes: string[]): Promise<Set<string>> {
    if (!stockCodes.length) return new Set();
    const rows = (await LimitUpStock.findAll({
      attributes: ['stock_code'],
      where: {
        trade_date: tradeDate,
        stock_code: { [Op.in]: stockCodes },
      },
      raw: true,
    })) as unknown as Array<{ stock_code: string }>;
    return new Set(rows.map(r => r.stock_code));
  }
}

const PRODUCTION_DATA_SOURCE: LinkageDataSource = new DefaultLinkageDataSource();

// ---------------------------------------------------------------------------
// 策略主体
// ---------------------------------------------------------------------------

export class LinkageStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'linkage_strategy',
    name: '行业联动',
    description:
      '识别行业内已有涨停龙头（涨幅 > 9%）后，在同行业内寻找流通市值 < 龙头、昨日涨幅 < 5%、今日开盘高开 < 3% 的"未启动"联动股；3 日内持有，止盈（涨停）/ 止损 / 次日大跌出场。',
    category: 'momentum',
    default_params: { ...DEFAULT_LINKAGE_PARAMS },
    enabled: true,
    risk_level: 'high',
    tags: ['短线', '联动', '题材扩散', '涨停', '事件驱动'],
    style: 'short_term_event_driven',
  };

  private readonly dataSource: LinkageDataSource;

  constructor(dataSource: LinkageDataSource = PRODUCTION_DATA_SOURCE) {
    super();
    this.dataSource = dataSource;
  }

  /**
   * QuantStrategy 抽象基类要求的 per-stock evaluate()。
   *
   * 本策略是组合级，不通过单股 pipeline 工作；这里返回一条信息性 'hold'
   * 信号，让 per-stock backtest engine 不至于崩溃，但调用方应当走
   * generateSignals(date) 来获得真正的调仓信号。
   */
  evaluate(context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    const latestClose = context.bars?.length ? context.bars[context.bars.length - 1].close : 0;
    return {
      strategy_key: this.definition.strategy_key,
      symbol: context.symbol,
      name: context.name,
      signal: 'hold',
      score: 0,
      confidence: 0,
      entry_price: latestClose,
      target_holding_days: this.definition.default_params.holdingDaysLimit,
      reasons: ['LinkageStrategy 是组合级策略，请使用 generateSignals(date) 获得调仓信号'],
      risk_flags: [],
      factors: {
        note: 'use_generateSignals_instead',
      },
    };
  }

  /**
   * 组合级调仓信号生成 — US-027 主入口。
   *
   * @param tradeDate ISO YYYY-MM-DD，当日交易日
   * @param options.params 覆盖 default_params 的部分字段
   * @param options.currentPositions 当前持仓（含 entry_date + entry_price）
   */
  async generateSignals(
    tradeDate: string,
    options: LinkageGenerateOptions = {}
  ): Promise<LinkageSignalsResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
      throw new Error(`generateSignals: invalid trade_date (expected YYYY-MM-DD): ${tradeDate}`);
    }
    const params = this.resolveParams(options.params);
    if (params.maxPositions <= 0) {
      throw new Error(`generateSignals: maxPositions must be > 0, got ${params.maxPositions}`);
    }
    const currentPositions = options.currentPositions ?? [];

    // === Step A: Exit 流程
    const exitResults = await this.evaluateExits(tradeDate, currentPositions, params);

    // === Step B: 入场流程 —— 涨停龙头识别 → 行业内候选池 → 5 维 AND 过滤 → 排序 → cap
    const entryEvaluation = await this.evaluateEntries(
      tradeDate,
      params,
      new Set(exitResults.signals.filter(s => s.signal === 'hold').map(s => s.stock_code))
    );

    // === Step C: target_positions = HOLD（保留）+ 新 BUY，cap 在 maxPositions
    const kept: LinkagePosition[] = [];
    const sellMap = new Map(exitResults.signals.map(s => [s.stock_code, s]));
    for (const pos of currentPositions) {
      const sig = sellMap.get(pos.stock_code);
      if (!sig) {
        kept.push(pos);
        continue;
      }
      if (sig.signal === 'sell') continue;
      kept.push(pos);
    }

    const remainingSlots = Math.max(0, params.maxPositions - kept.length);
    const buyCandidates = entryEvaluation.candidates.slice(0, remainingSlots);

    const buySignals: LinkageSignal[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      name: c.meta.name ?? null,
      industry: c.meta.industry ?? null,
      signal: 'buy',
      reason: `行业「${c.meta.industry}」龙头 ${c.leader.stock_code}（涨幅 ${(
        c.leader.change_pct * 100
      ).toFixed(2)}%）；联动候选昨日涨幅 ${((c.quote.yesterday_change_pct ?? 0) * 100).toFixed(
        2
      )}% / 开盘高开 ${(c.quote.open_gap_pct * 100).toFixed(2)}% / 流通市值 ${formatYi(
        c.meta.circulating_market_cap ?? 0
      )}亿 < 龙头 ${formatYi(c.leader.circulating_market_cap ?? 0)}亿`,
      reference_price: c.quote.close,
      open_gap_pct: c.quote.open_gap_pct,
      yesterday_change_pct: c.quote.yesterday_change_pct,
      leader_stock_code: c.leader.stock_code,
      circulating_market_cap: c.meta.circulating_market_cap ?? undefined,
      leader_market_cap: c.leader.circulating_market_cap ?? undefined,
    }));

    const newPositions: LinkagePosition[] = buyCandidates.map(c => ({
      stock_code: c.stock_code,
      entry_date: tradeDate,
      entry_price: c.quote.close,
      entry_industry: c.meta.industry ?? null,
      entry_leader_code: c.leader.stock_code,
    }));

    const targetPositions = [...kept, ...newPositions];
    const allSignals = [...exitResults.signals, ...buySignals];

    logger.info(
      `LinkageStrategy.generateSignals(${tradeDate}): ` +
        `limit_up=${entryEvaluation.filtered.limit_up_stock_count} ` +
        `hot_industries=${entryEvaluation.filtered.hot_industry_count} ` +
        `candidate_pool=${entryEvaluation.filtered.candidate_pool_size} ` +
        `eligible=${entryEvaluation.candidates.length} ` +
        `held_kept=${kept.length} buy=${buySignals.length} ` +
        `sell=${allSignals.filter(s => s.signal === 'sell').length} ` +
        `hold=${allSignals.filter(s => s.signal === 'hold').length}`
    );

    return {
      trade_date: tradeDate,
      target_positions: targetPositions,
      signals: allSignals,
      filtered: entryEvaluation.filtered,
      params,
      eligible_count: entryEvaluation.candidates.length,
      hot_industries: entryEvaluation.hotIndustries,
    };
  }

  // -------------------------------------------------------------------------
  // 内部步骤
  // -------------------------------------------------------------------------

  /** 入场候选过滤 + 排序，不做 cap（cap 在主流程里基于 remainingSlots 做） */
  private async evaluateEntries(
    tradeDate: string,
    params: LinkageParams,
    excludeStockCodes: Set<string>
  ): Promise<{
    candidates: Array<{
      stock_code: string;
      meta: LinkageCandidateMeta;
      quote: LinkageQuote;
      leader: LinkageLimitUpInfo;
    }>;
    filtered: LinkageFilteredStats;
    hotIndustries: Array<{
      industry: string;
      leader_stock_code: string;
      leader_change_pct: number;
    }>;
  }> {
    const filtered: LinkageFilteredStats = {
      limit_up_stock_count: 0,
      hot_industry_count: 0,
      candidate_pool_size: 0,
      fail_meta_missing: 0,
      fail_st: 0,
      fail_missing_quote: 0,
      fail_missing_yesterday: 0,
      fail_yesterday_change_too_high: 0,
      fail_open_gap_too_high: 0,
      fail_cap_not_below_leader: 0,
    };

    // 1) 拉当日所有涨停股，按行业归组
    const industryToLimitUpStocks = await this.dataSource.loadIndustryLimitUpStocks(tradeDate);
    const allLimitUpCodes = new Set<string>();
    for (const arr of industryToLimitUpStocks.values()) {
      for (const lu of arr) allLimitUpCodes.add(lu.stock_code);
    }
    filtered.limit_up_stock_count = allLimitUpCodes.size;

    if (industryToLimitUpStocks.size === 0) {
      return { candidates: [], filtered, hotIndustries: [] };
    }

    // 2) 识别热门行业 + 该行业龙头股（涨幅最大的涨停股；龙头股自身涨幅必须 > leaderMinChangePct）
    const hotIndustries: Array<{
      industry: string;
      leader: LinkageLimitUpInfo;
    }> = [];
    for (const [industry, luArr] of industryToLimitUpStocks.entries()) {
      // 行业内按涨幅降序，取第一只为龙头
      const sorted = [...luArr].sort((a, b) => b.change_pct - a.change_pct);
      const leader = sorted[0];
      if (leader.change_pct > params.leaderMinChangePct) {
        hotIndustries.push({ industry, leader });
      }
    }
    filtered.hot_industry_count = hotIndustries.length;

    const hotIndustriesPublic = hotIndustries.map(h => ({
      industry: h.industry,
      leader_stock_code: h.leader.stock_code,
      leader_change_pct: h.leader.change_pct,
    }));

    if (hotIndustries.length === 0) {
      return { candidates: [], filtered, hotIndustries: hotIndustriesPublic };
    }

    // 3) 拉每个热门行业的成份股（剔除涨停股）
    const industryNames = hotIndustries.map(h => h.industry);
    const constituents = await this.dataSource.loadIndustryConstituents(
      industryNames,
      allLimitUpCodes
    );

    // 候选池总规模 + 收集所有候选代码
    const allCandidates: Array<{ meta: LinkageCandidateMeta; leader: LinkageLimitUpInfo }> = [];
    for (const h of hotIndustries) {
      const members = constituents.get(h.industry) ?? [];
      for (const m of members) {
        if (excludeStockCodes.has(m.stock_code)) continue;
        allCandidates.push({ meta: m, leader: h.leader });
      }
    }
    filtered.candidate_pool_size = allCandidates.length;
    if (allCandidates.length === 0) {
      return { candidates: [], filtered, hotIndustries: hotIndustriesPublic };
    }

    // 4) 拉候选股 daily quotes（含 today + yesterday）
    const candidateCodes = [...new Set(allCandidates.map(c => c.meta.stock_code))];
    const quoteMap = await this.dataSource.loadDailyQuotes(tradeDate, candidateCodes);

    // 5) 5 维 AND 过滤
    const candidates: Array<{
      stock_code: string;
      meta: LinkageCandidateMeta;
      quote: LinkageQuote;
      leader: LinkageLimitUpInfo;
    }> = [];
    const seen = new Set<string>();
    for (const cand of allCandidates) {
      const code = cand.meta.stock_code;
      if (seen.has(code)) continue; // 同股票若同时归属多个热门行业只算一次
      seen.add(code);

      // 5.1 元数据 + 流通市值
      if (cand.meta.circulating_market_cap == null) {
        filtered.fail_meta_missing += 1;
        continue;
      }

      // 5.2 ST 提前过滤
      if (params.excludeST && cand.meta.name && isSTName(cand.meta.name)) {
        filtered.fail_st += 1;
        continue;
      }

      // 5.3 流通市值 < 龙头流通市值
      if (cand.leader.circulating_market_cap == null) {
        // 龙头自己缺市值，无法判定"小于龙头"——保守剔除
        filtered.fail_cap_not_below_leader += 1;
        continue;
      }
      if (cand.meta.circulating_market_cap >= cand.leader.circulating_market_cap) {
        filtered.fail_cap_not_below_leader += 1;
        continue;
      }

      // 5.4 daily quote
      const quote = quoteMap.get(code);
      if (!quote) {
        filtered.fail_missing_quote += 1;
        continue;
      }

      // 5.5 昨日涨幅
      if (quote.yesterday_change_pct == null || !Number.isFinite(quote.yesterday_change_pct)) {
        filtered.fail_missing_yesterday += 1;
        continue;
      }
      if (quote.yesterday_change_pct >= params.candidateMaxYesterdayChangePct) {
        filtered.fail_yesterday_change_too_high += 1;
        continue;
      }

      // 5.6 开盘高开
      if (!Number.isFinite(quote.open_gap_pct)) {
        filtered.fail_missing_quote += 1;
        continue;
      }
      if (quote.open_gap_pct >= params.candidateMaxOpenGapPct) {
        filtered.fail_open_gap_too_high += 1;
        continue;
      }

      candidates.push({
        stock_code: code,
        meta: cand.meta,
        quote,
        leader: cand.leader,
      });
    }

    // 6) 排序：龙头涨幅降序 → 候选自身流通市值升序（小盘优先弹性大）→ 候选 open_gap_pct 升序（高开小优先）→ stock_code 稳定 tie-break
    candidates.sort((a, b) => {
      if (a.leader.change_pct !== b.leader.change_pct) {
        return b.leader.change_pct - a.leader.change_pct;
      }
      const aCap = a.meta.circulating_market_cap ?? Number.POSITIVE_INFINITY;
      const bCap = b.meta.circulating_market_cap ?? Number.POSITIVE_INFINITY;
      if (aCap !== bCap) return aCap - bCap;
      if (a.quote.open_gap_pct !== b.quote.open_gap_pct) {
        return a.quote.open_gap_pct - b.quote.open_gap_pct;
      }
      return a.stock_code.localeCompare(b.stock_code);
    });

    return { candidates, filtered, hotIndustries: hotIndustriesPublic };
  }

  /** Exit 流程：对每只 currentPositions 计算 signal */
  private async evaluateExits(
    tradeDate: string,
    currentPositions: LinkagePosition[],
    params: LinkageParams
  ): Promise<{ signals: LinkageSignal[] }> {
    if (currentPositions.length === 0) return { signals: [] };

    const codes = currentPositions.map(p => p.stock_code);
    const [quotes, limitUpToday] = await Promise.all([
      this.dataSource.loadDailyQuotes(tradeDate, codes),
      this.dataSource.loadLimitUpStocksOnDate(tradeDate, codes),
    ]);

    const signals: LinkageSignal[] = [];
    for (const pos of currentPositions) {
      const quote = quotes.get(pos.stock_code);
      const holdingDays = naturalDaysBetween(pos.entry_date, tradeDate);

      // A. 持有 ≥ holdingDaysLimit → SELL（最高优先级）
      if (holdingDays >= params.holdingDaysLimit) {
        signals.push({
          stock_code: pos.stock_code,
          industry: pos.entry_industry ?? null,
          signal: 'sell',
          reason: `持有 ${holdingDays} 自然日 ≥ holdingDaysLimit(${params.holdingDaysLimit})，强制平仓`,
          reference_price: quote?.close,
        });
        continue;
      }

      // 缺当日行情数据 → 安全起见 HOLD（next day 会重新评估）
      if (!quote) {
        signals.push({
          stock_code: pos.stock_code,
          industry: pos.entry_industry ?? null,
          signal: 'hold',
          reason: '当日缺行情数据，HOLD 等下一交易日',
        });
        continue;
      }

      // B. 个股止损：(close - entry) / entry ≤ stopLossPct
      const pnlPct = (quote.close - pos.entry_price) / pos.entry_price;
      if (Number.isFinite(pnlPct) && pnlPct <= params.stopLossPct) {
        signals.push({
          stock_code: pos.stock_code,
          industry: pos.entry_industry ?? null,
          signal: 'sell',
          reason: `跌幅 ${(pnlPct * 100).toFixed(2)}% ≤ stopLossPct(${(
            params.stopLossPct * 100
          ).toFixed(2)}%)，止损`,
          reference_price: quote.close,
        });
        continue;
      }

      // C. 当日 hit 涨停 → SELL（联动已实现，止盈）；进场首日（holdingDays=0）也可触发
      if (limitUpToday.has(pos.stock_code)) {
        signals.push({
          stock_code: pos.stock_code,
          industry: pos.entry_industry ?? null,
          signal: 'sell',
          reason: `当日涨停（联动已实现），止盈 SELL`,
          reference_price: quote.close,
        });
        continue;
      }

      // D. 次日大跌：holdingDays >= 1 且 change_pct ≤ exitNextDayDropPct
      //    进场首日（holdingDays=0）不触发此判定（避免入场即被开盘高开后回落误平）
      if (
        holdingDays >= 1 &&
        Number.isFinite(quote.change_pct) &&
        quote.change_pct <= params.exitNextDayDropPct
      ) {
        signals.push({
          stock_code: pos.stock_code,
          industry: pos.entry_industry ?? null,
          signal: 'sell',
          reason: `次日跌幅 ${(quote.change_pct * 100).toFixed(2)}% ≤ exitNextDayDropPct(${(
            params.exitNextDayDropPct * 100
          ).toFixed(2)}%)，SELL`,
          reference_price: quote.close,
        });
        continue;
      }

      // E. 都不触发 → HOLD
      signals.push({
        stock_code: pos.stock_code,
        industry: pos.entry_industry ?? null,
        signal: 'hold',
        reason: `继续持有（持有 ${holdingDays} 日，pnl=${(pnlPct * 100).toFixed(2)}%）`,
      });
    }

    return { signals };
  }

  /**
   * 合并 default_params + override。
   *
   * 全部标量参数，spread 合并安全（不踩 "spread merge 偷藏 default" 的坑）。
   */
  private resolveParams(override?: Partial<LinkageParams>): LinkageParams {
    const def = this.definition.default_params as Required<LinkageParams>;
    return {
      maxPositions: override?.maxPositions ?? def.maxPositions,
      leaderMinChangePct: override?.leaderMinChangePct ?? def.leaderMinChangePct,
      candidateMaxYesterdayChangePct:
        override?.candidateMaxYesterdayChangePct ?? def.candidateMaxYesterdayChangePct,
      candidateMaxOpenGapPct: override?.candidateMaxOpenGapPct ?? def.candidateMaxOpenGapPct,
      holdingDaysLimit: override?.holdingDaysLimit ?? def.holdingDaysLimit,
      exitNextDayDropPct: override?.exitNextDayDropPct ?? def.exitNextDayDropPct,
      stopLossPct: override?.stopLossPct ?? def.stopLossPct,
      excludeST: override?.excludeST ?? def.excludeST,
    };
  }
}

// ---------------------------------------------------------------------------
// 内部 helpers（仅本文件 + .test.ts 复用）
// ---------------------------------------------------------------------------

/** 自然日差（不算交易日，简单 ISO 日期相减）。entry=tradeDate 时返回 0 */
export function naturalDaysBetween(entryDate: string, tradeDate: string): number {
  const a = new Date(`${entryDate}T00:00:00Z`).getTime();
  const b = new Date(`${tradeDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  const diff = (b - a) / (1000 * 60 * 60 * 24);
  return Math.max(0, Math.round(diff));
}

/** 元 → 亿 简化显示（reason 字符串用） */
function formatYi(amountInYuan: number): string {
  if (!Number.isFinite(amountInYuan)) return '0';
  return (amountInYuan / 1e8).toFixed(2);
}

function stripSuffix(symbol: string | null | undefined): string {
  if (!symbol) return '';
  const i = symbol.indexOf('.');
  return i < 0 ? symbol : symbol.slice(0, i);
}

function guessStockSymbol(stockCode: string): string {
  if (!stockCode) return '';
  if (stockCode.includes('.')) return stockCode;
  const head = stockCode[0];
  if (head === '6') return `${stockCode}.SH`;
  if (head === '0' || head === '3') return `${stockCode}.SZ`;
  if (head === '4' || head === '8') return `${stockCode}.BJ`;
  return `${stockCode}.SZ`;
}

/**
 * ST 名称判定 — 重新导出自 `backend/src/utils/stNameUtils.ts`（US-025 抽取）。
 * 任何判定逻辑变更只改共享模块。
 */
export { isSTName };
