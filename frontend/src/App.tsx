import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Layout, ConfigProvider, Menu, Avatar, Dropdown, Spin } from 'antd';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { UserOutlined, LogoutOutlined, BarChartOutlined, DownOutlined } from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store/rootReducer';
import { loginSuccess, logout } from './store/authSlice';
import { clearUserScopedStorage } from './utils/sessionCleanup';
import AdminGuard from './components/AdminGuard';
import { authService } from './services/authService';
import { API_DOMAIN_URL } from './services/api';
import { PortfolioProvider } from './contexts/PortfolioContext';
import GlobalPortfolioSelector from './components/layout/GlobalPortfolioSelector';
import AlertsBell from './components/layout/AlertsBell';
import CriticalAlertModal from './components/layout/CriticalAlertModal';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const TodayCommandCenter = lazy(() => import('./pages/TodayCommandCenter'));
const Backtest = lazy(() => import('./pages/Backtest'));
const Login = lazy(() => import('./pages/Login'));
const Portfolio = lazy(() => import('./pages/Portfolio'));
const Market = lazy(() => import('./pages/Market'));
const DataUpdateStatus = lazy(() => import('./pages/DataUpdateStatus'));
const BacktestResults = lazy(() => import('./components/backtest/BacktestResults'));
const Profile = lazy(() => import('./pages/Profile'));
const UserManagement = lazy(() => import('./pages/UserManagement'));
const AIAdvisor = lazy(() => import('./pages/AIAdvisor'));
const TaskScheduler = lazy(() => import('./pages/TaskScheduler'));
const Screener = lazy(() => import('./pages/Screener'));
const ReviewCenter = lazy(() => import('./pages/ReviewCenter'));
const StrategyResearchCenter = lazy(() => import('./pages/StrategyResearchCenter'));
const RecommendationTrace = lazy(() => import('./pages/RecommendationTrace'));
const AutonomousTradingOverview = lazy(() => import('./pages/AutonomousTradingOverview'));
const LiveTrading = lazy(() => import('./pages/LiveTrading'));
const QuantResearchWorkbench = lazy(() => import('./pages/QuantResearchWorkbench'));
const RiskAlerts = lazy(() => import('./pages/RiskAlerts'));
const SystemLogs = lazy(() => import('./pages/SystemLogs'));
const StockDetail = lazy(() => import('./pages/StockDetail'));

// 6 unified workspace shells (US-001/US-002)
const TodayWorkspace = lazy(() => import('./pages/workspace/TodayWorkspace'));
const FactorWorkspace = lazy(() => import('./pages/workspace/FactorWorkspace'));
const LabWorkspace = lazy(() => import('./pages/workspace/LabWorkspace'));
const LabStrategyDetail = lazy(() => import('./pages/workspace/LabStrategyDetail'));
const PortfolioWorkspace = lazy(() => import('./pages/workspace/PortfolioWorkspace'));
const DataWorkspace = lazy(() => import('./pages/workspace/DataWorkspace'));
const SettingsWorkspace = lazy(() => import('./pages/workspace/SettingsWorkspace'));
// Batch AL (2026-06-21) — SystemWorkspace 系统介绍 + 用户反馈闭环.
// 例外打破"6 shell 固定" — 用户原话明确要求新增 (workspace/CLAUDE.md
// 的限制面向 PRD US-001; 本批用户授权扩到 7 shell).
const SystemWorkspace = lazy(() => import('./pages/workspace/SystemWorkspace'));

import {
  CompassOutlined,
  SettingOutlined,
  ExperimentOutlined,
  DatabaseOutlined,
  FilterOutlined,
  PieChartOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';

import type { MenuProps } from 'antd';

const { Header, Content, Sider } = Layout;

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const token = localStorage.getItem('token');
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
};

const BacktestDetailRoute: React.FC = () => {
  const { id } = useParams();

  if (!id) {
    return <Navigate to="/backtest" replace />;
  }

  return <BacktestResults backtest_id={id} />;
};

const routeFallback = (
  <div className="route-loading">
    <Spin />
    <span>正在加载页面...</span>
  </div>
);

const menuLink = (key: string, icon: React.ReactNode, title: string) => ({
  key,
  icon,
  label: <Link to={key}>{title}</Link>,
  title,
});

