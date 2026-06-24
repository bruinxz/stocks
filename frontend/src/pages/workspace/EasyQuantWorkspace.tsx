import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRightOutlined,
  BellOutlined,
  CheckCircleOutlined,
  DownOutlined,
  ExportOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  UserOutlined,
} from '@ant-design/icons';
import './EasyQuantWorkspace.css';

type StepKey = 'template' | 'data' | 'backtest' | 'observe';
type TemplateId = 'steady_trend' | 'mean_cross' | 'low_vol_value';

interface JourneyStep {
  key: StepKey;
  number: string;
  title: string;
  caption: string;
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
    caption: '从策略模板开始，事半功倍。',
    sketch: 'sprout',
  },
  {
    key: 'data',
    number: '02',
    title: '查数据',
    caption: '检查完整性，为回测做好准备。',
    sketch: 'lens',
  },
  {
    key: 'backtest',
    number: '03',
    title: '跑回测',
    caption: '验证策略表现，评估风险与收益。',
    sketch: 'chart',
  },
  {
    key: 'observe',
    number: '04',
    title: '模拟观察',
    caption: '在模拟环境中观察策略行为。',
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
        <path d="M23 72c17-27 38-25 66-4M24 44c22 25 43 24 64-7" />
        <path d="m31 36-8 8 8 8M81 60l8 8-8 8" />
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
        <path d="M37 112c42-54 77-58 106-33" />
        <path d="M117 87c7-24 12-46 16-66" />
        <path d="M134 26c26-7 43-1 54 15-19 7-35 7-54-3" />
        <path d="M75 113c18-14 37-16 54-8" />
      </svg>
    );
  }

  return (
    <svg className="eq-sketch" viewBox="0 0 112 112" aria-hidden="true">
      <path d="M31 79c14-5 22-21 25-48 7 28 15 42 27 48" />
      <path d="M56 32c-14-6-25-3-34 9 15 6 27 2 34-9Zm4 3c11-9 23-9 32-1-9 10-23 10-32 1Z" />
      <path d="M27 82c20 7 38 7 58 0" />
    </svg>
  );
};

