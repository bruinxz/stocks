import api from './api';

/**
 * US-062 Strategy Copilot 前端 API 客户端。
 *
 * 调用：
 *   - POST /api/ai/strategy-copilot          → askStrategyCopilot()
 *   - GET  /api/ai/strategy-copilot/stream   → 用 EventSource 直连 (不走 axios)
 *   - GET  /api/ai/strategy-copilot/context  → loadStrategyCopilotContext()
 *
 * 数据形态对齐 backend StrategyCopilotService.CopilotResponse。
 */

export type CopilotIntent = 'explain_backtest' | 'suggest_params' | 'generate_draft' | 'general';

export const COPILOT_INTENT_LABELS: Record<CopilotIntent, string> = {
  explain_backtest: '解释回测',
  suggest_params: '建议调参',
  generate_draft: '生成草案',
  general: '通用问答',
};

export interface BacktestSummary {
  task_id: number;
  task_name: string;
  status: string;
  start_date: string;
  end_date: string;
  created_at: string;
  total_return_pct: number | null;
  sharpe_ratio: number | null;
  max_drawdown_pct: number | null;
  win_rate: number | null;
  trade_count: number | null;
}

export interface StrategyMeta {
  strategy_key: string;
  name: string;
  description: string | null;
  category: string | null;
  risk_level: string | null;
  tags: string[];
  default_params: Record<string, any>;
}

export interface CopilotContext {
  strategy: StrategyMeta | null;
  backtests: BacktestSummary[];
}

export interface CopilotResponse {
  conversation_id: string;
  strategy_key: string | null;
  intent: CopilotIntent;
  prompt: string;
  reply: string;
  suggested_params: Record<string, any>;
  strategy_draft: string | null;
  next_action: string | null;
  status: 'completed' | 'partial' | 'failed';
  nlp_engine: string;
  error: string | null;
  generated_at: string;
  metadata: Record<string, unknown>;
  persisted: boolean;
}

export interface AskCopilotRequest {
  prompt: string;
  strategy_key?: string;
  intent_override?: CopilotIntent;
  dry_run?: boolean;
  task_label?: string;
  conversation_id?: string;
}

/**
 * 同步触发 Copilot 对话（POST /api/ai/strategy-copilot）。
 *
 * status='partial' 仍正常返回（启发式 fallback），UI 应按 reply / suggested_params 渲染。
 */
export async function askStrategyCopilot(request: AskCopilotRequest): Promise<CopilotResponse> {
  const response = await api.post<{
    success: boolean;
    data: CopilotResponse;
    message?: string;
  }>('/ai/strategy-copilot', request);
  if (!response.data?.success) {
    throw new Error(response.data?.message || 'Copilot 请求失败');
  }
  return response.data.data;
}

/**
 * 加载 Copilot 上下文（POST 前先拿到策略元 + 最近回测，UI 立刻可显示）。
 */
export async function loadStrategyCopilotContext(
  strategyKey?: string,
  lookback = 5
): Promise<CopilotContext> {
  const response = await api.get<{
    success: boolean;
    data: CopilotContext;
    message?: string;
  }>('/ai/strategy-copilot/context', {
    params: {
      strategy_key: strategyKey,
      lookback,
    },
  });
  if (!response.data?.success) {
    throw new Error(response.data?.message || '加载 Copilot 上下文失败');
  }
  return response.data.data || { strategy: null, backtests: [] };
}

/**
 * 比对 default_params 与 suggested_params, 返回 [{key, before, after}] 三元组数组。
 * 让 UI 渲染 "建议改动" 表。
 */
export function diffSuggestedParams(
  defaultParams: Record<string, any> | null | undefined,
  suggested: Record<string, any> | null | undefined
): Array<{ key: string; before: any; after: any }> {
  if (!suggested || typeof suggested !== 'object') return [];
  const dp = defaultParams && typeof defaultParams === 'object' ? defaultParams : {};
  const out: Array<{ key: string; before: any; after: any }> = [];
  for (const [key, after] of Object.entries(suggested)) {
    const before = dp[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    out.push({ key, before: before === undefined ? null : before, after });
  }
  return out;
}

export const strategyCopilotService = {
  askStrategyCopilot,
  loadStrategyCopilotContext,
  diffSuggestedParams,
};

export default strategyCopilotService;
