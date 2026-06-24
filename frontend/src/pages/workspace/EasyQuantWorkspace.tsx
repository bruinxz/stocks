import React, { useMemo, useState } from 'react';
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
  sketch: 'sprout' | 'lens' | 'chart' | 'telescope';
}

interface StrategyTemplate {
  id: TemplateId;
  name: string;
  risk: string;
  holding: string;
  dataStatus: string;
  description: string;
  reason: string;
  sketch: 'trend' | 'cross' | 'shield';
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
    key: 'observe',
    number: '04',
    title: '模拟观察',
    caption: '观察一段时间，再考虑更复杂配置。',
    drawerTitle: '观察日志',
    sketch: 'telescope',
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
    sketch: 'trend',
  },
  {
    id: 'mean_cross',
    name: '均线突破',
    risk: '中风险',
    holding: '1 到 4 周',
    dataStatus: '部分缺失',
    description: '短中期均线金叉，捕捉趋势启动信号。',
    reason: '逻辑直观，适合学习信号是怎么产生的。',
    sketch: 'cross',
  },
  {
    id: 'low_vol_value',
    name: '低波价值',
    risk: '低风险',
    holding: '3 到 12 个月',
    dataStatus: '已就绪',
    description: '低波动加高股息组合，追求稳健收益。',
    reason: '交易频率低，适合慢节奏模拟观察。',
    sketch: 'shield',
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
  type: JourneyStep['sketch'] | StrategyTemplate['sketch'] | 'flag';
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
  const progressPercent = Math.round(((activeStepIndex + 1) / journeySteps.length) * 100);

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

  const startGuidedFlow = () => {
    setActiveStep('template');
    window.requestAnimationFrame(() => {
      document.getElementById('easy-quant-flow')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  const renderStage = () => {
    if (activeStep === 'data') {
      return (
        <section className="eq-stage-panel eq-stage-panel--data" aria-label="查数据">
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
          <div className="eq-stage-topline">
            <span>当前任务</span>
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
            <JourneySketch type="chart" />
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
        <div className="eq-stage-topline">
          <span>当前任务</span>
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
              {selectedTemplate === template.id ? (
                <span className="eq-template-check" aria-hidden="true">
                  ✓
                </span>
              ) : null}
              <JourneySketch type={template.sketch} />
              <span>
                <strong>{template.name}</strong>
                <em>{template.description}</em>
              </span>
              <small className={`eq-risk-tag eq-risk-tag--${getRiskTone(template.risk)}`}>
                {template.risk}
              </small>
            </button>
          ))}
        </div>
        <div className="eq-stage-actions">
          <button className="eq-button eq-button--dark" onClick={() => setActiveStep('data')}>
            下一步：查数据 <ArrowRightOutlined />
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

      <section className="eq-hero">
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
          <JourneySketch type="flag" />
          <h2>先用沪深300成分池跑 2 年回测</h2>
          <p>覆盖度高，流动性好，更适合验证第一版策略稳定性。</p>
        </aside>
      </section>

      <section id="easy-quant-flow" className="eq-flow-shell" aria-label="简易版操作动线">
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
              onClick={() => setActiveStep(step.key)}
            >
              <span>{step.number}</span>
              <div>
                <strong>{step.title}</strong>
                <em>{step.caption}</em>
              </div>
            </button>
          ))}
        </aside>

        <div className="eq-stage-wrap">{renderStage()}</div>

        <aside className="eq-inspector" aria-label="快捷入口">
          <div className="eq-quick-list">
            <button onClick={() => setDrawerKey('template')}>模板对比</button>
            <button onClick={() => setDrawerKey('data')}>查数据</button>
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
            <span>{drawerKey === 'guide' ? '动线说明' : drawerStepData.drawerTitle}</span>
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
