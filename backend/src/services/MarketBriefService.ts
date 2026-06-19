import axios from 'axios';
import { Op, fn, col } from 'sequelize';
import moment from 'moment-timezone';
import { logger } from '../utils/logger';
import { MarketBrief } from '../models/MarketBrief';
import { DailyBar } from '../models/DailyBar';
import { Stock } from '../models/Stock';
import { LimitUpStock } from '../models/LimitUpStock';
import { NorthboundHolding } from '../models/NorthboundHolding';

/**
 * MarketBriefService — US-073 AI 大盘速读卡片日度生成。
 *
 * 每个交易日 08:30（开盘前 30 分钟）由 SchedulerService 触发
 * `marketBriefService.computeAndPersist()` 计算并写入 `market_briefs` 表。
 * 前端 TodayWorkspace 通过 `GET /api/ai/market-brief/today` 拿到当日卡片数据。
 *
 * **AC 5 维数据汇聚**：
 *   - prev_close              上日收盘指数（沪深300基准 sh.000300）；
 *   - today_open              今日开盘指数（同基准）；
 *   - northbound_net_amount   昨日北向资金净买入（hold_value_change_1d 全市场 sum / 1e8 转亿）；
 *   - limit_up_count          昨日全市场涨停数（LimitUpStock 行数）；
 *   - ai_view                 TradingAgents 一句话观点（含 trade_date + 4 维原始值喂 prompt）；
 *
 * **设计参考** （与 MarketSentimentIndex US-057 / StrategyCopilotService US-062 同款）：
 *
 *   - **DataSource DI** (8 项 AI feature checklist 之 1)：
 *     接口 `MarketBriefDataSource` 暴露 6 方法
 *     (loadPrevClose / loadTodayOpen / loadNorthboundNet / loadLimitUpCount /
 *      callRemoteAIView / saveBrief)；
 *     Default impl 走 DB + TradingAgents axios；
 *     生产 `PRODUCTION_MARKET_BRIEF_DATA_SOURCE` singleton；
 *     单测注入 fake source 完全脱 DB / 网络。
 *
 *   - **8+ 纯函数全 export** (mean / buildBriefSummary / buildPromptForAI /
 *     normalizeTodayIso / pickAIViewFromPayload / parsePctChange) 让单测覆盖
 *     NaN / 边界 / 已知数值 / fail-OPEN 路径。
 *
 *   - **plain-object 返回类型** `MarketBriefResult` 兼容 persist=true 与
 *     dry_run=true 同款形态（与 US-037 OptimizationResultRecord / US-055
 *     AnalyzeSingleStockResult / US-057 MarketSentimentIndexResult 一致）。
 *
 *   - **status='partial' 仍正常 persist**: 某一维度数据缺失（北向接口当日未 sync /
 *     基准指数当日还未开盘）不阻塞写入，写 status='partial' + components_json 标
 *     注哪些维度缺失。完全缺失 (5 维度全空) 写 status='failed' 仍 persist 让 ops
 *     看到曾尝试。
 *
 *   - **fail-OPEN on callRemoteAIView**: TradingAgents 故障不阻塞主流程，转
 *     heuristic_fallback 兜底（基于已有 4 维 raw 值拼一句中文观点）。`nlp_engine`
 *     字段标记是 trading_agents 还是 heuristic_fallback，UI 可显示来源。
 *
 *   - **fail-OPEN on saveBrief**: DB 故障转 warning 返回 persisted=false 让 caller
 *     仍能拿到 brief 数据（与 US-055 / US-057 同款）。
 *
 *   - **缓存策略**: 读路径 `getTodayBrief()` 优先 read DB cache（一日一行）；
 *     若当日尚未生成，**懒求值** 触发一次 `computeAndPersist()` 同步生成并返回。
 *     这样 SchedulerService 08:30 cron miss（机器重启/cron 失效）时前端首次访问仍能
 *     拿到数据，而不是空 200。**今日已生成则直接读 cache 不重复触发**。
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// audit L-19: 集中常量, 不再硬编码 IP.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TRADING_AGENTS_BASE_URL } = require('../config/externalServices');
const TRADING_AGENTS_URL = TRADING_AGENTS_BASE_URL;

/** AI 一句话观点的远端 axios timeout */
export const REMOTE_TIMEOUT_MS = 30_000;

