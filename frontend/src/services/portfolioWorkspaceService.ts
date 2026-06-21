import api from './api';

/**
 * US-017 持仓与复盘工作区前端 API 客户端。
 *
 * 包装既有 PaperTrading + Journal 端点 + US-017 / US-076 新增的 endpoint：
 *   - GET  /paper-trading                               → getPortfolio()
 *   - GET  /paper-trading/snapshots                     → getSnapshots()
 *   - GET  /paper-trading/history                       → getTradeHistory()
 *   - POST /paper-trading/trade                         → placeTrade() (用于一键平仓)
 *   - PUT  /paper-trading/positions/:id/stop-loss       → setPositionStopLoss()  ← US-017 新增
 *   - PUT  /paper-trading/positions/:id/take-profit     → setPositionTakeProfit() ← US-076 新增
 *   - GET  /journals                                    → listJournals()
 *   - GET  /journals/:date                              → getJournalDetail()
 *   - POST /journals/:date/notes                        → appendJournalNote()    ← US-017 新增
 *   - GET  /market/history/:symbol                      → fetchBenchmarkHistory() (沪深 300 净值对比)
 *
 * 所有响应遵循后端统一信封 `{ success, data, message? }`，service 层把
 * `data` 解出来直接返回给组件。`success=false` 抛 JS Error（保持与
 * factorService / labService 一致）。
 */

// ---------- 类型定义 ----------

export interface PortfolioInfo {
  id: number;
  name: string;
  initial_capital: number;
  current_cash: number;
  total_value: number;
  is_active: boolean;
}

export interface PositionRow {
  id: number;
  symbol: string;
  name: string | null;
  quantity: number;
  avg_cost: number;
  current_price: number;
  market_value: number;
  unrealized_pnl: number;
  stop_loss_price: number | null;
  take_profit_price: number | null;
  /**
   * 追踪止损 — 持仓期间观察到的最高收盘价 (US-048).
   * 由 TrailingStopGuard 每日收盘后写; 新仓首日尚未跑 guard 之前为 null.
   * US-058 用作"当前回撤" 的分母 (DD% = (highest - current) / highest * 100).
   */
  highest_price?: number | null;
  /** 追踪止损回撤比例 (US-048), 0-1 间. */
  trailing_stop_pct?: number | null;
  /** 追踪止损触发价 = highest_price * (1 - effective_pct), US-048 写入. */
  trailing_stop_price?: number | null;
  /**
   * 当日 ATR(14) / current_price * 100, % 单位.  由 PaperTradingFacade.getPortfolio
   * 在 US-058 加入: 服务端读 30 天日 bars 算 ATR(14), 缺数据返 null.
   */
  atr_pct?: number | null;
  created_at: string;
  updated_at: string;
}

export interface PortfolioWithPositions {
  portfolio: PortfolioInfo;
  positions: PositionRow[];
}

export interface SnapshotRow {
  id: number;
  portfolio_id: number;
  date: string;
  total_value: number;
  current_cash: number;
  position_value: number;
}

export interface TradeRow {
  id: number;
  portfolio_id: number;
  symbol: string;
  name: string;
  direction: 'BUY' | 'SELL';
  execute_price: number;
  quantity: number;
  amount: number;
  commission: number;
  realized_pnl: number | null;
  created_at: string;
  /** AL-3 (2026-06-21): 操作理由 JSONB. 历史 trade 是 {}; 新 trade 必有 source. */
  trade_reason?: TradeReasonPayload;
  /** AL-3 (2026-06-21): 一句话总结. 历史 trade 是 null. */
  trade_reason_summary?: string | null;
}

