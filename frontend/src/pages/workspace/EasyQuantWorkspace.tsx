import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  DownOutlined,
  ExportOutlined,
  HistoryOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { BacktestDetail, BacktestStrategyResult, BacktestTask } from '../../services/labService';
import easyQuantService, {
  EasyQuantResearchAudit,
  EasyQuantTemplateView,
} from '../../services/easyQuantService';
import {
  EASY_QUANT_TEMPLATES,
  EasyQuantRunConfig,
  EasyQuantTemplateId,
  buildDefaultEasyQuantRunConfig,
  getEasyQuantTemplate,
} from './easyQuantTemplates';
import {
  EasyQuantBacktestVerdict,
  buildEasyQuantBacktestVerdict,
  explainEasyQuantError,
} from './easyQuantResultHelpers';
import {
  EasyQuantSectionId as SectionId,
  EasyQuantSectionNavItem,
  EasyQuantStepKey as StepKey,
  useEasyQuantBacktestPolling,
  useEasyQuantBootstrap,
  useEasyQuantDisplayUsername,
  useEasyQuantElapsedSeconds,
  useEasyQuantSectionScrollSpy,
} from './easyQuantHooks';
import './EasyQuantWorkspace.css';

type DrawerKey = StepKey | 'guide' | 'ledger' | 'history' | null;
type BacktestReportTab = 'metrics' | 'trades' | 'blocks';

interface ReportMetricRow {
  label: string;
  value: string;
  detail: string;
  tone?: 'good' | 'watch' | 'bad' | 'neutral';
}

interface ReportMetricGroup {
  title: string;
  rows: ReportMetricRow[];
}

const EASY_QUANT_LAST_RUN_STORAGE_KEY = 'easy_quant_last_run_v1';
const EASY_QUANT_LAST_RUN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EASY_QUANT_AUDIT_POLL_INTERVAL_MS = 3000;
const EASY_QUANT_AUDIT_POLL_TIMEOUT_MS = 2 * 60 * 1000;
const REQUIRED_RESEARCH_ARTIFACT_TYPES = [
  'backtest',
  'integrity_audit',
  'execution_audit',
] as const;

interface EasyQuantLastRunState {
  task_id: number;
  template_id: EasyQuantTemplateId;
  hypothesis?: string;
  run_config?: EasyQuantRunConfig;
  saved_at: number;
}

interface JourneyStep {
  key: StepKey;
  number: string;
  title: string;
  caption: string;
  drawerTitle: string;
  sketch: 'sprout' | 'lens' | 'chart' | 'shield' | 'telescope';
}

const journeySteps: JourneyStep[] = [
  {
    key: 'template',
    number: '01',
    title: '选模板',
    caption: '先选一个不用调太多参数的策略。',
    drawerTitle: '模板怎么选',
    sketch: 'sprout',
  },
  {
    key: 'data',
    number: '02',
    title: '查数据',
    caption: '看行情、因子和风险边界是否齐备。',
    drawerTitle: '查数据详情',
    sketch: 'lens',
  },
  {
    key: 'backtest',
    number: '03',
    title: '跑回测',
    caption: '先判断收益和回撤是否能接受。',
    drawerTitle: '回测报告',
    sketch: 'chart',
  },
  {
    key: 'credibility',
    number: '04',
    title: '可信度',
    caption: '看有没有未来数据和成交阻断。',
    drawerTitle: '可信度详情',
    sketch: 'shield',
  },
  {
    key: 'observe',
    number: '05',
    title: '模拟观察',
    caption: '观察一段时间，再考虑更复杂配置。',
    drawerTitle: '观察日志',
    sketch: 'telescope',
  },
];

const templateSketchById: Record<EasyQuantTemplateId, 'trend' | 'cross' | 'shield'> = {
  steady_trend: 'trend',
  breakout_ma: 'cross',
  low_vol_value: 'shield',
};

const easyQuantStoryHints = {
  data: '确认行情、因子和运行环境够不够支撑这次研究。',
  hypothesis: '说明这次想验证什么，后续账本、审计和报告都会挂在这条链路上。',
  metrics: '看完整收益、回撤、成本和交易质量，确认结论不是只看一个数字。',
  trades: '复盘每笔买卖发生的时间、盈亏，以及系统给出的买入/卖出原因。',
  blocks: '看哪些订单被涨跌停、停牌、T+1 或资金不足挡住。',
  history: '找回以前的简易版回测；可在这里复看，也可跳专业版深挖。',
  ledger: '串起研究假设、数据审计、成交约束和最终可信度。',
  credibility: '先排除偷看未来和不可成交，再决定是否进入模拟观察。',
} as const;

type EasyQuantStoryHintKey = keyof typeof easyQuantStoryHints;

const backtestReportStoryByTab: Record<BacktestReportTab, EasyQuantStoryHintKey> = {
  metrics: 'metrics',
  trades: 'trades',
  blocks: 'blocks',
};

const credibilityStoryByKey: Record<string, EasyQuantStoryHintKey> = {
  backtest: 'ledger',
  integrity: 'credibility',
  execution: 'blocks',
};

function StoryHint({
  story,
  label = '说明',
  focusable = true,
}: {
  story: EasyQuantStoryHintKey;
  label?: string;
  focusable?: boolean;
}) {
  const text = easyQuantStoryHints[story];

  return (
    <span
      className="eq-story-hint"
      tabIndex={focusable ? 0 : undefined}
      aria-label={`${label}：${text}`}
    >
      <InfoCircleOutlined aria-hidden="true" />
      <span className="eq-story-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function getResearchAuditCompletenessScore(audit?: EasyQuantResearchAudit | null): number {
  if (!audit) {
    return 0;
  }

  const verdict = String(audit.credibility_verdict?.verdict || '').toLowerCase();
  const terminalVerdict = verdict && verdict !== 'pending';
  const artifactTypes = new Set((audit.artifacts || []).map(item => item.artifact_type));
  const completedArtifacts = (audit.artifacts || []).filter(
    item => String(item.status || '').toLowerCase() !== 'pending'
  ).length;

  return (
    (terminalVerdict ? 100 : 0) +
    REQUIRED_RESEARCH_ARTIFACT_TYPES.filter(type => artifactTypes.has(type)).length * 10 +
    completedArtifacts
  );
}

function pickMostCompleteResearchAudit(
  primary?: EasyQuantResearchAudit | null,
  secondary?: EasyQuantResearchAudit | null
): EasyQuantResearchAudit | null {
  if (!primary) {
    return secondary || null;
  }

  if (!secondary) {
    return primary;
  }

  return getResearchAuditCompletenessScore(primary) >= getResearchAuditCompletenessScore(secondary)
    ? primary
    : secondary;
}

function isResearchAuditComplete(audit?: EasyQuantResearchAudit | null): boolean {
  if (!audit) {
    return false;
  }

  const verdict = String(audit.credibility_verdict?.verdict || '').toLowerCase();
  if (!verdict || verdict === 'pending') {
    return false;
  }

  return REQUIRED_RESEARCH_ARTIFACT_TYPES.every(type =>
    (audit.artifacts || []).some(
      item => item.artifact_type === type && String(item.status || '').toLowerCase() !== 'pending'
    )
  );
}

function trimSentenceEnding(text?: string): string {
  return String(text || '').replace(/[。.!！]+$/g, '');
}

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const formatPercentValue = (value: unknown, fallback = '暂无') => {
  const numericValue = toFiniteNumber(value);
  return numericValue === null ? fallback : `${numericValue.toFixed(2)}%`;
};

const formatRatioAsPercent = (value: unknown, fallback = '暂无') => {
  const numericValue = toFiniteNumber(value);
  return numericValue === null ? fallback : `${(numericValue * 100).toFixed(2)}%`;
};

const formatNumberValue = (value: unknown, digits = 2, fallback = '暂无') => {
  const numericValue = toFiniteNumber(value);
  return numericValue === null ? fallback : numericValue.toFixed(digits);
};

const formatMoneyValue = (value: unknown, fallback = '暂无') => {
  const numericValue = toFiniteNumber(value);
  if (numericValue === null) {
    return fallback;
  }

  if (Math.abs(numericValue) >= 10000) {
    return `${(numericValue / 10000).toFixed(Math.abs(numericValue) >= 100000 ? 0 : 1)}万`;
  }

  return `${Math.round(numericValue).toLocaleString('zh-CN')}元`;
};

const formatDateOnly = (value: unknown) => {
  const text = String(value || '').slice(0, 10);
  return text || '未记录';
};

const formatUniverseLabel = (universe: EasyQuantRunConfig['universe']) =>
  universe === 'favorites' ? '自选股' : '全市场候选';

const pickBestBacktestResult = (detail?: BacktestDetail | null): BacktestStrategyResult | null => {
  if (!detail?.results?.length) {
    return null;
  }

  return [...detail.results].sort((a, b) => {
    const aReturn = toFiniteNumber(a.total_return_pct) ?? -999999;
    const bReturn = toFiniteNumber(b.total_return_pct) ?? -999999;
    return bReturn - aReturn;
  })[0];
};

const getExecutionDiagnostics = (result?: BacktestStrategyResult | null): Record<string, any> =>
  ((result?.metrics_json || {}) as any).execution_diagnostics || {};

const getRejectedOrders = (result?: BacktestStrategyResult | null): any[] =>
  Array.isArray(result?.rejected_orders_json) ? result?.rejected_orders_json || [] : [];

const getBlockedReasonLabel = (reason: unknown) => {
  const value = String(reason || 'unknown');
  const labels: Record<string, string> = {
    max_positions: '仓位上限',
    already_holding: '已有持仓',
    limit_up_block_buy: '涨停买入',
    limit_up_blocked_buy: '涨停买入',
    limit_down_block_sell: '跌停卖出',
    limit_down_blocked_sell: '跌停卖出',
    t_plus_one_block: 'T+1 限制',
    t_plus_1_violation: 'T+1 限制',
    suspended_or_zero_volume: '停牌或零成交',
    st_filtered: 'ST 过滤',
    turnover_below_threshold: '流动性不足',
    next_bar_missing: '次日行情缺失',
    next_exit_bar_missing: '次日退出行情缺失',
    lot_or_cash_too_small: '金额不足',
    cash_not_enough: '现金不足',
    unknown: '其他原因',
  };

  return labels[value] || value.replace(/_/g, ' ');
};

const normalizeEasyQuantRunConfig = (
  template: ReturnType<typeof getEasyQuantTemplate>,
  saved?: Partial<EasyQuantRunConfig> | null
): EasyQuantRunConfig => {
  const fallback = buildDefaultEasyQuantRunConfig(template);
  const lookback = Number(saved?.lookback_years);
  const initialCapital = Number(saved?.initial_capital);
  const candidateLimit = Number(saved?.candidate_limit);
  const maxPositions = Number(saved?.max_positions);
  const positionPct = Number(saved?.position_pct);

  return {
    initial_capital:
      Number.isFinite(initialCapital) && initialCapital > 0
        ? initialCapital
        : fallback.initial_capital,
    lookback_years: [1, 2, 3].includes(lookback)
      ? (lookback as EasyQuantRunConfig['lookback_years'])
      : fallback.lookback_years,
    universe:
      saved?.universe === 'all' || saved?.universe === 'favorites'
        ? saved.universe
        : fallback.universe,
    candidate_limit:
      Number.isFinite(candidateLimit) && candidateLimit > 0
        ? Math.round(candidateLimit)
        : fallback.candidate_limit,
    max_positions:
      Number.isFinite(maxPositions) && maxPositions > 0
        ? Math.round(maxPositions)
        : fallback.max_positions,
    position_pct:
      Number.isFinite(positionPct) && positionPct > 0 ? positionPct : fallback.position_pct,
  };
};

const isEasyQuantTemplateId = (value: unknown): value is EasyQuantTemplateId =>
  EASY_QUANT_TEMPLATES.some(template => template.id === value);

const pickHistoryTaskTemplateId = (
  task: BacktestTask,
  fallback: EasyQuantTemplateId
): EasyQuantTemplateId => {
  const parameters = task.parameters || {};
  const parameterTemplateId = parameters.template_id;
  if (isEasyQuantTemplateId(parameterTemplateId)) {
    return parameterTemplateId;
  }

  const strategyKeys = Array.isArray(task.strategy_keys)
    ? task.strategy_keys
    : Array.isArray(parameters.strategy_keys)
      ? parameters.strategy_keys
      : [];
  const matchedTemplate = EASY_QUANT_TEMPLATES.find(template =>
    strategyKeys.includes(template.strategy_key)
  );

  return matchedTemplate?.id || fallback;
};

const deriveLookbackYearsFromTask = (
  task: BacktestTask
): EasyQuantRunConfig['lookback_years'] | undefined => {
  const start = new Date(task.start_date);
  const end = new Date(task.end_date);
  const days = Math.round((end.getTime() - start.getTime()) / 86400000);

  if (!Number.isFinite(days) || days <= 0) {
    return undefined;
  }

  if (days <= 460) {
    return 1;
  }

  if (days <= 820) {
    return 2;
  }

  return 3;
};

const buildRunConfigFromHistoryTask = (
  task: BacktestTask,
  template: ReturnType<typeof getEasyQuantTemplate>
): EasyQuantRunConfig =>
  normalizeEasyQuantRunConfig(template, {
    initial_capital: Number(task.parameters?.initial_capital || task.initial_capital || 0),
    lookback_years: deriveLookbackYearsFromTask(task),
    universe:
      task.parameters?.universe === 'all' || task.parameters?.universe === 'favorites'
        ? task.parameters.universe
        : undefined,
    candidate_limit: Number(task.parameters?.candidate_limit || 0),
    max_positions: Number(task.parameters?.max_positions || 0),
    position_pct: Number(task.parameters?.position_pct || 0),
  });

const getBacktestStatusLabel = (status?: string) => {
  const normalized = String(status || '').toUpperCase();
  const labels: Record<string, string> = {
    QUEUED: '排队中',
    RUNNING: '运行中',
    COMPLETED: '已完成',
    FAILED: '失败',
    PENDING: '待运行',
  };

  return labels[normalized] || status || '未知';
};

const sectionNavItems: EasyQuantSectionNavItem[] = [
  { id: 'easy-quant-hero', label: '开始' },
  { id: 'easy-quant-flow', label: '动线' },
  { id: 'easy-quant-template', label: '模板' },
  { id: 'easy-quant-data', label: '查数据' },
  { id: 'easy-quant-backtest', label: '回测' },
  { id: 'easy-quant-credibility', label: '可信度' },
  { id: 'easy-quant-observe', label: '观察' },
];

const sectionByStep: Record<StepKey, SectionId> = {
  template: 'easy-quant-template',
  data: 'easy-quant-data',
  backtest: 'easy-quant-backtest',
  credibility: 'easy-quant-credibility',
  observe: 'easy-quant-observe',
};

const stepBySection: Partial<Record<SectionId, StepKey>> = {
  'easy-quant-template': 'template',
  'easy-quant-data': 'data',
  'easy-quant-backtest': 'backtest',
  'easy-quant-credibility': 'credibility',
  'easy-quant-observe': 'observe',
};

const getRiskTone = (risk: string): 'low' | 'medium' | 'high' => {
  if (risk.includes('高')) {
    return 'high';
  }

  if (risk.includes('低')) {
    return 'low';
  }

  if (risk.includes('中')) {
    return 'medium';
  }

  return 'low';
};

const artifactLabelByStatus: Record<string, string> = {
  pass: '通过',
  watch: '需谨慎',
  reject: '阻断',
  insufficient: '数据不足',
  pending: '待生成',
  error: '异常',
};

const artifactToneByStatus: Record<string, 'ready' | 'degraded' | 'blocked'> = {
  pass: 'ready',
  watch: 'degraded',
  reject: 'blocked',
  insufficient: 'blocked',
  pending: 'degraded',
  error: 'blocked',
};

const getArtifactStatusLabel = (status?: string) => artifactLabelByStatus[status || ''] || '待生成';

const getArtifactTone = (status?: string): 'ready' | 'degraded' | 'blocked' =>
  artifactToneByStatus[status || ''] || 'degraded';

const EasyQuantMark: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <svg
    className={compact ? 'eq-logo-mark eq-logo-mark--compact' : 'eq-logo-mark'}
    viewBox="0 0 64 64"
    role="img"
    aria-label="QuantX 量化简易版 logo"
  >
    <rect x="4" y="4" width="56" height="56" rx="13" fill="none" />
    <path
      d="M15 43c8-3 16-8 25-21 3 16 8 25 17 29"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="3.2"
    />
    <path
      d="M39 23c-10-4-18-1-24 8 11 4 19 1 24-8Zm3 2c8-6 15-6 22-1-7 8-15 8-22 1Z"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.8"
    />
    <circle cx="52" cy="47" r="4" fill="currentColor" />
  </svg>
);