// All deprecated paths now resolve to a workspace entry in the menu so the
// sidebar highlights the right top-level item even if we still render the
// legacy page underneath for backward compatibility.
const routeSelectionAliases: Array<[RegExp, string]> = [
  // legacy aliases preserved for old deep links
  [
    /^\/quant\/(research|signals|backtests|strategies|experiments|dashboard)(\/.*)?$/,
    '/workspace/lab',
  ],
  // US-078: 策略详情子路由也归属"策略实验室"
  [/^\/workspace\/lab\/strategies(\/.*)?$/, '/workspace/lab'],
  [
    /^\/strategy-research(\/(optimization|versions|experiments|weights|event-results))?(\/.*)?$/,
    '/workspace/lab',
  ],
  [/^\/live-trading(\/(orders|reconcile))?(\/.*)?$/, '/workspace/portfolio'],
  [/^\/review(\/(trades|performance|agent-tail|journal))?(\/.*)?$/, '/workspace/portfolio'],
  [/^\/backtest(\/.+)?$/, '/workspace/lab'],
  [/^\/autonomous-trading(\/.*)?$/, '/workspace/portfolio'],
  [/^\/paper-trading(\/.*)?$/, '/workspace/portfolio'],
  [/^\/recommendations?(\/.*)?$/, '/workspace/today'],
  [/^\/recommendation-(performance|trade-outcomes|loop-policies)(\/.*)?$/, '/workspace/portfolio'],
  [/^\/agent-tail-alpha(\/.*)?$/, '/workspace/portfolio'],
  [/^\/strategy-experiment-lab(\/.*)?$/, '/workspace/lab'],
  [/^\/strategy(\/.*)?$/, '/workspace/lab'],
  [/^\/risk-alerts(\/.*)?$/, '/workspace/today'],
  [/^\/today(\/.*)?$/, '/workspace/today'],
  [/^\/dashboard(\/.*)?$/, '/workspace/today'],
  [/^\/portfolio(\/.*)?$/, '/workspace/portfolio'],
  [/^\/screener(\/.*)?$/, '/workspace/factors'],
  [/^\/market(\/.*)?$/, '/workspace/data'],
  [/^\/data-update(\/.*)?$/, '/workspace/data'],
  [/^\/tasks(\/.*)?$/, '/workspace/data'],
  [/^\/logs(\/.*)?$/, '/workspace/data'],
  [/^\/ai-advisor(\/.*)?$/, '/workspace/lab'],
  [/^\/journals(\/.*)?$/, '/workspace/portfolio'],
  [/^\/profile(\/.*)?$/, '/workspace/settings'],
  [/^\/users(\/.*)?$/, '/workspace/settings'],
  [/^\/signals\/.+\/trace$/, '/workspace/portfolio'],
];

const resolveMenuPath = (pathname: string) => {
  const matchedAlias = routeSelectionAliases.find(([pattern]) => pattern.test(pathname));
  return matchedAlias?.[1] || pathname;
};

const flattenMenu = (
  items: MenuProps['items'] = [],
  parentKeys: string[] = [],
  section = ''
): Array<{ key: string; parentKeys: string[]; section: string; title: string }> => {
  const result: Array<{ key: string; parentKeys: string[]; section: string; title: string }> = [];

  (items || []).forEach((item: any) => {
    if (!item) return;
    const key = String(item.key || '');
    const title = String(item.title || item.label || '');

    if (Array.isArray(item.children) && item.children.length > 0) {
      result.push(...flattenMenu(item.children, key ? [...parentKeys, key] : parentKeys, title));
      return;
    }

    if (key.startsWith('/')) {
      result.push({ key, parentKeys, section, title });
    }
  });

  return result;
};

