import React, { Suspense, useState } from 'react';
import { ConfigProvider } from 'antd';
import { Outlet, useLocation } from 'react-router-dom';
import { CSS_VARS, CATDESK_TOKENS } from './tokens';
import './catdesk.css';
import { useTabState, type TabKey } from './useTabState';
import { TabNav } from './shared/TabNav';
import { LoadingState } from './shared/LoadingState';
import { CowMascot, type CowMood } from './shared/CowMascot';
import { createTab67HttpApi, type Tab67Api } from './tabs/daily-report/tab67Api';
import { PageFreshnessStamp } from './shared/PageFreshnessStamp';
import GlobalPortfolioSelector from '../../components/layout/GlobalPortfolioSelector';
import AlertsBell from '../../components/layout/AlertsBell';
import CriticalAlertModal from '../../components/layout/CriticalAlertModal';

const AShareMorningBrief = React.lazy(() => import('./tabs/AShareMorningBrief'));
const AShareMarket = React.lazy(() => import('./tabs/a-share-market/AShareMarket'));
const USStockPicks = React.lazy(() => import('./tabs/USStockPicks'));
const JPKRMarket = React.lazy(() => import('./tabs/JPKRMarket'));
const HighMultipotential = React.lazy(() => import('./tabs/HighMultipotential'));
const PortfolioOverview = React.lazy(() => import('./tabs/PortfolioOverview'));
const AIAnalysisDesk = React.lazy(() => import('./tabs/AIAnalysisDesk'));
const BacktestEvidence = React.lazy(() => import('./tabs/BacktestEvidence'));
const DailyReportContainer = React.lazy(() => import('./tabs/daily-report/DailyReportContainer'));
const ReportHistoryContainer = React.lazy(
  () => import('./tabs/report-history/ReportHistoryContainer')
);
const DEFAULT_TAB67_API = createTab67HttpApi();

const TAB_COMPONENTS: Record<
  Exclude<TabKey, 'daily' | 'history'>,
  React.LazyExoticComponent<React.ComponentType>
> = {
  market: AShareMarket,
  morning: AShareMorningBrief,
  us: USStockPicks,
  jpkr: JPKRMarket,
  multi: HighMultipotential,
  portfolio: PortfolioOverview,
  ai: AIAnalysisDesk,
  backtest: BacktestEvidence,
};

export interface CatDeskOutletContext {
  selectedRow: string | null;
  setSelectedRow: (id: string | null) => void;
}

const TAB_META: Record<TabKey, { eyebrow: string; title: string; description: string }> = {
  market: {
    eyebrow: 'A 股全景行情',
    title: 'A 股市场',
    description: '搜索股票、指数与 ETF，查看最新行情、估值与历史走势。',
  },
  morning: {
    eyebrow: '早盘信号花园',
    title: 'A 股早报',
    description: '把昨夜的催化线索，折成今天值得观察的一页。',
  },
  us: {
    eyebrow: '美国科技盘面',
    title: '美股科技',
    description: '先看科技板块强弱，再看代表股与高关注科技 ETF。',
  },
  jpkr: {
    eyebrow: '韩国科技窗口',
    title: '韩股科技',
    description: '聚焦少量韩国科技代表股，日本市场仅作次级参考。',
  },
  multi: {
    eyebrow: '长期潜力研究室',
    title: '高倍潜力',
    description: '寻找耐心、基本面与想象力同时成立的公司。',
  },
  portfolio: {
    eyebrow: '账户与仓位账本',
    title: '我的持仓',
    description: '资金、仓位、保护线与浮动盈亏放在同一张可核对的账上。',
  },
  ai: {
    eyebrow: '多智能体会审室',
    title: 'AI 分析',
    description: '选一只股票，让研究、交易与风控角色给出结构化的第二意见。',
  },
  backtest: {
    eyebrow: '先看证据，再谈观点',
    title: '回测证据',
    description: '先看证据，再谈观点；每一步都能回到当时。',
  },
  daily: {
    eyebrow: '每日研究来信',
    title: '每日日报',
    description: '把复杂信息整理成一封可以慢慢读的研究信。',
  },
  history: {
    eyebrow: '研究判断档案',
    title: '报告历史',
    description: '保留每一次判断，也保留判断发生时的世界。',
  },
};