// AL-3 (2026-06-21): TradeReason 前端类型 — 与
// backend/src/portfolio/internal/tradeReasonBuilder.ts 对齐.
export type TradeReasonSource =
  | 'manual'
  | 'auto_buy_from_signals'
  | 'analysis_engine_hard'
  | 'rebalance'
  | 'trailing_stop'
  | 'drawdown_breaker'
  | 'industry_concentration'
  | 'per_stock_stop_loss'
  | 'black_swan'
  | 'restricted_share'
  | 'market_regime_alert'
  | 'kill_switch'
  | 'close_position'
  | 'take_profit'
  | 'stop_loss'
  | 'trailing_take_profit'
  | 'sell_signal'
  | 'technical_breakdown'
  | 'unknown';

export interface TradeReasonEvidenceItem {
  label: string;
  detail?: string;
  weight?: number;
}

export interface TradeReasonPayload {
  source: TradeReasonSource;
  strategy_key?: string;
  signal_id?: number;
  ai_report_id?: string;
  evidence?: TradeReasonEvidenceItem[];
  confidence?: number;
  key_reasons?: string[];
  risk_trigger?: { type: string; threshold?: number; actual?: number; indicator?: string };
  ai_summary?: string;
}

export interface JournalSummary {
  id: number;
  date: string;
  mood: string | null;
  tags: string[] | null;
}

export interface JournalUserNote {
  content: string;
  created_at: string;
}

export interface JournalDetail {
  id: number;
  user_id: number;
  date: string;
  market_summary: string;
  portfolio_analysis: string;
  action_plan: string | null;
  tags: string[] | null;
  mood: string | null;
  user_notes: JournalUserNote[];
}

export interface BenchmarkHistoryPoint {
  date: string;
  close: number;
}

export interface SetStopLossPayload {
  /** null 表示清除止损 */
  stop_loss_price: number | null;
}

export interface SetStopLossResponse {
  position_id: number;
  symbol: string;
  stop_loss_price: number | null;
  current_price: number;
}

export interface SetTakeProfitPayload {
  /** null 表示清除止盈 */
  take_profit_price: number | null;
}

export interface SetTakeProfitResponse {
  position_id: number;
  symbol: string;
  take_profit_price: number | null;
  current_price: number;
}

export interface AppendJournalNoteResponse {
  date: string;
  user_notes: JournalUserNote[];
  appended: JournalUserNote;
}

export interface PlaceTradePayload {
  symbol: string;
  direction: 'BUY' | 'SELL';
  quantity: number;
  /** 多账户多盘必传 (2026-06-17 串盘修复). 不传 → 后端 fallback 到 active id ASC 第一个盘. */
  portfolio_id?: number;
}

export interface PlaceTradeResponse {
  direction: 'BUY' | 'SELL';
  symbol: string;
  quantity: number;
  execute_price: number;
  commission: number;
  realized_pnl?: number;
}

// ---------- API 函数 ----------

function unwrap<T>(
  res: { data?: { success?: boolean; data?: T; message?: string } },
  fallback: string
): T {
  if (!res.data?.success) {
    throw new Error(res.data?.message || fallback);
  }
  return res.data.data as T;
}

/** 修复 (2026-06-17 串盘): portfolio 列表条目, 供 PortfolioWorkspace 顶部选盘下拉 */
export interface PortfolioListItem {
  id: number;
  name: string;
  initial_capital: number;
  current_cash: number;
  total_value: number;
  positions_count: number;
  created_at: string;
}

export async function getPortfolio(portfolio_id?: number): Promise<PortfolioWithPositions> {
  // portfolio_id 显式传防多账户多盘串盘. 不传时后端 fallback 到 user 名下 active id ASC 第一个.
  const url = portfolio_id ? `/paper-trading?portfolio_id=${portfolio_id}` : '/paper-trading';
  const res = await api.get(url);
  return unwrap<PortfolioWithPositions>(res, '获取模拟盘数据失败');
}

export async function listPortfolios(): Promise<PortfolioListItem[]> {
  const res = await api.get('/paper-trading/portfolios');
  return unwrap<PortfolioListItem[]>(res, '获取模拟盘列表失败');
}

