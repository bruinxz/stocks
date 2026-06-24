import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightOutlined,
  AreaChartOutlined,
  BellOutlined,
  CheckCircleOutlined,
  CloseOutlined,
  DatabaseOutlined,
  DownOutlined,
  ExportOutlined,
  EyeOutlined,
  LineChartOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
} from '@ant-design/icons';
import './EasyQuantWorkspace.css';

type StepKey = 'template' | 'data' | 'backtest' | 'observe';
type TemplateId = 'steady_trend' | 'mean_cross' | 'low_vol_value';
type DrawerKey = StepKey | 'guide' | null;

interface JourneyStep {
  key: StepKey;
  number: string;
  title: string;
  caption: string;
  drawerTitle: string;
  icon: ReactNode;
}

interface StrategyTemplate {
  id: TemplateId;
  name: string;
  risk: string;
  holding: string;
  dataStatus: string;
  description: string;
  reason: string;
  icon: ReactNode;
}

const journeySteps: JourneyStep[] = [
  {
    key: 'template',
    number: '01',
    title: '选模板',
    caption: '先选一个不用调太多参数的策略。',
    drawerTitle: '模板怎么选',
    icon: <RiseOutlined />,
  },
  {
    key: 'data',
    number: '02',
    title: '查数据',
    caption: '看行情、因子和风险边界是否齐备。',
    drawerTitle: '数据体检',
    icon: <DatabaseOutlined />,
  },
  {
    key: 'backtest',
    number: '03',
    title: '跑回测',
    caption: '先判断收益和回撤是否能接受。',
    drawerTitle: '回测报告',
    icon: <AreaChartOutlined />,
  },
  {
    key: 'observe',
    number: '04',
    title: '模拟观察',
    caption: '观察一段时间，再考虑更复杂配置。',
    drawerTitle: '观察日志',
    icon: <EyeOutlined />,
  },
];

const strategyTemplates: StrategyTemplate[] = [
  {
    id: 'steady_trend',
    name: '稳健趋势',
    risk: '中低风险',
    holding: '1 到 3 个月',
    dataStatus: '已就绪',
    description: '跟随中长期趋势，优选强势行业龙头。',
    reason: '适合希望先稳稳跑通第一套策略的新手。',
    icon: <RiseOutlined />,
  },
  {
    id: 'mean_cross',
    name: '均线突破',
    risk: '中风险',
    holding: '1 到 4 周',
    dataStatus: '部分缺失',
    description: '短中期均线金叉，捕捉趋势启动信号。',
    reason: '逻辑直观，适合学习信号是怎么产生的。',
    icon: <LineChartOutlined />,
  },
  {
    id: 'low_vol_value',
    name: '低波价值',
    risk: '低风险',
    holding: '3 到 12 个月',
    dataStatus: '已就绪',
    description: '低波动加高股息组合，追求稳健收益。',
    reason: '交易频率低，适合慢节奏模拟观察。',
    icon: <SafetyCertificateOutlined />,
  },
];

const dataChecks = [
  { label: '行情完整度', value: '96%', detail: '沪深300 成分覆盖充分' },
  { label: '因子覆盖', value: '92%', detail: '估值与动量字段可用' },
  { label: '风险边界', value: '已启用', detail: '单票仓位和回撤线已设置' },
];

const reportMetrics = [
  { label: '样例总收益', value: '+18.7%', note: '已计入交易成本' },
  { label: '最大回撤', value: '-8.4%', note: '低于新手默认警戒线' },
  { label: '夏普比率', value: '1.32', note: '风险调整后表现可接受' },
  { label: '胜率', value: '57%', note: '不是越高越好，要结合赔率' },
];

const observeLogs = [
  { time: '09:30:01', title: '读取行情', state: '完成', detail: '已读取沪深 300 成分股行情数据' },
  { time: '09:30:02', title: '生成信号', state: '无信号', detail: '未生成新的交易信号' },
  { time: '09:30:03', title: '执行风险检查', state: '正常', detail: '持仓与风控规则未触发风险' },
  { time: '09:30:04', title: '持仓变化', state: '无变化', detail: '今日没有模拟成交' },
  { time: '09:30:05', title: '当日总结', state: '观察中', detail: '等待下一次有效信号' },
];

