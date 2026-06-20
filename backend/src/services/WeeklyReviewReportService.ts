/**
 * WeeklyReviewReportService — US-065 邮件周度策略复盘报告
 *
 * 每周一 08:00（北京时间）给所有 notification_channels.email.enabled=true 且
 * email.weekly_review=true 的用户发送上周（周一-周日，按上海时区）的策略复盘
 * HTML 邮件，覆盖：
 *   1. **上周净值曲线** —— 内嵌 inline SVG sparkline（无外部 PNG / chart-png 依赖
 *      —— SVG 直接落到 HTML body 里所有主流邮箱客户端都能渲染）
 *   2. **各策略贡献** —— 按持仓股 industry 聚合上周已实现 PnL（trade 表无
 *      strategy_key 字段，以行业作为最近似的"策略分组"代理；与 IndustryAttribution
 *      service 复用同款 industry 维度）
 *   3. **行业归因** —— 同 #2 但以行业排序前 5 / 后 3
 *   4. **本周关注事件** —— 即将公告的业绩预告 + 即将解禁 / 财报披露（复用
 *      EarningsForecastWatcher 的 forecast loader 即可）
 *   5. **AI 周观点** —— 启发式生成（不强依赖远端 AI；AC 字面是"AI 周观点"
 *      但 fail-OPEN：远端不可达则走启发式 narrative 兜底，同 US-061 双路范式）
 *
 * 完全遵循 US-063 引入的 8 项推送类 service checklist：
 *   (1) `User.risk_config.notification_channels.email.*` JSONB namespace 共享
 *       （与 feishu / wechat 并列；与 position_limits / trailing_stop 并列；
 *       复用 US-063 normalizeNotificationConfig + .changed('risk_config', true)
 *       mutation 模式）
 *   (2) `normalizeWeeklyReviewConfig` 静默退回默认（用户改坏不让 4xx）
 *   (3) `shouldSendWeeklyReviewForUser` 3 路径 gate（通道关 / 周报关 / 缺地址）
 *   (4) `EmailNotificationService.sendEmail(payload, addr, {buildEmail})` 注入式
 *       channel adapter —— 本 service 调用方，buildEmail helper 在本文件
 *   (5) per-user 串行 await + per-user try/catch fail-OPEN
 *   (6) `dry_run=true` 选项让 UI 预演 + Modal.confirm 二次确认推送
 *   (7) 业务 ID `WEEKLY-{user_id}-{YYYYMMDD}-{rand4}` 与 US-055 命名范式一致
 *   (8) scheduler cron + manual trigger 双入口共用 service.sendWeeklyReviewReports()
 */

import moment from 'moment-timezone';
import { Op } from 'sequelize';

import { logger } from '../utils/logger';
import { User } from '../models/User';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { Stock } from '../models/Stock';
import { EarningsForecast } from '../models/EarningsForecast';
import { DailyBar } from '../models/DailyBar';
import { AIInvestmentSignal, AISignalSourceType } from '../models/AIInvestmentSignal';
import {
  normalizeNotificationConfig,
  NotificationChannelsConfig,
} from './DailyTradingDigestService';
import {
  emailNotificationService,
  EmailNotificationSendResult,
  EmailPayload,
} from './EmailNotificationService';

// ---------------------------------------------------------------------------
// 类型常量
// ---------------------------------------------------------------------------

export const WEEKLY_REVIEW_STATUS = Object.freeze({
  SENT: 'sent',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  PARTIAL: 'partial',
} as const);

export type WeeklyReviewStatus = (typeof WEEKLY_REVIEW_STATUS)[keyof typeof WEEKLY_REVIEW_STATUS];

/** 上周日期范围（周一 00:00 → 周日 23:59:59，按上海时区） */
export interface PrevWeekRange {
  /** 上周一 (YYYY-MM-DD) */
  start_date: string;
  /** 上周日 (YYYY-MM-DD) */
  end_date: string;
  /** 上周第一天作为 ISO week 标识，方便 dedup */
  week_id: string;
}

/** 上周净值快照（用于 sparkline + start/end PnL） */
export interface WeeklyEquityPoint {
  date: string;
  total_value: number;
}

/** 行业（≈策略）维度贡献 */
export interface IndustryContributionRow {
  industry: string;
  realized_pnl: number;
  trade_count: number;
  symbols: string[];
}

/**
 * 策略维度贡献 (US-087 PM-011).
 *
 * trade 表本身无 strategy_key 列, 策略归属来自该 trade 关联的 AIInvestmentSignal:
 *   - signal.metadata.paper_trading_by_portfolio[portfolio_id].trade_id === trade.id
 *     或 .sell_trade_id === trade.id → strategy = signal.source_type
 *   - signal.metadata.paper_trading 同形态 (旧 schema)
 *   - 无法匹配 (手动下单 / signal 元数据丢失) → strategy_key = '__MANUAL__'
 *
 * 同 sell_trade_id 被多个 signal 共享时 (加仓 cycle), 第一个 signal 的 source_type
 * 优先 (与 PaperTradingAttributionService accountedSellTradeIds 去重思想一致 —
 * 真实 PnL 只算一次, 归属到首个 signal 的策略).
 *
 * 字段语义:
 *   - strategy_key: AISignalSourceType 枚举值或 '__MANUAL__' / '__UNKNOWN__'
 *   - strategy_label: 中文展示标签 (sourceTypeLabel 同款映射)
 *   - realized_pnl: Σ SELL realized_pnl (与 industry 一致, BUY 不入)
 *   - trade_count: SELL 笔数
 *   - symbols: 去重 symbol 列表
 *   - win_count / loss_count: realized_pnl>0 与 <0 的笔数 (与 industry 维度对偶,
 *     未来 attribution 看板可直接复用胜率)
 */
export interface StrategyContributionRow {
  strategy_key: string;
  strategy_label: string;
  realized_pnl: number;
  trade_count: number;
  symbols: string[];
  win_count: number;
  loss_count: number;
}

/** 内部输入: trade 行 + 推断出的 strategy_key */
export interface StrategyTradeRow {
  symbol: string;
  direction: 'BUY' | 'SELL' | string;
  realized_pnl: number;
  /** 由 caller 通过 trade_id → signal.source_type lookup 推断, 缺省走 '__MANUAL__' */
  strategy_key: string;
}

/**
 * US-088 PM-012 — 持仓股相关性矩阵 (周报内).
 *
 * 维度: 上周 (Mon-Sun) 持仓股 + 上周交易过的股 ∪ 集合, 按"上周 (实际不超 N=10
 * cap, 防 30×30 矩阵把邮件正文撑爆) 单股日收益率" 的 N×N pearson 相关. 给操盘
 * 手看"持仓是否过度集中在同方向" — 红色 = 高正相关 (黑天鹅时一起跌);
 * 绿色 = 高负相关 (天然对冲); 灰色 = 弱相关 (健康的多样化).
 *
 * 字段语义:
 *   - symbols: 行/列对应的 symbol 顺序 (与 matrix 索引一一对应), 由
 *     selectCorrelationSymbols 按 "上周末持仓 value 大→小 + tie-break symbol asc"
 *     稳定选出 (Top-N, N=CORRELATION_MAX_SYMBOLS).
 *   - matrix: N×N 实数矩阵, 对角线恒 1; 主对角线之外对称; 任一 symbol 序列方差为 0
 *     (上周价格全相同 / 数据点不足) → 那一行/列全填 null (NaN 替身), UI 渲染为 '—'.
 *   - window_days: 实际使用的日收益序列长度 (= unique 交易日数 - 1; 一周 5 交易日
 *     则 window_days=4); 不足 MIN_RETURNS (=3) 整个 payload 返 null.
 *   - sample_size: 实际进入计算的 symbols 数 (≤ MAX_SYMBOLS, 数据缺失的 symbol 被
 *     提前剔除); UI 显示 "基于 N 只持仓股" 帮用户判断置信度.
 *   - capped_n: 候选 symbol 总数 (持仓 + 交易过), 若 > MAX_SYMBOLS 在 UI 显示
 *     "前 N 名 (共 M 只)" 提示截断.
 */
export interface CorrelationMatrixRow {
  symbol: string;
  /** 对应矩阵每列的相关系数, 长度 == symbols.length, null = 数据不足无法计算 */
  values: Array<number | null>;
}

export interface CorrelationMatrixPayload {
  symbols: string[];
  matrix: CorrelationMatrixRow[];
  window_days: number;
  sample_size: number;
  capped_n: number;
}

/** US-088 PM-012 — 单股日 close 输入, 由 PRODUCTION DataSource 提供 */
export interface DailyCloseRow {
  /** YYYY-MM-DD (上海时区) */
  date: string;
  /** 当日 close 价 */
  close: number;
}

/**
 * US-088 PM-012 — 矩阵规模 cap. 一封邮件正文里 N×N 表格 N=10 已经接近视觉上限
 * (10 行 × 10 列 + 表头), 再大邮件 client 会横向滚动很难看. 真要看完整矩阵走
 * frontend 看板. 改这个数必须同步改下面 `MIN_RETURNS` 注释里关于"4 = 一周 5
 * 交易日 - 1" 的解释和 buildCorrelationMatrixHtml 的 column-count 注释.
 */
export const CORRELATION_MAX_SYMBOLS = 10;

/**
 * US-088 PM-012 — pearson 计算的最小日收益数. 一周满 5 交易日才能算出 4 个日收
 * 益, 不足意味着上周市场休市 / portfolio 新建. 阈值定 3 = 周三新建账户也能算
 * (但置信度低, UI 标 "数据不足" 提示).
 */
export const CORRELATION_MIN_RETURNS = 3;

/** 单股贡献（top winners / losers 用） */
export interface SymbolContributionRow {
  symbol: string;
  name: string;
  industry: string | null;
  realized_pnl: number;
  trade_count: number;
}

/** 本周关注事件（业绩预告） */
export interface UpcomingEventRow {
  symbol: string;
  name: string;
  event_type: 'earnings_forecast' | 'earnings_report';
  detail: string;
  announce_date?: string | null;
}

/** AI 周观点（启发式 narrative；远端不可达时兜底） */
export interface AIWeeklyOpinion {
  /** 'remote' = TradingAgents 远端生成；'heuristic' = 本地启发式兜底 */
  source: 'remote' | 'heuristic';
  /** 一句总结（30-60 字） */
  headline: string;
  /** 多段叙述（HTML 排版） */
  paragraphs: string[];
}

