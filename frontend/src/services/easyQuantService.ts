import api from './api';
import {
  BacktestResearchAudit,
  BacktestDetail,
  BacktestTask,
  CreateBacktestResponse,
  QuantStrategyItem,
  QuantWorkflowPreset,
  createBacktestTask,
  getBacktestDetail,
  listBacktestTasks,
  listQuantStrategies,
  listWorkflowPresets,
} from './labService';
import portfolioCrudService from './portfolioCrudService';
import {
  EASY_QUANT_TEMPLATES,
  EasyQuantTemplate,
  EasyQuantTemplateId,
  EasyQuantRunConfig,
  buildEasyQuantBacktestPayload,
  getEasyQuantTemplate,
} from '../pages/workspace/easyQuantTemplates';

export type EasyQuantHealthStatus = 'ready' | 'degraded' | 'blocked';

export interface EasyQuantHealthSnapshot {
  status: EasyQuantHealthStatus;
  conclusion: string;
  raw: any;
}

export interface EasyQuantTemplateView extends EasyQuantTemplate {
  available: boolean;
  unavailable_reason?: string;
  backend_strategy?: QuantStrategyItem;
}

export interface EasyQuantHealthVerdict {
  status: EasyQuantHealthStatus;
  title: string;
  summary: string;
  can_run_backtest: boolean;
}

export interface EasyQuantBootstrap {
  templates: EasyQuantTemplateView[];
  selected_template_id: EasyQuantTemplateId;
  workflow_presets: QuantWorkflowPreset[];
  data_freshness: EasyQuantHealthSnapshot;
  runtime_health: EasyQuantHealthSnapshot;
  health_verdict: EasyQuantHealthVerdict;
}

export type EasyQuantResearchAudit = BacktestResearchAudit;

async function readOptional<T>(reader: Promise<T>, fallback: T): Promise<T> {
  try {
    return await reader;
  } catch {
    return fallback;
  }
}

function normalizeHealthStatus(rawStatus: unknown): EasyQuantHealthStatus {
  const value = String(rawStatus || '').toLowerCase();

  if (['ready', 'ok', 'healthy', 'pass'].includes(value)) {
    return 'ready';
  }

  if (['blocked', 'error', 'failed', 'fail', 'critical'].includes(value)) {
    return 'blocked';
  }

  if (['degraded', 'warning', 'warn', 'caution', 'risk'].includes(value)) {
    return 'degraded';
  }

  return 'blocked';
}

function unwrapHealth(res: any, fallback: string): EasyQuantHealthSnapshot {
  if (!res) {
    return {
      status: 'blocked',
      conclusion: `健康检查没有拿到完整结论：${fallback}`,
      raw: null,
    };
  }

  if (res?.data?.success === false) {
    return {
      status: 'blocked',
      conclusion: res.data.message || fallback,
      raw: res.data,
    };
  }

  const data = res?.data?.data || {};
  const summary = data.summary || {};

  return {
    status: normalizeHealthStatus(summary.status || data.status),
    conclusion: res?.data?.message || summary.conclusion || data.conclusion || fallback,
    raw: data,
  };
}

function buildHealthVerdict(
  dataFreshness: EasyQuantHealthSnapshot,
  runtimeHealth: EasyQuantHealthSnapshot
): EasyQuantHealthVerdict {
  const blockedSource =
    dataFreshness?.status === 'blocked'
      ? dataFreshness
      : runtimeHealth?.status === 'blocked'
        ? runtimeHealth
        : null;

  if (blockedSource) {
    return {
      status: 'blocked',
      title: '现在不适合跑回测',
      summary: blockedSource.conclusion || '系统检查未通过。',
      can_run_backtest: false,
    };
  }

  const degradedSource =
    dataFreshness?.status === 'degraded'
      ? dataFreshness
      : runtimeHealth?.status === 'degraded'
        ? runtimeHealth
        : null;

  if (degradedSource) {
    return {
      status: 'degraded',
      title: '可以试跑，但结果需要谨慎看',
      summary: degradedSource.conclusion || '部分检查不是最佳状态。',
      can_run_backtest: true,
    };
  }

  return {
    status: 'ready',
    title: '数据和系统状态可用',
    summary: '可以开始一次真实回测。',
    can_run_backtest: true,
  };
}

