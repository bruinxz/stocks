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
import {
  DashboardOutlined,
  LineChartOutlined,
  UserOutlined,
  AreaChartOutlined,
  SyncOutlined,
  LogoutOutlined,
  BarChartOutlined,
  FundProjectionScreenOutlined,
  DownOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store/rootReducer';
import { loginSuccess, logout } from './store/authSlice';
import { authService } from './services/authService';
import { API_DOMAIN_URL } from './services/api';

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
const Recommendations = lazy(() => import('./pages/Recommendations'));
const ReviewCenter = lazy(() => import('./pages/ReviewCenter'));
const StrategyResearchCenter = lazy(() => import('./pages/StrategyResearchCenter'));
const RecommendationTrace = lazy(() => import('./pages/RecommendationTrace'));
const AutonomousTradingOverview = lazy(() => import('./pages/AutonomousTradingOverview'));
const AutonomousRecommendationTracker = lazy(
  () => import('./pages/AutonomousRecommendationTracker')
);
const LiveTrading = lazy(() => import('./pages/LiveTrading'));
const QuantResearchWorkbench = lazy(() => import('./pages/QuantResearchWorkbench'));
const RiskAlerts = lazy(() => import('./pages/RiskAlerts'));
const SystemLogs = lazy(() => import('./pages/SystemLogs'));
import {
  RobotOutlined,
  ClockCircleOutlined,
  AlertOutlined,
  BookOutlined,
  ThunderboltOutlined,
  NodeIndexOutlined,
  BranchesOutlined,
  RadarChartOutlined,
  AimOutlined,
  CompassOutlined,
  SettingOutlined,
  TrophyOutlined,
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

const routeSelectionAliases: Array<[RegExp, string]> = [
  [/^\/quant\/(research|signals|backtests|strategies|experiments)(\/.*)?$/, '/quant/research'],
  [
    /^\/strategy-research\/(optimization|versions|experiments|weights|event-results)(\/.*)?$/,
    '/strategy-research',
  ],
  [/^\/live-trading\/(orders|reconcile)(\/.*)?$/, '/live-trading'],
  [/^\/review\/(trades|performance|agent-tail|journal)(\/.*)?$/, '/review'],
  [/^\/backtest\/.+$/, '/backtest'],
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
            dispatch(logout());
            localStorage.removeItem('token');
          }
        } catch (error) {
          console.error('Failed to fetch user profile on load', error);
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
    localStorage.removeItem('token');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('username');
    navigate('/login');
  };

  const mainMenuItems: MenuProps['items'] = useMemo(
    () => [
      {
        key: 'nav-today',
        icon: <CompassOutlined />,
        label: '今日作战',
        title: '今日作战',
        children: [
          menuLink('/today', <CompassOutlined />, '今日作战台'),
          menuLink('/autonomous-trading/overview', <FundProjectionScreenOutlined />, '当前持仓'),
          menuLink('/risk-alerts', <AlertOutlined />, '卖出/风控'),
        ],
      },
      {
        key: 'nav-quant-research',
        icon: <AimOutlined />,
        label: '量化交易',
        title: '量化交易',
        children: [
          menuLink('/quant/dashboard', <FundProjectionScreenOutlined />, '量化总览'),
          menuLink('/quant/research', <ThunderboltOutlined />, '研究工作台'),
          menuLink('/strategy-research', <TrophyOutlined />, '策略闭环'),
          menuLink('/ai-advisor', <RobotOutlined />, 'AI深度研报'),
          menuLink('/backtest', <LineChartOutlined />, '传统事件回测'),
        ],
      },
      {
        key: 'nav-review',
        icon: <RadarChartOutlined />,
        label: '收益复盘',
        title: '收益复盘',
        children: [
          menuLink('/review', <RadarChartOutlined />, '复盘总览'),
          menuLink('/review/trades', <NodeIndexOutlined />, '交易明细'),
          menuLink('/review/performance', <FundProjectionScreenOutlined />, '信号绩效'),
          menuLink('/review/agent-tail', <RadarChartOutlined />, 'Agent尾盘账本'),
          menuLink('/review/journal', <BookOutlined />, '交易日记'),
        ],
      },
      {
        key: 'nav-live-trading',
        icon: <SafetyCertificateOutlined />,
        label: '实盘交易',
        title: '实盘交易',
        children: [
          menuLink('/live-trading', <SafetyCertificateOutlined />, '安全边界'),
          menuLink('/live-trading/reconcile', <BranchesOutlined />, '只读对账'),
          menuLink('/live-trading/orders', <ThunderboltOutlined />, '订单审批'),
        ],
      },
      {
        key: 'nav-data-system',
        icon: <SyncOutlined />,
        label: '数据与系统',
        title: '数据与系统',
        children: [
          menuLink('/market', <AreaChartOutlined />, '市场与自选'),
          menuLink('/data-update', <SyncOutlined />, '数据同步'),
          menuLink('/tasks', <ClockCircleOutlined />, '调度任务'),
          menuLink('/logs', <BookOutlined />, '运行日志'),
          menuLink('/dashboard', <DashboardOutlined />, '系统总览'),
        ],
      },
      {
        key: 'nav-settings',
        icon: <SettingOutlined />,
        label: '账号与设置',
        title: '账号与设置',
        children: [
          menuLink('/profile', <UserOutlined />, '个人中心'),
          ...(user?.role === 'admin' ? [menuLink('/users', <UserOutlined />, '用户管理')] : []),
        ],
      },
    ],
    [user?.role]
  );

  const flatMenuItems = useMemo(() => flattenMenu(mainMenuItems), [mainMenuItems]);
  const menuPath = useMemo(() => resolveMenuPath(location.pathname), [location.pathname]);
  const selectedMenu =
    flatMenuItems
      .filter(item => menuPath === item.key || menuPath.startsWith(`${item.key}/`))
      .sort((a, b) => b.key.length - a.key.length)[0] || flatMenuItems[0];
  const selectedKey = selectedMenu?.key || '/dashboard';
  const currentSection = selectedMenu?.section || '工作台';
  const currentPageTitle = selectedMenu?.title || '总览仪表盘';
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
        label: <Link to="/profile">个人中心</Link>,
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
          )}
        </Header>
        <Content className="modern-layout-content">
          <Suspense fallback={routeFallback}>
            <Routes>
              <Route path="/" element={<Navigate to="/today" replace />} />
              <Route
                path="/today"
                element={
                  <ProtectedRoute>
                    <TodayCommandCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/paper-trading"
                element={<Navigate to="/autonomous-trading/overview?tab=manual" replace />}
              />
              <Route
                path="/autonomous-trading/overview"
                element={
                  <ProtectedRoute>
                    <AutonomousTradingOverview />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/autonomous-trading/recommendations"
                element={
                  <ProtectedRoute>
                    <AutonomousRecommendationTracker />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/live-trading"
                element={
                  <ProtectedRoute>
                    <LiveTrading />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/live-trading/orders"
                element={
                  <ProtectedRoute>
                    <LiveTrading />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/live-trading/reconcile"
                element={
                  <ProtectedRoute>
                    <LiveTrading />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/autonomous-trading/optimization"
                element={<Navigate to="/strategy-research/optimization" replace />}
              />
              <Route
                path="/strategy-research"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/strategy-research/optimization"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/strategy-research/versions"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/strategy-research/experiments"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/strategy-research/event-results"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/strategy-research/weights"
                element={
                  <ProtectedRoute>
                    <StrategyResearchCenter />
                  </ProtectedRoute>
                }
              />
              <Route path="/quant" element={<Navigate to="/quant/dashboard" replace />} />
              <Route
                path="/quant/dashboard"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/quant/research"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/quant/strategies"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/quant/backtests"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/quant/signals"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/quant/experiments"
                element={
                  <ProtectedRoute>
                    <QuantResearchWorkbench />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/market"
                element={
                  <ProtectedRoute>
                    <Market />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/ai-advisor"
                element={
                  <ProtectedRoute>
                    <AIAdvisor />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/tasks"
                element={
                  <ProtectedRoute>
                    <TaskScheduler />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/data-update"
                element={
                  <ProtectedRoute>
                    <DataUpdateStatus />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/logs"
                element={
                  <ProtectedRoute>
                    <SystemLogs />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/portfolio"
                element={
                  <ProtectedRoute>
                    <Portfolio />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/backtest"
                element={
                  <ProtectedRoute>
                    <Backtest />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/backtest/:id"
                element={
                  <ProtectedRoute>
                    <BacktestDetailRoute />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/recommendations"
                element={
                  <ProtectedRoute>
                    <Recommendations />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/recommendation-performance"
                element={<Navigate to="/review/performance" replace />}
              />
              <Route
                path="/agent-tail-alpha"
                element={<Navigate to="/review/agent-tail" replace />}
              />
              <Route
                path="/recommendation-trade-outcomes"
                element={<Navigate to="/review/trades" replace />}
              />
              <Route
                path="/recommendation-trade-outcomes/:id"
                element={
                  <ProtectedRoute>
                    <RecommendationTrace />
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
                path="/review"
                element={
                  <ProtectedRoute>
                    <ReviewCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/review/trades"
                element={
                  <ProtectedRoute>
                    <ReviewCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/review/performance"
                element={
                  <ProtectedRoute>
                    <ReviewCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/review/agent-tail"
                element={
                  <ProtectedRoute>
                    <ReviewCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/review/journal"
                element={
                  <ProtectedRoute>
                    <ReviewCenter />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/recommendation-loop-policies"
                element={<Navigate to="/strategy-research/versions" replace />}
              />
              <Route
                path="/strategy-experiment-lab"
                element={<Navigate to="/strategy-research/experiments" replace />}
              />
              <Route
                path="/screener"
                element={
                  <ProtectedRoute>
                    <Screener />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/risk-alerts"
                element={
                  <ProtectedRoute>
                    <RiskAlerts />
                  </ProtectedRoute>
                }
              />
              <Route path="/journals" element={<Navigate to="/review/journal" replace />} />
              <Route
                path="/strategy"
                element={<Navigate to="/strategy-research/event-results" replace />}
              />
              <Route
                path="/profile"
                element={
                  <ProtectedRoute>
                    <Profile />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/users"
                element={
                  <ProtectedRoute>
                    <UserManagement />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<Navigate to="/today" replace />} />
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
        <AppContent />
      </Router>
    </ConfigProvider>
  );
};

export default App;