const TAB_COW: Record<TabKey, { mood: CowMood; note: string }> = {
  market: { mood: 'curious', note: '五千多项证券，慢慢挑。' },
  morning: { mood: 'confident', note: '早盘线索，交给我。' },
  us: { mood: 'curious', note: '科技板块，先看强弱。' },
  jpkr: { mood: 'surprised', note: '韩国科技，少而精。' },
  multi: { mood: 'thinking', note: '慢慢找，才找得到好公司。' },
  portfolio: { mood: 'working', note: '每一笔仓位都要对得上账。' },
  ai: { mood: 'curious', note: '多问一层，再做判断。' },
  backtest: { mood: 'working', note: '别急，先让证据说话。' },
  daily: { mood: 'hopeful', note: '今天也整理得明明白白。' },
  history: { mood: 'sleepy', note: '旧判断也值得再翻一翻。' },
};

export interface CatDeskLayoutProps {
  tab67Api?: Tab67Api;
  dailyTradingDay?: string;
}

export default function CatDeskLayout({
  tab67Api = DEFAULT_TAB67_API,
  dailyTradingDay,
}: CatDeskLayoutProps) {
  const { activeTab, setTab } = useTabState();
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const location = useLocation();

  const ActiveTab = TAB_COMPONENTS[activeTab as Exclude<TabKey, 'daily' | 'history'>];
  const outletContext: CatDeskOutletContext = { selectedRow, setSelectedRow };
  const isNestedPage = location.pathname !== '/catdesk' && location.pathname !== '/catdesk/';
  const tabMeta = TAB_META[activeTab];
  const tabCow = TAB_COW[activeTab];
  const today = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date());

  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: CATDESK_TOKENS.accent,
          colorText: CATDESK_TOKENS.textPrimary,
          colorTextSecondary: CATDESK_TOKENS.textSecondary,
          colorBgContainer: CATDESK_TOKENS.bgSurface,
          colorBorder: CATDESK_TOKENS.border,
          borderRadius: 12,
          fontFamily: CATDESK_TOKENS.fontSans,
        },
      }}
    >
      <div className="catdesk-shell" style={CSS_VARS as React.CSSProperties}>
        <TabNav activeTab={activeTab} onTabChange={setTab} />
        <section className="catdesk-workspace">
          <header className="catdesk-topbar">
            <div className="catdesk-title-group">
              <span className="catdesk-eyebrow">{tabMeta.eyebrow}</span>
              <h1>{tabMeta.title}</h1>
              <p>{tabMeta.description}</p>
            </div>
            <div className="catdesk-topbar-meta">
              <div className="catdesk-topbar-tools" aria-label="账户与告警工具">
                <GlobalPortfolioSelector />
                <AlertsBell />
                <CriticalAlertModal />
              </div>
              <span className="catdesk-live-pill">
                <i /> 数据观测中
              </span>
              <span className="catdesk-date">{today}</span>
              <div className="catdesk-orbit-cow">
                <span className="catdesk-cow-bubble">{tabCow.note}</span>
                <span className="catdesk-orbit" />
                <CowMascot className="catdesk-cow-face" mood={tabCow.mood} />
              </div>
            </div>
          </header>
          {activeTab === 'portfolio' || activeTab === 'ai' ? null : (
            <PageFreshnessStamp activeTab={activeTab} />
          )}
          <div className="catdesk-ribbon" aria-hidden="true">
            <span>催化</span>
            <i /> <span>确信</span>
            <i /> <span>证据</span>
            <i />
            <span>复盘</span>
          </div>
          <main className="catdesk-main">
            <Suspense
              fallback={
                <LoadingState
                  title="正在布置研究台"
                  description="牛牛正在摆好这一页的数据和工具…"
                  mood="hopeful"
                />
              }
            >
              {isNestedPage ? (
                <Outlet context={outletContext} />
              ) : activeTab === 'daily' ? (
                <DailyReportContainer api={tab67Api} tradingDay={dailyTradingDay} />
              ) : activeTab === 'history' ? (
                <ReportHistoryContainer api={tab67Api} />
              ) : (
                <ActiveTab />
              )}
            </Suspense>
          </main>
        </section>
      </div>
    </ConfigProvider>
  );
}