export async function getSnapshots(portfolio_id?: number): Promise<SnapshotRow[]> {
  const url = portfolio_id
    ? `/paper-trading/snapshots?portfolio_id=${portfolio_id}`
    : '/paper-trading/snapshots';
  const res = await api.get(url);
  return unwrap<SnapshotRow[]>(res, '获取资金曲线快照失败');
}

export async function getTradeHistory(portfolio_id?: number): Promise<TradeRow[]> {
  const url = portfolio_id
    ? `/paper-trading/history?portfolio_id=${portfolio_id}`
    : '/paper-trading/history';
  const res = await api.get(url);
  return unwrap<TradeRow[]>(res, '获取交易流水失败');
}

export async function placeTrade(payload: PlaceTradePayload): Promise<PlaceTradeResponse> {
  const res = await api.post('/paper-trading/trade', payload);
  return unwrap<PlaceTradeResponse>(res, '交易失败');
}

export async function setPositionStopLoss(
  positionId: number,
  payload: SetStopLossPayload
): Promise<SetStopLossResponse> {
  const res = await api.put(`/paper-trading/positions/${positionId}/stop-loss`, payload);
  return unwrap<SetStopLossResponse>(res, '设置止损价失败');
}

export async function setPositionTakeProfit(
  positionId: number,
  payload: SetTakeProfitPayload
): Promise<SetTakeProfitResponse> {
  const res = await api.put(`/paper-trading/positions/${positionId}/take-profit`, payload);
  return unwrap<SetTakeProfitResponse>(res, '设置止盈价失败');
}

export async function listJournals(): Promise<JournalSummary[]> {
  // 后端目前返回完整对象数组，service 端只 expose 摘要字段供 UI 列表使用。
  const res = await api.get('/journals');
  const rows = unwrap<JournalDetail[]>(res, '获取复盘日记列表失败');
  return rows.map(r => ({
    id: r.id,
    date: r.date,
    mood: r.mood,
    tags: r.tags,
  }));
}

export async function getJournalDetail(date: string): Promise<JournalDetail | null> {
  try {
    const res = await api.get(`/journals/${date}`);
    return unwrap<JournalDetail>(res, '获取复盘日记详情失败');
  } catch (err: any) {
    // 404 = 该日期还没有日记 — 返回 null 让 UI 显示空态而不是错误
    const status = err?.response?.status;
    if (status === 404) {
      return null;
    }
    throw err;
  }
}

export async function appendJournalNote(
  date: string,
  content: string
): Promise<AppendJournalNoteResponse> {
  const res = await api.post(`/journals/${date}/notes`, { content });
  return unwrap<AppendJournalNoteResponse>(res, '追加手记失败');
}

/**
 * 拉取基准指数的日 K 收盘价序列。
 * 默认沪深 300 (`sh.000300`)，调用方可传别的 symbol 复用。
 */
export async function fetchBenchmarkHistory(
  symbol: string,
  startDate: string,
  endDate: string
): Promise<BenchmarkHistoryPoint[]> {
  const res = await api.get(`/market/history/${symbol}`, {
    params: { start_date: startDate, end_date: endDate, frequency: 'd' },
  });
  // /market/history 历史上不一定走统一 {success, data} 信封，做柔性解析
  const payload = res.data?.data ?? res.data;
  const bars = payload?.bars || payload?.history || payload || [];
  if (!Array.isArray(bars)) {
    return [];
  }
  return bars
    .map((b: any) => ({
      date: String(b.time || b.date || b.trade_date || '').slice(0, 10),
      close: Number(b.close ?? b.Close ?? 0),
    }))
    .filter((p: BenchmarkHistoryPoint) => p.date && Number.isFinite(p.close));
}

// ---------- bundled export ----------

export const portfolioWorkspaceService = {
  getPortfolio,
  listPortfolios,
  getSnapshots,
  getTradeHistory,
  placeTrade,
  setPositionStopLoss,
  setPositionTakeProfit,
  listJournals,
  getJournalDetail,
  appendJournalNote,
  fetchBenchmarkHistory,
  getCorrelationReport,
  getIndustryConcentrationSummary,
  getDailyAttributionReport,
};

