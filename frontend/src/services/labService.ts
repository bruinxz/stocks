import api from './api';

/**
 * US-016 策略实验室前端 API 客户端。
 *
 * 调用现有 quant 后端端点 + US-016 新增的 compare 端点：
 *   - GET  /api/quant/strategies          → listQuantStrategies()
 *   - GET  /api/quant/backtests           → listBacktestTasks()
 *   - GET  /api/quant/backtests/:id       → getBacktestDetail(id)
 *   - POST /api/quant/backtests           → createBacktestTask(payload)
 *   - POST /api/quant/backtests/compare   → compareBacktests([ids])
 *
 * 所有响应遵循后端统一信封 `{ success, data, message? }`；service 层把 `data` 解出来直接返回。
 */

// ---------- /api/quant/strategies ------------------------------------------

export interface QuantStrategyItem {
  strategy_key: string;
  name: string;
  display_name?: string;
  description?: string;
  category?: string;
  enabled?: boolean;
  risk_level?: 'low' | 'medium' | 'high';
  tags?: string[];
  default_params?: Record<string, any>;
}

export async function listQuantStrategies(): Promise<QuantStrategyItem[]> {
  const res = await api.get('/quant/strategies');
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取策略列表失败');
  }
  return (res.data.data || []) as QuantStrategyItem[];
}

// ---------- /api/quant/backtests -------------------------------------------

export interface BacktestRunSummary {
  task_id?: number;
  status?: string;
  progress?: number;
  universe?: string;
  start_date?: string;
  end_date?: string;
  range_label?: string;
  strategy_count?: number;
  initial_capital?: number;
  duration_label?: string;
  best_strategy_key?: string | null;
  best_strategy_name?: string | null;
  best_return_pct?: number;
  best_excess_return_pct?: number;
  best_max_drawdown_pct?: number;
  best_sharpe_ratio?: number;
  best_trade_count?: number;
  result_count?: number;
  retryable?: boolean;
  conclusion?: string;
  last_error?: string | null;
}

export interface BacktestTask {
  id: number;
  task_name: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PENDING';
  progress: number;
  start_date: string;
  end_date: string;
  created_at: string;
  updated_at?: string;
  error_message?: string;
  universe?: string;
  strategy_keys?: string[];
  symbols?: string[];
  initial_capital?: number;
  parameters?: Record<string, any>;
  run_summary?: BacktestRunSummary;
}

export interface BacktestStrategyResult {
  strategy_key: string;
  strategy_name: string;
  total_return_pct: number;
  annual_return_pct?: number;
  excess_return_pct?: number;
  benchmark_return_pct?: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  win_rate: number;
  profit_factor?: number;
  trade_count: number;
  avg_holding_days?: number;
  equity_curve_json: Array<{ date: string; total_value: number }>;
  metrics_json?: Record<string, any>;
}

export interface BacktestDetail {
  task: BacktestTask;
  results: BacktestStrategyResult[];
  trades: any[];
  run_summary?: BacktestRunSummary;
}

export async function listBacktestTasks(limit = 50): Promise<BacktestTask[]> {
  const res = await api.get('/quant/backtests', { params: { limit } });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取回测任务列表失败');
  }
  return (res.data.data || []) as BacktestTask[];
}

export async function getBacktestDetail(id: number): Promise<BacktestDetail | null> {
  const res = await api.get(`/quant/backtests/${id}`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取回测详情失败');
  }
  return res.data.data as BacktestDetail;
}

// ---------- /api/quant/backtests POST (create) -----------------------------

export interface CreateBacktestPayload {
  task_name?: string;
  universe?: 'favorites' | 'all';
  strategy_keys: string[];
  start_date: string;
  end_date: string;
  initial_capital?: number;
  candidate_limit?: number;
  max_positions?: number;
  position_pct?: number;
  min_score?: number;
  execution_timing?: 'next_open' | 'same_close' | 'twap_proxy';
  enable_t_plus_one?: boolean;
  benchmark_symbol?: string;
  params_by_strategy?: Record<string, Record<string, any>>;
  async?: boolean;
}

export interface CreateBacktestResponse {
  task: BacktestDetail | BacktestTask | any;
  queue_job_id?: string | number;
}

export async function createBacktestTask(
  payload: CreateBacktestPayload
): Promise<CreateBacktestResponse> {
  const res = await api.post('/quant/backtests', payload);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '创建回测任务失败');
  }
  return res.data.data as CreateBacktestResponse;
}