/**
 * AI 一句话观点字符上限 (US-043 / FE-004 验收: ≤ 150 字).
 *
 * 同时作用于:
 *   - buildPromptForAI: 显式告知远端 LLM 上限;
 *   - pickAIViewFromPayload: 远端违约超出时 hard-cap 截断 (防御 fail-OPEN);
 *   - buildHeuristicAIView: 启发式拼装也 hard-cap (兜底自洽).
 *
 * 数值与前端 MarketBriefCard 渲染时的截断常量同源 (frontend 用同一阈值, 不会展示不同上限).
 */
export const AI_VIEW_MAX_CHARS = 150;

/** 基准指数 symbol（沪深300 — AC 描述"今日开盘"） */
export const BENCHMARK_SYMBOL = 'sh.000300';

/** NLP 引擎标签 (与 US-061 / US-062 同款) */
export const NLP_ENGINES = Object.freeze({
  TRADING_AGENTS: 'trading_agents' as const,
  HEURISTIC: 'heuristic_fallback' as const,
});

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface MarketBriefOptions {
  /** 覆盖 as-of 日期 YYYY-MM-DD；缺省 = 今天（Asia/Shanghai）  */
  trade_date?: string;
  /** dry_run=true 不写表 */
  dry_run?: boolean;
  /** 远端 AI 调用是否跳过（单测 / dry-run 加速）；默认 false */
  skip_ai?: boolean;
}

export interface MarketBriefComponents {
  /** 上日收盘 / 今日开盘 / 涨跌幅 */
  benchmark: {
    symbol: string;
    prev_close: number | null;
    today_open: number | null;
    open_change_pct: number | null;
    error: string | null;
  };
  /** 昨日北向资金净买入（亿元） */
  northbound: {
    net_amount_yi: number | null;
    sample_count: number;
    error: string | null;
  };
  /** 昨日涨停数 */
  limit_up: {
    count: number | null;
    error: string | null;
  };
  /** AI 一句话观点来源 */
  ai_view: {
    engine: string | null;
    error: string | null;
  };
}