export interface WeeklyReviewPayload {
  user_id: number;
  username: string;
  week: PrevWeekRange;
  pnl: {
    start_value: number;
    end_value: number;
    pnl_amount: number;
    pnl_pct: number | null;
  };
  equity_curve: WeeklyEquityPoint[];
  industry_contribution: IndustryContributionRow[];
  /**
   * US-087 PM-011 — 按 strategy_key 拆 PnL.
   * 与 industry_contribution 对偶, 同一份 trade 数据按"来源策略" (signal.source_type)
   * 重新聚合. 无关联 signal 的 SELL trade → strategy_key='__MANUAL__'.
   */
  strategy_contribution: StrategyContributionRow[];
  /**
   * US-088 PM-012 — 持仓股 N×N pearson 相关矩阵.
   * 数据不足 (无持仓 / 上周休市 / DailyBar 抓取失败) → null, UI 直接 hide section.
   */
  correlation_matrix: CorrelationMatrixPayload | null;
  top_winners: SymbolContributionRow[];
  top_losers: SymbolContributionRow[];
  trade_count: number;
  realized_pnl_total: number;
  upcoming_events: UpcomingEventRow[];
  ai_opinion: AIWeeklyOpinion;
}

export interface WeeklyReviewForUserResult {
  report_id: string;
  status: WeeklyReviewStatus;
  /** 实际是否发邮件（dry_run / 配置关 / 失败均 false） */
  sent: boolean;
  user_id: number;
  username: string;
  week: PrevWeekRange;
  payload?: WeeklyReviewPayload;
  email_used?: string;
  email_response?: any;
  error?: string;
  skip_reason?: string;
}

export interface SendWeeklyReviewResult {
  week: PrevWeekRange;
  scanned_users: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  dry_run: boolean;
  per_user: WeeklyReviewForUserResult[];
}

export interface SendWeeklyReviewOptions {
  /** 仅评估单个 user，缺省扫所有 is_active=true 且 email.weekly_review=true 的用户 */
  user_id?: number;
  /** 覆盖 trade_date（上周计算基准点），缺省 = 上海时区当前日期 */
  reference_date?: string;
  /** 不实际发邮件，只返回 payload，用于预演 */
  dry_run?: boolean;
  /** 关注事件 lookahead 天数，缺省 7（本周） */
  upcoming_lookahead_days?: number;
}

// ---------------------------------------------------------------------------
// DataSource interface（注入式）
// ---------------------------------------------------------------------------

export interface WeeklyReviewDataSource {
  /** 列出所有 is_active=true 且 risk_config.notification_channels.email.weekly_review=true 的用户 */
  listEligibleUsers(options: { user_id?: number }): Promise<
    Array<{
      user_id: number;
      username: string;
      config: NotificationChannelsConfig;
    }>
  >;
  /** 取该 user 的 portfolio + positions */
  loadPortfolio(
    user_id: number
  ): Promise<{ portfolio: PaperTradingPortfolio; positions: PaperTradingPosition[] } | null>;
  /** 取该 portfolio [start, end] 范围内的 snapshots（升序） */
  loadWeeklySnapshots(
    portfolio_id: number,
    start_date: string,
    end_date: string
  ): Promise<WeeklyEquityPoint[]>;
  /** 取该 portfolio [start, end] 范围内的 trades */
  loadWeeklyTrades(
    portfolio_id: number,
    start_date: string,
    end_date: string
  ): Promise<PaperTradingTrade[]>;
  /**
   * US-087 PM-011 — 取这批 trade 的 strategy_key 映射.
   *
   * 实现策略 (PRODUCTION): 用 trade_ids 反向查 AIInvestmentSignal:
   *   `metadata.paper_trading_by_portfolio.<portfolio_id>.trade_id IN (...)`
   *   `OR metadata.paper_trading_by_portfolio.<portfolio_id>.sell_trade_id IN (...)`
   *   `OR metadata.paper_trading.trade_id IN (...)` (legacy schema)
   * 失败 / 缺数据时返空 Map (caller 走 fail-OPEN, 缺映射 → '__MANUAL__').
   */
  loadTradeStrategyMap(portfolio_id: number, trade_ids: number[]): Promise<Map<number, string>>;
  /**
   * US-088 PM-012 — 取上周 (start_date 到 end_date) 这批 symbol 的日 close.
   *
   * 返回 Map<symbol, Array<{date, close}>> (按日期升序). 数据缺失的 symbol 在
   * Map 中 absent (不返空 array, 让 caller 用 has() 区分 "失败" vs "停牌").
   * PRODUCTION 实现: Stock.symbol IN (...) JOIN DailyBar.time BETWEEN ... 单次
   * 查询. fail-OPEN: throw → caller 顶层 catch → correlation_matrix=null.
   */
  loadDailyCloses(
    symbols: string[],
    start_date: string,
    end_date: string
  ): Promise<Map<string, DailyCloseRow[]>>;
  /** 取 symbol → {industry, name} mapping */
  loadStockMetadata(
    symbols: string[]
  ): Promise<Map<string, { name: string; industry: string | null }>>;
  /** 取本周关注事件（业绩预告 + 财报披露） */
  loadUpcomingEvents(
    symbols: string[],
    from_date: string,
    to_date: string
  ): Promise<UpcomingEventRow[]>;
  /** 生成 AI 周观点（远端 → heuristic 兜底） */
  generateAIWeeklyOpinion(payload: {
    pnl_pct: number | null;
    industry_contribution: IndustryContributionRow[];
    top_winners: SymbolContributionRow[];
    top_losers: SymbolContributionRow[];
    upcoming_events: UpcomingEventRow[];
  }): Promise<AIWeeklyOpinion>;
  /** 调用 EmailNotificationService.sendEmail(payload, addr, {buildEmail}) */
  sendEmail(payload: WeeklyReviewPayload, to: string): Promise<EmailNotificationSendResult>;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 判定本 user 当前应否发周报：
 *   email.enabled && email.weekly_review && address 非空
 */
export function shouldSendWeeklyReviewForUser(config: NotificationChannelsConfig): {
  shouldSend: boolean;
  reason?: string;
} {
  if (!config.email.enabled) {
    return { shouldSend: false, reason: 'email 通道未启用' };
  }
  if (!config.email.weekly_review) {
    return { shouldSend: false, reason: '用户已关闭 weekly review 推送' };
  }
  const addr = safeString(config.email.address);
  if (!addr) {
    return { shouldSend: false, reason: '未配置 email 接收地址' };
  }
  return { shouldSend: true };
}

/**
 * 取上周一-上周日范围（按上海时区 ISO week, Monday = 第 1 天）。
 *
 * 取 reference_date 所在周的上一周：
 *   - reference = 2026-06-08 (周一) → 上周一 2026-06-01 / 上周日 2026-06-07
 *   - reference = 2026-06-09 (周二) → 上周一 2026-06-01 / 上周日 2026-06-07
 *   - reference = 2026-06-07 (周日) → 上周一 2026-05-25 / 上周日 2026-05-31
 *
 * ISO 周周日 day = 0（JS Date.getDay）翻成 7 后减 1 得周一偏移 —— 与
 * US-060 computeWeekStart 同款范式。
 */
export function computePrevWeekRange(referenceDate: string): PrevWeekRange {
  const m = moment.tz(referenceDate, 'YYYY-MM-DD', 'Asia/Shanghai');
  if (!m.isValid()) {
    // 防御性 —— caller 应保证 valid date，这里兜底用当天
    const today = moment().tz('Asia/Shanghai');
    return computePrevWeekRangeFromMoment(today);
  }
  return computePrevWeekRangeFromMoment(m);
}

function computePrevWeekRangeFromMoment(m: moment.Moment): PrevWeekRange {
  const isoDow = m.isoWeekday(); // ISO: Mon=1, Sun=7
  // 走到本周的周一
  const thisMonday = m.clone().subtract(isoDow - 1, 'days');
  // 上周一 = 本周一 - 7 天
  const prevMonday = thisMonday.clone().subtract(7, 'days');
  const prevSunday = prevMonday.clone().add(6, 'days');
  return {
    start_date: prevMonday.format('YYYY-MM-DD'),
    end_date: prevSunday.format('YYYY-MM-DD'),
    week_id: `${prevMonday.isoWeekYear()}-W${String(prevMonday.isoWeek()).padStart(2, '0')}`,
  };
}

/**
 * 从 snapshots 中算上周 PnL —— start = 第一条 snapshot，end = 最后一条。
 * 若 snapshots 为空（用户上周无 portfolio 活动 / 新户）返回 zero PnL。
 */
export function computeWeeklyPnL(snapshots: WeeklyEquityPoint[]): WeeklyReviewPayload['pnl'] {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return {
      start_value: 0,
      end_value: 0,
      pnl_amount: 0,
      pnl_pct: null,
    };
  }
  const start = safeNumber(snapshots[0].total_value);
  const end = safeNumber(snapshots[snapshots.length - 1].total_value);
  const pnl = roundMoney(end - start);
  const pct = start > 0 ? roundPct(((end - start) / start) * 100) : null;
  return {
    start_value: roundMoney(start),
    end_value: roundMoney(end),
    pnl_amount: pnl,
    pnl_pct: pct,
  };
}

/**
 * 按 industry 聚合 trades 的 realized_pnl。
 *
 * 数据切分约定：
 *   - 取 SELL trade 的 realized_pnl 累加（BUY 不结算 PnL）
 *   - 行业取 Stock.industry；未匹配 → '__UNKNOWN__'（与 US-052
 *     IndustryConcentrationGuard 同款 UNKNOWN sentinel）
 */
export function aggregateIndustryContribution(
  trades: Array<Pick<PaperTradingTrade, 'symbol' | 'direction' | 'realized_pnl'>>,
  stockMeta: Map<string, { name: string; industry: string | null }>
): IndustryContributionRow[] {
  const map = new Map<string, IndustryContributionRow>();
  for (const t of trades) {
    if (!t || t.direction !== 'SELL') continue;
    const pnl = safeNumber(t.realized_pnl);
    const meta = stockMeta.get(t.symbol);
    const industry = safeString(meta?.industry) || '__UNKNOWN__';
    const row = map.get(industry) || {
      industry,
      realized_pnl: 0,
      trade_count: 0,
      symbols: [],
    };
    row.realized_pnl += pnl;
    row.trade_count += 1;
    if (!row.symbols.includes(t.symbol)) row.symbols.push(t.symbol);
    map.set(industry, row);
  }
  // 按 realized_pnl 降序 + industry 升序稳定 tie-break
  return Array.from(map.values())
    .map(r => ({ ...r, realized_pnl: roundMoney(r.realized_pnl) }))
    .sort((a, b) => {
      const diff = b.realized_pnl - a.realized_pnl;
      if (diff !== 0) return diff;
      return a.industry.localeCompare(b.industry);
    });
}

/**
 * US-087 PM-011 — strategy_key 维度聚合.
 *
 * 与 aggregateIndustryContribution 对偶, 但聚合 key 是 strategy_key (由
 * caller 通过 trade_id → signal.source_type lookup 推断, 见
 * StrategyTradeRow.strategy_key 注释). 缺映射的 SELL 默认走 '__MANUAL__'.
 *
 * 排序:
 *   - realized_pnl 降序 (盈利策略在前)
 *   - tie → strategy_key 字母升序 (稳定)
 */
