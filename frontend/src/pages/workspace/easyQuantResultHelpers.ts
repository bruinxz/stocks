import { BacktestDetail, BacktestStrategyResult } from '../../services/labService';

export type EasyQuantVerdictStatus = 'ready' | 'caution' | 'blocked';

export interface EasyQuantMetric {
  key: 'return' | 'drawdown' | 'sharpe' | 'trades' | 'win_rate';
  label: string;
  value: string;
  explanation: string;
  tone: 'good' | 'watch' | 'bad' | 'neutral';
}

export interface EasyQuantBacktestVerdict {
  status: EasyQuantVerdictStatus;
  title: string;
  summary: string;
  beginner_metrics: EasyQuantMetric[];
  next_action_label: string;
  can_create_observation: boolean;
}

// Prefer a backend-provided easy_verdict when available; these are UI fallback gates.
export const EASY_QUANT_OBSERVATION_THRESHOLDS = {
  min_total_return_pct: 0,
  max_drawdown_pct: 20,
  caution_max_drawdown_pct: 30,
  min_sharpe_ratio: 0.8,
  min_trade_count: 5,
};

const formatPct = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '暂无';

const formatNumber = (value?: number | null) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '暂无';

function pickBestResult(detail: BacktestDetail | null): BacktestStrategyResult | null {
  if (!detail?.results?.length) {
    return null;
  }

  return [...detail.results].sort((a, b) => {
    const aSharpe = Number.isFinite(a.sharpe_ratio) ? a.sharpe_ratio : -999;
    const bSharpe = Number.isFinite(b.sharpe_ratio) ? b.sharpe_ratio : -999;
    return bSharpe - aSharpe;
  })[0];
}

function pickBackendVerdict(detail: BacktestDetail | null): EasyQuantBacktestVerdict | null {
  const verdict = (detail as any)?.easy_verdict;
  if (
    verdict &&
    ['ready', 'caution', 'blocked'].includes(verdict.status) &&
    Array.isArray(verdict.beginner_metrics)
  ) {
    return verdict as EasyQuantBacktestVerdict;
  }

  return null;
}

export function buildEasyQuantBacktestVerdict(
  detail: BacktestDetail | null
): EasyQuantBacktestVerdict {
  const backendVerdict = pickBackendVerdict(detail);
  if (backendVerdict) {
    return backendVerdict;
  }

  const result = pickBestResult(detail);

  if (!detail) {
    return {
      status: 'blocked',
      title: '先跑一次真实回测',
      summary: '选择模板并通过数据检查后，就能看到这里的回测解释。',
      beginner_metrics: [],
      next_action_label: '先开始回测',
      can_create_observation: false,
    };
  }

  if (detail.task?.status === 'FAILED') {
    return {
      status: 'blocked',
      title: '这次回测没有跑通',
      summary: detail.task.error_message || '系统没有拿到可解释的回测结果，请检查数据后重试。',
      beginner_metrics: [],
      next_action_label: '重新检查数据',
      can_create_observation: false,
    };
  }

  if (!result) {
    return {
      status: 'blocked',
      title: '回测完成但没有结果',
      summary: '任务结束了，但没有生成策略结果，建议换一个模板或进入专业版排查。',
      beginner_metrics: [],
      next_action_label: '查看专业版详情',
      can_create_observation: false,
    };
  }

  const totalReturn = result.total_return_pct;
  const drawdown = Math.abs(result.max_drawdown_pct);
  const sharpe = result.sharpe_ratio;
  const trades = result.trade_count;
  const winRate = result.win_rate;
  const thresholds = EASY_QUANT_OBSERVATION_THRESHOLDS;

  const canCreateObservation =
    totalReturn > thresholds.min_total_return_pct &&
    drawdown <= thresholds.max_drawdown_pct &&
    sharpe >= thresholds.min_sharpe_ratio &&
    trades >= thresholds.min_trade_count;
  const status: EasyQuantVerdictStatus = canCreateObservation
    ? 'ready'
    : totalReturn > thresholds.min_total_return_pct &&
        drawdown <= thresholds.caution_max_drawdown_pct
      ? 'caution'
      : 'blocked';

  return {
    status,
    title:
      status === 'ready'
        ? '可以进入模拟观察'
        : status === 'caution'
          ? '可以继续研究，但不建议马上观察'
          : '暂不建议进入模拟观察',
    summary:
      status === 'ready'
        ? '这次回测的收益、回撤和波动表现达到了简易版观察门槛。'
        : status === 'caution'
          ? '结果有亮点，但风险或样本质量还不够稳。'
          : '这次结果不适合作为模拟观察的起点。',
    beginner_metrics: [
      {
        key: 'return',
        label: '总收益',
        value: formatPct(totalReturn),
        explanation: '这代表这段历史区间内策略整体赚了多少。',
        tone: totalReturn > 0 ? 'good' : 'bad',
      },
      {
        key: 'drawdown',
        label: '最大回撤',
        value: formatPct(drawdown),
        explanation: '这代表中途最难受的一段亏损幅度。',
        tone: drawdown <= 15 ? 'good' : drawdown <= 25 ? 'watch' : 'bad',
      },
      {
        key: 'sharpe',
        label: '夏普比率',
        value: formatNumber(sharpe),
        explanation: '这代表收益相对波动是否划算，新手先看 0.8 以上。',
        tone: sharpe >= 1 ? 'good' : sharpe >= 0.8 ? 'watch' : 'bad',
      },
      {
        key: 'trades',
        label: '交易次数',
        value: String(trades || 0),
        explanation: '次数太少时，结果可能只是偶然。',
        tone: trades >= 10 ? 'good' : trades >= 5 ? 'watch' : 'bad',
      },
      {
        key: 'win_rate',
        label: '胜率',
        value: formatPct(winRate),
        explanation: '胜率不是越高越好，要和盈亏比一起看。',
        tone: 'neutral',
      },
    ],
    next_action_label: canCreateObservation ? '创建模拟观察组合' : '换模板再测一次',
    can_create_observation: canCreateObservation,
  };
}

export function explainEasyQuantError(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes('unauthorized') || lower.includes('401')) {
    return '登录状态失效，请重新登录后再试。';
  }

  if (lower.includes('data') || lower.includes('行情') || lower.includes('bar')) {
    return '行情数据可能不完整，请先刷新数据中心或换一个模板。';
  }

  if (lower.includes('timeout') || lower.includes('超时') || lower.includes('超过')) {
    return '回测运行时间过长，请稍后刷新结果。';
  }

  if (lower.includes('strategy') || lower.includes('策略')) {
    return '当前策略不可用，请换一个模板或进入专业版查看策略状态。';
  }

  return message || '操作失败，请稍后重试。';
}
