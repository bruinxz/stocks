import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  DownOutlined,
  ExportOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { BacktestDetail } from '../../services/labService';
import easyQuantService, {
  EasyQuantResearchAudit,
  EasyQuantTemplateView,
} from '../../services/easyQuantService';
import {
  EASY_QUANT_TEMPLATES,
  EasyQuantTemplateId,
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
  useEasyQuantSectionScrollSpy,
} from './easyQuantHooks';
import './EasyQuantWorkspace.css';

type DrawerKey = StepKey | 'guide' | 'ledger' | null;

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
  const [activeStep, setActiveStep] = useState<StepKey>('template');
  const [selectedTemplateId, setSelectedTemplateId] = useState<EasyQuantTemplateId>('steady_trend');
  const { bootstrap, bootstrapLoading, bootstrapError } = useEasyQuantBootstrap();
  const [backtestTaskId, setBacktestTaskId] = useState<number | null>(null);
  const [backtestDetail, setBacktestDetail] = useState<BacktestDetail | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
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

  useEffect(() => {
    setHypothesis(selectedTemplateData.default_hypothesis);
  }, [selectedTemplateData.default_hypothesis, selectedTemplateId]);

  const backtestVerdict: EasyQuantBacktestVerdict = useMemo(
    () => buildEasyQuantBacktestVerdict(backtestDetail, researchAudit),
    [backtestDetail, researchAudit]
  );
  const researchAuditVerdict = backtestVerdict;
  const researchArtifacts = useMemo(
    () => researchAudit?.artifacts || backtestDetail?.research_audit?.artifacts || [],
    [backtestDetail, researchAudit]
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
    drawerKey && drawerKey !== 'guide' && drawerKey !== 'ledger'
      ? journeySteps.find(step => step.key === drawerKey) || activeStepData
      : activeStepData;
  const drawerTitle =
    drawerKey === 'guide'
      ? '动线说明'
      : drawerKey === 'ledger'
        ? '实验账本'
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
      const created = await easyQuantService.runEasyQuantBacktest(selectedTemplateId, hypothesis);
      setBacktestTaskId(created.task_id);
    } catch (error) {
      setBacktestError(error instanceof Error ? error.message : String(error));
      setBacktestLoading(false);
    }
  }, [hypothesis, selectedTemplateId]);

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

    if (backtestDetail.research_audit) {
      setResearchAudit(backtestDetail.research_audit);
      return undefined;
    }

    let cancelled = false;
    setResearchAuditLoading(true);
    setResearchAuditError(null);

    easyQuantService
      .getEasyQuantResearchAudit(taskId)
      .then(audit => {
        if (!cancelled) {
          setResearchAudit(audit);
        }
      })
      .catch(error => {
        if (!cancelled) {
          setResearchAuditError(error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setResearchAuditLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [backtestDetail, backtestTaskId]);

  const handleCreateObservation = useCallback(async () => {
    setObservationCreating(true);
    setObservationMessage(null);

    try {
      const created =
        await easyQuantService.createEasyQuantObservationPortfolio(selectedTemplateId);
      setObservationMessage(`已创建模拟观察组合：${created.name}`);
    } catch (error) {
      setObservationMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setObservationCreating(false);
    }
  }, [selectedTemplateId]);

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

  const getSectionClassName = (sectionId: SectionId) =>
    `eq-screen-section ${visibleSections[sectionId] ? 'eq-screen-section--visible' : ''}`;

  const startGuidedFlow = () => {
    setActiveStep('template');
    window.requestAnimationFrame(() => scrollToSection('easy-quant-flow'));
  };

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

  const renderStage = (stageKey: StepKey = activeStep) => {
    if (stageKey === 'data') {
      return (
        <article className="eq-stage-panel eq-stage-panel--data">
          <div className="eq-stage-topline">
            <span>当前任务</span>
          </div>
          <div className="eq-stage-copy">
            <h2>查数据</h2>
            <p>先确认数据可靠，再进入回测。新手不需要理解每个字段，只看是否可以继续。</p>
          </div>
          <div className="eq-verdict-card">
            <JourneySketch type="lens" />
            <div>
              <span className="eq-soft-label">体检结果</span>
              <strong>{bootstrap?.health_verdict.title || '正在读取数据状态'}</strong>
              <p>{bootstrap?.health_verdict.summary || '正在读取后端数据健康和运行健康。'}</p>
            </div>
          </div>
          {bootstrapError && (
            <p className="eq-state-error">{explainEasyQuantError(bootstrapError)}</p>
          )}
          {bootstrapLoading && <p className="eq-state-muted">正在检查策略和数据状态...</p>}
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
            <h2>回测报告</h2>
            <p>先看一个结论，再决定要不要进入模拟观察。详细指标放在抽屉里慢慢看。</p>
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
          {backtestError && (
            <p className="eq-state-error">{explainEasyQuantError(backtestError)}</p>
          )}
          {backtestTaskId && <p className="eq-state-muted">回测任务 ID：{backtestTaskId}</p>}
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
            <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('backtest')}>
              查看完整指标
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
            <h2>可信度</h2>
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
            <p className="eq-state-error">{explainEasyQuantError(researchAuditError)}</p>
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
                <span>{item.label}</span>
                <strong>{getArtifactStatusLabel(item.status)}</strong>
                <p>{item.summary}</p>
              </article>
            ))}
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
            <button className="eq-button eq-button--quiet" onClick={() => goToStep('template')}>
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
              className={`eq-template-card ${
                selectedTemplateId === template.id ? 'eq-template-card--active' : ''
              }`}
              onClick={() => setSelectedTemplateId(template.id)}
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
              </span>
              <small className={`eq-risk-tag eq-risk-tag--${getRiskTone(template.risk_label)}`}>
                {template.risk_label}
              </small>
            </button>
          ))}
        </div>
        <label className="eq-hypothesis">
          <span>研究假设</span>
          <textarea
            value={hypothesis}
            onChange={event => setHypothesis(event.target.value)}
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
          <button onClick={() => setDrawerKey('template')}>模板对比</button>
          <button onClick={() => setDrawerKey('data')}>查数据</button>
          <button onClick={() => setDrawerKey('backtest')}>回测指标</button>
          <button onClick={() => setDrawerKey('ledger')}>实验账本</button>
          <button onClick={() => setDrawerKey('observe')}>观察日志</button>
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

    if (drawerKey === 'backtest') {
      return (
        <div className="eq-drawer-list">
          {backtestVerdict.beginner_metrics.length ? (
            backtestVerdict.beginner_metrics.map(metric => (
              <article key={metric.key}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <p>{metric.explanation}</p>
              </article>
            ))
          ) : (
            <article>
              <span>回测指标</span>
              <strong>待生成</strong>
              <p>完成一次真实回测后，这里会显示收益、回撤、夏普等解释。</p>
            </article>
          )}
        </div>
      );
    }

    if (drawerKey === 'ledger') {
      return (
        <div className="eq-ledger">
          <article>
            <span>研究假设</span>
            <strong>{hypothesis || selectedTemplateData.default_hypothesis}</strong>
            <p>
              模板：{selectedTemplateData.name}。回测任务：
              {backtestTaskId ? `#${backtestTaskId}` : '待生成'}。
            </p>
          </article>
          {credibilityItems.map(item => (
            <article key={item.key}>
              <span>{item.label}</span>
              <strong>{getArtifactStatusLabel(item.status)}</strong>
              <p>{item.summary}</p>
            </article>
          ))}
          <article>
            <span>最终结论</span>
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
                  <button aria-label="刷新今日建议">
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