export function aggregateStrategyContribution(
  trades: StrategyTradeRow[]
): StrategyContributionRow[] {
  const map = new Map<string, StrategyContributionRow>();
  for (const t of trades) {
    if (!t || t.direction !== 'SELL') continue;
    const pnl = safeNumber(t.realized_pnl);
    const strategy_key = safeString(t.strategy_key) || '__MANUAL__';
    const row = map.get(strategy_key) || {
      strategy_key,
      strategy_label: strategyLabel(strategy_key),
      realized_pnl: 0,
      trade_count: 0,
      symbols: [],
      win_count: 0,
      loss_count: 0,
    };
    row.realized_pnl += pnl;
    row.trade_count += 1;
    if (pnl > 0) row.win_count += 1;
    if (pnl < 0) row.loss_count += 1;
    if (!row.symbols.includes(t.symbol)) row.symbols.push(t.symbol);
    map.set(strategy_key, row);
  }
  return Array.from(map.values())
    .map(r => ({ ...r, realized_pnl: roundMoney(r.realized_pnl) }))
    .sort((a, b) => {
      const diff = b.realized_pnl - a.realized_pnl;
      if (diff !== 0) return diff;
      return a.strategy_key.localeCompare(b.strategy_key);
    });
}

/**
 * strategy_key → 中文展示标签. 与 PaperTradingAttributionService.sourceTypeLabel
 * 同款映射 (US-020 接入新 source 时两处同步更新).
 */
export function strategyLabel(key: string): string {
  const labels: Record<string, string> = {
    [AISignalSourceType.QUANT_RECOMMENDATION]: '量化推荐',
    [AISignalSourceType.TRADING_AGENTS]: 'TradingAgents',
    [AISignalSourceType.DAILY_SCREENER]: 'AI每日优选',
    [AISignalSourceType.MANUAL_ANALYSIS]: '人工分析',
    [AISignalSourceType.ANALYSIS_ENGINE]: '多维分析引擎',
    __MANUAL__: '手动交易',
    __UNKNOWN__: '未标注策略',
  };
  return labels[key] || key || '未标注策略';
}

// ---------------------------------------------------------------------------
// US-088 PM-012 — 持仓股相关性矩阵 (pure helpers)
// ---------------------------------------------------------------------------

/**
 * Pearson 相关系数. 满足:
 *   - 任一向量 len < 2 → null (无法算 σ)
 *   - 两向量长度不等 → 取较短长度 (上层应保证对齐, 此处兜底)
 *   - 任一向量方差为 0 (常数序列) → null (corr 未定义, 数学上 0/0)
 *   - 任一元素 NaN/Inf → null (污染算子, 不静默 fallback 到 0)
 *
 * 返回值 clamp 到 [-1, 1] (浮点误差可能让 1.0 算到 1.00000000001).
 * round 到 3 位小数让邮件展示稳定 (绝对值 ≥0.001 才显示, 否则当 0).
 */
export function computePearson(a: number[], b: number[]): number | null {
  if (!Array.isArray(a) || !Array.isArray(b)) return null;
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  const r = cov / Math.sqrt(varA * varB);
  if (!Number.isFinite(r)) return null;
  const clamped = Math.max(-1, Math.min(1, r));
  return Math.round(clamped * 1000) / 1000;
}

/**
 * 从 close 序列算日收益率 r_t = (close_t - close_{t-1}) / close_{t-1}.
 *
 * 输入: 按 date 升序的 close 行 (PRODUCTION 已 ORDER BY time ASC).
 * 返回: 长度 = closes.length - 1 的收益数组, 不足 2 个有效 close → 空数组.
 * 任一 close <= 0 或非有限 → 该位置跳过 (returns 长度仍按"成功对" 累加),
 * 让单个 spike 不污染整段序列.
 */
export function dailyReturnsFromCloses(closes: DailyCloseRow[]): number[] {
  if (!Array.isArray(closes) || closes.length < 2) return [];
  const out: number[] = [];
  let prev: number | null = null;
  for (const row of closes) {
    const v = Number(row?.close);
    if (!Number.isFinite(v) || v <= 0) {
      // 不重置 prev — 让 close 偶发缺失时与下一日依然能算一对, 但代价是
      // 收益率会变成 2-day return. 选当前简化方案 = 重置 prev, 跳过中
      // 间缺口防止 2-day return 污染单日方差; 上层在 dataPointCount 不
      // 足 MIN_RETURNS 时会兜底 null.
      prev = null;
      continue;
    }
    if (prev !== null && prev > 0) {
      out.push((v - prev) / prev);
    }
    prev = v;
  }
  return out;
}

/**
 * 从持仓 + 交易股 ∪ 集合里挑相关矩阵参与者. 按"上周末持仓 market_value 大→小"
 * (越大说明在 portfolio 里占比越高, 越值得被分析相关性). 平手或缺持仓走 symbol
 * 字母升序兜底 (与排序稳定性同思想).
 *
 * 输入:
 *   - positions: 当前持仓 (snapshot), 各含 symbol + market_value (or quantity*price)
 *   - tradedSymbols: 上周交易过但已平的股 (避免漏掉 "buy-sell 同周 round-trip")
 *   - cap: Top-N cap (= CORRELATION_MAX_SYMBOLS)
 *
 * 输出: 去重的 symbol 列表 (顺序 = 优先级降序). 同时返回 capped_n = 候选总数,
 * 让 UI 知道是否被 cap (展示 "前 N 名 / 共 M 只" 帮助用户判断截断).
 */
export function selectCorrelationSymbols(
  positions: Array<{ symbol: string; market_value?: number | null }>,
  tradedSymbols: string[],
  cap: number = CORRELATION_MAX_SYMBOLS
): { selected: string[]; capped_n: number } {
  const valueMap = new Map<string, number>();
  for (const p of positions || []) {
    const sym = safeString(p?.symbol);
    if (!sym) continue;
    const mv = Number(p?.market_value);
    valueMap.set(sym, Math.max(valueMap.get(sym) || 0, Number.isFinite(mv) ? mv : 0));
  }
  for (const sym of tradedSymbols || []) {
    const s = safeString(sym);
    if (!s) continue;
    if (!valueMap.has(s)) valueMap.set(s, 0);
  }
  const all = Array.from(valueMap.entries());
  // 排序: market_value 降序 + symbol 字母升序 tie-break (稳定)
  all.sort((a, b) => {
    const diff = b[1] - a[1];
    if (diff !== 0) return diff;
    return a[0].localeCompare(b[0]);
  });
  const safeCap = Math.max(1, Math.floor(Number(cap) || CORRELATION_MAX_SYMBOLS));
  return {
    selected: all.slice(0, safeCap).map(([s]) => s),
    capped_n: all.length,
  };
}

/**
 * 主入口: 用 symbols + closes 算 N×N pearson 相关矩阵.
 *
 * 算法:
 *   1. 用 selectCorrelationSymbols 输出的 symbols 作为行/列顺序;
 *   2. 每个 symbol 通过 dailyReturnsFromCloses 得日收益序列, 取所有 symbol 序列
 *      共同的有效日 (intersect by date 防停牌 / 缺口让 pearson 用错位窗口);
 *   3. 对齐后, 若 intersect 长度 < CORRELATION_MIN_RETURNS → 整个 payload 返 null
 *      (不返"半矩阵" — 一部分 symbol 能算一部分不能会让 UI 解读困难);
 *   4. 任一 symbol 的对齐序列方差为 0 (上周价格全相同 / 全停牌) → 该行/列全 null;
 *   5. 对角线恒 1; 对称矩阵, 只算上三角再镜像减一半开销.
 *
 * 任何 throw / 空入 → null, 让 caller 不需 try/catch.
 */
export function computeCorrelationMatrix(
  symbols: string[],
  closesMap: Map<string, DailyCloseRow[]>,
  options: { minReturns?: number } = {}
): CorrelationMatrixPayload | null {
  if (!Array.isArray(symbols) || symbols.length === 0) return null;
  if (!closesMap || typeof closesMap.get !== 'function') return null;
  const minReturns = Math.max(2, Math.floor(options.minReturns || CORRELATION_MIN_RETURNS));

  // 用各 symbol 的 closes 算 dateSet 交集 (let pearson 都在同一组日期)
  const validSymbols: string[] = [];
  const closesPerSymbol = new Map<string, DailyCloseRow[]>();
  for (const sym of symbols) {
    const rows = closesMap.get(sym);
    if (!Array.isArray(rows) || rows.length < 2) continue;
    closesPerSymbol.set(sym, rows);
    validSymbols.push(sym);
  }
  if (validSymbols.length === 0) return null;

  // 交集日期 (每个 symbol 都有 close 的日子) — 先按 symbol 把 (date → close) 建好,
  // 再用 size 最小的当种子做交集 (降低 Set 拷贝成本), 顺道把 closeByDate 缓存复用.
  const closeByDatePerSymbol = new Map<string, Map<string, number>>();
  for (const sym of validSymbols) {
    const rows = closesPerSymbol.get(sym) || [];
    const closeByDate = new Map<string, number>();
    for (const r of rows) {
      const d = safeString(r.date);
      const v = Number(r.close);
      if (d && Number.isFinite(v) && v > 0) closeByDate.set(d, v);
    }
    closeByDatePerSymbol.set(sym, closeByDate);
  }
  const seedSym = validSymbols
    .slice()
    .sort(
      (a, b) => (closeByDatePerSymbol.get(a)?.size || 0) - (closeByDatePerSymbol.get(b)?.size || 0)
    )[0];
  const seed = closeByDatePerSymbol.get(seedSym) || new Map<string, number>();
  const intersect = new Set<string>(seed.keys());
  for (const sym of validSymbols) {
    if (sym === seedSym) continue;
    const cbd = closeByDatePerSymbol.get(sym) || new Map<string, number>();
    for (const d of Array.from(intersect)) {
      if (!cbd.has(d)) intersect.delete(d);
    }
  }
  const sortedDates = Array.from(intersect).sort();
  if (sortedDates.length < minReturns + 1) {
    // 收益数 = closes 数 - 1, 要算 pearson 至少 minReturns 个收益 → 至少 minReturns+1 个 close
    return null;
  }

  // 对每个 valid symbol 算对齐后的日收益 — 交集后所有 sortedDates 在 cbd 里必然 has
  const returnsPerSymbol = new Map<string, number[]>();
  for (const sym of validSymbols) {
    const cbd = closeByDatePerSymbol.get(sym) || new Map<string, number>();
    const aligned: DailyCloseRow[] = [];
    for (const d of sortedDates) {
      const v = cbd.get(d);
      if (v !== undefined) aligned.push({ date: d, close: v });
    }
    returnsPerSymbol.set(sym, dailyReturnsFromCloses(aligned));
  }

  // 再次过滤掉收益不够的 symbol (intersect 后还可能某 symbol 收益 < minReturns)
  const finalSymbols = validSymbols.filter(
    s => (returnsPerSymbol.get(s) || []).length >= minReturns
  );
  if (finalSymbols.length === 0) return null;

  // 计算上三角 + 镜像
  const rows: CorrelationMatrixRow[] = finalSymbols.map(sym => ({
    symbol: sym,
    values: finalSymbols.map(() => null as number | null),
  }));
  for (let i = 0; i < finalSymbols.length; i++) {
    rows[i].values[i] = 1;
    const ri = returnsPerSymbol.get(finalSymbols[i]) || [];
    for (let j = i + 1; j < finalSymbols.length; j++) {
      const rj = returnsPerSymbol.get(finalSymbols[j]) || [];
      const r = computePearson(ri, rj);
      rows[i].values[j] = r;
      rows[j].values[i] = r;
    }
  }

  return {
    symbols: finalSymbols,
    matrix: rows,
    window_days: Math.min(...finalSymbols.map(s => (returnsPerSymbol.get(s) || []).length)),
    sample_size: finalSymbols.length,
    capped_n: symbols.length,
  };
}