const JourneySketch: React.FC<{
  type: JourneyStep['sketch'] | 'trend' | 'cross' | 'shield' | 'flag';
}> = ({ type }) => {
  if (type === 'lens') {
    return (
      <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
        <circle cx="47" cy="43" r="24" />
        <path d="M65 61 87 83M39 39h17M39 50h10M73 29h18M75 39h12M77 49h10" />
      </svg>
    );
  }

  if (type === 'chart') {
    return (
      <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
        <path d="M24 83h65M28 78V24" />
        <path d="M34 70c10-13 16-16 24-9 10 8 15 5 28-20" />
        <circle cx="34" cy="70" r="3" />
        <circle cx="58" cy="61" r="3" />
        <circle cx="86" cy="41" r="3" />
      </svg>
    );
  }

  if (type === 'telescope') {
    return (
      <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
        <path d="m25 57 50-22 7 16-50 22-7-16Z" />
        <path d="m76 35 11-4 8 18-11 4M48 66 36 91M52 64l11 27M34 91h32" />
        <path d="M82 22h4m-1-3v7M91 63h4m-1-3v7" />
      </svg>
    );
  }

  if (type === 'trend') {
    return (
      <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
        <path d="M25 75c15-17 22-22 34-11 11 10 20 5 32-22" />
        <path d="M72 43h20v20" />
      </svg>
    );
  }

  if (type === 'cross') {
    return (
      <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
        <path d="M22 72c18-22 34-28 48-20 8 5 13 12 20 18" />
        <path d="M22 42c18 18 35 25 50 15 7-5 12-12 18-20" />
        <path d="m78 39 12-2-2 12" />
      </svg>
    );
  }

  if (type === 'shield') {
    return (
      <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
        <path d="M56 18c13 10 25 13 35 13v24c0 22-15 34-35 42-20-8-35-20-35-42V31c10 0 22-3 35-13Z" />
        <path d="m40 57 11 11 24-28" />
      </svg>
    );
  }

  if (type === 'flag') {
    return (
      <svg className="eq-sketch eq-sketch--hero" viewBox="0 0 220 160" aria-hidden="true">
        <path d="M52 43h116c10 0 18 8 18 18v64c0 10-8 18-18 18H52c-10 0-18-8-18-18V61c0-10 8-18 18-18Z" />
        <path d="M34 70h152M66 28v28M154 28v28" />
        <path d="M62 118c20-22 33-32 48-18 15 13 27 4 48-28" />
        <path d="m151 100 22 13-22 13v-26Z" />
      </svg>
    );
  }

  return (
    <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
      <path d="M34 34h44c8 0 13 5 13 13v35c0 8-5 13-13 13H34c-8 0-13-5-13-13V47c0-8 5-13 13-13Z" />
      <path d="M29 26h46c8 0 13 5 13 13M37 18h41c8 0 13 5 13 13" />
      <path d="m43 65 10 10 24-28" />
    </svg>
  );
};