export async function loadEasyQuantBootstrap(): Promise<EasyQuantBootstrap> {
  const [strategyResult, workflowPresets, dataFreshnessRes, runtimeHealthRes] = await Promise.all([
    listQuantStrategies()
      .then(value => ({ ok: true as const, value }))
      .catch(error => ({ ok: false as const, error })),
    readOptional(listWorkflowPresets(), []),
    api.get('/quant/data-freshness').catch(error => {
      const response = (error as { response?: unknown }).response;
      return response || null;
    }),
    api.get('/quant/runtime-health').catch(error => {
      const response = (error as { response?: unknown }).response;
      return response || null;
    }),
  ]);

  const strategies = strategyResult.ok ? strategyResult.value : [];
  const strategyLoadFailed = !strategyResult.ok;
  const strategyByKey = new Map(strategies.map(item => [item.strategy_key, item]));
  const templates = EASY_QUANT_TEMPLATES.map(template => {
    const backendStrategy = strategyByKey.get(template.strategy_key);
    const available =
      !strategyLoadFailed && Boolean(backendStrategy) && backendStrategy?.enabled !== false;

    return {
      ...template,
      available,
      unavailable_reason: available
        ? undefined
        : strategyLoadFailed
          ? '策略列表加载失败，请刷新后再试。'
          : '这个策略当前不可用，请先换一个模板。',
      backend_strategy: backendStrategy,
    };
  });

  const dataFreshness = unwrapHealth(dataFreshnessRes, '没有拿到行情数据健康结论。');
  const runtimeHealth = unwrapHealth(runtimeHealthRes, '没有拿到系统运行健康结论。');
  const selectedTemplateId = templates.find(template => template.available)?.id || 'steady_trend';

  return {
    templates,
    selected_template_id: selectedTemplateId,
    workflow_presets: workflowPresets,
    data_freshness: dataFreshness,
    runtime_health: runtimeHealth,
    health_verdict: buildHealthVerdict(dataFreshness, runtimeHealth),
  };
}

export async function runEasyQuantBacktest(
  templateId: EasyQuantTemplateId,
  hypothesis?: string,
  runConfig?: EasyQuantRunConfig
): Promise<CreateBacktestResponse> {
  const template = getEasyQuantTemplate(templateId);
  const payload = buildEasyQuantBacktestPayload(template, hypothesis, runConfig);
  return createBacktestTask({
    ...payload,
    easy_mode: true,
    hypothesis: hypothesis || payload.hypothesis,
  });
}

export async function getEasyQuantBacktestDetail(taskId: number): Promise<BacktestDetail | null> {
  return getBacktestDetail(taskId);
}

export function isEasyQuantBacktestTask(task: BacktestTask): boolean {
  return (
    task.parameters?.easy_mode === true ||
    task.parameters?.easy_mode === 'true' ||
    task.task_name?.startsWith('简易版-') ||
    EASY_QUANT_TEMPLATES.some(template => task.parameters?.template_id === template.id)
  );
}

export async function listEasyQuantBacktestHistory(limit = 50): Promise<BacktestTask[]> {
  const tasks = await listBacktestTasks(limit);
  return tasks.filter(isEasyQuantBacktestTask);
}

export async function getEasyQuantResearchAudit(
  taskId: number
): Promise<EasyQuantResearchAudit | null> {
  const res = await api.get(`/quant/backtests/${taskId}/research-audit`);
  if (!res.data?.success) {
    throw new Error(res.data?.message || '获取回测可信度失败');
  }
  return res.data.data as EasyQuantResearchAudit;
}

export async function createEasyQuantObservationPortfolio(
  templateId: EasyQuantTemplateId,
  runConfig?: EasyQuantRunConfig
) {
  const template = getEasyQuantTemplate(templateId);
  const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  return portfolioCrudService.createPortfolio({
    name: `简易观察-${template.name}-${timestamp}`,
    description: `由简易版模板 ${template.name} 创建，仅用于模拟观察。`,
    initial_capital: runConfig?.initial_capital || template.default_initial_capital,
    strategy_keys: [template.strategy_key],
    enabled_factors: [],
    auto_trade_enabled: false,
  });
}

export const easyQuantService = {
  loadEasyQuantBootstrap,
  runEasyQuantBacktest,
  getEasyQuantBacktestDetail,
  listEasyQuantBacktestHistory,
  getEasyQuantResearchAudit,
  createEasyQuantObservationPortfolio,
};

export default easyQuantService;