/**
 * US-088 PM-012 — 主入口: 把 selectCorrelationSymbols + closesMap 串起来算矩阵.
 * 任何空入 / throw → 返 null. caller 一次调用就能拿完整 payload.
 */
export function buildCorrelationMatrixPayload(
  positions: Array<{ symbol: string; market_value?: number | null }>,
  tradedSymbols: string[],
  closesMap: Map<string, DailyCloseRow[]>,
  options: { cap?: number; minReturns?: number } = {}
): CorrelationMatrixPayload | null {
  try {
    const cap = options.cap || CORRELATION_MAX_SYMBOLS;
    const minReturns = options.minReturns || CORRELATION_MIN_RETURNS;
    const { selected, capped_n } = selectCorrelationSymbols(positions, tradedSymbols, cap);
    if (selected.length === 0) return null;
    const matrix = computeCorrelationMatrix(selected, closesMap, { minReturns });
    if (!matrix) return null;
    // 用 buildCorrelationMatrixPayload 已知的 capped_n 覆盖 computeCorrelationMatrix
    // 内部计算的 (后者只看到入参 symbols.length, 而真正的"候选总数" 是 positions
    // + tradedSymbols ∪).
    return { ...matrix, capped_n };
  } catch (err) {
    // pure helper 永不 throw — 返 null 让 caller 顶层 try/catch 不必再包.
    return null;
  }
}

/**
 * 按 symbol 聚合 trades，取 top N 盈利和 top N 亏损。
 * order='desc' = top winners; order='asc' = top losers (绝对值最负)。
 */
export function aggregateSymbolContribution(
  trades: Array<Pick<PaperTradingTrade, 'symbol' | 'direction' | 'realized_pnl' | 'name'>>,
  stockMeta: Map<string, { name: string; industry: string | null }>,
  order: 'desc' | 'asc',
  limit: number
): SymbolContributionRow[] {
  const map = new Map<string, SymbolContributionRow>();
  for (const t of trades) {
    if (!t || t.direction !== 'SELL') continue;
    const pnl = safeNumber(t.realized_pnl);
    const meta = stockMeta.get(t.symbol);
    const row = map.get(t.symbol) || {
      symbol: t.symbol,
      name: safeString(meta?.name) || t.name || t.symbol,
      industry: meta?.industry || null,
      realized_pnl: 0,
      trade_count: 0,
    };
    row.realized_pnl += pnl;
    row.trade_count += 1;
    map.set(t.symbol, row);
  }
  const arr = Array.from(map.values()).map(r => ({
    ...r,
    realized_pnl: roundMoney(r.realized_pnl),
  }));
  arr.sort((a, b) => {
    const diff =
      order === 'desc' ? b.realized_pnl - a.realized_pnl : a.realized_pnl - b.realized_pnl;
    if (diff !== 0) return diff;
    return a.symbol.localeCompare(b.symbol);
  });
  const cap = Math.max(1, Math.min(20, Math.floor(Number(limit) || 5)));
  // 对于 order='asc'，只保留 realized_pnl < 0 的（zero pnl 不是 loser）
  // 对于 order='desc'，只保留 > 0
  const filtered =
    order === 'asc' ? arr.filter(r => r.realized_pnl < 0) : arr.filter(r => r.realized_pnl > 0);
  return filtered.slice(0, cap);
}

/**
 * 给 equity_curve 生成 inline SVG sparkline。
 *
 * 设计：
 *   - 邮件 client 兼容性最高的方案 = inline SVG 直接落到 HTML body
 *     （vs <img src="cid:..."> 需要 multipart 附件 + 部分 client 默认不下图）
 *   - 320 × 80 像素紧凑 sparkline，y 范围按 [min*0.95, max*1.05] 自动 fit；
 *     全 0 或 单点时退化为空字符串
 *   - 颜色 = 净值上涨绿 (#16a34a) / 下跌红 (#dc2626) / 无变化灰 (#94a3b8)
 *     （A 股配色：红涨绿跌？—— 邮件场景按国际惯例 green-up red-down，
 *     与 PnL 表格颜色保持一致，避免视觉混乱）
 */
