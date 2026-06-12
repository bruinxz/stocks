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

// ---------- /api/quant/strategies/:id/detail (US-078) ----------------------

export interface StrategyDetailBacktest {
  id: number;
  task_name: string;
  status: string;
  created_at: string;
  start_date: string;
  end_date: string;
  strategy_keys?: string[];
  initial_capital: number;
  run_summary: {
    best_strategy_key: string | null;
    best_strategy_name: string | null;
    best_return_pct: number;
    best_max_drawdown_pct: number;
    best_sharpe_ratio: number;
    best_trade_count: number;
  } | null;
  strategy_metrics:
    | {
        present: true;
        total_return_pct: number;
        annual_return_pct: number;
        excess_return_pct: number;
        sharpe_ratio: number;
        max_drawdown_pct: number;
        win_rate: number;
        trade_count: number;
        is_champion: boolean;
      }
    | { present: false };
}

export interface StrategyDetailLatestIC {
  factor_name: string;
  look_forward_days: number;
  ic_mean: number | null;
  ic_ir: number | null;
  ic_positive_ratio: number | null;
  sample_count: number;
  computed_at: string;
  period_start: string;
  period_end: string;
}

export interface StrategyDetailLiveBinding {
  enabled: boolean;
  recent_signal_count: number;
  last_signal_date: string | null;
}

export interface StrategyDetailResponse {
  strategy: QuantStrategyItem & {
    execution_policy?: Record<string, any>;
    environment_policy?: Record<string, any>;
    lifecycle_policy?: Record<string, any>;
    edge_hypothesis?: Record<string, any>;
    notes?: string | null;
  };
  backtests: StrategyDetailBacktest[];
  latest_ic: StrategyDetailLatestIC | null;
  live_binding: StrategyDetailLiveBinding;
  /** Phase 4: 实时计算的 promotion gate 状态（与硬门禁规则 1:1 镜像） */
  promotion_gate?: {
    edge_hypothesis: {
      thesis_ok: boolean;
      category_ok: boolean;
      kill_switch_ok: boolean;
      all_satisfied: boolean;
      missing: string[];
    };
  };
}

export async function getStrategyDetail(strategyKey: string): Promise<StrategyDetailResponse> {
  const res = await api.get(`/quant/strategies/${encodeURIComponent(strategyKey)}/detail`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取策略详情失败');
  }
  return res.data.data as StrategyDetailResponse;
}

// ---------- /api/quant/strategies/:id/source (US-093) ---------------------

/**
 * US-093 — 策略源码（.ts 文件）。后端从 `backend/src/quant/strategies/*.ts` 直接读取，
 * 严格校验 strategy_key（snake_case 字母数字下划线）后通过白名单映射定位文件，
 * 杜绝 path traversal。前端 Monaco 编辑器只读展示。
 *
 * 后端响应包：{ strategy_key, filename, file_path, content, byte_size }。
 * 错误：400 (strategy_key 非法 / 缺失) / 404 (映射查不到) / 413 (>256KB)。
 */
export interface StrategySourceResponse {
  strategy_key: string;
  filename: string;
  file_path: string;
  content: string;
  byte_size: number;
}

export async function getStrategySource(strategyKey: string): Promise<StrategySourceResponse> {
  const res = await api.get(`/quant/strategies/${encodeURIComponent(strategyKey)}/source`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取策略源码失败');
  }
  return res.data.data as StrategySourceResponse;
}

// ---------- /api/quant/strategies/:id PATCH (US-083 dry-run toggle) --------

/**
 * US-083: 切换策略 dry-run 开关。
 *
 * 后端 QuantController.updateStrategyConfig 接受顶层 `dry_run` 字段（typed shortcut），
 * 会自动 merge 到 lifecycle_policy.dry_run JSONB 子字段。dry-run 策略的信号仍正常
 * 写入 QuantSignal 表，但 PaperTradingFacade.applyAutomation 不会为这些信号调用
 * placeOrder/createBuyTrade —— 用户可以先观察一段时间策略产出信号，再决定是否启用真实下单。
 *
 * 返回更新后的策略对象（含 lifecycle_policy.dry_run = 最新值）。
 */
export async function setStrategyDryRun(
  strategyKey: string,
  dryRun: boolean
): Promise<QuantStrategyItem & { lifecycle_policy?: Record<string, any> }> {
  const res = await api.patch(`/quant/strategies/${encodeURIComponent(strategyKey)}`, {
    dry_run: dryRun,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '更新策略 dry-run 模式失败');
  }
  return res.data.data;
}

// ---------- /api/quant/strategies/:id PATCH (Phase 4 edge_hypothesis editor) ----------

/**
 * Phase 4: 用户/Lab 编辑 edge_hypothesis (alpha 假设)。
 *
 * 后端 QuantController.updateStrategyConfig 支持顶层 `edge_hypothesis` 字段，
 * replace-not-merge 语义 — 整个 JSON 对象覆盖 strategy.edge_hypothesis 字段。
 *
 * Phase 4 promotion 门禁要求所有 promote 成 champion 的策略必须填:
 *   - thesis (≥10 字符)
 *   - category
 *   - kill_switch_metric
 * 否则会被 PromotionGate 拦截。
 *
 * @returns 更新后的策略对象（含新 edge_hypothesis）
 */