export interface MarketBriefResult {
  trade_date: string;
  prev_close: number | null;
  today_open: number | null;
  open_change_pct: number | null;
  northbound_net_amount: number | null;
  limit_up_count: number | null;
  ai_view: string | null;
  nlp_engine: string | null;
  status: 'ok' | 'partial' | 'failed';
  message: string;
  components: MarketBriefComponents;
  /** 已写入 DB */
  persisted: boolean;
  /** dry_run 模式 */
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
// DataSource 接口
// ---------------------------------------------------------------------------

/** 远端 TradingAgents /api/market-brief 的 payload 形态 (类似 /api/strategy-copilot) */
export interface RemoteMarketBriefPayload {
  status?: string;
  data?: {
    view?: string;
    summary?: string;
    text?: string;
    error?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface MarketBriefDataSource {
  /** 取基准指数上一交易日收盘价（time 严格 < tradeDate 的最近一行） */
  loadPrevClose(tradeDate: string, benchmarkSymbol: string): Promise<number | null>;
  /** 取基准指数当日开盘价（time == tradeDate 的那行，无则 null） */
  loadTodayOpen(tradeDate: string, benchmarkSymbol: string): Promise<number | null>;
  /**
   * 取上一交易日的北向资金全市场净买入（hold_value_change_1d sum / 1e8）。
   * 注：northbound 数据是"截至上交易日"快照，故取 < tradeDate 的最近一日。
   */
  loadNorthboundNet(
    tradeDate: string
  ): Promise<{ net_amount_yi: number | null; sample_count: number }>;
  /** 取上一交易日的全市场涨停数（LimitUpStock 行数） */
  loadLimitUpCount(tradeDate: string): Promise<number | null>;
  /** 调用远端 TradingAgents 生成一句话观点；失败返回 status='FAILED' payload */
  callRemoteAIView(prompt: string): Promise<RemoteMarketBriefPayload>;
  /** 写入 / 覆盖一行 MarketBrief */
  saveBrief(record: MarketBriefRecord): Promise<void>;
}

export interface MarketBriefRecord {
  trade_date: string;
  prev_close: number | null;
  today_open: number | null;
  open_change_pct: number | null;
  northbound_net_amount: number | null;
  limit_up_count: number | null;
  ai_view: string | null;
  nlp_engine: string | null;
  components_json: Record<string, unknown>;
  status: 'ok' | 'partial' | 'failed';
  message: string;
}

// ---------------------------------------------------------------------------
// pure helpers (全部 export 供单测覆盖)
// ---------------------------------------------------------------------------

/** 标准化日期 ISO（YYYY-MM-DD），无效返回 null */
export function normalizeDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** 取今日 Asia/Shanghai 日期 ISO */
export function todayShanghaiIso(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

/** 计算开盘 vs 上日收盘涨跌幅 (%)。input null 返回 null（不假设 0） */
export function parsePctChange(today: number | null, prev: number | null): number | null {
  if (today == null || prev == null) return null;
  if (!Number.isFinite(today) || !Number.isFinite(prev) || prev === 0) return null;
  return ((today - prev) / prev) * 100;
}

/** 安全 round（NaN/Inf 透传 null） */
export function safeRound(value: number | null, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const base = 10 ** digits;
  return Math.round(value * base) / base;
}

/**
 * 喂 TradingAgents 的 prompt（中文）—— 让远端给出一句话大盘观点。
 *
 * 模板顺序固定，方便后续 prompt tuning 对比。
 */
export function buildPromptForAI(ctx: {
  trade_date: string;
  prev_close: number | null;
  today_open: number | null;
  open_change_pct: number | null;
  northbound_net_yi: number | null;
  limit_up_count: number | null;
}): string {
  const lines = [
    `你是一名 A 股市场每日早盘速读编辑。请基于以下数据，用 1-2 句简短中文给出当日大盘观点（不超过 ${AI_VIEW_MAX_CHARS} 字, 越精炼越好, 目标 60-100 字）。`,
    '只输出观点本身，不要加 "观点：" 等前缀。',
    `日期：${ctx.trade_date}`,
    `沪深300 上日收盘：${ctx.prev_close ?? '—'}`,
    `沪深300 今日开盘：${ctx.today_open ?? '—'}`,
    `开盘涨跌幅：${ctx.open_change_pct == null ? '—' : ctx.open_change_pct.toFixed(2) + '%'}`,
    `昨日北向资金净买入：${
      ctx.northbound_net_yi == null ? '—' : ctx.northbound_net_yi.toFixed(2) + ' 亿元'
    }`,
    `昨日全市场涨停数：${ctx.limit_up_count ?? '—'}`,
  ];
  return lines.join('\n');
}

/** 从远端 payload 抓取 ai view 文本（兼容 view / summary / text 三种字段命名）。
 *  超出 AI_VIEW_MAX_CHARS (150 字, AC) 时硬截断 — 远端 LLM 违约也不会撑爆 UI. */
export function pickAIViewFromPayload(payload: RemoteMarketBriefPayload): string | null {
  const statusRaw = String(payload?.status || '').toUpperCase();
  if (statusRaw === 'FAILED') return null;
  const data = payload?.data || {};
  const view = data.view || data.summary || data.text || '';
  const trimmed = String(view || '').trim();
  if (!trimmed) return null;
  return trimmed.length > AI_VIEW_MAX_CHARS ? trimmed.slice(0, AI_VIEW_MAX_CHARS) : trimmed;
}

/**
 * 启发式 fallback 一句话观点 —— TradingAgents 失败时仍能给用户看到合理的一句中文。
 *
 * 判定逻辑（按重要度排序）：
 *   1. 开盘涨跌幅强势（≥ +1%）→ "高开 / 多头氛围"；弱势（≤ -1%）→ "低开 / 谨慎"；
 *   2. 北向资金净买入 ≥ 30 亿 → 叠加"北向继续流入"；≤ -30 亿 → 叠加"北向资金离场"；
 *   3. 涨停数 ≥ 80 → 叠加"赚钱效应强"；≤ 30 → 叠加"赚钱效应弱"。
 *
 * 输出形如："沪深300 高开 +1.20%，北向继续流入，赚钱效应强"。
 * 完全无数据时输出 "今日大盘数据待补，请稍后刷新"。
 */
export function buildHeuristicAIView(ctx: {
  open_change_pct: number | null;
  northbound_net_yi: number | null;
  limit_up_count: number | null;
}): string {
  const parts: string[] = [];

  const pct = ctx.open_change_pct;
  if (pct != null && Number.isFinite(pct)) {
    let tone = '小幅';
    if (pct >= 1) tone = '强势高开';
    else if (pct <= -1) tone = '弱势低开';
    else if (pct > 0) tone = '小幅高开';
    else if (pct < 0) tone = '小幅低开';
    else tone = '平开';
    parts.push(`沪深300 ${tone}${pct >= 0 ? ' +' : ' '}${pct.toFixed(2)}%`);
  }

  const nb = ctx.northbound_net_yi;
  if (nb != null && Number.isFinite(nb)) {
    if (nb >= 30) parts.push('北向继续流入');
    else if (nb <= -30) parts.push('北向资金离场');
    else if (nb > 0) parts.push('北向小幅流入');
    else if (nb < 0) parts.push('北向小幅流出');
  }

  const lu = ctx.limit_up_count;
  if (lu != null && Number.isFinite(lu)) {
    if (lu >= 80) parts.push('赚钱效应强');
    else if (lu <= 30) parts.push('赚钱效应弱');
  }

  if (parts.length === 0) {
    return '今日大盘数据待补，请稍后刷新';
  }
  const joined = parts.join('，');
  // 启发式 fallback 也守 AI_VIEW_MAX_CHARS — 维度未来扩到 5+ 段时不会撑爆 UI.
  return joined.length > AI_VIEW_MAX_CHARS ? joined.slice(0, AI_VIEW_MAX_CHARS) : joined;
}

/** 构造人类可读中文摘要（saveBrief.message 字段） */
export function buildBriefSummary(ctx: {
  trade_date: string;
  prev_close: number | null;
  today_open: number | null;
  open_change_pct: number | null;
  northbound_net_yi: number | null;
  limit_up_count: number | null;
  status: 'ok' | 'partial' | 'failed';
}): string {
  const pieces: string[] = [`大盘速读 ${ctx.trade_date}`];
  if (ctx.prev_close != null) pieces.push(`上日收盘 ${ctx.prev_close.toFixed(2)}`);
  if (ctx.today_open != null) {
    if (ctx.open_change_pct != null) {
      pieces.push(
        `今日开盘 ${ctx.today_open.toFixed(2)} (${
          ctx.open_change_pct >= 0 ? '+' : ''
        }${ctx.open_change_pct.toFixed(2)}%)`
      );
    } else {
      pieces.push(`今日开盘 ${ctx.today_open.toFixed(2)}`);
    }
  }
  if (ctx.northbound_net_yi != null) {
    pieces.push(
      `北向${ctx.northbound_net_yi >= 0 ? '净流入' : '净流出'} ${Math.abs(
        ctx.northbound_net_yi
      ).toFixed(2)} 亿`
    );
  }
  if (ctx.limit_up_count != null) {
    pieces.push(`涨停 ${ctx.limit_up_count} 家`);
  }
  if (ctx.status === 'partial') pieces.push('(部分数据待补)');
  if (ctx.status === 'failed') pieces.push('(数据全部缺失)');
  return pieces.join(' · ');
}

// ---------------------------------------------------------------------------
// Default DataSource —— 走 DB + TradingAgents 真实远端
// ---------------------------------------------------------------------------

class DefaultMarketBriefDataSource implements MarketBriefDataSource {
  async loadPrevClose(tradeDate: string, benchmarkSymbol: string): Promise<number | null> {
    const stock = await Stock.findOne({ where: { symbol: benchmarkSymbol } });
    if (!stock) return null;
    const bar = await DailyBar.findOne({
      where: {
        stock_id: stock.id,
        time: { [Op.lt]: new Date(`${tradeDate}T00:00:00.000Z`) },
      },
      order: [['time', 'DESC']],
    });
    if (!bar) return null;
    const v = Number(bar.close);
    return Number.isFinite(v) ? v : null;
  }

  async loadTodayOpen(tradeDate: string, benchmarkSymbol: string): Promise<number | null> {
    const stock = await Stock.findOne({ where: { symbol: benchmarkSymbol } });
    if (!stock) return null;
    const bar = await DailyBar.findOne({
      where: {
        stock_id: stock.id,
        time: {
          [Op.gte]: new Date(`${tradeDate}T00:00:00.000Z`),
          [Op.lte]: new Date(`${tradeDate}T23:59:59.999Z`),
        },
      },
      order: [['time', 'ASC']],
    });
    if (!bar) return null;
    const v = Number(bar.open);
    return Number.isFinite(v) ? v : null;
  }

  async loadNorthboundNet(
    tradeDate: string
  ): Promise<{ net_amount_yi: number | null; sample_count: number }> {
    // 北向数据是"截至上一交易日"快照；找 < tradeDate 的最近一日
    const latest = (await NorthboundHolding.findOne({
      where: { trade_date: { [Op.lt]: tradeDate } },
      order: [['trade_date', 'DESC']],
      attributes: ['trade_date'],
    })) as NorthboundHolding | null;
    if (!latest) return { net_amount_yi: null, sample_count: 0 };

    // 全市场聚合 sum(hold_amount) 的"变化"无法直接拿到（model 没有 change 列），
    // 退而求其次：使用最新 trade_date 与上一 trade_date 的 hold_amount 全市场差值
    // 作为"昨日净买入"代理。若上一日数据也不全则返回 null。
    const prevDay = (await NorthboundHolding.findOne({
      where: { trade_date: { [Op.lt]: latest.trade_date } },
      order: [['trade_date', 'DESC']],
      attributes: ['trade_date'],
    })) as NorthboundHolding | null;
    if (!prevDay) return { net_amount_yi: null, sample_count: 0 };

    const [latestSum, prevSum] = (await Promise.all([
      NorthboundHolding.findOne({
        where: { trade_date: latest.trade_date },
        attributes: [
          [fn('SUM', col('hold_amount')), 'total'],
          [fn('COUNT', col('stock_code')), 'cnt'],
        ],
        raw: true,
      }),
      NorthboundHolding.findOne({
        where: { trade_date: prevDay.trade_date },
        attributes: [[fn('SUM', col('hold_amount')), 'total']],
        raw: true,
      }),
    ])) as Array<{ total?: number | string; cnt?: number | string } | null>;

    const latestTotal = Number(latestSum?.total ?? NaN);
    const prevTotal = Number(prevSum?.total ?? NaN);
    if (!Number.isFinite(latestTotal) || !Number.isFinite(prevTotal)) {
      return { net_amount_yi: null, sample_count: Number(latestSum?.cnt ?? 0) };
    }
    const deltaYuan = latestTotal - prevTotal;
    return {
      net_amount_yi: deltaYuan / 1e8,
      sample_count: Number(latestSum?.cnt ?? 0),
    };
  }

  async loadLimitUpCount(tradeDate: string): Promise<number | null> {
    // 上一交易日涨停数 (LimitUpStock 行数, trade_date < tradeDate 取最近一日)
    const latest = (await LimitUpStock.findOne({
      where: { trade_date: { [Op.lt]: tradeDate } },
      order: [['trade_date', 'DESC']],
      attributes: ['trade_date'],
    })) as LimitUpStock | null;
    if (!latest) return null;
    const cnt = await LimitUpStock.count({ where: { trade_date: latest.trade_date } });
    return cnt;
  }

  async callRemoteAIView(prompt: string): Promise<RemoteMarketBriefPayload> {
    try {
      const response = await axios.post(
        `${TRADING_AGENTS_URL}/api/market-brief`,
        { prompt, target: 'market_brief_one_liner' },
        { timeout: REMOTE_TIMEOUT_MS }
      );
      return response.data as RemoteMarketBriefPayload;
    } catch (error) {
      const msg = (error as Error).message || String(error);
      logger.warn(`MarketBriefService callRemoteAIView failed: ${msg} — falling back to heuristic`);
      return { status: 'FAILED', data: { error: msg } };
    }
  }

  async saveBrief(record: MarketBriefRecord): Promise<void> {
    const existing = await MarketBrief.findOne({ where: { trade_date: record.trade_date } });
    if (existing) {
      await existing.update(record);
    } else {
      await MarketBrief.create(record as Partial<MarketBrief>);
    }
  }
}

/** 生产环境 singleton */
export const PRODUCTION_MARKET_BRIEF_DATA_SOURCE: MarketBriefDataSource =
  new DefaultMarketBriefDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MarketBriefService {
  constructor(
    private readonly dataSource: MarketBriefDataSource = PRODUCTION_MARKET_BRIEF_DATA_SOURCE
  ) {}

  /**
   * 主流程：聚合 5 维数据 + 调远端 AI view + 写表。
   *
   * 失败语义：
   *   - 任一数据维度失败（DB / 接口）走 fail-OPEN 返回 null + components.<x>.error 标注；
   *   - 远端 AI 失败走 heuristic_fallback；
   *   - 写表失败转 warning + persisted=false（caller 仍能拿到 result）。
   */
  async computeAndPersist(options: MarketBriefOptions = {}): Promise<MarketBriefResult> {
    const tradeDate = options.trade_date || todayShanghaiIso();
    const dryRun = !!options.dry_run;
    const skipAI = !!options.skip_ai;

    // 1) 4 维 raw 数据并发拉取，每维独立 safeAwait 失败不阻塞
    const [prevCloseResult, todayOpenResult, northboundResult, limitUpResult] = await Promise.all([
      safeAwait(this.dataSource.loadPrevClose(tradeDate, BENCHMARK_SYMBOL), null),
      safeAwait(this.dataSource.loadTodayOpen(tradeDate, BENCHMARK_SYMBOL), null),
      safeAwait(this.dataSource.loadNorthboundNet(tradeDate), {
        net_amount_yi: null,
        sample_count: 0,
      }),
      safeAwait(this.dataSource.loadLimitUpCount(tradeDate), null),
    ]);

    const prevClose = prevCloseResult.value;
    const todayOpen = todayOpenResult.value;
    const openChangePct = parsePctChange(todayOpen, prevClose);
    const nbNet = northboundResult.value.net_amount_yi;
    const luCount = limitUpResult.value;

    // 2) 构造 AI prompt + 远端调用 / heuristic fallback
    const promptCtx = {
      trade_date: tradeDate,
      prev_close: prevClose,
      today_open: todayOpen,
      open_change_pct: openChangePct,
      northbound_net_yi: nbNet,
      limit_up_count: luCount,
    };
    let aiView: string | null = null;
    let nlpEngine: string | null = null;
    let aiError: string | null = null;
    if (!skipAI) {
      try {
        const prompt = buildPromptForAI(promptCtx);
        const payload = await this.dataSource.callRemoteAIView(prompt);
        const remote = pickAIViewFromPayload(payload);
        if (remote) {
          aiView = remote;
          nlpEngine = NLP_ENGINES.TRADING_AGENTS;
        } else {
          aiView = buildHeuristicAIView(promptCtx);
          nlpEngine = NLP_ENGINES.HEURISTIC;
          aiError = String(payload?.data?.error || '远端未返回有效观点');
        }
      } catch (err) {
        aiView = buildHeuristicAIView(promptCtx);
        nlpEngine = NLP_ENGINES.HEURISTIC;
        aiError = (err as Error).message || String(err);
      }
    } else {
      aiView = buildHeuristicAIView(promptCtx);
      nlpEngine = NLP_ENGINES.HEURISTIC;
    }

    // 3) 计算 status
    const errorFlags = [
      prevCloseResult.error || prevClose == null,
      todayOpenResult.error || todayOpen == null,
      northboundResult.error || nbNet == null,
      limitUpResult.error || luCount == null,
    ];
    const failedCount = errorFlags.filter(Boolean).length;
    let status: 'ok' | 'partial' | 'failed';
    if (failedCount === 4) status = 'failed';
    else if (failedCount > 0) status = 'partial';
    else status = 'ok';

    // 4) 拼 components + summary message
    const components: MarketBriefComponents = {
      benchmark: {
        symbol: BENCHMARK_SYMBOL,
        prev_close: safeRound(prevClose, 4),
        today_open: safeRound(todayOpen, 4),
        open_change_pct: safeRound(openChangePct, 4),
        error: prevCloseResult.error || todayOpenResult.error,
      },
      northbound: {
        net_amount_yi: safeRound(nbNet, 4),
        sample_count: northboundResult.value.sample_count,
        error: northboundResult.error,
      },
      limit_up: {
        count: luCount,
        error: limitUpResult.error,
      },
      ai_view: {
        engine: nlpEngine,
        error: aiError,
      },
    };
    const message = buildBriefSummary({
      trade_date: tradeDate,
      prev_close: components.benchmark.prev_close,
      today_open: components.benchmark.today_open,
      open_change_pct: components.benchmark.open_change_pct,
      northbound_net_yi: components.northbound.net_amount_yi,
      limit_up_count: components.limit_up.count,
      status,
    });

    const record: MarketBriefRecord = {
      trade_date: tradeDate,
      prev_close: components.benchmark.prev_close,
      today_open: components.benchmark.today_open,
      open_change_pct: components.benchmark.open_change_pct,
      northbound_net_amount: components.northbound.net_amount_yi,
      limit_up_count: components.limit_up.count,
      ai_view: aiView,
      nlp_engine: nlpEngine,
      components_json: components as unknown as Record<string, unknown>,
      status,
      message,
    };

    // 5) persist（dry_run / 失败均不阻塞）
    let persisted = false;
    if (!dryRun) {
      try {
        await this.dataSource.saveBrief(record);
        persisted = true;
      } catch (error) {
        logger.warn(
          `MarketBriefService.saveBrief(${tradeDate}) failed: ${
            (error as Error).message
          } — returning result anyway`
        );
      }
    }

    return {
      ...record,
      components,
      persisted,
      dry_run: dryRun,
    };
  }

  /**
   * 读取当日 brief。
   *
   * 顺序：
   *   1. 查 DB 是否已有当日记录 → 有则直接 model→result 转换返回；
   *   2. 无则触发 `computeAndPersist` 懒生成（带 8:30 cron miss / 首次访问兜底）。
   *
   * 调用方： `GET /api/ai/market-brief/today` controller。
   */
  async getTodayBrief(options: MarketBriefOptions = {}): Promise<MarketBriefResult> {
    const tradeDate = options.trade_date || todayShanghaiIso();
    const existing = await MarketBrief.findOne({ where: { trade_date: tradeDate } });
    if (existing) {
      return briefModelToResult(existing);
    }
    return this.computeAndPersist({ ...options, trade_date: tradeDate });
  }

  /**
   * 列表查询：最近 N 天的速读（前端可选历史回看）。
   *
   * @param days 默认 7, 上限 90
   */
  async listRecentBriefs(days = 7): Promise<MarketBrief[]> {
    const limit = Math.max(1, Math.min(90, Math.floor(days)));
    return MarketBrief.findAll({
      order: [['trade_date', 'DESC']],
      limit,
    });
  }
}

/** 生产环境 singleton */
export const marketBriefService = new MarketBriefService();

// ---------------------------------------------------------------------------
// 私有 helpers
// ---------------------------------------------------------------------------

/** 包装 Promise，失败时返回 {value: fallback, error: msg}；成功 {value, error: null} */
async function safeAwait<T>(
  p: Promise<T>,
  fallback: T
): Promise<{ value: T; error: string | null }> {
  try {
    const v = await p;
    return { value: v, error: null };
  } catch (e) {
    return { value: fallback, error: (e as Error).message };
  }
}

/** Model → Result 转换（getTodayBrief 命中 cache 时用） */
function briefModelToResult(model: MarketBrief): MarketBriefResult {
  const componentsRaw = model.components_json || {};
  const components: MarketBriefComponents = {
    benchmark: ((componentsRaw as Record<string, unknown>)
      .benchmark as MarketBriefComponents['benchmark']) || {
      symbol: BENCHMARK_SYMBOL,
      prev_close: model.prev_close == null ? null : Number(model.prev_close),
      today_open: model.today_open == null ? null : Number(model.today_open),
      open_change_pct: model.open_change_pct == null ? null : Number(model.open_change_pct),
      error: null,
    },
    northbound: ((componentsRaw as Record<string, unknown>)
      .northbound as MarketBriefComponents['northbound']) || {
      net_amount_yi:
        model.northbound_net_amount == null ? null : Number(model.northbound_net_amount),
      sample_count: 0,
      error: null,
    },
    limit_up: ((componentsRaw as Record<string, unknown>)
      .limit_up as MarketBriefComponents['limit_up']) || {
      count: model.limit_up_count,
      error: null,
    },
    ai_view: ((componentsRaw as Record<string, unknown>)
      .ai_view as MarketBriefComponents['ai_view']) || {
      engine: model.nlp_engine,
      error: null,
    },
  };
  return {
    trade_date: model.trade_date,
    prev_close: model.prev_close == null ? null : Number(model.prev_close),
    today_open: model.today_open == null ? null : Number(model.today_open),
    open_change_pct: model.open_change_pct == null ? null : Number(model.open_change_pct),
    northbound_net_amount:
      model.northbound_net_amount == null ? null : Number(model.northbound_net_amount),
    limit_up_count: model.limit_up_count,
    ai_view: model.ai_view,
    nlp_engine: model.nlp_engine,
    status: model.status,
    message: model.message || '',
    components,
    persisted: true,
    dry_run: false,
  };
}