export default portfolioWorkspaceService;

// ============================================================
// US-012: Industry concentration KPI snapshot
// ============================================================

export interface IndustryBreakdownEntry {
  industry: string;
  total_value: number;
  /** 0-1 */
  pct: number;
  position_count: number;
  symbols: string[];
}

export interface IndustryConcentrationSummary {
  user_id: number;
  portfolio_id: number | null;
  enabled: boolean;
  /** 告警阈值 0-1，默认 0.35。 */
  alert_pct: number;
  rebalance_target_pct: number;
  /** 当前最大行业占比 0-1；null = 空持仓 / 无 portfolio。 */
  max_industry_pct: number | null;
  /** 对应行业名（null = 同上；`__UNKNOWN__` = 未分类）。 */
  max_industry_name: string | null;
  /** 当前是否超 alert_pct（严格 `>`，禁用配置强制 false）。 */
  over_alert: boolean;
  open_positions_count: number;
  total_position_value: number;
  industry_breakdown: IndustryBreakdownEntry[];
}

/** 哨兵 industry 名（与后端 IndustryConcentrationGuard 同步）。 */
export const UNKNOWN_INDUSTRY_LABEL = '__UNKNOWN__';

/**
 * 拉取行业集中度 KPI 快照（US-012）— 顶部 KPI 卡专用。
 *
 * 后端 `GET /api/portfolio/industry-concentration-summary` — dry-run，不写
 * RiskAlert，UI 可任意频率轮询。
 */
export async function getIndustryConcentrationSummary(): Promise<IndustryConcentrationSummary> {
  const res = await api.get('/portfolio/industry-concentration-summary');
  return unwrap<IndustryConcentrationSummary>(res, '获取行业集中度 KPI 失败');
}

// ============================================================
// Phase 6: Portfolio correlation matrix + cluster
// ============================================================

export interface CorrelationCluster {
  members: string[];
  avg_correlation: number;
  total_market_value: number;
  pct_of_portfolio: number;
  dominant_industry?: string;
}

export interface CorrelationReport {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  position_count: number;
  insufficient_data_symbols: string[];
  lookback_days: number;
  matrix: {
    symbols: string[];
    matrix: Array<Array<number | null>>;
  };
  high_correlation_clusters: CorrelationCluster[];
  avg_off_diagonal_correlation: number | null;
  diversification_level: 'high' | 'medium' | 'low' | 'insufficient';
}

export async function getCorrelationReport(params: {
  portfolio_id?: number;
  lookback_days?: number;
  cluster_threshold?: number;
} = {}): Promise<CorrelationReport> {
  const res = await api.get('/portfolio/correlation', { params });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取相关性报告失败');
  }
  return res.data.data as CorrelationReport;
}

// ============================================================
// Phase 8: Exposure coach (gross / net / leverage / β)
// ============================================================

export interface ExposureReport {
  generated_at: string;
  portfolio_id: number;
  user_id: number;
  total_equity: number;
  current_cash: number;
  cash_pct: number;
  position_count: number;
  gross_exposure: number;
  net_exposure: number;
  leverage_ratio: number;
  beta_exposure: number;
  beta_missing_count: number;
  warnings: string[];
}