const EasyQuantWorkspace: React.FC = () => {
  const [activeStep, setActiveStep] = useState<StepKey>('template');
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateId>('steady_trend');

  const selectedTemplateData = useMemo(
    () => strategyTemplates.find(item => item.id === selectedTemplate) || strategyTemplates[0],
    [selectedTemplate]
  );

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

  const renderStage = () => {
    if (activeStep === 'data') {
      return (
        <section className="eq-stage-panel" aria-label="检查数据">
          <div className="eq-stage-head">
            <h2>检查数据</h2>
            <p>确认行情、因子、基准和风控边界都可用，再开始回测。</p>
          </div>
          <div className="eq-data-grid">
            {dataChecks.map(item => (
              <article key={item.label} className="eq-data-card">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <p>{item.detail}</p>
              </article>
            ))}
          </div>
          <button className="eq-button eq-button--dark" onClick={() => setActiveStep('backtest')}>
            开始回测 <PlayCircleOutlined />
          </button>
        </section>
      );
    }

    if (activeStep === 'backtest') {
      return (
        <section className="eq-stage-panel" aria-label="回测报告">
          <div className="eq-stage-head">
            <h2>回测报告</h2>
            <p>把专业指标翻译成新手能判断的三件事：收益、回撤、是否值得模拟。</p>
          </div>
          <div className="eq-report-grid">
            {reportMetrics.map(metric => (
              <article key={metric.label} className="eq-report-card">
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
                <p>{metric.note}</p>
              </article>
            ))}
          </div>
          <button className="eq-button eq-button--dark" onClick={() => setActiveStep('observe')}>
            进入模拟观察 <ArrowRightOutlined />
          </button>
        </section>
      );
    }

    if (activeStep === 'observe') {
      return (
        <section className="eq-stage-panel eq-stage-panel--observe" aria-label="模拟观察">
          <div className="eq-stage-head">
            <h2>模拟观察</h2>
            <p>观察 30 个交易日后再考虑实盘，收益不代表未来表现。</p>
          </div>
          <div className="eq-observe-layout">
            <article className="eq-observe-summary">
              <h3>{selectedTemplateData.name}</h3>
              <span>{selectedTemplateData.risk}</span>
              <strong>8/30</strong>
              <p>当前为模拟观察期，仅用于策略验证。</p>
            </article>
            <div className="eq-observe-log">
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
          </div>
        </section>
      );
    }

    return (
      <section className="eq-stage-panel" aria-label="选择策略模板">
        <div className="eq-stage-head">
          <h2>选择策略模板</h2>
          <p>精选适合新手的策略模板，先跑通第一套策略，再慢慢调参数。</p>
        </div>
        <div className="eq-template-list">
          {strategyTemplates.map(template => (
            <button
              key={template.id}
              className={`eq-template-row ${
                selectedTemplate === template.id ? 'eq-template-row--active' : ''
              }`}
              onClick={() => setSelectedTemplate(template.id)}
              aria-pressed={selectedTemplate === template.id}
            >
              <JourneySketch type={template.sketch} />
              <span className="eq-template-main">
                <strong>{template.name}</strong>
                <em>{template.description}</em>
                <small>{template.reason}</small>
              </span>
              <span className="eq-template-meta">
                <b>{template.risk}</b>
                <em>{template.holding}</em>
              </span>
              <span
                className={
                  template.dataStatus === '已就绪'
                    ? 'eq-template-status'
                    : 'eq-template-status eq-template-status--warn'
                }
              >
                {template.dataStatus}
              </span>
            </button>
          ))}
        </div>
        <button className="eq-button eq-button--dark" onClick={() => setActiveStep('data')}>
          检查数据 <ArrowRightOutlined />
        </button>
      </section>
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
          <h1>从一颗策略种子开始</h1>
          <p>选模板，查数据，跑回测，再进入模拟观察</p>
          <div className="eq-journey">
            {journeySteps.map((step, index) => (
              <button
                key={step.key}
                className={`eq-journey-step ${
                  activeStep === step.key ? 'eq-journey-step--active' : ''
                }`}
                onClick={() => setActiveStep(step.key)}
              >
                <span className="eq-step-number">{step.number}</span>
                <JourneySketch type={step.sketch} />
                {index < journeySteps.length - 1 ? <span className="eq-dash-line" /> : null}
                <strong>{step.title}</strong>
                <em>{step.caption}</em>
              </button>
            ))}
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
          <h2>建议先用沪深300成分股池跑 2 年回测</h2>
          <p>覆盖度高，流动性好，能够更有效地验证策略稳定性与风险。</p>
          <button className="eq-button eq-button--light" onClick={() => setActiveStep('template')}>
            开始配置 <ArrowRightOutlined />
          </button>
        </aside>
      </section>

      <section className="eq-action-grid" aria-label="快捷入口">
        <article className="eq-action-card">
          <JourneySketch type="trend" />
          <div>
            <h2>选择策略模板</h2>
            <p>精选适合新手的模板，快速搭建你的第一套策略。</p>
            <button className="eq-button eq-button--dark" onClick={() => setActiveStep('template')}>
              浏览模板 <ArrowRightOutlined />
            </button>
          </div>
        </article>
        <article className="eq-action-card">
          <JourneySketch type="shield" />
          <div>
            <h2>检查数据</h2>
            <p>检查行情、因子与基准数据，确保回测结果可靠。</p>
            <button className="eq-button eq-button--dark" onClick={() => setActiveStep('data')}>
              开始检查 <ArrowRightOutlined />
            </button>
          </div>
        </article>
        <article className="eq-action-card">
          <JourneySketch type="chart" />
          <div>
            <h2>查看回测记录</h2>
            <p>浏览历史回测结果，复盘并对比不同策略表现。</p>
            <button className="eq-button eq-button--dark" onClick={() => setActiveStep('backtest')}>
              查看记录 <ArrowRightOutlined />
            </button>
          </div>
        </article>
      </section>

      {renderStage()}

      <footer className="eq-status-strip" aria-label="系统状态">
        <span>
          <EasyQuantMark compact />
          数据最新更新时间 <strong>2026-06-24 15:28</strong>
        </span>
        <span>
          <CheckCircleOutlined />
          数据完整性 <strong>96%</strong>
        </span>
        <span>
          <CheckCircleOutlined />
          风险边界 <strong>已启用</strong>
        </span>
        <Link to="/workspace/system">查看新手指南</Link>
        <Link to="/workspace/lab">
          进入专业版 <ExportOutlined />
        </Link>
      </footer>
    </main>
  );
};

export default EasyQuantWorkspace;