const AppContent: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const token = localStorage.getItem('token');
  const { user } = useSelector((state: RootState) => state.auth);
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  useEffect(() => {
    // Fetch profile on initial load if token exists but user state is missing
    const fetchProfile = async () => {
      if (token && !user) {
        try {
          const res = await authService.getCurrentUser();
          if (res && res.success) {
            dispatch(loginSuccess({ user: res.data.user, token }));
          } else {
            // Batch U (2026-06-17): profile fetch 失败时同样走中央化清扫.
            dispatch(logout());
            clearUserScopedStorage();
          }
        } catch (error) {
          // Batch AK (2026-06-21, hotfix): catch 分支也必须清 token + user,
          // 否则 fetchProfile 失败 → token 仍在 localStorage → 任何后续 API 401
          // 又触发 api.ts location.href='/login' → 加载新页面 → 又重启 React →
          // useEffect 又看到 token → 又调 fetchProfile → 又失败... 死循环表现为
          // "登录页一直闪动一直刷新".
          console.error('Failed to fetch user profile on load', error);
          dispatch(logout());
          clearUserScopedStorage();
        }
      }
    };
    fetchProfile();
  }, [token, user, dispatch]);

  const displayUsername =
    user?.nickname || user?.username || localStorage.getItem('username') || 'Admin';
  const avatarSrc = user?.avatar_url
    ? user.avatar_url.startsWith('http')
      ? user.avatar_url
      : `${API_DOMAIN_URL}${user.avatar_url}`
    : undefined;

  const handleLogout = () => {
    // Batch U (2026-06-17, front-3 fix): 中央化清扫, 不再散弹式 removeItem.
    // 之前漏清 aiAdvisor_* / pt_selected_portfolio_id / user / stocks_pinned_symbols,
    // 共用浏览器场景下次登录用户读到旧 user 的 AI 研究 / 选盘 / 收藏.
    clearUserScopedStorage();
    dispatch(logout());
    navigate('/login');
  };

  // US-001: collapse the legacy 38-page sprawl into 6 top-level workspaces.
  // Each workspace owns a tabbed inner layout (built out in later stories).
  const mainMenuItems: MenuProps['items'] = useMemo(
    () => [
      menuLink('/workspace/today', <CompassOutlined />, '今日作战'),
      menuLink('/workspace/factors', <FilterOutlined />, '选股因子'),
      menuLink('/workspace/lab', <ExperimentOutlined />, '策略实验室'),
      menuLink('/workspace/portfolio', <PieChartOutlined />, '持仓与复盘'),
      menuLink('/workspace/data', <DatabaseOutlined />, '数据中心'),
      menuLink('/workspace/settings', <SettingOutlined />, '账号设置'),
      // Batch AL (2026-06-21) — 用户明确要求新增"系统介绍"
      menuLink('/workspace/system', <InfoCircleOutlined />, '系统介绍'),
    ],
    []
  );

  const flatMenuItems = useMemo(() => flattenMenu(mainMenuItems), [mainMenuItems]);
  const menuPath = useMemo(() => resolveMenuPath(location.pathname), [location.pathname]);
  const selectedMenu =
    flatMenuItems
      .filter(item => menuPath === item.key || menuPath.startsWith(`${item.key}/`))
      .sort((a, b) => b.key.length - a.key.length)[0] || flatMenuItems[0];
  const selectedKey = selectedMenu?.key || '/workspace/today';
  const currentSection = selectedMenu?.section || '工作台';
  const currentPageTitle = selectedMenu?.title || '今日作战';
  const selectedParentKeys = useMemo(
    () => selectedMenu?.parentKeys || [],
    [selectedMenu?.parentKeys]
  );
  const rootSubmenuKeys = useMemo(
    () => (mainMenuItems || []).map((item: any) => String(item?.key || '')).filter(Boolean),
    [mainMenuItems]
  );

  useEffect(() => {
    if (selectedParentKeys.length) {
      setOpenKeys(selectedParentKeys);
    }
  }, [selectedKey, selectedParentKeys]);

  const handleMenuOpenChange = (keys: string[]) => {
    const latestOpenKey = keys.find(key => !openKeys.includes(key));
    if (latestOpenKey && rootSubmenuKeys.includes(latestOpenKey)) {
      setOpenKeys([latestOpenKey]);
    } else {
      setOpenKeys(keys);
    }
  };

  const userMenuProps: MenuProps = {
    items: [
      {
        key: 'profile',
        icon: <UserOutlined />,
        label: <Link to="/workspace/settings">个人中心</Link>,
      },
      {
        type: 'divider',
      },
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: '退出登录',
        danger: true,
        onClick: handleLogout,
      },
    ],
  };

  if (location.pathname === '/login') {
    return (
      <Suspense fallback={routeFallback}>
        <Routes>
          <Route path="/login" element={<Login />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Layout className="modern-layout">
      <Sider width={256} className="modern-sider">
        <div className="modern-sider-inner">
          <div>
            <div className="modern-logo">
              <BarChartOutlined className="logo-icon" />
              <span className="logo-copy">
                <strong>QuantX</strong>
                <em>Autonomous A-Share Lab</em>
              </span>
            </div>
            <Menu
              mode="inline"
              selectedKeys={[selectedKey]}
              openKeys={openKeys}
              onOpenChange={handleMenuOpenChange}
              className="modern-menu"
              items={mainMenuItems}
            />
          </div>
        </div>
      </Sider>
      <Layout style={{ background: 'transparent' }}>
        <Header className="modern-header">
          <div className="header-context">
            <span>{currentSection}</span>
            <strong>{currentPageTitle}</strong>
          </div>
          {token && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              {/* 2026-06-17 全局选盘下拉. 任何 workspace 通过 usePortfolio() 拿到 selected */}
              <GlobalPortfolioSelector />
              {/* US-070 [FE-031] 顶 nav bar 全局告警铃铛 — 60s 轮询未读告警数,
                  红 Badge ≥10, 点击跳风控中心. */}
              <AlertsBell />
              {/* US-074 [FE-035] critical 告警强制弹窗 — 不渲染任何可见 UI 直到
                  实时推送命中 isCriticalAlert. 全局 mount 在 token 守护下保证
                  任何 workspace 都能弹. */}
              <CriticalAlertModal />
              <Dropdown menu={userMenuProps} placement="bottomRight" trigger={['click']}>
                <div className="header-user-dropdown">
                  <Avatar
                    size={36}
                    style={{ backgroundColor: '#1f3a5f', fontSize: 14 }}
                    icon={<UserOutlined />}
                    src={avatarSrc}
                  />
                  <span className="header-user-copy">
                    <strong>{displayUsername}</strong>
                    <em>{user?.role === 'admin' ? '管理员' : '已登录'}</em>
                  </span>
                  <DownOutlined className="header-user-caret" />
                </div>
              </Dropdown>
            </div>
          )}
        </Header>
        <Content className="modern-layout-content">
          <Suspense fallback={routeFallback}>
            <Routes>
              {/* Default lands users in the new today workspace */}
              <Route path="/" element={<Navigate to="/workspace/today" replace />} />

              {/* 6 unified workspaces (US-001) */}
              <Route
                path="/workspace/today"
                element={
                  <ProtectedRoute>
                    <TodayWorkspace />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workspace/factors"
                element={
                  <ProtectedRoute>
                    <FactorWorkspace />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workspace/lab"
                element={
                  <ProtectedRoute>
                    <LabWorkspace />
                  </ProtectedRoute>
                }
              />
              {/* US-078: 策略详情页 — 嵌在 LabWorkspace 概念下（侧边栏仍高亮"策略实验室"） */}
              <Route
                path="/workspace/lab/strategies/:id"
                element={
                  <ProtectedRoute>
                    <LabStrategyDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workspace/portfolio"
                element={
                  <ProtectedRoute>
                    <PortfolioWorkspace />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workspace/data"
                element={
                  <ProtectedRoute>
                    <DataWorkspace />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/workspace/settings"
                element={
                  <ProtectedRoute>
                    <SettingsWorkspace />
                  </ProtectedRoute>
                }
              />
              {/* Batch AL (2026-06-21) — SystemWorkspace 入口 */}
              <Route
                path="/workspace/system"
                element={
                  <ProtectedRoute>
                    <SystemWorkspace />
                  </ProtectedRoute>
                }
              />

              {/* 个股详情页 — 含 K 线、公司信息、历史明细 + AI 解读 */}
              <Route
                path="/stock/:symbol"
                element={
                  <ProtectedRoute>
                    <StockDetail />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/stocks/:symbol"
                element={
                  <ProtectedRoute>
                    <StockDetail />
                  </ProtectedRoute>
                }
              />

              {/* Legacy redirects — duplicate pages now bounce to a workspace home.
                  Listed in PRD US-001 acceptance criteria. */}
              <Route path="/today" element={<Navigate to="/workspace/today" replace />} />
              <Route path="/dashboard" element={<Navigate to="/workspace/today" replace />} />
              <Route path="/risk-alerts" element={<Navigate to="/workspace/today" replace />} />
              <Route
                path="/strategy-experiment-lab"
                element={<Navigate to="/workspace/lab" replace />}
              />
              <Route
                path="/autonomous-optimization-lab"
                element={<Navigate to="/workspace/lab" replace />}
              />
              <Route
                path="/quant-backtest-lab"
                element={<Navigate to="/workspace/lab" replace />}
              />
              <Route
                path="/quant-performance-dashboard"
                element={<Navigate to="/workspace/lab" replace />}
              />
              <Route path="/quant-signal-pool" element={<Navigate to="/workspace/lab" replace />} />
              <Route
                path="/quant-strategy-library"
                element={<Navigate to="/workspace/lab" replace />}
              />
              <Route path="/strategy" element={<Navigate to="/workspace/lab" replace />} />
              <Route path="/recommendations" element={<Navigate to="/workspace/today" replace />} />
              <Route
                path="/recommendation-performance"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/recommendation-trade-outcomes"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/recommendation-loop-policies"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/agent-tail-alpha"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/autonomous-recommendation-tracker"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/autonomous-trading/overview"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/autonomous-trading/recommendations"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route
                path="/autonomous-trading/optimization"
                element={<Navigate to="/workspace/lab" replace />}
              />
              <Route
                path="/paper-trading"
                element={<Navigate to="/workspace/portfolio" replace />}
              />
              <Route path="/portfolio" element={<Navigate to="/workspace/portfolio" replace />} />
              <Route path="/journals" element={<Navigate to="/workspace/portfolio" replace />} />
              <Route path="/screener" element={<Navigate to="/workspace/factors" replace />} />
              <Route path="/market" element={<Navigate to="/workspace/data" replace />} />
              <Route path="/data-update" element={<Navigate to="/workspace/data" replace />} />
              <Route path="/tasks" element={<Navigate to="/workspace/data" replace />} />
              <Route path="/logs" element={<Navigate to="/workspace/data" replace />} />
              <Route path="/profile" element={<Navigate to="/workspace/settings" replace />} />
              <Route path="/users" element={<Navigate to="/workspace/settings" replace />} />

              {/* Pages still reachable for deep links / iframes — kept off the menu.
                  Stories US-015..US-018 will fold their useful pieces into the
                  workspace tabs and these can then be deleted physically. */}
              <Route
                path="/legacy/today"
                element={
                  <ProtectedRoute>
                    <TodayCommandCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/portfolio"
                element={
                  <ProtectedRoute>
                    <AutonomousTradingOverview />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/live-trading"
                element={
                  <ProtectedRoute>
                    <LiveTrading />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/quant-research"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/strategy-research"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/review"
                element={
                  <ProtectedRoute>
                    <ReviewCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/ai-advisor"
                element={
                  <ProtectedRoute>
                    <AIAdvisor />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/backtest"
                element={
                  <ProtectedRoute>
                    <Backtest />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/backtest/:id"
                element={
                  <ProtectedRoute>
                    <BacktestDetailRoute />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/risk-alerts"
                element={
                  <ProtectedRoute>
                    <RiskAlerts />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/dashboard"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/market"
                element={
                  <ProtectedRoute>
                    <Market />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/data-update"
                element={
                  <ProtectedRoute>
                    <DataUpdateStatus />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/tasks"
                element={
                  <ProtectedRoute>
                    <AdminGuard>
                      <TaskScheduler />
                    </AdminGuard>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/logs"
                element={
                  <ProtectedRoute>
                    <AdminGuard>
                      <SystemLogs />
                    </AdminGuard>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/portfolio-classic"
                element={
                  <ProtectedRoute>
                    <Portfolio />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/screener"
                element={
                  <ProtectedRoute>
                    <Screener />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/profile"
                element={
                  <ProtectedRoute>
                    <Profile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/legacy/users"
                element={
                  <ProtectedRoute>
                    <AdminGuard>
                      <UserManagement />
                    </AdminGuard>
                  </ProtectedRoute>
                }
              />
              <Route
                path="/signals/:id/trace"
                element={
                  <ProtectedRoute>
                    <RecommendationTrace />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/recommendation-trade-outcomes/:id"
                element={
                  <ProtectedRoute>
                    <RecommendationTrace />
                  </ProtectedRoute>
                }
              />

              {/* Anything else: park in today workspace */}
              <Route path="*" element={<Navigate to="/workspace/today" replace />} />
            </Routes>
          </Suspense>
        </Content>
      </Layout>
    </Layout>
  );
};

const App: React.FC = () => {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#1f3a5f',
          colorInfo: '#2f6f73',
          colorSuccess: '#1f8a70',
          colorWarning: '#c9822b',
          colorError: '#c94b4b',
          borderRadius: 12,
          fontFamily:
            "'IBM Plex Sans', 'Noto Sans SC', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
          colorBgContainer: '#ffffff',
          colorText: '#1e252b',
          colorTextSecondary: '#65727e',
        },
        components: {
          Button: { borderRadius: 10, controlHeight: 36, fontWeight: 600 },
          Card: { borderRadiusLG: 16 },
          Table: {
            borderRadius: 14,
            headerBg: '#f7f1e7',
            headerColor: '#55616c',
            rowHoverBg: '#fbf7ef',
          },
          Input: { borderRadius: 10, controlHeight: 36 },
          Select: { borderRadius: 10, controlHeight: 36 },
          DatePicker: { borderRadius: 10, controlHeight: 36 },
        },
      }}
    >
      <Router>
        <PortfolioProvider>
          <AppContent />
        </PortfolioProvider>
      </Router>
    </ConfigProvider>
  );
};

export default App;