const EasyQuantWorkspace: React.FC = () => {
  const scrollRootRef = useRef<HTMLDivElement | null>(null);
  const snapRestoreTimerRef = useRef<number | null>(null);
  const navLockTimerRef = useRef<number | null>(null);
  const programmaticSectionRef = useRef<SectionId | null>(null);
  const restoredRunRef = useRef(false);
  const runConfigTouchedRef = useRef(false);
  const hypothesisTouchedRef = useRef(false);
  const latestEmbeddedResearchAuditRef = useRef<EasyQuantResearchAudit | null>(null);
  const [activeStep, setActiveStep] = useState<StepKey>('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState<EasyQuantTemplateId>('steady_trend');
  const { bootstrap, bootstrapLoading, bootstrapError, bootstrapElapsedSeconds, reloadBootstrap } =
    useEasyQuantBootstrap();
  const [backtestTaskId, setBacktestTaskId] = useState<number | null>(null);
  const [backtestDetail, setBacktestDetail] = useState<BacktestDetail | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const backtestElapsedSeconds = useEasyQuantElapsedSeconds(backtestLoading);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [researchAudit, setResearchAudit] = useState<EasyQuantResearchAudit | null>(null);
  const [researchAuditLoading, setResearchAuditLoading] = useState(false);
  const [researchAuditError, setResearchAuditError] = useState<string | null>(null);
  const [observationCreating, setObservationCreating] = useState(false);
  const [observationMessage, setObservationMessage] = useState<string | null>(null);
  const [drawerKey, setDrawerKey] = useState<DrawerKey>(null);
  const [visibleSections, setVisibleSections] = useState<Record<string, boolean>>({
    'easy-quant-hero': true,
  });
  const [activeSectionId, setActiveSectionId] = useState<SectionId>('easy-quant-hero');

  const fallbackTemplates = useMemo<EasyQuantTemplateView[]>(
    () =>
      EASY_QUANT_TEMPLATES.map(template => ({
        ...template,
        available: true,
      })),
    []
  );
  const templatesForView = bootstrap?.templates || fallbackTemplates;
  const selectedTemplateData = useMemo<EasyQuantTemplateView>(
    () =>
      templatesForView.find(item => item.id === selectedTemplateId) || {
        ...getEasyQuantTemplate(selectedTemplateId),
        available: true,
      },
    [selectedTemplateId, templatesForView]
  );
  const [hypothesis, setHypothesis] = useState(selectedTemplateData.default_hypothesis);
  const [runConfig, setRunConfig] = useState<EasyQuantRunConfig>(() =>
    buildDefaultEasyQuantRunConfig(getEasyQuantTemplate('steady_trend'))
  );
  const [backtestReportTab, setBacktestReportTab] = useState<BacktestReportTab>('metrics');
  const [historyItems, setHistoryItems] = useState<BacktestTask[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const clearResearchRunState = useCallback(() => {
    localStorage.removeItem(EASY_QUANT_LAST_RUN_STORAGE_KEY);
    setBacktestTaskId(null);
    setBacktestDetail(null);
    setBacktestLoading(false);
    setBacktestError(null);
    setResearchAudit(null);
    setResearchAuditLoading(false);
    setResearchAuditError(null);
    setObservationMessage(null);
  }, []);

  const updateRunConfig = useCallback(
    (patch: Partial<EasyQuantRunConfig>) => {
      runConfigTouchedRef.current = true;
      clearResearchRunState();
      setRunConfig(current =>
        normalizeEasyQuantRunConfig(selectedTemplateData, { ...current, ...patch })
      );
    },
    [clearResearchRunState, selectedTemplateData]
  );

  const handleTemplateSelect = useCallback(
    (templateId: EasyQuantTemplateId) => {
      if (selectedTemplateId !== templateId) {
        clearResearchRunState();
      }
      const nextTemplate = getEasyQuantTemplate(templateId);
      runConfigTouchedRef.current = false;
      hypothesisTouchedRef.current = false;
      setSelectedTemplateId(templateId);
      setHypothesis(nextTemplate.default_hypothesis);
      setRunConfig(buildDefaultEasyQuantRunConfig(nextTemplate));
    },
    [clearResearchRunState, selectedTemplateId]
  );

  const openBacktestDrawer = useCallback((tab: BacktestReportTab = 'metrics') => {
    setBacktestReportTab(tab);
    setDrawerKey('backtest');
  }, []);

  const loadEasyQuantHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);

    try {
      const items = await easyQuantService.listEasyQuantBacktestHistory(80);
      setHistoryItems(items);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const openHistoryDrawer = useCallback(() => {
    setDrawerKey('history');
    void loadEasyQuantHistory();
  }, [loadEasyQuantHistory]);

  useEffect(() => {
    if (!bootstrap?.selected_template_id) {
      return;
    }

    setSelectedTemplateId(currentTemplateId => {
      const currentTemplate = bootstrap.templates.find(item => item.id === currentTemplateId);
      return currentTemplate?.available === false
        ? bootstrap.selected_template_id
        : currentTemplateId;
    });
  }, [bootstrap]);

  useEffect(() => {
    if (restoredRunRef.current) {
      restoredRunRef.current = false;
      return;
    }

    const defaultTemplate = getEasyQuantTemplate(selectedTemplateId);
    if (!hypothesisTouchedRef.current) {
      setHypothesis(defaultTemplate.default_hypothesis);
    }
    if (!runConfigTouchedRef.current) {
      setRunConfig(buildDefaultEasyQuantRunConfig(defaultTemplate));
    }
  }, [selectedTemplateId]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(EASY_QUANT_LAST_RUN_STORAGE_KEY);
      if (!raw) {
        return;
      }

      const saved = JSON.parse(raw) as Partial<EasyQuantLastRunState>;
      const taskId = Number(saved.task_id);
      const savedAt = Number(saved.saved_at);
      const templateId = saved.template_id;
      const templateExists = EASY_QUANT_TEMPLATES.some(template => template.id === templateId);
      const isFresh =
        Number.isFinite(savedAt) && Date.now() - savedAt <= EASY_QUANT_LAST_RUN_MAX_AGE_MS;

      if (!Number.isFinite(taskId) || taskId <= 0 || !templateExists || !isFresh) {
        localStorage.removeItem(EASY_QUANT_LAST_RUN_STORAGE_KEY);
        return;
      }

      restoredRunRef.current = true;
      runConfigTouchedRef.current = false;
      hypothesisTouchedRef.current = Boolean(
        typeof saved.hypothesis === 'string' && saved.hypothesis.trim()
      );
      setSelectedTemplateId(templateId as EasyQuantTemplateId);
      const restoredTemplate = getEasyQuantTemplate(templateId as EasyQuantTemplateId);
      if (typeof saved.hypothesis === 'string' && saved.hypothesis.trim()) {
        setHypothesis(saved.hypothesis);
      } else {
        setHypothesis(restoredTemplate.default_hypothesis);
      }
      setRunConfig(
        normalizeEasyQuantRunConfig(
          restoredTemplate,
          saved.run_config
        )
      );
      setBacktestTaskId(taskId);
      setBacktestLoading(true);
      setBacktestError(null);
      setActiveStep('backtest');
      setActiveSectionId('easy-quant-backtest');
      window.setTimeout(() => {
        restoredRunRef.current = false;
      }, 0);
    } catch {
      localStorage.removeItem(EASY_QUANT_LAST_RUN_STORAGE_KEY);
    }
  }, []);

  const resolvedResearchAudit = useMemo(
    () => pickMostCompleteResearchAudit(researchAudit, backtestDetail?.research_audit),
    [backtestDetail?.research_audit, researchAudit]
  );
  useEffect(() => {
    const embeddedAudit = backtestDetail?.research_audit || null;
    latestEmbeddedResearchAuditRef.current = embeddedAudit;
    if (!embeddedAudit) {
      return;
    }
    setResearchAudit(current => pickMostCompleteResearchAudit(embeddedAudit, current));
    if (isResearchAuditComplete(embeddedAudit)) {
      setResearchAuditLoading(false);
    }
  }, [backtestDetail?.research_audit]);
  const researchAuditComplete = useMemo(
    () => isResearchAuditComplete(resolvedResearchAudit),
    [resolvedResearchAudit]
  );
  const backtestVerdict: EasyQuantBacktestVerdict = useMemo(
    () => buildEasyQuantBacktestVerdict(backtestDetail, resolvedResearchAudit),
    [backtestDetail, resolvedResearchAudit]
  );
  const researchAuditVerdict = backtestVerdict;
  const bestBacktestResult = useMemo(
    () => pickBestBacktestResult(backtestDetail),
    [backtestDetail]
  );
  const executionDiagnostics = useMemo(
    () => getExecutionDiagnostics(bestBacktestResult),
    [bestBacktestResult]
  );
  const reportMetricGroups = useMemo<ReportMetricGroup[]>(() => {
    if (!bestBacktestResult) {
      return [];
    }

    const metrics = bestBacktestResult.metrics_json || {};

    return [
      {
        title: '收益',
        rows: [
          {
            label: '总收益',
            value: formatPercentValue(bestBacktestResult.total_return_pct),
            detail: '策略在这段历史区间的整体收益。',
            tone: (toFiniteNumber(bestBacktestResult.total_return_pct) ?? 0) >= 0 ? 'good' : 'bad',
          },
          {
            label: '年化收益',
            value: formatPercentValue(bestBacktestResult.annual_return_pct),
            detail: '把这段结果折算到一年后的近似速度。',
          },
          {
            label: '基准收益',
            value: formatPercentValue(bestBacktestResult.benchmark_return_pct),
            detail: '用于对照的指数或基准在同一时期的收益。',
          },
          {
            label: '超额收益',
            value: formatPercentValue(bestBacktestResult.excess_return_pct),
            detail: '策略相对基准多赚或少赚的部分。',
            tone: (toFiniteNumber(bestBacktestResult.excess_return_pct) ?? 0) >= 0 ? 'good' : 'bad',
          },
          {
            label: '最终资产',
            value: formatMoneyValue((metrics as any).final_value),
            detail: '回测结束时的总资产估算。',
          },
        ],
      },
      {
        title: '风险',
        rows: [
          {
            label: '最大回撤',
            value: formatPercentValue(
              Math.abs(toFiniteNumber(bestBacktestResult.max_drawdown_pct) ?? 0)
            ),
            detail: '历史过程中从高点到低点的最大亏损幅度。',
            tone:
              Math.abs(toFiniteNumber(bestBacktestResult.max_drawdown_pct) ?? 0) <= 20
                ? 'good'
                : 'watch',
          },
          {
            label: '夏普比率',
            value: formatNumberValue(bestBacktestResult.sharpe_ratio),
            detail: '收益相对波动是否划算。',
          },
          {
            label: 'Calmar',
            value: formatNumberValue((metrics as any).calmar_ratio),
            detail: '年化收益和最大回撤的折中。',
          },
          {
            label: 'Sortino',
            value: formatNumberValue((metrics as any).sortino_ratio),
            detail: '更关注下跌波动的风险收益比。',
          },
        ],
      },
      {
        title: '交易',
        rows: [
          {
            label: '交易次数',
            value: formatNumberValue(bestBacktestResult.trade_count, 0),
            detail: '完整买卖闭环的数量，太少时结果更容易偶然。',
          },
          {
            label: '胜率',
            value: formatPercentValue(bestBacktestResult.win_rate),
            detail: '赚钱交易占比，要和盈亏比一起看。',
          },
          {
            label: '盈亏比',
            value: formatNumberValue(bestBacktestResult.profit_factor),
            detail: '盈利交易合计相对亏损交易合计的比例。',
          },
          {
            label: '平均持有',
            value: `${formatNumberValue(bestBacktestResult.avg_holding_days, 1)}天`,
            detail: '每笔交易平均持有多久。',
          },
          {
            label: '换手率',
            value: formatRatioAsPercent((metrics as any).turnover_ratio),
            detail: '交易额相对平均资产的比例。',
          },
        ],
      },
      {
        title: '成本与执行',
        rows: [
          {
            label: '手续费',
            value: formatMoneyValue(executionDiagnostics.total_commission),
            detail: '买卖双边佣金估算。',
          },
          {
            label: '印花税',
            value: formatMoneyValue(executionDiagnostics.total_stamp_tax),
            detail: 'A 股卖出侧印花税估算。',
          },
          {
            label: '过户费',
            value: formatMoneyValue(executionDiagnostics.total_transfer_fee),
            detail: '交易过户费用估算。',
          },
          {
            label: '滑点成本',
            value: formatMoneyValue(executionDiagnostics.total_slippage_cost),
            detail: '成交价相对参考价的不利偏移估算。',
          },
          {
            label: '成交尝试',
            value: `${formatNumberValue(executionDiagnostics.buy_fill_count, 0)}买 / ${formatNumberValue(
              executionDiagnostics.sell_fill_count,
              0
            )}卖`,
            detail: '实际成交的买入和卖出次数。',
          },
        ],
      },
    ];
  }, [bestBacktestResult, executionDiagnostics]);
  const tradeRows = useMemo(
    () =>
      [...(backtestDetail?.trades || [])].sort((a, b) =>
        String(b.buy_date || '').localeCompare(String(a.buy_date || ''))
      ),
    [backtestDetail?.trades]
  );
  const blockedOrderRows = useMemo(
    () =>
      getRejectedOrders(bestBacktestResult).sort((a, b) =>
        String(b.trade_date || '').localeCompare(String(a.trade_date || ''))
      ),
    [bestBacktestResult]
  );
  const blockedReasonRows = useMemo(
    () =>
      Object.entries((executionDiagnostics.block_reasons || {}) as Record<string, number>)
        .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
        .map(([reason, count]) => ({
          reason,
          count,
          label: getBlockedReasonLabel(reason),
        })),
    [executionDiagnostics]
  );
  const researchArtifacts = useMemo(
    () => resolvedResearchAudit?.artifacts || [],
    [resolvedResearchAudit]
  );
  const dataCheckItems = useMemo(
    () => [
      {
        label: '行情数据',
        value: bootstrap?.data_freshness?.status === 'ready' ? '可用' : '待确认',
        tone: bootstrap?.data_freshness?.status || 'degraded',
        detail: bootstrap?.data_freshness?.conclusion || '等待后端返回行情数据健康结论。',
      },
      {
        label: '运行环境',
        value: bootstrap?.runtime_health?.status === 'ready' ? '可用' : '待确认',
        tone: bootstrap?.runtime_health?.status || 'degraded',
        detail: bootstrap?.runtime_health?.conclusion || '等待后端返回运行环境健康结论。',
      },
      {
        label: '流程预设',
        value: bootstrap ? `${bootstrap.workflow_presets.length} 个` : '检查中',
        tone: bootstrap?.workflow_presets.length ? 'ready' : 'degraded',
        detail: bootstrap?.workflow_presets.length
          ? '已读取专业版工作流预设，简易版会沿用默认安全边界。'
          : '正在读取工作流预设。',
      },
    ],
    [bootstrap]
  );
  const bootstrapLoadingSteps = useMemo(
    () => [
      { label: '策略库', detail: '读取模板和策略开关' },
      { label: '行情数据', detail: '确认行情闭环状态' },
      { label: '运行环境', detail: '检查队列和运行健康' },
      { label: '流程预设', detail: '读取安全边界' },
    ],
    []
  );
  const bootstrapLoadingStepIndex = Math.min(
    bootstrapLoadingSteps.length - 1,
    Math.floor(bootstrapElapsedSeconds / 4)
  );
  const bootstrapLoadingTitle =
    bootstrapElapsedSeconds >= 12 ? '仍在完成启动体检' : '正在读取数据状态';
  const bootstrapLoadingSummary =
    bootstrapElapsedSeconds >= 12
      ? '远端 dev 库响应较慢，仍在检查运行健康；这不是回测失败，也还没有开始下单。'
      : '正在按顺序读取策略库、行情数据、运行环境和流程预设。';
  const observationEvents = useMemo(
    () => [
      {
        time: '现在',
        title: '模拟观察组合',
        state: observationMessage ? '已创建' : '待创建',
        detail:
          observationMessage ||
          `将基于 ${selectedTemplateData.name} 创建纸面观察组合，默认不自动交易。`,
      },
      {
        time: '回测后',
        title: '可信度门槛',
        state: researchAuditVerdict.can_create_observation ? '通过' : '未通过',
        detail: researchAuditVerdict.summary,
      },
      {
        time: '每日',
        title: '观察方式',
        state: '纸面',
        detail: '只记录虚拟组合和信号变化，不会下真实订单。',
      },
    ],
    [observationMessage, researchAuditVerdict, selectedTemplateData.name]
  );

  const activeStepIndex = journeySteps.findIndex(step => step.key === activeStep);
  const activeStepData = journeySteps[activeStepIndex] || journeySteps[0];
  const drawerStepData =
    drawerKey && drawerKey !== 'guide' && drawerKey !== 'ledger' && drawerKey !== 'history'
      ? journeySteps.find(step => step.key === drawerKey) || activeStepData
      : activeStepData;
  const drawerTitle =
    drawerKey === 'guide'
      ? '动线说明'
      : drawerKey === 'ledger'
        ? '实验账本'
        : drawerKey === 'history'
          ? '历史回测'
          : drawerStepData.drawerTitle;
  const progressPercent = Math.round(((activeStepIndex + 1) / journeySteps.length) * 100);
  const displayUsername = useEasyQuantDisplayUsername();

  const handleRunBacktest = useCallback(async () => {
    setBacktestLoading(true);
    setBacktestError(null);
    setBacktestDetail(null);
    setResearchAudit(null);
    setResearchAuditError(null);
    setResearchAuditLoading(false);
    setObservationMessage(null);

    try {
      const created = await easyQuantService.runEasyQuantBacktest(
        selectedTemplateId,
        hypothesis,
        runConfig
      );
      setBacktestTaskId(created.task_id);
      localStorage.setItem(
        EASY_QUANT_LAST_RUN_STORAGE_KEY,
        JSON.stringify({
          task_id: created.task_id,
          template_id: selectedTemplateId,
          hypothesis,
          run_config: runConfig,
          saved_at: Date.now(),
        } satisfies EasyQuantLastRunState)
      );
    } catch (error) {
      setBacktestError(error instanceof Error ? error.message : String(error));
      setBacktestLoading(false);
    }
  }, [hypothesis, runConfig, selectedTemplateId]);

  const handleRefreshBacktestResult = useCallback(async () => {
    if (!backtestTaskId) {
      return;
    }

    setBacktestError(null);
    try {
      const detail = await easyQuantService.getEasyQuantBacktestDetail(backtestTaskId);
      setBacktestDetail(detail);
      const status = detail?.task?.status;
      if (status === 'COMPLETED' || status === 'FAILED') {
        setBacktestLoading(false);
      }
    } catch (error) {
      setBacktestError(error instanceof Error ? error.message : String(error));
    }
  }, [backtestTaskId]);

  useEasyQuantBacktestPolling(
    backtestTaskId,
    setBacktestDetail,
    setBacktestLoading,
    setBacktestError
  );

  useEffect(() => {
    const taskId = backtestDetail?.task?.id || backtestTaskId;
    if (!taskId || backtestDetail?.task?.status !== 'COMPLETED') {
      return undefined;
    }

    const embeddedAudit = latestEmbeddedResearchAuditRef.current;
    if (embeddedAudit) {
      setResearchAudit(current => pickMostCompleteResearchAudit(embeddedAudit, current));
    }

    if (isResearchAuditComplete(embeddedAudit)) {
      setResearchAuditLoading(false);
      return undefined;
    }

    let cancelled = false;
    let pollTimer: number | null = null;
    const startedAt = Date.now();

    const pollAudit = async () => {
      setResearchAuditLoading(true);
      setResearchAuditError(null);

      try {
        const audit = await easyQuantService.getEasyQuantResearchAudit(taskId);
        if (cancelled) {
          return;
        }

        setResearchAudit(current => pickMostCompleteResearchAudit(audit, current));

        if (
          isResearchAuditComplete(audit) ||
          Date.now() - startedAt > EASY_QUANT_AUDIT_POLL_TIMEOUT_MS
        ) {
          setResearchAuditLoading(false);
          return;
        }

        pollTimer = window.setTimeout(pollAudit, EASY_QUANT_AUDIT_POLL_INTERVAL_MS);
      } catch (error) {
        if (!cancelled) {
          setResearchAuditError(error instanceof Error ? error.message : String(error));
          setResearchAuditLoading(false);
        }
      }
    };

    void pollAudit();

    return () => {
      cancelled = true;
      if (pollTimer) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [
    backtestDetail?.task?.id,
    backtestDetail?.task?.status,
    backtestTaskId,
  ]);

  const handleCreateObservation = useCallback(async () => {
    setObservationCreating(true);
    setObservationMessage(null);

    try {
      const created = await easyQuantService.createEasyQuantObservationPortfolio(
        selectedTemplateId,
        runConfig
      );
      setObservationMessage(`已创建模拟观察组合：${created.name}`);
    } catch (error) {
      setObservationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setObservationCreating(false);
    }
  }, [runConfig, selectedTemplateId]);

  useEasyQuantSectionScrollSpy(
    scrollRootRef,
    programmaticSectionRef,
    sectionNavItems,
    stepBySection,
    setActiveSectionId,
    setActiveStep,
    setVisibleSections
  );

  useEffect(
    () => () => {
      if (snapRestoreTimerRef.current) {
        window.clearTimeout(snapRestoreTimerRef.current);
      }
      if (navLockTimerRef.current) {
        window.clearTimeout(navLockTimerRef.current);
      }
    },
    []
  );

  const scrollToSection = (sectionId: SectionId) => {
    const scrollRoot = scrollRootRef.current;
    const section = document.getElementById(sectionId);
    if (!section || !scrollRoot) {
      return;
    }

    if (snapRestoreTimerRef.current) {
      window.clearTimeout(snapRestoreTimerRef.current);
    }

    if (navLockTimerRef.current) {
      window.clearTimeout(navLockTimerRef.current);
    }

    setActiveSectionId(sectionId);
    const stepKey = stepBySection[sectionId];
    if (stepKey) {
      setActiveStep(stepKey);
    }
    setVisibleSections(prev =>
      prev[sectionId]
        ? prev
        : {
            ...prev,
            [sectionId]: true,
          }
    );

    const scrollRootTop = scrollRoot.getBoundingClientRect().top;
    const sectionTop = section.getBoundingClientRect().top;
    const targetTop = sectionTop - scrollRootTop + scrollRoot.scrollTop;

    programmaticSectionRef.current = sectionId;
    scrollRoot.classList.add('eq-scroll-root--no-snap');
    scrollRoot.style.scrollBehavior = 'auto';
    scrollRoot.scrollTo({
      top: targetTop,
      behavior: 'auto',
    });

    window.requestAnimationFrame(() => {
      scrollRoot.scrollTo({
        top: targetTop,
        behavior: 'auto',
      });
    });

    navLockTimerRef.current = window.setTimeout(() => {
      programmaticSectionRef.current = null;
      scrollRoot.style.scrollBehavior = '';
    }, 180);
    snapRestoreTimerRef.current = window.setTimeout(() => {
      scrollRoot.classList.remove('eq-scroll-root--no-snap');
    }, 240);
  };

  const goToStep = (stepKey: StepKey) => {
    setActiveStep(stepKey);
    window.requestAnimationFrame(() => scrollToSection(sectionByStep[stepKey]));
  };

  const handleResetResearchFlow = () => {
    clearResearchRunState();
    goToStep('template');
  };

  const handleOpenHistoryBacktest = async (item: BacktestTask) => {
    const taskId = Number(item.id);
    if (!Number.isFinite(taskId) || taskId <= 0) {
      return;
    }

    const templateId = pickHistoryTaskTemplateId(item, selectedTemplateId);
    const template = getEasyQuantTemplate(templateId);
    const nextRunConfig = buildRunConfigFromHistoryTask(item, template);
    const nextHypothesis =
      typeof item.parameters?.hypothesis === 'string' && item.parameters.hypothesis.trim()
        ? item.parameters.hypothesis
        : template.default_hypothesis;

    restoredRunRef.current = true;
    runConfigTouchedRef.current = false;
    hypothesisTouchedRef.current = true;
    setSelectedTemplateId(templateId);
    setHypothesis(nextHypothesis);
    setRunConfig(nextRunConfig);
    setBacktestTaskId(taskId);
    setBacktestDetail(null);
    setBacktestError(null);
    setResearchAudit(null);
    setResearchAuditError(null);
    setResearchAuditLoading(false);
    setObservationMessage(null);
    setDrawerKey(null);
    setActiveStep('backtest');
    localStorage.setItem(
      EASY_QUANT_LAST_RUN_STORAGE_KEY,
      JSON.stringify({
        task_id: taskId,
        template_id: templateId,
        hypothesis: nextHypothesis,
        run_config: nextRunConfig,
        saved_at: Date.now(),
      } satisfies EasyQuantLastRunState)
    );
    window.setTimeout(() => {
      restoredRunRef.current = false;
    }, 0);

    try {
      setBacktestLoading(true);
      const detail = await easyQuantService.getEasyQuantBacktestDetail(taskId);
      setBacktestDetail(detail);
      setResearchAudit(detail?.research_audit || null);
      const status = String(detail?.task?.status || item.status || '').toUpperCase();
      setBacktestLoading(status === 'QUEUED' || status === 'RUNNING' || status === 'PENDING');
    } catch (error) {
      setBacktestError(error instanceof Error ? error.message : String(error));
      setBacktestLoading(false);
    }

    window.requestAnimationFrame(() => scrollToSection('easy-quant-backtest'));
  };

  const getSectionClassName = (sectionId: SectionId) =>
    `eq-screen-section ${visibleSections[sectionId] ? 'eq-screen-section--visible' : ''}`;

  const startGuidedFlow = () => {
    setActiveStep('template');
    window.requestAnimationFrame(() => scrollToSection('easy-quant-flow'));
  };
  const backtestRunningTitle =
    backtestElapsedSeconds >= 90 ? '仍在运行' : backtestTaskId ? '正在排队和计算' : '正在提交任务';
  const backtestRunningSummary =
    backtestElapsedSeconds >= 90
      ? '回测仍在后台执行，可以继续等待，也可以点刷新结果查看最新状态。'
      : backtestTaskId
        ? '任务已经提交，正在等待后端计算收益、回撤和成交记录。'
        : '正在创建回测任务，拿到任务号后会自动开始轮询结果。';
  const rawBacktestStatus = String(backtestDetail?.task?.status || '').toUpperCase();
  const backtestProgress = Number(backtestDetail?.task?.progress || 0);
  const completedResearchAuditVerdict = String(
    resolvedResearchAudit?.credibility_verdict?.verdict || ''
  ).toLowerCase();
  const hasCompletedResearchAudit =
    Boolean(completedResearchAuditVerdict) &&
    completedResearchAuditVerdict !== 'pending' &&
    researchAuditComplete;
  const backtestRunningStageIndex = !backtestTaskId
    ? 0
    : rawBacktestStatus === 'QUEUED'
      ? 1
      : researchAuditLoading || hasCompletedResearchAudit
        ? 3
        : rawBacktestStatus === 'COMPLETED'
          ? 3
          : 2;
  const backtestRunningStages = useMemo(
    () =>
      [
        {
          label: '提交任务',
          detail: backtestTaskId ? `任务号 ${backtestTaskId}` : '正在创建任务号',
        },
        {
          label: '排队',
          detail:
            rawBacktestStatus === 'QUEUED'
              ? '等待回测 worker 接手'
              : backtestTaskId
                ? '已进入计算队列'
                : '拿到任务号后排队',
        },
        {
          label: '计算收益',
          detail:
            backtestProgress > 0 && rawBacktestStatus === 'RUNNING'
              ? `当前进度 ${backtestProgress}%`
              : '计算收益、回撤和成交记录',
        },
        {
          label: '写入可信度',
          detail: hasCompletedResearchAudit
            ? '审计结论已写入'
            : researchAuditLoading
              ? '正在写实验账本'
              : rawBacktestStatus === 'COMPLETED'
                ? '正在生成审计结论'
                : '回测完成后自动审计',
        },
      ].map((stage, index) => ({
        ...stage,
        state:
          backtestError && index === backtestRunningStageIndex
            ? 'error'
            : index < backtestRunningStageIndex
              ? 'done'
              : index === backtestRunningStageIndex
                ? 'active'
                : 'waiting',
      })),
    [
      backtestError,
      backtestProgress,
      backtestRunningStageIndex,
      backtestTaskId,
      hasCompletedResearchAudit,
      rawBacktestStatus,
      researchAuditLoading,
    ]
  );
  const backtestFailureGuidance = useMemo(() => {
    if (!backtestError) {
      return null;
    }

    const failedStage =
      backtestRunningStages.find(stage => stage.state === 'error') ||
      backtestRunningStages[backtestRunningStageIndex] ||
      backtestRunningStages[0];
    const taskMessage = backtestDetail?.task?.error_message;
    const detail = taskMessage
      ? `后端回测任务返回：${taskMessage}。可以先刷新结果确认状态；如果仍失败，重新跑一次会保留同样的模板和假设。`
      : '这通常是提交、轮询或后端计算临时失败。可以先刷新结果；如果任务不存在或仍失败，再重新跑一次。';

    return {
      title: `失败发生在${failedStage.label}`,
      detail,
    };
  }, [
    backtestDetail?.task?.error_message,
    backtestError,
    backtestRunningStageIndex,
    backtestRunningStages,
  ]);

  const credibilityItems = useMemo(() => {
    const getArtifact = (artifact_type: string) =>
      researchArtifacts.find(item => item.artifact_type === artifact_type);
    const items = [
      {
        key: 'backtest',
        label: '回测来源',
        artifact: getArtifact('backtest'),
        fallback: backtestDetail ? '回测已返回，等待账本写入。' : '完成回测后生成来源记录。',
      },
      {
        key: 'integrity',
        label: '未来数据',
        artifact: getArtifact('integrity_audit'),
        fallback: researchAuditLoading ? '正在检查未来函数和数据可见性。' : '等待可信度审计。',
      },
      {
        key: 'execution',
        label: 'A股成交',
        artifact: getArtifact('execution_audit'),
        fallback: researchAuditLoading ? '正在汇总涨跌停、停牌和 T+1 约束。' : '等待成交约束审计。',
      },
    ];

    return items.map(item => ({
      ...item,
      status: item.artifact?.status || (researchAuditLoading ? 'pending' : 'insufficient'),
      summary: item.artifact?.summary || item.fallback,
    }));
  }, [backtestDetail, researchArtifacts, researchAuditLoading]);
  const credibilityActionHint = useMemo(() => {
    const firstBlockingReason = researchAuditVerdict.blocking_reasons?.[0];
    const firstWatchReason = researchAuditVerdict.watch_reasons?.[0];

    if (researchAuditLoading) {
      return {
        title: '正在生成可信度结论',
        detail: '系统正在把回测来源、未来数据检查和 A 股成交约束写进实验账本。',
      };
    }

    if (!backtestDetail) {
      return {
        title: '先跑一次真实回测',
        detail: '不用提前判断收益好坏，先让系统生成可追溯的回测和审计记录。',
      };
    }

    if (!researchAuditVerdict.can_create_observation) {
      return {
        title: '暂时不要进入观察',
        detail: firstBlockingReason
          ? `先处理：${trimSentenceEnding(firstBlockingReason)}。处理后重新跑回测，再看可信度是否放行。`
          : '先处理数据、模板或审计缺口。修正后重新跑回测，再看可信度是否放行。',
      };
    }

    if (researchAuditVerdict.status === 'caution') {
      return {
        title: '可以小步观察，但不要放大仓位',
        detail: firstWatchReason
          ? `先观察 5 到 10 个交易日，重点看：${trimSentenceEnding(firstWatchReason)}。`
          : '先观察 5 到 10 个交易日，重点看信号、成交和回撤是否稳定。',
      };
    }

    return {
      title: '可以进入模拟观察',
      detail: '先观察 5 到 10 个交易日，确认信号、成交和回撤都稳定后，再考虑更复杂配置。',
    };
  }, [backtestDetail, researchAuditLoading, researchAuditVerdict]);

  const renderStage = (stageKey: StepKey = activeStep) => {
    if (stageKey === 'data') {
      return (
        <article className="eq-stage-panel eq-stage-panel--data">
          <div className="eq-stage-topline">
            <span>当前任务</span>
          </div>
          <div className="eq-stage-copy">
            <h2>
              查数据 <StoryHint story="data" label="查数据说明" />
            </h2>
            <p>先确认数据可靠，再进入回测。新手不需要理解每个字段，只看是否可以继续。</p>
          </div>
          <div
            className={`eq-verdict-card ${bootstrapLoading ? 'eq-verdict-card--loading' : ''}`}
            aria-busy={bootstrapLoading}
          >
            <JourneySketch type="lens" />
            <div>
              <span className="eq-soft-label">体检结果</span>
              <strong>
                {bootstrapLoading
                  ? bootstrapLoadingTitle
                  : bootstrap?.health_verdict.title || '正在读取数据状态'}
              </strong>
              <p>
                {bootstrapLoading
                  ? bootstrapLoadingSummary
                  : bootstrap?.health_verdict.summary || '正在读取后端数据健康和运行健康。'}
              </p>
            </div>
          </div>
          {bootstrapError && (
            <div className="eq-inline-notice eq-inline-notice--error" role="alert">
              <p>{explainEasyQuantError(bootstrapError, 'bootstrap')}</p>
              <button type="button" className="eq-button eq-button--quiet" onClick={reloadBootstrap}>
                重新检查 <ReloadOutlined />
              </button>
            </div>
          )}
          {bootstrapLoading && (
            <div className="eq-loading-status" aria-live="polite">
              <div className="eq-loading-line">
                <span>已检查 {bootstrapElapsedSeconds} 秒</span>
                <i aria-hidden="true" />
              </div>
              <div className="eq-loading-steps">
                {bootstrapLoadingSteps.map((item, index) => {
                  const state =
                    index < bootstrapLoadingStepIndex
                      ? 'done'
                      : index === bootstrapLoadingStepIndex
                        ? 'active'
                        : 'waiting';

                  return (
                    <span key={item.label} className={`eq-loading-step eq-loading-step--${state}`}>
                      <b>{item.label}</b>
                      <em>{item.detail}</em>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {bootstrap?.health_verdict && (
            <p className={`eq-state-${bootstrap.health_verdict.status}`}>
              {bootstrap.health_verdict.title}：{bootstrap.health_verdict.summary}
            </p>
          )}
          <div className="eq-inline-metrics">
            {dataCheckItems.map(item => (
              <article key={item.label}>
                <span>{item.label}</span>
                <strong className={`eq-state-${item.tone}`}>{item.value}</strong>
                <em>{item.detail}</em>
              </article>
            ))}
          </div>
          <div className="eq-stage-actions">
            <button
              className="eq-button eq-button--dark"
              disabled={
                bootstrapLoading ||
                Boolean(bootstrapError) ||
                !bootstrap ||
                backtestLoading ||
                selectedTemplateData.available === false ||
                bootstrap?.health_verdict.can_run_backtest === false
              }
              onClick={() => {
                goToStep('backtest');
                void handleRunBacktest();
              }}
            >
              {backtestLoading ? '回测运行中' : '开始真实回测'} <PlayCircleOutlined />
            </button>
            <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('data')}>
              查看数据明细
            </button>
          </div>
        </article>
      );
    }

    if (stageKey === 'backtest') {
      return (
        <article className="eq-stage-panel eq-stage-panel--backtest">
          <div className="eq-stage-topline">
            <span>当前任务</span>
          </div>
          <div className="eq-stage-copy">
            <h2>
              回测报告 <StoryHint story="metrics" label="回测报告说明" />
            </h2>
            <p>先看一个结论，再决定要不要进入模拟观察。详细指标放在抽屉里慢慢看。</p>
            <div className="eq-report-actions">
              <button
                className="eq-button eq-button--quiet eq-report-history-link"
                onClick={openHistoryDrawer}
              >
                历史回测 <HistoryOutlined />
              </button>
            </div>
          </div>
          <div className="eq-run-summary-strip" aria-label="本次回测配置">
            <span>
              初始资金 <strong>{formatMoneyValue(runConfig.initial_capital)}</strong>
            </span>
            <span>
              回测区间 <strong>近{runConfig.lookback_years}年</strong>
            </span>
            <span>
              股票池 <strong>{formatUniverseLabel(runConfig.universe)}</strong>
            </span>
            <span>
              仓位{' '}
              <strong>
                {runConfig.position_pct}% / 最多{runConfig.max_positions}只
              </strong>
            </span>
          </div>
          <div className="eq-result-hero">
            <div>
              <span className="eq-soft-label">真实回测结论</span>
              <strong>{backtestLoading ? '回测运行中' : backtestVerdict.title}</strong>
              <p>
                {backtestLoading
                  ? '正在读取后端回测任务结果，完成后会自动解释收益和风险。'
                  : backtestVerdict.summary}
              </p>
            </div>
            <JourneySketch type="chart" />
          </div>
          {backtestTaskId && <p className="eq-state-muted">回测任务 ID：{backtestTaskId}</p>}
          {(backtestLoading || backtestError) && (
            <div
              className={`eq-running-status ${backtestError ? 'eq-running-status--error' : ''}`}
              role={backtestError ? 'alert' : undefined}
              aria-live="polite"
            >
              <div>
                <span>{backtestError ? backtestFailureGuidance?.title : backtestRunningTitle}</span>
                <strong>
                  {backtestError ? '需要处理后再继续' : `已运行 ${backtestElapsedSeconds} 秒`}
                </strong>
              </div>
              <p>
                {backtestError
                  ? backtestFailureGuidance?.detail ||
                    explainEasyQuantError(backtestError, 'backtest')
                  : backtestRunningSummary}
              </p>
              <div className="eq-running-timeline" aria-label="回测运行阶段">
                {backtestRunningStages.map(stage => (
                  <span
                    key={stage.label}
                    className={`eq-running-node eq-running-node--${stage.state}`}
                  >
                    <b>{stage.label}</b>
                    <em>{stage.detail}</em>
                  </span>
                ))}
              </div>
              {!backtestError && (
                <div className="eq-loading-line">
                  <span>正在读取任务状态</span>
                  <i aria-hidden="true" />
                </div>
              )}
              <div className="eq-running-actions">
                <button
                  className="eq-button eq-button--quiet"
                  disabled={!backtestTaskId}
                  onClick={handleRefreshBacktestResult}
                >
                  刷新结果 <ReloadOutlined />
                </button>
                {backtestError && (
                  <button className="eq-button eq-button--quiet" onClick={handleRunBacktest}>
                    重新跑一次 <PlayCircleOutlined />
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="eq-inline-metrics eq-inline-metrics--four">
            {backtestVerdict.beginner_metrics.length ? (
              backtestVerdict.beginner_metrics.map(metric => (
                <article key={metric.key}>
                  <span>{metric.label}</span>
                  <strong className={`eq-metric-value eq-metric-value--${metric.tone}`}>
                    {metric.value}
                  </strong>
                  <em>{metric.explanation}</em>
                </article>
              ))
            ) : (
              <article>
                <span>回测指标</span>
                <strong className="eq-metric-value eq-metric-value--neutral">待生成</strong>
                <em>点“开始真实回测”后，这里会展示新手版解释。</em>
              </article>
            )}
          </div>
          <div className="eq-stage-actions">
            <button
              className="eq-button eq-button--dark"
              disabled={!backtestDetail || backtestLoading}
              onClick={() => goToStep('credibility')}
            >
              查看可信度 <ArrowRightOutlined />
            </button>
            <button
              className="eq-button eq-button--quiet"
              onClick={() => openBacktestDrawer('metrics')}
            >
              查看完整指标
            </button>
            <button
              className="eq-button eq-button--quiet"
              onClick={() => openBacktestDrawer('trades')}
            >
              查看交易明细
            </button>
          </div>
        </article>
      );
    }

    if (stageKey === 'credibility') {
      return (
        <article className="eq-stage-panel eq-stage-panel--credibility">
          <div className="eq-stage-topline">
            <span>当前任务</span>
          </div>
          <div className="eq-stage-copy">
            <h2>
              可信度 <StoryHint story="credibility" label="可信度说明" />
            </h2>
            <p>先确认这次研究没有偷看未来，也没有违反 A 股成交规则，再进入模拟观察。</p>
          </div>
          <div className="eq-credibility-hero">
            <div>
              <span className="eq-soft-label">可信度总判</span>
              <strong>{researchAuditLoading ? '可信度生成中' : researchAuditVerdict.title}</strong>
              <p>
                {researchAuditLoading
                  ? '正在写入实验账本和审计结论。'
                  : researchAuditVerdict.summary}
              </p>
            </div>
            <JourneySketch type="shield" />
          </div>
          {researchAuditError && (
            <div className="eq-inline-notice eq-inline-notice--error" role="alert">
              <p className="eq-state-error">{explainEasyQuantError(researchAuditError, 'audit')}</p>
            </div>
          )}
          {backtestTaskId && (
            <p className="eq-state-muted">实验账本关联回测任务：{backtestTaskId}</p>
          )}
          <div className="eq-credibility-grid">
            {credibilityItems.map(item => (
              <article
                key={item.key}
                className={`eq-credibility-card eq-credibility-card--${getArtifactTone(item.status)}`}
              >
                <span>
                  {item.label}
                  <StoryHint
                    story={credibilityStoryByKey[item.key] || 'credibility'}
                    label={`${item.label}说明`}
                  />
                </span>
                <strong>{getArtifactStatusLabel(item.status)}</strong>
                <p>{item.summary}</p>
              </article>
            ))}
          </div>
          <div className={`eq-action-brief eq-action-brief--${researchAuditVerdict.status}`}>
            <strong>{credibilityActionHint.title}</strong>
            <p>{credibilityActionHint.detail}</p>
          </div>
          <div className="eq-stage-actions">
            <button
              className="eq-button eq-button--dark"
              disabled={!researchAuditVerdict.can_create_observation || researchAuditLoading}
              onClick={() => goToStep('observe')}
            >
              进入模拟观察 <ArrowRightOutlined />
            </button>
            <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('ledger')}>
              查看实验账本
            </button>
            {!researchAuditVerdict.can_create_observation && (
              <button className="eq-button eq-button--quiet" onClick={() => goToStep('data')}>
                回到查数据
              </button>
            )}
          </div>
        </article>
      );
    }

    if (stageKey === 'observe') {
      return (
        <article className="eq-stage-panel eq-stage-panel--observe">
          <div className="eq-stage-topline">
            <span>当前任务</span>
          </div>
          <div className="eq-stage-copy">
            <h2>模拟观察</h2>
            <p>不要急着实盘。先观察策略每天如何生成信号、通过风控、产生持仓变化。</p>
          </div>
          <div className="eq-observe-hero">
            <article>
              <span>{selectedTemplateData.name}</span>
              <strong>{observationMessage ? '已创建' : '待创建'}</strong>
              <p>{observationMessage || '回测达到观察门槛后，可以创建一个纸面观察组合。'}</p>
            </article>
            <div className="eq-observe-timeline">
              {observationEvents.map(log => (
                <button key={`${log.time}-${log.title}`} onClick={() => setDrawerKey('observe')}>
                  <time>{log.time}</time>
                  <strong>{log.title}</strong>
                  <span>{log.state}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="eq-state-muted">
            模拟观察只记录虚拟组合，不会下真实订单，也不会自动开启实盘。
          </p>
          <div className="eq-stage-actions">
            <button
              className="eq-button eq-button--dark"
              disabled={!researchAuditVerdict.can_create_observation || observationCreating}
              onClick={handleCreateObservation}
            >
              {observationCreating ? '创建中' : researchAuditVerdict.next_action_label}
            </button>
            <Link className="eq-button eq-button--quiet" to="/workspace/portfolio">
              去模拟盘查看
            </Link>
            <button className="eq-button eq-button--quiet" onClick={handleResetResearchFlow}>
              重新选模板
            </button>
          </div>
        </article>
      );
    }

    return (
      <article className="eq-stage-panel eq-stage-panel--template">
        <div className="eq-stage-topline">
          <span>当前任务</span>
        </div>
        <div className="eq-stage-copy">
          <h2>选择策略模板</h2>
          <p>从一个默认模板开始，先跑通完整流程。参数和高级规则之后再慢慢打开。</p>
        </div>
        <div className="eq-template-cards">
          {templatesForView.map(template => (
            <button
              key={template.id}
              type="button"
              className={`eq-template-card ${
                selectedTemplateId === template.id ? 'eq-template-card--active' : ''
              }`}
              onClick={() => handleTemplateSelect(template.id)}
              aria-pressed={selectedTemplateId === template.id}
              disabled={template.available === false}
            >
              {selectedTemplateId === template.id ? (
                <span className="eq-template-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
              <JourneySketch type={templateSketchById[template.id]} />
              <span>
                <strong>{template.name}</strong>
                <em>
                  {template.beginner_summary}
                  {template.available === false ? ` ${template.unavailable_reason}` : ''}
                </em>
                <small className="eq-template-best-for">{template.best_for}</small>
              </span>
              <div className="eq-template-facts">
                <small>买入：{template.buy_logic_label}</small>
                <small>卖出：{template.sell_logic_label}</small>
                <small>周期：{template.holding_period_label}</small>
              </div>
              <small className={`eq-risk-tag eq-risk-tag--${getRiskTone(template.risk_label)}`}>
                {template.risk_label}
              </small>
            </button>
          ))}
        </div>
        <section className="eq-run-config" aria-label="轻量回测配置">
          <div className="eq-run-config-head">
            <span>轻量配置</span>
            <em>{selectedTemplateData.risk_note}</em>
          </div>
          <div className="eq-config-group">
            <span>初始资金</span>
            <div className="eq-config-options">
              {[100000, 200000, 500000, 1000000].map(amount => (
                <button
                  key={amount}
                  type="button"
                  className={`eq-config-chip ${
                    runConfig.initial_capital === amount ? 'eq-config-chip--active' : ''
                  }`}
                  onClick={() => updateRunConfig({ initial_capital: amount })}
                >
                  {formatMoneyValue(amount)}
                </button>
              ))}
            </div>
            <input
              className="eq-config-input"
              type="number"
              min={10000}
              step={10000}
              aria-label="自定义初始资金"
              value={runConfig.initial_capital}
              onChange={event =>
                updateRunConfig({
                  initial_capital: Math.max(10000, Number(event.target.value) || 10000),
                })
              }
            />
          </div>
          <div className="eq-config-group">
            <span>回测区间</span>
            <div className="eq-config-options">
              {[
                { value: 1, label: '近1年' },
                { value: 2, label: '近2年' },
                { value: 3, label: '近3年' },
              ].map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={`eq-config-chip ${
                    runConfig.lookback_years === option.value ? 'eq-config-chip--active' : ''
                  }`}
                  onClick={() =>
                    updateRunConfig({
                      lookback_years: option.value as EasyQuantRunConfig['lookback_years'],
                    })
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="eq-config-group">
            <span>股票池</span>
            <div className="eq-config-options">
              {[
                { value: 'favorites', label: '自选股', candidate_limit: 80 },
                { value: 'all', label: '全市场候选', candidate_limit: 160 },
              ].map(option => (
                <button
                  key={option.value}
                  type="button"
                  className={`eq-config-chip ${
                    runConfig.universe === option.value ? 'eq-config-chip--active' : ''
                  }`}
                  onClick={() =>
                    updateRunConfig({
                      universe: option.value as EasyQuantRunConfig['universe'],
                      candidate_limit: option.candidate_limit,
                    })
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="eq-config-group">
            <span>单票仓位</span>
            <div className="eq-config-options">
              {[5, 10, 12, 15].map(positionPct => (
                <button
                  key={positionPct}
                  type="button"
                  className={`eq-config-chip ${
                    runConfig.position_pct === positionPct ? 'eq-config-chip--active' : ''
                  }`}
                  onClick={() => updateRunConfig({ position_pct: positionPct })}
                >
                  {positionPct}%
                </button>
              ))}
            </div>
          </div>
          <div className="eq-config-group">
            <span>最大持仓</span>
            <div className="eq-config-options">
              {[3, 6, 8, 10].map(maxPositions => (
                <button
                  key={maxPositions}
                  type="button"
                  className={`eq-config-chip ${
                    runConfig.max_positions === maxPositions ? 'eq-config-chip--active' : ''
                  }`}
                  onClick={() => updateRunConfig({ max_positions: maxPositions })}
                >
                  {maxPositions}只
                </button>
              ))}
            </div>
          </div>
        </section>
        <label className="eq-hypothesis">
          <span>
            研究假设 <StoryHint story="hypothesis" label="研究假设说明" />
          </span>
          <textarea
            value={hypothesis}
            onChange={event => {
              hypothesisTouchedRef.current = true;
              setHypothesis(event.target.value);
            }}
            rows={3}
          />
        </label>
        <div className="eq-stage-actions">
          <button
            className="eq-button eq-button--dark"
            disabled={selectedTemplateData.available === false}
            onClick={() => goToStep('data')}
          >
            下一步：查数据 <ArrowRightOutlined />
          </button>
          {selectedTemplateData.available === false && (
            <Link className="eq-button eq-button--quiet" to="/workspace/lab">
              去专业版查看策略
            </Link>
          )}
        </div>
      </article>
    );
  };

  const renderStepDock = () => (
    <aside className="eq-step-dock" aria-label="步骤导航">
      <div className="eq-progress">
        <span>进度</span>
        <strong>{progressPercent}%</strong>
        <div>
          <i style={{ width: `${progressPercent}%` }} />
        </div>
      </div>
      {journeySteps.map(step => (
        <button
          key={step.key}
          className={`eq-step-pill ${activeStep === step.key ? 'eq-step-pill--active' : ''}`}
          onClick={() => goToStep(step.key)}
        >
          <span>{step.number}</span>
          <div>
            <strong>{step.title}</strong>
            <em>{step.caption}</em>
          </div>
        </button>
      ))}
    </aside>
  );

  const renderQuickCard = () => (
    <aside className="eq-inspector" aria-label="快捷入口">
      <div className="eq-quick-card">
        <span>快捷入口</span>
        <div className="eq-quick-list">
          <button onClick={openHistoryDrawer}>历史回测</button>
          <button onClick={() => openBacktestDrawer('trades')}>交易明细</button>
          <button onClick={() => openBacktestDrawer('metrics')}>完整指标</button>
          <button onClick={() => setDrawerKey('data')}>查数据</button>
          <button onClick={() => setDrawerKey('template')}>模板对比</button>
          <button onClick={() => setDrawerKey('observe')}>观察日志</button>
          <button onClick={() => openBacktestDrawer('blocks')}>成交阻断</button>
          <button onClick={() => setDrawerKey('ledger')}>实验账本</button>
        </div>
      </div>
    </aside>
  );

  const renderFlowOverview = () => (
    <div className="eq-flow-overview-grid">
      {journeySteps.map(step => (
        <button
          key={step.key}
          className={`eq-flow-card ${activeStep === step.key ? 'eq-flow-card--active' : ''}`}
          onClick={() => goToStep(step.key)}
        >
          <span>{step.number}</span>
          <JourneySketch type={step.sketch} />
          <strong>{step.title}</strong>
          <em>{step.caption}</em>
        </button>
      ))}
    </div>
  );

  const renderDrawerContent = () => {
    if (drawerKey === 'guide') {
      return (
        <>
          <p>
            简易版只保留一条主线：选模板、查数据、跑回测、模拟观察。每一步页面只做一个决定，
            其余信息都收进抽屉。
          </p>
          <div className="eq-drawer-list">
            {journeySteps.map(step => (
              <article key={step.key}>
                <span>{step.number}</span>
                <strong>{step.title}</strong>
                <p>{step.caption}</p>
              </article>
            ))}
          </div>
          <div className="eq-drawer-note">
            <strong>推荐动线</strong>
            <span>先按默认配置走完一次，再回到专业版调参数。</span>
          </div>
        </>
      );
    }

    if (drawerKey === 'data') {
      return (
        <div className="eq-drawer-list">
          {dataCheckItems.map(item => (
            <article key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      );
    }

    if (drawerKey === 'history') {
      return (
        <>
          <div className="eq-drawer-note eq-history-intro">
            <strong>
              只列简易版回测 <StoryHint story="history" label="历史回测说明" />
            </strong>
            <span>点“在简易版查看”会回到当前五步流程；点“专业版详情”会打开完整回测页。</span>
            <button
              className="eq-button eq-button--quiet"
              onClick={() => void loadEasyQuantHistory()}
            >
              刷新历史 <ReloadOutlined />
            </button>
          </div>
          {historyError && (
            <div className="eq-inline-notice eq-inline-notice--error" role="alert">
              <p>{explainEasyQuantError(historyError, 'backtest')}</p>
              <button
                type="button"
                className="eq-button eq-button--quiet"
                onClick={() => void loadEasyQuantHistory()}
              >
                重试 <ReloadOutlined />
              </button>
            </div>
          )}
          {historyLoading && (
            <article className="eq-empty-note eq-history-loading" role="status">
              <span>历史回测</span>
              <strong>正在读取历史列表</strong>
              <p>正在读取最近的简易版回测任务。</p>
            </article>
          )}
          {!historyLoading && !historyItems.length && !historyError && (
            <article className="eq-empty-note" role="status">
              <span>历史回测</span>
              <strong>还没有简易版回测</strong>
              <p>跑完一次真实回测后，这里会保留入口，方便复看报告或进入专业详情。</p>
            </article>
          )}
          {!historyLoading && historyItems.length > 0 && (
            <div className="eq-history-list">
              {historyItems.map(item => {
                const templateId = pickHistoryTaskTemplateId(item, selectedTemplateId);
                const template = getEasyQuantTemplate(templateId);
                const bestReturn = item.run_summary?.best_return_pct;
                const bestDrawdown = item.run_summary?.best_max_drawdown_pct;
                return (
                  <article key={item.id} className="eq-history-card">
                    <div className="eq-history-card-head">
                      <span>
                        #{item.id} · {getBacktestStatusLabel(item.status)}
                      </span>
                      <strong>{item.task_name}</strong>
                    </div>
                    <div className="eq-history-meta">
                      <span>模板：{template.name}</span>
                      <span>
                        区间：{formatDateOnly(item.start_date)} 至 {formatDateOnly(item.end_date)}
                      </span>
                      <span>初始资金：{formatMoneyValue(item.initial_capital)}</span>
                      <span>
                        最好收益：
                        <b
                          className={
                            (toFiniteNumber(bestReturn) ?? 0) >= 0
                              ? 'eq-metric-value--good'
                              : 'eq-metric-value--bad'
                          }
                        >
                          {formatPercentValue(bestReturn)}
                        </b>
                      </span>
                      <span>
                        最大回撤：{formatPercentValue(Math.abs(toFiniteNumber(bestDrawdown) ?? 0))}
                      </span>
                    </div>
                    <p>
                      {item.run_summary?.conclusion ||
                        item.error_message ||
                        '这条历史回测可以在简易版复看，也可以进入专业版查看全部指标。'}
                    </p>
                    <div className="eq-history-actions">
                      <button
                        className="eq-button eq-button--dark"
                        onClick={() => void handleOpenHistoryBacktest(item)}
                      >
                        在简易版查看
                      </button>
                      <Link
                        className="eq-button eq-button--quiet"
                        to={`/legacy/backtest/${item.id}`}
                      >
                        专业版详情 <ExportOutlined />
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      );
    }

    if (drawerKey === 'backtest') {
      return (
        <>
          <div className="eq-report-tabs" role="tablist" aria-label="回测报告标签">
            {[
              { key: 'metrics', label: '完整指标' },
              { key: 'trades', label: '交易明细' },
              { key: 'blocks', label: '成交阻断' },
            ].map(tab => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={backtestReportTab === tab.key}
                className={backtestReportTab === tab.key ? 'eq-report-tab--active' : ''}
                onClick={() => setBacktestReportTab(tab.key as BacktestReportTab)}
              >
                {tab.label}
                <StoryHint
                  story={backtestReportStoryByTab[tab.key as BacktestReportTab]}
                  label={`${tab.label}说明`}
                  focusable={false}
                />
              </button>
            ))}
          </div>
          {backtestReportTab === 'metrics' && (
            <div className="eq-report-panel">
              {reportMetricGroups.length ? (
                reportMetricGroups.map(group => (
                  <section key={group.title} className="eq-report-group">
                    <h3>{group.title}</h3>
                    <div className="eq-report-metric-grid">
                      {group.rows.map(row => (
                        <article key={`${group.title}-${row.label}`}>
                          <span>{row.label}</span>
                          <strong className={row.tone ? `eq-metric-value--${row.tone}` : undefined}>
                            {row.value}
                          </strong>
                          <p>{row.detail}</p>
                        </article>
                      ))}
                    </div>
                  </section>
                ))
              ) : (
                <article className="eq-empty-note" role="status">
                  <span>完整指标</span>
                  <strong>待生成</strong>
                  <p>完成一次真实回测后，这里会展示收益、风险、交易和成本的完整分组。</p>
                </article>
              )}
            </div>
          )}
          {backtestReportTab === 'trades' && (
            <div className="eq-report-panel">
              <div className="eq-report-summary">
                <span>交易明细</span>
                <strong>{tradeRows.length ? `${tradeRows.length} 笔` : '暂无完整交易'}</strong>
                <p>这里展示每笔交易的买入原因、卖出原因、持有天数和实际盈亏。</p>
              </div>
              {tradeRows.length ? (
                <div className="eq-report-list">
                  {tradeRows.slice(0, 40).map((trade, index) => {
                    const entry_reason =
                      trade.entry_reason || '策略信号触发买入，后端没有返回更细原因。';
                    const exit_reason =
                      trade.exit_reason || '策略退出或达到风控条件，后端没有返回更细原因。';
                    const tradeReturn = toFiniteNumber(trade.return_pct);
                    return (
                      <article
                        key={`${trade.symbol}-${trade.buy_date}-${index}`}
                        className="eq-trade-card"
                      >
                        <div className="eq-trade-card-head">
                          <span>{trade.symbol}</span>
                          <strong>{trade.name || '未命名股票'}</strong>
                          <em
                            className={
                              tradeReturn !== null && tradeReturn >= 0
                                ? 'eq-metric-value--good'
                                : 'eq-metric-value--bad'
                            }
                          >
                            {formatPercentValue(trade.return_pct)}
                          </em>
                        </div>
                        <div className="eq-trade-meta">
                          <span>
                            买入 {formatDateOnly(trade.buy_date)} @{' '}
                            {formatNumberValue(trade.buy_price)}
                          </span>
                          <span>
                            卖出 {formatDateOnly(trade.sell_date)} @{' '}
                            {formatNumberValue(trade.sell_price)}
                          </span>
                          <span>数量 {formatNumberValue(trade.quantity, 0)}</span>
                          <span>盈亏 {formatMoneyValue(trade.pnl)}</span>
                          <span>持有 {formatNumberValue(trade.holding_days, 0)}天</span>
                        </div>
                        <div className="eq-trade-reasons">
                          <p>
                            <span>买入原因</span>
                            {entry_reason}
                          </p>
                          <p>
                            <span>卖出原因</span>
                            {exit_reason}
                          </p>
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <article className="eq-empty-note" role="status">
                  <span>交易明细</span>
                  <strong>没有完整买卖闭环</strong>
                  <p>这可能是区间较短、模板过于保守，或所有候选单都被 A 股成交约束挡住。</p>
                </article>
              )}
            </div>
          )}
          {backtestReportTab === 'blocks' && (
            <div className="eq-report-panel">
              <div className="eq-block-summary">
                <article>
                  <span>买入成交</span>
                  <strong>{formatNumberValue(executionDiagnostics.buy_fill_count, 0)}</strong>
                </article>
                <article>
                  <span>卖出成交</span>
                  <strong>{formatNumberValue(executionDiagnostics.sell_fill_count, 0)}</strong>
                </article>
                <article>
                  <span>被挡订单</span>
                  <strong>{formatNumberValue(executionDiagnostics.rejected_order_count, 0)}</strong>
                </article>
              </div>
              {blockedReasonRows.length ? (
                <div className="eq-block-reasons">
                  {blockedReasonRows.map(item => (
                    <span key={item.reason}>
                      {item.label} <strong>{item.count}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
              {blockedOrderRows.length ? (
                <div className="eq-report-list">
                  {blockedOrderRows.slice(0, 40).map((order, index) => (
                    <article
                      key={`${order.symbol}-${order.trade_date}-${order.reason}-${index}`}
                      className="eq-block-card"
                    >
                      <div className="eq-trade-card-head">
                        <span>{formatDateOnly(order.trade_date)}</span>
                        <strong>
                          {order.name || order.symbol || '未知标的'} ·{' '}
                          {String(order.side || '').toUpperCase() === 'SELL' ||
                          String(order.side || '').toLowerCase() === 'sell'
                            ? '卖出'
                            : '买入'}
                        </strong>
                        <em>{getBlockedReasonLabel(order.reason)}</em>
                      </div>
                      <p>{order.detail || '后端没有返回更细的阻断说明。'}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <article className="eq-empty-note" role="status">
                  <span>成交阻断</span>
                  <strong>暂无被挡订单</strong>
                  <p>这表示当前结果里没有记录涨跌停、停牌、T+1 或资金不足导致的跳过订单。</p>
                </article>
              )}
            </div>
          )}
        </>
      );
    }

    if (drawerKey === 'ledger') {
      return (
        <div className="eq-ledger">
          <article>
            <span>
              研究假设 <StoryHint story="hypothesis" label="研究假设说明" />
            </span>
            <strong>{hypothesis || selectedTemplateData.default_hypothesis}</strong>
            <p>
              模板：{selectedTemplateData.name}。回测任务：
              {backtestTaskId ? `#${backtestTaskId}` : '待生成'}。
            </p>
          </article>
          {credibilityItems.map(item => (
            <article key={item.key}>
              <span>
                {item.label}
                <StoryHint
                  story={credibilityStoryByKey[item.key] || 'ledger'}
                  label={`${item.label}说明`}
                />
              </span>
              <strong>{getArtifactStatusLabel(item.status)}</strong>
              <p>{item.summary}</p>
            </article>
          ))}
          <article>
            <span>
              最终结论 <StoryHint story="ledger" label="实验账本说明" />
            </span>
            <strong>{researchAuditVerdict.title}</strong>
            <p>{researchAuditVerdict.summary}</p>
          </article>
        </div>
      );
    }

    if (drawerKey === 'observe') {
      return (
        <div className="eq-drawer-log">
          {observationEvents.map(log => (
            <article key={`${log.time}-${log.title}`}>
              <time>{log.time}</time>
              <div>
                <strong>{log.title}</strong>
                <p>{log.detail}</p>
              </div>
              <span>{log.state}</span>
            </article>
          ))}
        </div>
      );
    }

    return (
      <div className="eq-drawer-list">
        {templatesForView.map(template => (
          <article key={template.id}>
            <span>{template.risk_label}</span>
            <strong>{template.name}</strong>
            <p>
              {template.beginner_summary} 持有周期：{template.holding_period_label}。 策略状态：
              {template.available === false ? '不可用' : '可用'}。
            </p>
          </article>
        ))}
      </div>
    );
  };

  return (
    <main className="easy-quant" data-testid="easy-quant-workspace">
      <header className="eq-site-header" aria-label="简易版导航">
        <Link className="eq-brand-lockup" to="/workspace/easy" aria-label="QuantX 量化简易版">
          <EasyQuantMark />
          <span>
            <strong>QuantX</strong>
            <em>量化简易版</em>
          </span>
        </Link>
        <nav className="eq-mode-nav" aria-label="模式切换">
          <Link className="eq-mode-link eq-mode-link--active" to="/workspace/easy">
            简易版
          </Link>
          <Link className="eq-mode-link" to="/workspace/lab">
            专业版
          </Link>
        </nav>
        <div className="eq-user-tools" aria-label="用户工具">
          <button className="eq-bell" aria-label="通知">
            <BellOutlined />
            <span>27</span>
          </button>
          <button className="eq-user-chip" aria-label="当前用户">
            <span className="eq-user-avatar">
              <UserOutlined />
            </span>
            <span>
              <strong>{displayUsername}</strong>
              <em>管理员</em>
            </span>
            <DownOutlined />
          </button>
        </div>
      </header>

      <nav className="eq-section-dots" aria-label="简易版分屏导航">
        {sectionNavItems.map(item => (
          <button
            key={item.id}
            className={`eq-section-dot ${activeSectionId === item.id ? 'eq-section-dot--active' : ''}`}
            onClick={() => scrollToSection(item.id)}
            aria-label={`跳转到${item.label}`}
            aria-current={activeSectionId === item.id ? 'step' : undefined}
          >
            <span />
            <em>{item.label}</em>
          </button>
        ))}
      </nav>

      <div className="eq-scroll-root" ref={scrollRootRef}>
        <section
          id="easy-quant-hero"
          className={getSectionClassName('easy-quant-hero')}
          aria-label="开始第一套量化策略"
        >
          <div className="eq-screen-inner eq-screen-content">
            <div className="eq-hero">
              <div className="eq-hero-main">
                <span className="eq-kicker">简易版工作台</span>
                <h1>开始第一套量化策略</h1>
                <p>从一个模板开始，按步骤查数据、跑回测、进入模拟观察。</p>
                <div className="eq-hero-actions">
                  <button
                    className="eq-button eq-button--dark eq-button--start"
                    onClick={startGuidedFlow}
                  >
                    开始 <ArrowRightOutlined />
                  </button>
                </div>
              </div>

              <aside className="eq-recommendation">
                <div className="eq-rec-top">
                  <strong>今日建议</strong>
                  <button type="button" aria-label="刷新今日建议">
                    <ReloadOutlined /> 刷新
                  </button>
                </div>
                <div className="eq-rec-body">
                  <JourneySketch type="flag" />
                  <h2>先用沪深300成分池跑 2 年回测</h2>
                  <p>覆盖度高，流动性好，更适合验证第一版策略稳定性。</p>
                </div>
              </aside>
            </div>
            <button className="eq-scroll-cue" onClick={startGuidedFlow} aria-label="向下滚动">
              <span>向下滚动</span>
              <ArrowRightOutlined />
            </button>
          </div>
        </section>

        <section
          id="easy-quant-flow"
          className={getSectionClassName('easy-quant-flow')}
          aria-label="四步操作动线"
        >
          <div className="eq-screen-inner eq-screen-content eq-flow-overview">
            <div className="eq-flow-intro">
              <span className="eq-kicker">四步操作动线</span>
              <h2>今天只推进一步</h2>
              <p>简易版把复杂量化流程收成四个动作。先看清楚顺序，再进入模板选择。</p>
              <div className="eq-flow-meter">
                <span>当前：{activeStepData.title}</span>
                <strong>{progressPercent}%</strong>
                <div>
                  <i style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
              <button className="eq-button eq-button--dark" onClick={() => goToStep('template')}>
                继续：选模板 <ArrowRightOutlined />
              </button>
            </div>
            {renderFlowOverview()}
          </div>
        </section>

        <div className="eq-screen-inner eq-workflow-grid" aria-label="分步操作区">
          {renderStepDock()}
          <div className="eq-stage-sections">
            <section
              id="easy-quant-template"
              className={getSectionClassName('easy-quant-template')}
              aria-label="选择策略模板"
            >
              <div className="eq-screen-content eq-stage-wrap">{renderStage('template')}</div>
            </section>

            <section
              id="easy-quant-data"
              className={getSectionClassName('easy-quant-data')}
              aria-label="查数据"
            >
              <div className="eq-screen-content eq-stage-wrap">{renderStage('data')}</div>
            </section>

            <section
              id="easy-quant-backtest"
              className={getSectionClassName('easy-quant-backtest')}
              aria-label="跑回测"
            >
              <div className="eq-screen-content eq-stage-wrap">{renderStage('backtest')}</div>
            </section>

            <section
              id="easy-quant-credibility"
              className={getSectionClassName('easy-quant-credibility')}
              aria-label="可信度"
            >
              <div className="eq-screen-content eq-stage-wrap">{renderStage('credibility')}</div>
            </section>

            <section
              id="easy-quant-observe"
              className={getSectionClassName('easy-quant-observe')}
              aria-label="模拟观察"
            >
              <div className="eq-screen-content eq-stage-wrap">{renderStage('observe')}</div>
            </section>
          </div>
          {renderQuickCard()}
        </div>

        <footer className="eq-status-strip" aria-label="系统状态">
          <span>
            <EasyQuantMark compact />
            数据状态 <strong>{bootstrap?.data_freshness?.status || '待检查'}</strong>
          </span>
          <span>
            <CheckCircleOutlined />
            运行环境 <strong>{bootstrap?.runtime_health?.status || '待检查'}</strong>
          </span>
          <span>
            <CheckCircleOutlined />
            模板 <strong>{selectedTemplateData.name}</strong>
          </span>
          <Link to="/workspace/system">新手指南</Link>
          <Link to="/workspace/lab">
            进入专业版 <ExportOutlined />
          </Link>
        </footer>
      </div>

      <div className={`eq-drawer-layer ${drawerKey ? 'eq-drawer-layer--open' : ''}`}>
        <button
          className="eq-drawer-backdrop"
          aria-label="关闭抽屉"
          onClick={() => setDrawerKey(null)}
        />
        <aside
          className="eq-drawer"
          role="dialog"
          aria-modal="true"
          aria-label={drawerKey ? '简易版详情抽屉' : undefined}
        >
          <div className="eq-drawer-head">
            <span>{drawerTitle}</span>
            <button aria-label="关闭抽屉" onClick={() => setDrawerKey(null)}>
              <CloseOutlined />
            </button>
          </div>
          {renderDrawerContent()}
        </aside>
      </div>
    </main>
  );
};

export default EasyQuantWorkspace;
