import api from './api';
import {
  BacktestDetail,
  CreateBacktestResponse,
  QuantStrategyItem,
  QuantWorkflowPreset,
  createBacktestTask,
  getBacktestDetail,
  listQuantStrategies,
  listWorkflowPresets,
} from './labService';
import portfolioCrudService from './portfolioCrudService';
import {
  EASY_QUANT_TEMPLATES,
  EasyQuantTemplate,
  EasyQuantTemplateId,
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
  data_freshness: EasyQuantHealthSnapshot | null;
  runtime_health: EasyQuantHealthSnapshot | null;
  health_verdict: EasyQuantHealthVerdict;
}

function normalizeHealthStatus(rawStatus: unknown): EasyQuantHealthStatus {
  const value = String(rawStatus || '').toLowerCase();

  if (['ready', 'ok', 'healthy', 'pass'].includes(value)) {
    return 'ready';
  }

  if (['blocked', 'error', 'failed', 'fail'].includes(value)) {
    return 'blocked';
  }

  return 'degraded';
}

function unwrapHealth(res: any, fallback: string): EasyQuantHealthSnapshot {
  const data = res?.data?.data || {};
  const summary = data.summary || {};

  return {
    status: normalizeHealthStatus(summary.status || data.status),
    conclusion: res?.data?.message || summary.conclusion || data.conclusion || fallback,
    raw: data,
  };
}

function buildHealthVerdict(
  dataFreshness: EasyQuantHealthSnapshot | null,
  runtimeHealth: EasyQuantHealthSnapshot | null
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

export async function loadEasyQuantBootstrap(
  selectedTemplateId: EasyQuantTemplateId = 'steady_trend'
): Promise<EasyQuantBootstrap> {
  const [strategies, workflowPresets, dataFreshnessRes, runtimeHealthRes] = await Promise.all([
    listQuantStrategies(),
    listWorkflowPresets(),
    api.get('/quant/data-freshness').catch(error => {
      const response = (error as { response?: unknown }).response;
      return response || null;
    }),
    api.get('/quant/runtime-health').catch(error => {
      const response = (error as { response?: unknown }).response;
      return response || null;
    }),
  ]);

  const strategyByKey = new Map(strategies.map(item => [item.strategy_key, item]));
  const templates = EASY_QUANT_TEMPLATES.map(template => {
    const backendStrategy = strategyByKey.get(template.strategy_key);
    const available = backendStrategy?.enabled !== false && Boolean(backendStrategy);

    return {
      ...template,
      available,
      unavailable_reason: available ? undefined : '这个策略当前不可用，请先换一个模板。',
      backend_strategy: backendStrategy,
    };
  });

  const dataFreshness = dataFreshnessRes
    ? unwrapHealth(dataFreshnessRes, '没有拿到行情数据健康结论。')
    : null;
  const runtimeHealth = runtimeHealthRes
    ? unwrapHealth(runtimeHealthRes, '没有拿到系统运行健康结论。')
    : null;

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
  templateId: EasyQuantTemplateId
): Promise<CreateBacktestResponse> {
  const template = getEasyQuantTemplate(templateId);
  return createBacktestTask(buildEasyQuantBacktestPayload(template));
}

export async function getEasyQuantBacktestDetail(taskId: number): Promise<BacktestDetail | null> {
  return getBacktestDetail(taskId);
}

export async function createEasyQuantObservationPortfolio(templateId: EasyQuantTemplateId) {
  const template = getEasyQuantTemplate(templateId);

  return portfolioCrudService.createPortfolio({
    name: `简易观察-${template.name}`,
    description: `由简易版模板 ${template.name} 创建，仅用于模拟观察。`,
    initial_capital: template.default_initial_capital,
    strategy_keys: [template.strategy_key],
    enabled_factors: [],
    auto_trade_enabled: false,
  });
}

export const easyQuantService = {
  loadEasyQuantBootstrap,
  runEasyQuantBacktest,
  getEasyQuantBacktestDetail,
  createEasyQuantObservationPortfolio,
};

export default easyQuantService;