export interface EdgeHypothesisPayload {
  thesis?: string;
  category?: string;
  expected_edge_pct?: number;
  expected_holding_days?: number;
  key_factors?: string[];
  failure_modes?: string[];
  kill_switch_metric?: string;
  kill_switch_threshold?: number;
  evidence_link?: string;
}

export async function setStrategyEdgeHypothesis(
  strategyKey: string,
  hypothesis: EdgeHypothesisPayload
): Promise<QuantStrategyItem & { edge_hypothesis?: Record<string, any> }> {
  const res = await api.patch(`/quant/strategies/${encodeURIComponent(strategyKey)}`, {
    edge_hypothesis: hypothesis,
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '更新 edge_hypothesis 失败');
  }
  return res.data.data;
}

// ---------- Phase 1: Walk-Forward Validation ------------------------------

export interface WalkForwardSummary {
  total_windows: number;
  completed_windows: number;
  failed_windows: number;
  mean_test_sharpe: number | null;
  std_test_sharpe: number | null;
  min_test_sharpe: number | null;
  max_test_sharpe: number | null;
  mean_test_return: number | null;
  mean_test_drawdown: number | null;
  win_ratio: number | null;
  out_of_sample_decay: number | null;
  dsr?: number | null;
  pbo?: number | null;
  verdict?: 'PASS' | 'FAIL' | 'INSUFFICIENT' | null;
  total_test_days?: number | null;
  num_trials?: number | null;
}

export interface WalkForwardWindowResult {
  id: number;
  run_id: number;
  window_index: number;
  train_start_date: string;
  train_end_date: string;
  test_start_date: string;
  test_end_date: string;
  best_params_json: Record<string, any>;
  train_composite_score: number | null;
  train_sharpe: number | null;
  test_sharpe: number | null;
  test_return: number | null;
  test_drawdown: number | null;
  test_total_return: number | null;
  test_win_rate: number | null;
  test_trade_count: number | null;
  train_run_id: number | null;
  train_combos_count: number | null;
  train_failed_combos: number | null;
  status: 'pending' | 'completed' | 'train_failed' | 'test_failed';
  error_message: string | null;
  duration_seconds: number | null;
  dsr?: number | null;
  verdict?: 'PASS' | 'FAIL' | 'INSUFFICIENT' | null;
  test_regime_breakdown_json?: any;
  path_index?: number | null;
  train_skip_dates_count?: number | null;
}

export interface WalkForwardRunRow {
  id: number;
  optimizer_type: string;
  strategy_name: string;
  status: 'running' | 'completed' | 'failed';
  total_combos: number;
  completed_combos: number;
  failed_combos: number;
  best_result_id: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  metadata_json?: { wf_summary?: WalkForwardSummary };
  param_grid_json?: any;
  backtest_config_json?: any;
}

export interface RunWalkForwardPayload {
  strategy_key: string;
  param_grid?: Record<string, any[]>;
  param_bounds?: Record<string, { min: number; max: number; integer?: boolean }>;
  base_config?: Record<string, any>;
  train_months?: number;
  test_months?: number;
  start_date: string;
  end_date: string;
  scheme?: 'rolling' | 'cpcv';
  optimizer_type?: 'grid_search' | 'bayesian';
  purging?: { label_horizon_days: number; embargo_days: number } | null;
  cpcv?: { n_groups: number; k_test_groups: number };
  max_combos?: number;
  persist?: boolean;
}

export interface RunWalkForwardResponse {
  run_id: number | null;
  summary: WalkForwardSummary;
  windows: WalkForwardWindowResult[];
  best_window: WalkForwardWindowResult | null;
}

export async function runWalkForwardValidation(
  payload: RunWalkForwardPayload
): Promise<RunWalkForwardResponse> {
  const res = await api.post('/quant/walk-forward', payload);
  if (!res.data?.success) {
    throw new Error(res.data?.message || 'Walk-forward 验证失败');
  }
  return res.data.data as RunWalkForwardResponse;
}

export async function listWalkForwardRuns(
  options: { strategy_name?: string; limit?: number } = {}
): Promise<WalkForwardRunRow[]> {
  const res = await api.get('/quant/walk-forward/runs', {
    params: {
      strategy_name: options.strategy_name,
      limit: options.limit ?? 30,
    },
  });
  if (!res.data?.success) {
    throw new Error(res.data?.message || '查询 walk-forward 列表失败');
  }
  return (res.data.data || []) as WalkForwardRunRow[];
}

export async function getWalkForwardWindows(runId: number): Promise<WalkForwardWindowResult[]> {
  const res = await api.get(`/quant/walk-forward/runs/${runId}/windows`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '查询窗口失败');
  }
  return (res.data.data || []) as WalkForwardWindowResult[];
}

export async function deleteWalkForwardRun(runId: number): Promise<void> {
  const res = await api.delete(`/quant/walk-forward/runs/${runId}`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '删除失败');
  }
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
  getStrategyDetail,
  getStrategySource,
  setStrategyDryRun,
  setStrategyEdgeHypothesis,
  // Phase 1: walk-forward
  runWalkForwardValidation,
  listWalkForwardRuns,
  getWalkForwardWindows,
  deleteWalkForwardRun,
};

export default labService;