export async function getExposureReport(portfolioId?: number): Promise<ExposureReport> {
  const res = await api.get('/portfolio/exposure', {
    params: portfolioId ? { portfolio_id: portfolioId } : {},
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取 exposure 失败');
  }
  return res.data.data as ExposureReport;
}

// ============================================================
// US-123 [PM-010] PortfolioWorkspace 归因卡 — 后端 6 维归因报告
// ============================================================
//
// 调 GET /api/portfolio/:id/attribution/daily (PM-007 / US-084 route),
// 读 daily_attribution_reports 表 (PM-003 schema). 报告由 cron
// DAILY_ATTRIBUTION_GENERATE (US-083 / PM-006) 在 17:00 工作日 upsert.
//
// 关键契约 (与 backend DailyAttributionService.DailyAttributionReport 对齐):
//   - breakdown JSONB 含 6 维 + factor_contrib_total + industry_contrib[] +
//     execution_cost + residual; 真值由 AttributionEngine (PM-002) 填.
//   - best_trades / worst_trades 各取 top 3.
//   - ai_summary ≤ 200 字; PM-005 (AIAttributionSummary) 替换成 LLM 输出.
//   - status='ok'/'skipped'/'failed', skipped/failed 时仍写一行做"今日未跑"留痕.
//
// 404 = "当日报告不存在" → 返 null 让 UI 显示 Empty 占位 + 用户感知 cron 状态.

export interface AttributionFactorContrib {
  factor: string;
  pnl: number;
  pct: number;
  /** 0-1 之间, 该因子在组合中的暴露权重 (PM-002 真填; placeholder=0) */
  exposure: number;
}

export interface AttributionIndustryContrib {
  industry: string;
  pnl: number;
  pct: number;
  trade_count: number;
}

export interface AttributionExecutionCostBreakdown {
  /** 总成本 (元) = commission_total + slippage_total */
  total_cost: number;
  /** 券商佣金 (元) */
  commission_total: number;
  /** 印花税 (元), 仅 SELL */
  stamp_duty_total: number;
  /** 过户费 (元) */
  transfer_fee_total: number;
  /** 滑点 (元), 仅当 caller 提供 ref_prices 时非 0 */
  slippage_total: number;
}

export interface AttributionBreakdown {
  factor_contrib: AttributionFactorContrib[];
  factor_contrib_total: number;
  industry_contrib: AttributionIndustryContrib[];
  timing_contrib: number;
  selection_contrib: number;
  sizing_contrib: number;
  execution_cost: number;
  execution_cost_breakdown: AttributionExecutionCostBreakdown | null;
  residual: number;
}

export interface AttributionBestWorstTrade {
  id: number;
  symbol: string;
  name?: string | null;
  realized_pnl: number;
  realized_pnl_pct?: number | null;
  amount: number;
  quantity: number;
}

export interface DailyAttributionReportRow {
  id: number;
  portfolio_id: number;
  date: string;
  total_pnl: number;
  total_pnl_pct: number | null;
  realized_pnl: number;
  unrealized_delta: number;
  trade_count: number;
  buy_count: number;
  sell_count: number;
  breakdown: AttributionBreakdown;
  best_trades: AttributionBestWorstTrade[];
  worst_trades: AttributionBestWorstTrade[];
  ai_summary: string;
  bias_findings: Array<Record<string, unknown>>;
  recommendations: string[];
  status: 'ok' | 'skipped' | 'failed' | string;
  reason: string | null;
  metadata: Record<string, unknown>;
  generated_at: string;
  source: string;
  created_at: string;
  updated_at: string;
}

/**
 * 拉取单个 portfolio 当日归因报告 (US-123 PM-010).
 *
 * @param portfolioId  PaperTradingPortfolio.id
 * @param date         YYYY-MM-DD, 默认后端今日 (Asia/Shanghai)
 * @returns            报告对象, 404 (报告未生成) 返 null 让 UI 走 Empty.
 *                     其它错误透传 (component 走 loadError 兜底).
 */
export async function getDailyAttributionReport(
  portfolioId: number,
  date?: string
): Promise<DailyAttributionReportRow | null> {
  try {
    const url = `/portfolio/${portfolioId}/attribution/daily`;
    const res = await api.get(url, { params: date ? { date } : {} });
    return unwrap<DailyAttributionReportRow>(res, '获取归因报告失败');
  } catch (err: any) {
    const status = err?.response?.status;
    if (status === 404) {
      // 报告未生成 — cron 未跑 / 当日新建账户 / 周末. 让 UI 显示 Empty + 解释文案.
      return null;
    }
    throw err;
  }
}
