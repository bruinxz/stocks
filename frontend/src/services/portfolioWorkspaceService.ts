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

export async function getPortfolio(): Promise<PortfolioWithPositions> {
  const res = await api.get('/paper-trading');
  return unwrap<PortfolioWithPositions>(res, '获取模拟盘数据失败');
}

export async function getSnapshots(): Promise<SnapshotRow[]> {
  const res = await api.get('/paper-trading/snapshots');
  return unwrap<SnapshotRow[]>(res, '获取资金曲线快照失败');
}

export async function getTradeHistory(): Promise<TradeRow[]> {
  const res = await api.get('/paper-trading/history');
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
};

export default portfolioWorkspaceService;

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
