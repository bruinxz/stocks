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
  const idx = symbol.indexOf('.');
  return idx > 0 ? symbol.slice(0, idx) : symbol;
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

    const pnl = computeWeeklyPnL(snapshots);
    const industryContrib = aggregateIndustryContribution(tradeRows, stockMeta);
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

    const payload: WeeklyReviewPayload = {
      user_id,
      username,
      week,
      pnl,
      equity_curve: snapshots,
      industry_contribution: industryContrib,
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
   * 接受 { enabled?, address?, weekly_review? } 三字段 patch，merge 到 user
   * 的 notification_channels.email 后落盘。
   */
  async updateEmailConfig(
    user_id: number,
    patch: Partial<{ enabled: boolean; address: string; weekly_review: boolean }>
  ): Promise<NotificationChannelsConfig> {
    const user = await User.findByPk(user_id);
    if (!user) throw new Error('用户不存在');
    const existing = normalizeNotificationConfig((user as any).risk_config);
    const nextEmail = { ...existing.email, ...(patch || {}) };
    const next: NotificationChannelsConfig = {
      feishu: { ...existing.feishu },
      email: nextEmail,
      wechat: { ...existing.wechat },
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