export function buildEquityCurveSparkline(
  points: WeeklyEquityPoint[],
  options: { width?: number; height?: number } = {}
): string {
  if (!Array.isArray(points) || points.length < 2) return '';
  const W = Math.max(80, Math.min(1024, options.width ?? 320));
  const H = Math.max(40, Math.min(256, options.height ?? 80));
  const PAD = 4;
  const xs = points.map((_, i) => i);
  const ys = points.map(p => safeNumber(p.total_value));
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  if (yMin === yMax) {
    // 全平直线
    const midY = H / 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><line x1="${PAD}" y1="${midY}" x2="${
      W - PAD
    }" y2="${midY}" stroke="#94a3b8" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  const yRangePad = (yMax - yMin) * 0.05;
  const yLo = yMin - yRangePad;
  const yHi = yMax + yRangePad;
  const xScale = (x: number) => PAD + ((W - 2 * PAD) * x) / (xs.length - 1);
  const yScale = (y: number) => H - PAD - ((H - 2 * PAD) * (y - yLo)) / (yHi - yLo);
  const path = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(2)} ${yScale(safeNumber(p.total_value)).toFixed(
          2
        )}`
    )
    .join(' ');
  const startY = ys[0];
  const endY = ys[ys.length - 1];
  const color = endY > startY ? '#16a34a' : endY < startY ? '#dc2626' : '#94a3b8';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * 启发式 AI 周观点 —— 远端不可达时兜底；与 US-061 双路范式一致。
 * 完全基于 payload 数据（PnL pct / 行业 top / 个股 top / 关注事件），
 * 不调远端服务（保证邮件 cron 不依赖远端高可用）。
 */
export function buildHeuristicWeeklyOpinion(payload: {
  pnl_pct: number | null;
  industry_contribution: IndustryContributionRow[];
  top_winners: SymbolContributionRow[];
  top_losers: SymbolContributionRow[];
  upcoming_events: UpcomingEventRow[];
}): AIWeeklyOpinion {
  const pct = payload.pnl_pct;
  let headline = '组合本周整体走势平稳，继续观察策略表现。';
  const paragraphs: string[] = [];

  if (pct === null) {
    headline = '上周净值数据不足，建议确认模拟盘是否正常运行。';
  } else if (pct >= 3) {
    headline = `组合本周大幅跑赢，净值 +${pct.toFixed(2)}%，建议关注后续兑现节奏。`;
  } else if (pct >= 1) {
    headline = `组合本周稳健上涨 +${pct.toFixed(2)}%，节奏与策略预期一致。`;
  } else if (pct > -1) {
    headline = `组合本周整体平稳 (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)，处于观察区。`;
  } else if (pct > -3) {
    headline = `组合本周小幅回撤 ${pct.toFixed(2)}%，关注亏损源头。`;
  } else {
    headline = `组合本周大幅回撤 ${pct.toFixed(2)}%，建议复盘止损纪律。`;
  }

  // 行业贡献描述
  const topIndustries = payload.industry_contribution.filter(r => r.realized_pnl > 0).slice(0, 3);
  if (topIndustries.length > 0) {
    const names = topIndustries
      .map(
        r =>
          `${r.industry === '__UNKNOWN__' ? '未分类' : r.industry}（+${formatMoney(
            r.realized_pnl
          )}元）`
      )
      .join('、');
    paragraphs.push(`本周收益主要来自 ${names}，已贡献正向现金流。`);
  }
  const losingIndustries = payload.industry_contribution
    .filter(r => r.realized_pnl < 0)
    .slice(0, 2);
  if (losingIndustries.length > 0) {
    const names = losingIndustries
      .map(
        r =>
          `${r.industry === '__UNKNOWN__' ? '未分类' : r.industry}（${formatMoney(
            r.realized_pnl
          )}元）`
      )
      .join('、');
    paragraphs.push(`回撤来源主要在 ${names}，建议复盘行业曝光是否偏高。`);
  }
  // 个股贡献描述
  if (payload.top_winners.length > 0) {
    const w = payload.top_winners[0];
    paragraphs.push(
      `最大盈利股 ${w.symbol} ${w.name}（+${formatMoney(
        w.realized_pnl
      )}元），值得保留为后续策略样本。`
    );
  }
  if (payload.top_losers.length > 0) {
    const l = payload.top_losers[0];
    paragraphs.push(
      `最大亏损股 ${l.symbol} ${l.name}（${formatMoney(
        l.realized_pnl
      )}元），复盘是否进场逻辑失效或止损执行偏晚。`
    );
  }
  // 关注事件描述
  if (payload.upcoming_events.length > 0) {
    const evCount = payload.upcoming_events.length;
    paragraphs.push(`本周共 ${evCount} 个关注事件触发，重点跟踪业绩预告及发布公告对持仓的影响。`);
  } else {
    paragraphs.push('本周暂无重要事件触发，可专注于持仓节奏与新仓位筛选。');
  }

  return {
    source: 'heuristic',
    headline,
    paragraphs,
  };
}

/**
 * 业务 ID：`WEEKLY-{user_id}-{YYYYMMDD}-{rand4}`（US-055 命名范式）。
 */
export function buildReportId(user_id: number, end_date: string, rand4Hex: string): string {
  const ymd = String(end_date).replace(/-/g, '');
  const rand = String(rand4Hex || '')
    .slice(0, 4)
    .padStart(4, '0');
  return `WEEKLY-${user_id}-${ymd}-${rand}`;
}

/**
 * 构造邮件 subject + html + text。
 *
 * HTML 设计：
 *   - 内嵌 inline CSS（外部样式表邮件不支持，<style> 部分 client 也吃掉）
 *   - 表格 + 文字段落 + 内嵌 SVG sparkline
 *   - 全部 inline width/height/style 属性
 */
export function buildWeeklyReviewEmail(payload: WeeklyReviewPayload): EmailPayload {
  const pnlColor =
    payload.pnl.pnl_amount > 0 ? '#16a34a' : payload.pnl.pnl_amount < 0 ? '#dc2626' : '#475569';
  const pnlSign = payload.pnl.pnl_amount > 0 ? '+' : '';
  const pctText =
    payload.pnl.pnl_pct === null
      ? '—'
      : `${payload.pnl.pnl_pct > 0 ? '+' : ''}${payload.pnl.pnl_pct.toFixed(2)}%`;

  const subject = `📊 ${payload.week.start_date} ~ ${
    payload.week.end_date
  } 策略周报 (${pnlSign}${formatMoney(payload.pnl.pnl_amount)} 元 / ${pctText})`;

  const sparkline = buildEquityCurveSparkline(payload.equity_curve, { width: 480, height: 100 });

  const industryRows = payload.industry_contribution.slice(0, 8);
  const industryTableHtml = industryRows.length
    ? industryRows
        .map(r => {
          const c = r.realized_pnl > 0 ? '#16a34a' : r.realized_pnl < 0 ? '#dc2626' : '#475569';
          const sign = r.realized_pnl > 0 ? '+' : '';
          const label = r.industry === '__UNKNOWN__' ? '未分类' : r.industry;
          return `<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(
            label
          )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:${c};font-weight:600;">${sign}${formatMoney(
            r.realized_pnl
          )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#64748b;">${
            r.trade_count
          }</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="3" style="padding:12px;color:#94a3b8;text-align:center;">本周无已实现交易</td></tr>';

  // US-087 PM-011 — strategy 维度表 (策略来源 / PnL / 笔数 / 胜率)
  const strategyRows = (payload.strategy_contribution || []).slice(0, 8);
  const strategyTableHtml = strategyRows.length
    ? strategyRows
        .map(r => {
          const c = r.realized_pnl > 0 ? '#16a34a' : r.realized_pnl < 0 ? '#dc2626' : '#475569';
          const sign = r.realized_pnl > 0 ? '+' : '';
          const decided = r.win_count + r.loss_count;
          const winRate = decided > 0 ? `${Math.round((r.win_count / decided) * 100)}%` : '—';
          return `<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(
            r.strategy_label
          )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:${c};font-weight:600;">${sign}${formatMoney(
            r.realized_pnl
          )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#64748b;">${
            r.trade_count
          }</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#64748b;">${winRate}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;">本周无已实现交易</td></tr>';

  // US-088 PM-012 — 相关性矩阵 HTML (correlation_matrix=null 时 hide section)
  const correlationSectionHtml = buildCorrelationMatrixHtml(payload.correlation_matrix);

  const winnerRowsHtml = payload.top_winners.length
    ? payload.top_winners.map(r => buildSymbolRowHtml(r, '#16a34a')).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;">本周无盈利兑现</td></tr>';

  const loserRowsHtml = payload.top_losers.length
    ? payload.top_losers.map(r => buildSymbolRowHtml(r, '#dc2626')).join('')
    : '<tr><td colspan="4" style="padding:12px;color:#94a3b8;text-align:center;">本周无亏损兑现</td></tr>';

  const eventsHtml = payload.upcoming_events.length
    ? payload.upcoming_events
        .map(
          ev =>
            `<li style="margin-bottom:6px;"><strong>${escapeHtml(ev.symbol)} ${escapeHtml(
              ev.name
            )}</strong> · ${escapeHtml(eventLabel(ev.event_type))}${
              ev.announce_date ? ` · ${escapeHtml(ev.announce_date)}` : ''
            } — ${escapeHtml(ev.detail)}</li>`
        )
        .join('')
    : '<li style="color:#94a3b8;">本周暂无重要关注事件</li>';

  const opinionHtml = `
    <div style="background:#f8fafc;border-left:4px solid #2563eb;padding:12px 16px;margin:16px 0;border-radius:4px;">
      <div style="font-weight:600;font-size:14px;color:#1e293b;margin-bottom:8px;">🤖 AI 周观点${
        payload.ai_opinion.source === 'heuristic'
          ? ' <span style="font-size:12px;color:#94a3b8;font-weight:400;">(本地启发式)</span>'
          : ''
      }</div>
      <div style="font-size:15px;font-weight:600;color:#0f172a;margin-bottom:8px;">${escapeHtml(
        payload.ai_opinion.headline
      )}</div>
      ${payload.ai_opinion.paragraphs
        .map(
          p =>
            `<p style="margin:6px 0;font-size:13px;line-height:1.6;color:#475569;">${escapeHtml(
              p
            )}</p>`
        )
        .join('')}
    </div>
  `.trim();

  const html = `
<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;color:#1e293b;">
  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 12px rgba(15,23,42,0.06);">
    <tr><td style="padding:24px 24px 12px 24px;">
      <h1 style="margin:0 0 4px 0;font-size:18px;font-weight:700;color:#0f172a;">📊 策略复盘周报</h1>
      <div style="font-size:13px;color:#64748b;">${escapeHtml(payload.username)} · ${escapeHtml(
    payload.week.start_date
  )} 至 ${escapeHtml(payload.week.end_date)} · ${escapeHtml(payload.week.week_id)}</div>
    </td></tr>
    <tr><td style="padding:0 24px 12px 24px;">
      <div style="display:inline-block;padding:12px 20px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <div style="font-size:12px;color:#64748b;margin-bottom:4px;">本周净值变化</div>
        <div style="font-size:28px;font-weight:700;color:${pnlColor};line-height:1.2;">${pnlSign}${formatMoney(
    payload.pnl.pnl_amount
  )} 元</div>
        <div style="font-size:14px;color:${pnlColor};margin-top:2px;">${pctText} （${formatMoney(
    payload.pnl.start_value
  )} → ${formatMoney(payload.pnl.end_value)} 元）</div>
      </div>
    </td></tr>
    ${
      sparkline
        ? `<tr><td style="padding:0 24px 16px 24px;"><div style="background:#fafbff;border-radius:8px;padding:12px;">${sparkline}<div style="font-size:11px;color:#94a3b8;margin-top:6px;">总资产走势（${payload.equity_curve.length} 个快照）</div></div></td></tr>`
        : ''
    }
    <tr><td style="padding:0 24px 16px 24px;">
      <h2 style="margin:8px 0;font-size:15px;font-weight:600;color:#0f172a;">📈 各行业贡献</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500;">行业</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">已实现盈亏 (元)</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">成交笔数</th></tr></thead>
        <tbody>${industryTableHtml}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 16px 24px;">
      <h2 style="margin:8px 0;font-size:15px;font-weight:600;color:#0f172a;">🎯 各策略贡献</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500;">策略</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">已实现盈亏 (元)</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">成交笔数</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">胜率</th></tr></thead>
        <tbody>${strategyTableHtml}</tbody>
      </table>
    </td></tr>
    ${correlationSectionHtml}
    <tr><td style="padding:0 24px 16px 24px;">
      <h2 style="margin:8px 0;font-size:15px;font-weight:600;color:#0f172a;">🏆 盈利 TOP ${
        payload.top_winners.length
      }</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500;">代码</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500;">名称</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">盈亏 (元)</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">行业</th></tr></thead>
        <tbody>${winnerRowsHtml}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 16px 24px;">
      <h2 style="margin:8px 0;font-size:15px;font-weight:600;color:#0f172a;">⚠️ 亏损 TOP ${
        payload.top_losers.length
      }</h2>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">
        <thead><tr style="background:#f8fafc;"><th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500;">代码</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-weight:500;">名称</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">盈亏 (元)</th><th style="padding:8px 12px;text-align:right;color:#64748b;font-weight:500;">行业</th></tr></thead>
        <tbody>${loserRowsHtml}</tbody>
      </table>
    </td></tr>
    <tr><td style="padding:0 24px 16px 24px;">
      <h2 style="margin:8px 0;font-size:15px;font-weight:600;color:#0f172a;">📅 本周关注事件</h2>
      <ul style="margin:0;padding-left:20px;font-size:13px;color:#475569;line-height:1.7;">${eventsHtml}</ul>
    </td></tr>
    <tr><td style="padding:0 24px 16px 24px;">${opinionHtml}</td></tr>
    <tr><td style="padding:12px 24px 24px 24px;border-top:1px solid #f1f5f9;">
      <div style="font-size:11px;color:#94a3b8;text-align:center;">QuantX A-Share Alpha · 自动生成 · ${escapeHtml(
        moment().tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm')
      )}</div>
    </td></tr>
  </table>
</body>
</html>`.trim();

  const text = buildPlainTextFallback(payload);

  return { subject, html, text };
}

function buildSymbolRowHtml(row: SymbolContributionRow, color: string): string {
  const sign = row.realized_pnl > 0 ? '+' : '';
  const industryLabel = row.industry || '—';
  return `<tr><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;font-family:monospace;color:#1e293b;">${escapeHtml(
    row.symbol
  )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;">${escapeHtml(
    row.name
  )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:${color};font-weight:600;">${sign}${formatMoney(
    row.realized_pnl
  )}</td><td style="padding:6px 12px;border-bottom:1px solid #e2e8f0;text-align:right;color:#64748b;font-size:12px;">${escapeHtml(
    industryLabel
  )}</td></tr>`;
}

/**
 * US-088 PM-012 — 把相关矩阵渲染成 HTML 表格 section.
 *
 * 颜色规则 (操盘手认知): 红色 = 高正相关 (黑天鹅风险), 浅色 = 弱相关 (健康),
 * 绿色 = 高负相关 (天然对冲). 与"涨绿跌红" 配色保持一致 (邮件场景按国际惯例).
 *   - |r| < 0.3 → 中性灰 #f1f5f9
 *   - 0.3 ≤ r < 0.6 → 暖橙 #fde68a
 *   - 0.6 ≤ r ≤ 1.0 → 深红 #fca5a5 (高风险)
 *   - -0.6 < r ≤ -0.3 → 浅绿 #bbf7d0
 *   - r ≤ -0.6 → 深绿 #86efac
 *   - null (数据不足) → '—' 灰底
 *
 * payload=null → 返空字符串 (整个 section 不渲染), caller 用 ${} 占位即可.
 */
export function buildCorrelationMatrixHtml(payload: CorrelationMatrixPayload | null): string {
  if (!payload || !Array.isArray(payload.symbols) || payload.symbols.length === 0) return '';
  const { symbols, matrix } = payload;
  const cellPad = 'padding:4px 6px;border:1px solid #e2e8f0;text-align:center;font-size:11px;';
  const headerHtml =
    `<tr><th style="${cellPad}background:#f8fafc;color:#64748b;font-weight:500;">代码</th>` +
    symbols
      .map(
        s =>
          `<th style="${cellPad}background:#f8fafc;color:#64748b;font-weight:500;font-family:monospace;">${escapeHtml(
            s
          )}</th>`
      )
      .join('') +
    '</tr>';
  const bodyHtml = matrix
    .map((row, i) => {
      const cells = row.values
        .map((v, j) => {
          if (v === null || !Number.isFinite(v)) {
            return `<td style="${cellPad}background:#f1f5f9;color:#94a3b8;">—</td>`;
          }
          // 对角线单独标记 (深蓝底 + 白字 1.00)
          if (i === j) {
            return `<td style="${cellPad}background:#1e293b;color:#fff;font-weight:600;">1.00</td>`;
          }
          const bg = correlationCellColor(v);
          const fg = Math.abs(v) >= 0.6 ? '#0f172a' : '#475569';
          return `<td style="${cellPad}background:${bg};color:${fg};font-weight:${
            Math.abs(v) >= 0.6 ? 600 : 500
          };">${v >= 0 ? '+' : ''}${v.toFixed(2)}</td>`;
        })
        .join('');
      return `<tr><th style="${cellPad}background:#f8fafc;color:#475569;font-weight:500;font-family:monospace;text-align:left;">${escapeHtml(
        row.symbol
      )}</th>${cells}</tr>`;
    })
    .join('');
  const cappedNote =
    payload.capped_n > payload.sample_size
      ? ` <span style="font-size:11px;color:#94a3b8;font-weight:400;">(前 ${payload.sample_size} 只 / 共 ${payload.capped_n} 只)</span>`
      : '';
  return `
    <tr><td style="padding:0 24px 16px 24px;">
      <h2 style="margin:8px 0;font-size:15px;font-weight:600;color:#0f172a;">🔗 持仓相关性矩阵${cappedNote}</h2>
      <div style="font-size:11px;color:#94a3b8;margin-bottom:6px;">基于上周 ${payload.window_days} 日日收益率 Pearson 相关 · 红=高正相关(齐涨齐跌) / 绿=负相关(对冲) / 灰=弱相关(健康)</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;">
        <thead>${headerHtml}</thead>
        <tbody>${bodyHtml}</tbody>
      </table>
    </td></tr>`.trim();
}