// ---------- /api/quant/backtests/compare -----------------------------------

export interface BacktestCompareCell {
  task_id: number;
  present: boolean;
  total_return_pct: number | null;
  excess_return_pct: number | null;
  max_drawdown_pct: number | null;
  sharpe_ratio: number | null;
  win_rate: number | null;
  turnover_rate: number | null;
  trade_count: number | null;
}

export interface BacktestCompareItem {
  task_id: number;
  task_name: string;
  status: string;
  start_date: string;
  end_date: string;
  universe?: string;
  strategy_keys: string[];
  initial_capital: number;
  run_summary: BacktestRunSummary;
  strategy_results: Array<{
    strategy_key: string;
    strategy_name: string;
    total_return_pct: number;
    annual_return_pct: number;
    excess_return_pct: number;
    benchmark_return_pct: number;
    max_drawdown_pct: number;
    sharpe_ratio: number;
    win_rate: number;
    profit_factor: number;
    trade_count: number;
    avg_holding_days: number;
    turnover_rate: number;
  }>;
  best_strategy_key: string | null;
  best_strategy_name: string | null;
  best_equity_curve: Array<{ date: string; total_value: number }>;
}

export interface BacktestCompareResponse {
  items: BacktestCompareItem[];
  strategy_comparison: Array<{
    strategy_key: string;
    cells: BacktestCompareCell[];
  }>;
  task_count: number;
  missing_task_ids: number[];
}

export async function compareBacktests(taskIds: number[]): Promise<BacktestCompareResponse> {
  const res = await api.post('/quant/backtests/compare', { task_ids: taskIds });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '对比回测失败');
  }
  return res.data.data as BacktestCompareResponse;
}

// ---------- /api/quant/backtests/:id/drawdown-series (US-075) --------------

export interface BacktestDrawdownSeriesPoint {
  date: string;
  drawdown_pct: number; // >=0, 越大回撤越深
  total_value: number;
}

export interface BacktestDrawdownSeriesResponse {
  task_id: number;
  task_name: string;
  strategy_key: string;
  strategy_name: string;
  max_drawdown_pct: number;
  point_count: number;
  series: BacktestDrawdownSeriesPoint[];
}

export async function getBacktestDrawdownSeries(
  taskId: number
): Promise<BacktestDrawdownSeriesResponse> {
  const res = await api.get(`/quant/backtests/${taskId}/drawdown-series`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取回撤序列失败');
  }
  return res.data.data as BacktestDrawdownSeriesResponse;
}

// ---------- /api/quant/backtests/:id/monthly-returns (US-075) --------------

export interface BacktestMonthlyReturnCell {
  year: number;
  month: number; // 1-12
  return_pct: number;
}

export interface BacktestMonthlyReturnsResponse {
  task_id: number;
  task_name: string;
  strategy_key: string;
  strategy_name: string;
  years: number[];
  months: number[]; // [1..12]
  cells: BacktestMonthlyReturnCell[];
}

export async function getBacktestMonthlyReturns(
  taskId: number
): Promise<BacktestMonthlyReturnsResponse> {
  const res = await api.get(`/quant/backtests/${taskId}/monthly-returns`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取月度收益失败');
  }
  return res.data.data as BacktestMonthlyReturnsResponse;
}

// ---------- /api/quant/backtests/:id/rolling-sharpe-series (US-075) --------

export interface BacktestRollingSharpePoint {
  date: string;
  sharpe: number | null; // window 不足时为 null
}

export interface BacktestRollingSharpeResponse {
  task_id: number;
  task_name: string;
  strategy_key: string;
  strategy_name: string;
  window_days: number;
  sharpe_ratio: number; // 整段静态夏普（来自 BacktestResult）
  series: BacktestRollingSharpePoint[];
}

export async function getBacktestRollingSharpeSeries(
  taskId: number,
  window = 90
): Promise<BacktestRollingSharpeResponse> {
  const res = await api.get(`/quant/backtests/${taskId}/rolling-sharpe-series`, {
    params: { window },
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取滚动夏普失败');
  }
  return res.data.data as BacktestRollingSharpeResponse;
}

// ---------- bundled export -------------------------------------------------

export const labService = {
  listQuantStrategies,
  listBacktestTasks,
  getBacktestDetail,
  createBacktestTask,
  compareBacktests,
  getBacktestDrawdownSeries,
  getBacktestMonthlyReturns,
  getBacktestRollingSharpeSeries,
};

export default labService;