const EasyQuantMark: React.FC<{ compact?: boolean }> = ({ compact = false }) => (
  <svg
    className={compact ? 'eq-logo-mark eq-logo-mark--compact' : 'eq-logo-mark'}
    viewBox="0 0 64 64"
    role="img"
    aria-label="QuantX 量化简易版 logo"
  >
    <rect x="5" y="5" width="54" height="54" rx="12" fill="none" />
    <path d="M18 42h7V28h-7v14Zm11 0h7V20h-7v22Zm11 0h7V31h-7v11Z" fill="currentColor" />
    <path d="M17 48h30" fill="none" />
  </svg>
);

const EasyQuantWorkspace: React.FC = () => {
  const [activeStep, setActiveStep] = useState<StepKey>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('steady_trend');
  const [drawerKey, setDrawerKey] = useState<DrawerKey>(null);

  const selectedTemplateData = useMemo(
    () => strategyTemplates.find(item => item.id === selectedTemplate) || strategyTemplates[0],
    [selectedTemplate]
  );

  const activeStepIndex = journeySteps.findIndex(step => step.key === activeStep);
  const activeStepData = journeySteps[activeStepIndex] || journeySteps[0];
  const drawerStepData =
    drawerKey && drawerKey !== 'guide'
      ? journeySteps.find(step => step.key === drawerKey) || activeStepData
      : activeStepData;
  const nextStep = journeySteps[Math.min(activeStepIndex + 1, journeySteps.length - 1)];
  const progressPercent = Math.round(((activeStepIndex + 1) / journeySteps.length) * 100);

  useEffect(() => {
    if (!drawerKey) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDrawerKey(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerKey]);

  const displayUsername =
    localStorage.getItem('username') ||
    (() => {
      try {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        return user?.nickname || user?.username || 'stock';
      } catch {
        return 'stock';
      }
    })();

  const moveToNextStep = () => {
    if (activeStepIndex < journeySteps.length - 1) {
      setActiveStep(journeySteps[activeStepIndex + 1].key);
      return;
    }
    setDrawerKey('observe');
  };

  const renderStage = () => {
    if (activeStep === 'data') {
      return (
        <section className="eq-stage-panel eq-stage-panel--data" aria-label="检查数据">
          <div className="eq-stage-header">
            <span className="eq-section-label">当前任务</span>
            <button onClick={() => setDrawerKey('data')}>查看数据明细</button>
          </div>
          <div className="eq-stage-copy">
            <h2>检查数据</h2>
            <p>先确认数据可靠，再进入回测。新手不需要理解每个字段，只看是否可以继续。</p>
          </div>
          <div className="eq-verdict-card">
            <span className="eq-verdict-icon">
              <DatabaseOutlined />
            </span>
            <div>
              <span className="eq-soft-label">体检结果</span>
              <strong>可以进入回测</strong>
              <p>行情完整度和风险边界都通过，因子字段足够跑第一版策略。</p>
            </div>
          </div>
          <div className="eq-inline-metrics">
            {dataChecks.map(item => (
              <article key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </article>
            ))}
          </div>
          <div className="eq-stage-actions">
            <button className="eq-button eq-button--dark" onClick={() => setActiveStep('backtest')}>
              开始回测 <PlayCircleOutlined />
            </button>
            <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('data')}>
              查看数据明细
            </button>
          </div>
        </section>
      );
    }

    if (activeStep === 'backtest') {
      return (
        <section className="eq-stage-panel eq-stage-panel--backtest" aria-label="回测报告">
          <div className="eq-stage-header">
            <span className="eq-section-label">当前任务</span>
            <button onClick={() => setDrawerKey('backtest')}>查看完整指标</button>
          </div>
          <div className="eq-stage-copy">
            <h2>回测报告</h2>
            <p>先看一个结论，再决定要不要进入模拟观察。详细指标放在抽屉里慢慢看。</p>
          </div>
          <div className="eq-result-hero">
            <div>
              <span className="eq-soft-label">样例结论</span>
              <strong>值得进入模拟观察</strong>
              <p>收益表现不错，最大回撤仍在新手默认边界内。</p>
            </div>
            <span className="eq-verdict-icon">
              <AreaChartOutlined />
            </span>
          </div>
          <div className="eq-inline-metrics eq-inline-metrics--four">
            {reportMetrics.map(metric => (
              <article key={metric.label}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </article>
            ))}
          </div>
          <div className="eq-stage-actions">
            <button className="eq-button eq-button--dark" onClick={() => setActiveStep('observe')}>
              进入模拟观察 <ArrowRightOutlined />
            </button>
            <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('backtest')}>
              查看完整指标
            </button>
          </div>
        </section>
      );
    }

    if (activeStep === 'observe') {
      return (
        <section className="eq-stage-panel eq-stage-panel--observe" aria-label="模拟观察">
          <div className="eq-stage-header">
            <span className="eq-section-label">当前任务</span>
            <button onClick={() => setDrawerKey('observe')}>查看观察日志</button>
          </div>
          <div className="eq-stage-copy">
            <h2>模拟观察</h2>
            <p>不要急着实盘。先观察策略每天如何生成信号、通过风控、产生持仓变化。</p>
          </div>
          <div className="eq-observe-hero">
            <article>
              <span>{selectedTemplateData.name}</span>
              <strong>8/30</strong>
              <p>已观察 8 个交易日，还需要继续看稳定性。</p>
            </article>
            <div className="eq-observe-timeline">
              {observeLogs.slice(0, 3).map(log => (
                <button key={`${log.time}-${log.title}`} onClick={() => setDrawerKey('observe')}>
                  <time>{log.time}</time>
                  <strong>{log.title}</strong>
                  <span>{log.state}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="eq-stage-actions">
            <button className="eq-button eq-button--dark" onClick={() => setDrawerKey('observe')}>
              查看完整日志
            </button>
            <button
              className="eq-button eq-button--quiet"
              onClick={() => setActiveStep('template')}
            >
              重新选模板
            </button>
          </div>
        </section>
      );
    }

    return (
      <section className="eq-stage-panel eq-stage-panel--template" aria-label="选择策略模板">
        <div className="eq-stage-header">
          <span className="eq-section-label">当前任务</span>
          <button onClick={() => setDrawerKey('template')}>对比模板</button>
        </div>
        <div className="eq-stage-copy">
          <h2>选择策略模板</h2>
          <p>从一个默认模板开始，先跑通完整流程。参数和高级规则之后再慢慢打开。</p>
        </div>
        <div className="eq-template-cards">
          {strategyTemplates.map(template => (
            <button
              key={template.id}
              className={`eq-template-card ${
                selectedTemplate === template.id ? 'eq-template-card--active' : ''
              }`}
              onClick={() => setSelectedTemplate(template.id)}
              aria-pressed={selectedTemplate === template.id}
            >
              <span className="eq-template-icon">{template.icon}</span>
              <span>
                <strong>{template.name}</strong>
                <em>{template.description}</em>
              </span>
              <small>{template.risk}</small>
            </button>
          ))}
        </div>
        <article className="eq-selected-note">
          <span>已选模板</span>
          <strong>{selectedTemplateData.name}</strong>
          <p>{selectedTemplateData.reason}</p>
        </article>
        <div className="eq-stage-actions">
          <button className="eq-button eq-button--dark" onClick={() => setActiveStep('data')}>
            下一步：检查数据 <ArrowRightOutlined />
          </button>
          <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('template')}>
            对比模板
          </button>
        </div>
      </section>
    );
  };

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
          {dataChecks.map(item => (
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
          {reportMetrics.map(metric => (
            <article key={metric.label}>
              <span>{metric.label}</span>
              <strong>{metric.value}</strong>
              <p>{metric.note}</p>
            </article>
          ))}
        </div>
      );
    }

    if (drawerKey === 'observe') {
      return (
        <div className="eq-drawer-log">
          {observeLogs.map(log => (
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
        {strategyTemplates.map(template => (
          <article key={template.id}>
            <span>{template.risk}</span>
            <strong>{template.name}</strong>
            <p>
              {template.description} 持有周期：{template.holding}。数据状态：{template.dataStatus}。
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

      <section className="eq-command-strip" aria-label="今日任务">
        <div className="eq-command-primary">
          <span className="eq-section-label">简易版工作台</span>
          <h1>今天只推进一步</h1>
          <p>把复杂量化流程收成四个动作，先跑通，再深入。</p>
          <div className="eq-command-actions">
            <button className="eq-button eq-button--dark" onClick={moveToNextStep}>
              继续：{nextStep.title} <ArrowRightOutlined />
            </button>
            <button className="eq-button eq-button--quiet" onClick={() => setDrawerKey('guide')}>
              看动线说明
            </button>
          </div>
        </div>
        <aside className="eq-today-card">
          <div className="eq-card-head">
            <strong>今日建议</strong>
            <button aria-label="刷新今日建议">
              <ReloadOutlined /> 刷新
            </button>
          </div>
          <h2>先用沪深300成分池跑 2 年回测</h2>
          <p>覆盖度高，流动性好，更适合验证第一版策略稳定性。</p>
        </aside>
      </section>

      <section className="eq-step-rail" aria-label="步骤导航">
        <div className="eq-progress">
          <span>进度</span>
          <strong>{progressPercent}%</strong>
          <div>
            <i style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
        <div className="eq-step-list">
          {journeySteps.map(step => (
            <button
              key={step.key}
              className={`eq-step-pill ${activeStep === step.key ? 'eq-step-pill--active' : ''}`}
              onClick={() => setActiveStep(step.key)}
            >
              <span className="eq-step-icon">{step.icon}</span>
              <div>
                <small>{step.number}</small>
                <strong>{step.title}</strong>
                <em>{step.caption}</em>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="eq-workbench" aria-label="简易版操作动线">
        <div className="eq-stage-wrap">{renderStage()}</div>

        <aside className="eq-inspector" aria-label="当前摘要">
          <div className="eq-inspector-card">
            <span className="eq-soft-label">当前步骤</span>
            <span className="eq-inspector-icon">{activeStepData.icon}</span>
            <h2>{activeStepData.title}</h2>
            <p>{activeStepData.caption}</p>
            <button className="eq-button eq-button--dark" onClick={() => setDrawerKey(activeStep)}>
              打开{activeStepData.drawerTitle}
            </button>
          </div>
          <div className="eq-quick-list">
            <button onClick={() => setDrawerKey('template')}>模板对比</button>
            <button onClick={() => setDrawerKey('data')}>数据体检</button>
            <button onClick={() => setDrawerKey('backtest')}>回测指标</button>
            <button onClick={() => setDrawerKey('observe')}>观察日志</button>
          </div>
        </aside>
      </section>

      <footer className="eq-status-strip" aria-label="系统状态">
        <span>
          <EasyQuantMark compact />
          数据更新 <strong>2026-06-24 15:28</strong>
        </span>
        <span>
          <CheckCircleOutlined />
          完整性 <strong>96%</strong>
        </span>
        <span>
          <CheckCircleOutlined />
          风险边界 <strong>已启用</strong>
        </span>
        <Link to="/workspace/system">新手指南</Link>
        <Link to="/workspace/lab">
          进入专业版 <ExportOutlined />
        </Link>
      </footer>

      {drawerKey ? (
        <div className="eq-drawer-layer">
          <button
            className="eq-drawer-backdrop"
            aria-label="关闭抽屉"
            onClick={() => setDrawerKey(null)}
          />
          <aside className="eq-drawer" role="dialog" aria-modal="true" aria-label="简易版详情抽屉">
            <div className="eq-drawer-head">
              <span>{drawerKey === 'guide' ? '动线说明' : drawerStepData.drawerTitle}</span>
              <button aria-label="关闭抽屉" onClick={() => setDrawerKey(null)}>
                <CloseOutlined />
              </button>
            </div>
            {renderDrawerContent()}
          </aside>
        </div>
      ) : null}
    </main>
  );
};

export default EasyQuantWorkspace;