function correlationCellColor(r: number): string {
  if (r >= 0.6) return '#fca5a5'; // 深红 高正相关
  if (r >= 0.3) return '#fde68a'; // 暖橙 中等正相关
  if (r > -0.3) return '#f1f5f9'; // 中性灰
  if (r > -0.6) return '#bbf7d0'; // 浅绿 中等负相关
  return '#86efac'; // 深绿 高负相关
}

function buildPlainTextFallback(payload: WeeklyReviewPayload): string {
  const lines: string[] = [];
  const sign = payload.pnl.pnl_amount > 0 ? '+' : '';
  const pctStr =
    payload.pnl.pnl_pct === null
      ? '—'
      : `${payload.pnl.pnl_pct > 0 ? '+' : ''}${payload.pnl.pnl_pct.toFixed(2)}%`;
  lines.push(`策略复盘周报 ${payload.week.start_date} ~ ${payload.week.end_date}`);
  lines.push(`用户：${payload.username}`);
  lines.push('');
  lines.push(
    `本周 PnL：${sign}${formatMoney(payload.pnl.pnl_amount)} 元 (${pctStr}) — ${formatMoney(
      payload.pnl.start_value
    )} → ${formatMoney(payload.pnl.end_value)} 元`
  );
  lines.push(
    `成交笔数：${payload.trade_count}，已实现 PnL：${formatMoney(payload.realized_pnl_total)} 元`
  );
  lines.push('');
  lines.push('行业贡献：');
  if (payload.industry_contribution.length === 0) {
    lines.push('  本周无已实现交易');
  } else {
    for (const r of payload.industry_contribution.slice(0, 8)) {
      const s = r.realized_pnl > 0 ? '+' : '';
      const label = r.industry === '__UNKNOWN__' ? '未分类' : r.industry;
      lines.push(`  - ${label}: ${s}${formatMoney(r.realized_pnl)} 元 (${r.trade_count} 笔)`);
    }
  }
  lines.push('');
  // US-087 PM-011 — 策略贡献
  lines.push('策略贡献：');
  if (!payload.strategy_contribution || payload.strategy_contribution.length === 0) {
    lines.push('  本周无已实现交易');
  } else {
    for (const r of payload.strategy_contribution.slice(0, 8)) {
      const s = r.realized_pnl > 0 ? '+' : '';
      const decided = r.win_count + r.loss_count;
      const winRate = decided > 0 ? `${Math.round((r.win_count / decided) * 100)}%` : '—';
      lines.push(
        `  - ${r.strategy_label}: ${s}${formatMoney(r.realized_pnl)} 元 (${
          r.trade_count
        } 笔, 胜率 ${winRate})`
      );
    }
  }
  lines.push('');
  // US-088 PM-012 — 持仓相关性矩阵
  if (payload.correlation_matrix && payload.correlation_matrix.symbols.length > 0) {
    const cm = payload.correlation_matrix;
    lines.push(`持仓相关性矩阵 (基于 ${cm.window_days} 日收益)：`);
    if (cm.capped_n > cm.sample_size) {
      lines.push(`  (前 ${cm.sample_size} 只 / 共 ${cm.capped_n} 只)`);
    }
    // 列宽以 symbol 最长 + 2 为基准
    const colW = Math.max(8, ...cm.symbols.map(s => s.length)) + 1;
    const fmt = (s: string) => s.padEnd(colW);
    // 表头
    lines.push('  ' + fmt('') + cm.symbols.map(fmt).join(''));
    for (let i = 0; i < cm.matrix.length; i++) {
      const row = cm.matrix[i];
      const cells = row.values.map(v => {
        if (v === null || !Number.isFinite(v)) return fmt('—');
        return fmt(`${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
      });
      lines.push('  ' + fmt(row.symbol) + cells.join(''));
    }
    lines.push('');
  }
  lines.push('AI 周观点：');
  lines.push(`  ${payload.ai_opinion.headline}`);
  for (const p of payload.ai_opinion.paragraphs) {
    lines.push(`  ${p}`);
  }
  return lines.join('\n');
}

function eventLabel(kind: UpcomingEventRow['event_type']): string {
  switch (kind) {
    case 'earnings_forecast':
      return '业绩预告';
    case 'earnings_report':
      return '财报披露';
    default:
      return String(kind);
  }
}

function escapeHtml(s: string): string {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Small internal helpers
// ---------------------------------------------------------------------------

function safeString(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function safeNumber(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** US-087 PM-011 helper — trade_id 提取, 非有限数返 null (与 safeNumber 默认 0 对偶). */
function toFiniteNumber(v: any): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(v: number): number {
  return Math.round(safeNumber(v) * 100) / 100;
}

function roundPct(v: number): number {
  return Math.round(safeNumber(v) * 100) / 100;
}

export function formatMoney(v: any): string {
  const n = safeNumber(v);
  const abs = Math.abs(n);
  const intPart = Math.floor(abs).toString();
  const intWithCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const decPart = (abs - Math.floor(abs)).toFixed(2).slice(1);
  return `${n < 0 ? '-' : ''}${intWithCommas}${decPart}`;
}

function nowShanghaiDate(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function randHex4(): string {
  const n = Math.floor(Math.random() * 0xffff);
  return n.toString(16).padStart(4, '0');
}

// ---------------------------------------------------------------------------
// Default DataSource: real Sequelize-backed implementation
// ---------------------------------------------------------------------------

export class DefaultWeeklyReviewDataSource implements WeeklyReviewDataSource {
  async listEligibleUsers(options: { user_id?: number }) {
    const where: any = { is_active: true };
    if (options.user_id !== undefined) {
      where.id = Number(options.user_id);
    }
    const users = await User.findAll({
      where,
      attributes: ['id', 'username', 'risk_config'],
      raw: true,
    });
    return users
      .map(u => ({
        user_id: (u as any).id,
        username: (u as any).username,
        config: normalizeNotificationConfig((u as any).risk_config),
      }))
      .filter(
        u =>
          u.config.email.enabled &&
          u.config.email.weekly_review &&
          !!safeString(u.config.email.address)
      );
  }

  async loadPortfolio(user_id: number) {
    const portfolio = await PaperTradingPortfolio.findOne({ where: { user_id } });
    if (!portfolio) return null;
    const positions = await PaperTradingPosition.findAll({
      where: { portfolio_id: portfolio.id },
    });
    return { portfolio, positions };
  }

  async loadWeeklySnapshots(portfolio_id: number, start_date: string, end_date: string) {
    const rows = (await PaperTradingSnapshot.findAll({
      attributes: ['date', 'total_value'],
      where: {
        portfolio_id,
        date: { [Op.gte]: start_date, [Op.lte]: end_date },
      },
      order: [['date', 'ASC']],
      raw: true,
    })) as unknown as Array<{ date: string; total_value: number | string }>;
    return rows.map(r => ({ date: r.date, total_value: Number(r.total_value) }));
  }

  async loadWeeklyTrades(portfolio_id: number, start_date: string, end_date: string) {
    const dayStart = moment.tz(start_date, 'Asia/Shanghai').startOf('day').toDate();
    const dayEnd = moment.tz(end_date, 'Asia/Shanghai').endOf('day').toDate();
    return PaperTradingTrade.findAll({
      where: {
        portfolio_id,
        created_at: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
      },
      order: [['created_at', 'ASC']],
    });
  }

  /**
   * US-087 PM-011 — trade_id → strategy_key 反向 lookup.
   *
   * AIInvestmentSignal.metadata 是 JSONB, 存放 paper_trading_by_portfolio.<pid>.trade_id
   * / sell_trade_id. 不同 portfolio 写不同 sub-key 防串号. legacy 行还可能落在
   * metadata.paper_trading.trade_id (US-020 之前 schema). 全局拉所有 signals
   * 在内存里匹配 — portfolio 周内 trade 数普遍 <100, signals 数 <1000, 直接
   * 全表扫不复杂. 真要优化可加 trades<-signals 反向索引表, 但当前规模无必要.
   *
   * 同 sell_trade_id 被多 signal 共享 (加仓 cycle) 时, 第一个 signal 的 source_type
   * 优先 (与 PaperTradingAttributionService accountedSellTradeIds 去重对偶).
   */
  async loadTradeStrategyMap(
    portfolio_id: number,
    trade_ids: number[]
  ): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (!trade_ids || trade_ids.length === 0) return out;
    const tradeIdSet = new Set(trade_ids.map(id => Number(id)).filter(id => Number.isFinite(id)));
    if (tradeIdSet.size === 0) return out;
    // 该 portfolio 范围内的 signals — 不按 trade_id JSONB 索引查 (MySQL 兼容性差),
    // 而是按 metadata.paper_trading_by_portfolio.<pid> 存在性 LIKE 粗筛 + 内存精筛.
    // PostgreSQL 走 jsonb_extract_path 可优化, 但 fail-OPEN 默认全表扫不影响功能.
    const signals = (await AIInvestmentSignal.findAll({
      attributes: ['id', 'source_type', 'metadata', 'created_at'],
      order: [['created_at', 'ASC']],
      raw: true,
    })) as unknown as Array<{
      id: number;
      source_type: string;
      metadata: any;
      created_at: Date | string;
    }>;
    for (const s of signals) {
      const meta = s.metadata && typeof s.metadata === 'object' ? s.metadata : {};
      const byPortfolio =
        meta.paper_trading_by_portfolio && typeof meta.paper_trading_by_portfolio === 'object'
          ? meta.paper_trading_by_portfolio
          : {};
      const keyed =
        byPortfolio[String(portfolio_id)] && typeof byPortfolio[String(portfolio_id)] === 'object'
          ? byPortfolio[String(portfolio_id)]
          : {};
      const legacy =
        meta.paper_trading && typeof meta.paper_trading === 'object' ? meta.paper_trading : {};
      const pt = Object.keys(keyed).length > 0 ? keyed : legacy;
      const tradeId = toFiniteNumber(pt.trade_id);
      const sellTradeId = toFiniteNumber(pt.sell_trade_id);
      const sourceType = safeString(s.source_type) || '__UNKNOWN__';
      // 首个 signal 优先 (created_at ASC), 同 trade_id 被多 signal 持有时不覆盖
      if (tradeId !== null && tradeIdSet.has(tradeId) && !out.has(tradeId)) {
        out.set(tradeId, sourceType);
      }
      if (sellTradeId !== null && tradeIdSet.has(sellTradeId) && !out.has(sellTradeId)) {
        out.set(sellTradeId, sourceType);
      }
    }
    return out;
  }

  async loadStockMetadata(symbols: string[]) {
    if (!symbols || symbols.length === 0) return new Map();
    const unique = Array.from(new Set(symbols.filter(s => !!s)));
    const stocks = (await Stock.findAll({
      where: { symbol: { [Op.in]: unique } },
      attributes: ['symbol', 'name', 'industry'],
      raw: true,
    })) as unknown as Array<{ symbol: string; name: string; industry?: string }>;
    const map = new Map<string, { name: string; industry: string | null }>();
    for (const s of stocks) {
      map.set(s.symbol, { name: s.name || '', industry: s.industry || null });
    }
    return map;
  }

  /**
   * US-088 PM-012 — 取上周 [start_date, end_date] 区间内每只 symbol 的日 close.
   *
   * 实现:
   *   1. Stock.symbol IN (...) 取 stock_id ↔ symbol 映射;
   *   2. DailyBar 按 stock_id IN (...) AND time BETWEEN [start, end] 拉所有日线;
   *   3. 按 stock_id 分组聚合, 按 symbol 重新归并到 Map.
   *
   * fail-OPEN 不在本层 try/catch — caller (runForUser 内 ---- US-088 块) 有顶层
   * try/catch, helper throw 让 caller 把 correlation_matrix 置 null. 单测验证
   * caller 顶层 catch 真的能兜底 (testSendDailyClosesThrowsCorrelationNull).
   *
   * NOTE: DailyBar.time 是 DATE 类型 (含时分秒), 上海时区. 用 moment.tz +
   * startOf/endOf('day') 算 [00:00:00, 23:59:59] 区间防边界丢点.
   */
  async loadDailyCloses(
    symbols: string[],
    start_date: string,
    end_date: string
  ): Promise<Map<string, DailyCloseRow[]>> {
    const out = new Map<string, DailyCloseRow[]>();
    if (!symbols || symbols.length === 0) return out;
    const unique = Array.from(new Set(symbols.filter(s => !!s)));
    if (unique.length === 0) return out;

    const stocks = (await Stock.findAll({
      where: { symbol: { [Op.in]: unique } },
      attributes: ['id', 'symbol'],
      raw: true,
    })) as unknown as Array<{ id: number; symbol: string }>;
    if (stocks.length === 0) return out;
    const idToSymbol = new Map<number, string>();
    for (const s of stocks) idToSymbol.set(Number(s.id), s.symbol);

    const dayStart = moment.tz(start_date, 'Asia/Shanghai').startOf('day').toDate();
    const dayEnd = moment.tz(end_date, 'Asia/Shanghai').endOf('day').toDate();
    const bars = (await DailyBar.findAll({
      where: {
        stock_id: { [Op.in]: Array.from(idToSymbol.keys()) },
        time: { [Op.gte]: dayStart, [Op.lte]: dayEnd },
      },
      attributes: ['stock_id', 'time', 'close'],
      order: [['time', 'ASC']],
      raw: true,
    })) as unknown as Array<{ stock_id: number; time: Date | string; close: number | string }>;

    for (const bar of bars) {
      const symbol = idToSymbol.get(Number(bar.stock_id));
      if (!symbol) continue;
      const close = Number(bar.close);
      if (!Number.isFinite(close)) continue;
      const date = moment.tz(bar.time, 'Asia/Shanghai').format('YYYY-MM-DD');
      const arr = out.get(symbol) || [];
      arr.push({ date, close });
      out.set(symbol, arr);
    }
    return out;
  }

  async loadUpcomingEvents(symbols: string[], from_date: string, to_date: string) {
    const out: UpcomingEventRow[] = [];
    if (!symbols || symbols.length === 0) return out;
    const unique = Array.from(new Set(symbols.filter(s => !!s)));
    const codes = unique.map(s => stripSuffix(s)).filter(s => !!s);
    if (codes.length === 0) return out;
    try {
      const rows = (await EarningsForecast.findAll({
        where: {
          stock_code: { [Op.in]: codes },
          announce_date: { [Op.gte]: from_date, [Op.lte]: to_date },
        },
        attributes: [
          'stock_code',
          'stock_name',
          'forecast_type',
          'announce_date',
          'report_period',
          'profit_change_low',
          'profit_change_high',
        ],
        order: [['announce_date', 'ASC']],
        raw: true,
      })) as unknown as Array<{
        stock_code: string;
        stock_name?: string;
        forecast_type?: string;
        announce_date?: string;
        report_period?: string;
        profit_change_low?: number;
        profit_change_high?: number;
      }>;
      for (const r of rows) {
        const sym = unique.find(s => stripSuffix(s) === r.stock_code) || r.stock_code;
        const lo =
          r.profit_change_low !== undefined && r.profit_change_low !== null
            ? Number(r.profit_change_low)
            : null;
        const hi =
          r.profit_change_high !== undefined && r.profit_change_high !== null
            ? Number(r.profit_change_high)
            : null;
        let pctText = '';
        if (lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi)) {
          pctText = `净利变动 ${lo > 0 ? '+' : ''}${lo.toFixed(1)}% ~ ${
            hi > 0 ? '+' : ''
          }${hi.toFixed(1)}%`;
        } else if (lo !== null && Number.isFinite(lo)) {
          pctText = `净利变动 ≥ ${lo > 0 ? '+' : ''}${lo.toFixed(1)}%`;
        } else if (hi !== null && Number.isFinite(hi)) {
          pctText = `净利变动 ≤ ${hi > 0 ? '+' : ''}${hi.toFixed(1)}%`;
        }
        const detail =
          [safeString(r.forecast_type), safeString(r.report_period), pctText]
            .filter(Boolean)
            .join(' · ') || '业绩预告';
        out.push({
          symbol: sym,
          name: safeString(r.stock_name) || sym,
          event_type: 'earnings_forecast',
          detail,
          announce_date: r.announce_date || null,
        });
      }
    } catch (err: any) {
      logger.warn(
        `[WeeklyReview] loadUpcomingEvents 失败 from=${from_date} to=${to_date}: ${
          err?.message || err
        }`
      );
    }
    return out;
  }

  async generateAIWeeklyOpinion(payload: {
    pnl_pct: number | null;
    industry_contribution: IndustryContributionRow[];
    top_winners: SymbolContributionRow[];
    top_losers: SymbolContributionRow[];
    upcoming_events: UpcomingEventRow[];
  }): Promise<AIWeeklyOpinion> {
    // 当前版本：直接走启发式（保证邮件 cron 0 远端依赖）。
    // 后续 story 可在此处 try { 远端 } catch { heuristic } 双路，与
    // US-061 TechnicalAnalysisService 同款双路范式。
    return buildHeuristicWeeklyOpinion(payload);
  }

  async sendEmail(payload: WeeklyReviewPayload, to: string): Promise<EmailNotificationSendResult> {
    return emailNotificationService.sendEmail(payload, to, {
      buildEmail: buildWeeklyReviewEmail,
    });
  }
}

function stripSuffix(symbol: string): string {
  if (!symbol) return '';
  const s = symbol.trim();
  if (!s) return '';
  const i = s.indexOf('.');
  if (i < 0) return s;
  const before = s.slice(0, i);
  const after = s.slice(i + 1);
  if (/^[a-zA-Z]{2}$/.test(before)) return after;
  return before;
}

export const PRODUCTION_WEEKLY_REVIEW_DATA_SOURCE: WeeklyReviewDataSource =
  new DefaultWeeklyReviewDataSource();

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WeeklyReviewReportService {
  private readonly dataSource: WeeklyReviewDataSource;

  constructor(dataSource: WeeklyReviewDataSource = PRODUCTION_WEEKLY_REVIEW_DATA_SOURCE) {
    this.dataSource = dataSource;
  }

  /**
   * 主入口 — 给所有符合条件的用户发上周复盘邮件。
   * 任一 user 失败不阻塞其他 user（fail-OPEN per-user try/catch）。
   */
  async sendWeeklyReviewReports(
    options: SendWeeklyReviewOptions = {}
  ): Promise<SendWeeklyReviewResult> {
    const refDate = options.reference_date || nowShanghaiDate();
    const week = computePrevWeekRange(refDate);
    const dryRun = options.dry_run === true;
    const lookahead = Math.max(1, Math.min(30, Math.floor(options.upcoming_lookahead_days ?? 7)));

    let users: Array<{ user_id: number; username: string; config: NotificationChannelsConfig }> =
      [];
    try {
      users = await this.dataSource.listEligibleUsers({ user_id: options.user_id });
    } catch (err: any) {
      logger.error(`[WeeklyReview] listEligibleUsers 失败: ${err?.message || err}`);
      return {
        week,
        scanned_users: 0,
        sent_count: 0,
        skipped_count: 0,
        failed_count: 0,
        dry_run: dryRun,
        per_user: [],
      };
    }

    const perUser: WeeklyReviewForUserResult[] = [];
    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const user of users) {
      try {
        const result = await this.sendForUser({
          user_id: user.user_id,
          username: user.username,
          config: user.config,
          week,
          dry_run: dryRun,
          reference_date: refDate,
          upcoming_lookahead_days: lookahead,
        });
        perUser.push(result);
        if (result.status === WEEKLY_REVIEW_STATUS.SENT) sentCount += 1;
        else if (result.status === WEEKLY_REVIEW_STATUS.SKIPPED) skippedCount += 1;
        else failedCount += 1;
      } catch (err: any) {
        logger.error(
          `[WeeklyReview] sendForUser user=${user.user_id} 二重 throw: ${err?.message || err}`
        );
        failedCount += 1;
        perUser.push({
          report_id: buildReportId(user.user_id, week.end_date, randHex4()),
          status: WEEKLY_REVIEW_STATUS.FAILED,
          sent: false,
          user_id: user.user_id,
          username: user.username,
          week,
          error: String(err?.message || err),
        });
      }
    }

    return {
      week,
      scanned_users: users.length,
      sent_count: sentCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      dry_run: dryRun,
      per_user: perUser,
    };
  }

  /**
   * 单用户周报生成 + 发送（如未跳过）。
   * 失败不 throw，转 WeeklyReviewForUserResult.error 返回（fail-OPEN）。
   */
  async sendForUser(options: {
    user_id: number;
    username: string;
    config: NotificationChannelsConfig;
    week: PrevWeekRange;
    dry_run: boolean;
    reference_date: string;
    upcoming_lookahead_days: number;
  }): Promise<WeeklyReviewForUserResult> {
    const { user_id, username, config, week, dry_run, reference_date, upcoming_lookahead_days } =
      options;
    const reportId = buildReportId(user_id, week.end_date, randHex4());

    const gate = shouldSendWeeklyReviewForUser(config);
    if (!gate.shouldSend) {
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        week,
        skip_reason: gate.reason,
      };
    }

    // ---- 取该 user 的 portfolio + positions ----
    let summary: { portfolio: PaperTradingPortfolio; positions: PaperTradingPosition[] } | null;
    try {
      summary = await this.dataSource.loadPortfolio(user_id);
    } catch (err: any) {
      logger.warn(`[WeeklyReview] loadPortfolio user=${user_id} 失败: ${err?.message || err}`);
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        week,
        error: `加载模拟盘失败：${err?.message || err}`,
      };
    }
    if (!summary || !summary.portfolio) {
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        week,
        skip_reason: '用户尚未建立模拟盘',
      };
    }

    // ---- 取 snapshots + trades ----
    let snapshots: WeeklyEquityPoint[] = [];
    try {
      snapshots = await this.dataSource.loadWeeklySnapshots(
        summary.portfolio.id,
        week.start_date,
        week.end_date
      );
    } catch (err: any) {
      logger.warn(
        `[WeeklyReview] loadWeeklySnapshots user=${user_id} 失败: ${err?.message || err}`
      );
    }

    let trades: PaperTradingTrade[] = [];
    try {
      trades = await this.dataSource.loadWeeklyTrades(
        summary.portfolio.id,
        week.start_date,
        week.end_date
      );
    } catch (err: any) {
      logger.warn(`[WeeklyReview] loadWeeklyTrades user=${user_id} 失败: ${err?.message || err}`);
    }

    // 聚合个股 / 行业的 trade rows（含未持仓代码 — 上周可能已卖光）
    const tradeRows = trades.map(t => ({
      symbol: t.symbol,
      name: t.name,
      direction: t.direction,
      realized_pnl: Number(t.realized_pnl),
    }));
    const symbolsForMetaSet = new Set<string>();
    for (const t of tradeRows) symbolsForMetaSet.add(t.symbol);
    for (const p of summary.positions) symbolsForMetaSet.add(p.symbol);

    let stockMeta = new Map<string, { name: string; industry: string | null }>();
    try {
      stockMeta = await this.dataSource.loadStockMetadata(Array.from(symbolsForMetaSet));
    } catch (err: any) {
      logger.warn(`[WeeklyReview] loadStockMetadata user=${user_id} 失败: ${err?.message || err}`);
    }

    // ---- US-087 PM-011: trade_id → strategy_key 反向 lookup (fail-OPEN, 缺映射 → '__MANUAL__') ----
    let tradeStrategyMap = new Map<number, string>();
    const tradeIdsForLookup = trades.map(t => Number(t.id)).filter(id => Number.isFinite(id));
    if (tradeIdsForLookup.length > 0) {
      try {
        tradeStrategyMap = await this.dataSource.loadTradeStrategyMap(
          summary.portfolio.id,
          tradeIdsForLookup
        );
      } catch (err: any) {
        logger.warn(
          `[WeeklyReview] loadTradeStrategyMap user=${user_id} 失败: ${err?.message || err}`
        );
      }
    }

    const pnl = computeWeeklyPnL(snapshots);
    const industryContrib = aggregateIndustryContribution(tradeRows, stockMeta);
    const strategyContrib = aggregateStrategyContribution(
      trades.map(t => ({
        symbol: t.symbol,
        direction: t.direction,
        realized_pnl: Number(t.realized_pnl),
        strategy_key: tradeStrategyMap.get(Number(t.id)) || '__MANUAL__',
      }))
    );
    const topWinners = aggregateSymbolContribution(tradeRows, stockMeta, 'desc', 5);
    const topLosers = aggregateSymbolContribution(tradeRows, stockMeta, 'asc', 3);
    const realizedPnlTotal = roundMoney(
      tradeRows.reduce(
        (sum, t) => sum + (t.direction === 'SELL' ? safeNumber(t.realized_pnl) : 0),
        0
      )
    );
    const tradeCount = tradeRows.length;

    // ---- 上周关注事件（持仓 + 上周交易过的股，本周内有公告日期的） ----
    const watchSymbols = Array.from(symbolsForMetaSet);
    const todayDate = moment.tz(reference_date, 'YYYY-MM-DD', 'Asia/Shanghai').format('YYYY-MM-DD');
    const lookaheadEnd = moment
      .tz(reference_date, 'YYYY-MM-DD', 'Asia/Shanghai')
      .add(upcoming_lookahead_days, 'days')
      .format('YYYY-MM-DD');
    let events: UpcomingEventRow[] = [];
    try {
      events = await this.dataSource.loadUpcomingEvents(watchSymbols, todayDate, lookaheadEnd);
    } catch (err: any) {
      logger.warn(`[WeeklyReview] loadUpcomingEvents user=${user_id} 失败: ${err?.message || err}`);
    }

    // ---- AI 周观点 ----
    let aiOpinion: AIWeeklyOpinion;
    try {
      aiOpinion = await this.dataSource.generateAIWeeklyOpinion({
        pnl_pct: pnl.pnl_pct,
        industry_contribution: industryContrib,
        top_winners: topWinners,
        top_losers: topLosers,
        upcoming_events: events,
      });
    } catch (err: any) {
      logger.warn(
        `[WeeklyReview] generateAIWeeklyOpinion user=${user_id} 失败 → heuristic 兜底: ${
          err?.message || err
        }`
      );
      aiOpinion = buildHeuristicWeeklyOpinion({
        pnl_pct: pnl.pnl_pct,
        industry_contribution: industryContrib,
        top_winners: topWinners,
        top_losers: topLosers,
        upcoming_events: events,
      });
    }

    // ---- US-088 PM-012: 持仓股相关性矩阵 (fail-OPEN, throw → correlation_matrix=null) ----
    let correlationMatrix: CorrelationMatrixPayload | null = null;
    try {
      const tradedSymbols = Array.from(new Set(tradeRows.map(t => t.symbol).filter(s => !!s)));
      const positionInputs = (summary.positions || []).map(p => ({
        symbol: p.symbol,
        market_value: Number((p as any).market_value),
      }));
      const { selected } = selectCorrelationSymbols(positionInputs, tradedSymbols);
      if (selected.length > 0) {
        const closesMap = await this.dataSource.loadDailyCloses(
          selected,
          week.start_date,
          week.end_date
        );
        correlationMatrix = buildCorrelationMatrixPayload(positionInputs, tradedSymbols, closesMap);
      }
    } catch (err: any) {
      logger.warn(
        `[WeeklyReview] loadDailyCloses/computeCorrelationMatrix user=${user_id} 失败: ${
          err?.message || err
        }`
      );
      correlationMatrix = null;
    }

    const payload: WeeklyReviewPayload = {
      user_id,
      username,
      week,
      pnl,
      equity_curve: snapshots,
      industry_contribution: industryContrib,
      strategy_contribution: strategyContrib,
      correlation_matrix: correlationMatrix,
      top_winners: topWinners,
      top_losers: topLosers,
      trade_count: tradeCount,
      realized_pnl_total: realizedPnlTotal,
      upcoming_events: events,
      ai_opinion: aiOpinion,
    };

    if (dry_run) {
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.SENT,
        sent: false,
        user_id,
        username,
        week,
        payload,
        skip_reason: 'dry_run',
      };
    }

    const toAddress = safeString(config.email.address);

    let sendRes: EmailNotificationSendResult;
    try {
      sendRes = await this.dataSource.sendEmail(payload, toAddress);
    } catch (err: any) {
      logger.warn(`[WeeklyReview] sendEmail user=${user_id} 失败: ${err?.message || err}`);
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.FAILED,
        sent: false,
        user_id,
        username,
        week,
        payload,
        email_used: toAddress,
        error: `邮件发送异常：${err?.message || err}`,
      };
    }

    if (sendRes.success) {
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.SENT,
        sent: true,
        user_id,
        username,
        week,
        payload,
        email_used: toAddress,
        email_response: sendRes.data,
      };
    }
    if (sendRes.skipped) {
      return {
        report_id: reportId,
        status: WEEKLY_REVIEW_STATUS.SKIPPED,
        sent: false,
        user_id,
        username,
        week,
        payload,
        email_used: toAddress,
        skip_reason: sendRes.message,
      };
    }
    return {
      report_id: reportId,
      status: WEEKLY_REVIEW_STATUS.PARTIAL,
      sent: false,
      user_id,
      username,
      week,
      payload,
      email_used: toAddress,
      email_response: sendRes.data,
      error: sendRes.message || '邮件发送失败',
    };
  }

  /**
   * AC 必需：POST /api/settings/email-config endpoint 用 ——
   * 接受 { enabled?, address?, weekly_review?, risk_alert? } 四字段 patch，merge 到 user
   * 的 notification_channels.email 后落盘。`risk_alert` 在 US-067 加入。
   */
  async updateEmailConfig(
    user_id: number,
    patch: Partial<{
      enabled: boolean;
      address: string;
      weekly_review: boolean;
      risk_alert: boolean;
    }>
  ): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextEmail = { ...existing.email, ...(patch || {}) };
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: nextEmail,
      wechat: { ...existing.wechat },
      sms: { ...existing.sms },
    };
    const normalized = normalizeNotificationConfig({ notification_channels: next });
    const rc =
      (user as any).risk_config && typeof (user as any).risk_config === 'object'
        ? { ...(user as any).risk_config }
        : {};
    rc.notification_channels = normalized;
    (user as any).risk_config = rc;
    user.changed('risk_config', true);
    await user.save();
    return normalized;
  }
}

export const weeklyReviewReportService = new WeeklyReviewReportService();
