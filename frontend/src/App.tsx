import React, { useEffect } from 'react';
import { Layout, ConfigProvider, Menu, Avatar, Dropdown } from 'antd';
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
  StockOutlined,
  UserOutlined,
  PieChartOutlined,
  AreaChartOutlined,
  SyncOutlined,
  LogoutOutlined,
  BarChartOutlined,
  FundProjectionScreenOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store/rootReducer';
import { loginSuccess, logout } from './store/authSlice';
import { authService } from './services/authService';
import { API_DOMAIN_URL } from './services/api';

import Dashboard from './pages/Dashboard';
import Backtest from './pages/Backtest';
import Strategy from './pages/Strategy';
import Login from './pages/Login';
import Portfolio from './pages/Portfolio';
import Market from './pages/Market';
import DataUpdateStatus from './pages/DataUpdateStatus';
import BacktestResults from './components/backtest/BacktestResults';
import Profile from './pages/Profile';
import UserManagement from './pages/UserManagement';
import AIAdvisor from './pages/AIAdvisor';
import TaskScheduler from './pages/TaskScheduler';
import Screener from './pages/Screener';
import Recommendations from './pages/Recommendations';
import RecommendationPerformance from './pages/RecommendationPerformance';
import PaperTrading from './pages/PaperTrading';
import RiskAlerts from './pages/RiskAlerts';
import TradingJournal from './pages/TradingJournal';
import SystemLogs from './pages/SystemLogs';
import {
  RobotOutlined,
  ClockCircleOutlined,
  RocketOutlined,
  AccountBookOutlined,
  AlertOutlined,
  BookOutlined,
  ThunderboltOutlined,
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

const AppContent: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch();
  const token = localStorage.getItem('token');
  const { user } = useSelector((state: RootState) => state.auth);

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

  const mainMenuItems: MenuProps['items'] = [
    {
      type: 'group',
      label: '核心概览',
      children: [
        {
          key: '/dashboard',
          icon: <DashboardOutlined />,
          label: <Link to="/dashboard">仪表盘</Link>,
        },
        { key: '/market', icon: <AreaChartOutlined />, label: <Link to="/market">市场大盘</Link> },
      ],
    },
    {
      type: 'group',
      label: 'AI 投顾',
      children: [
        {
          key: '/ai-advisor',
          icon: <RobotOutlined />,
          label: <Link to="/ai-advisor">AI 深度研报</Link>,
        },
        {
          key: '/recommendations',
          icon: <ThunderboltOutlined />,
          label: <Link to="/recommendations">智能候选推荐</Link>,
        },
        {
          key: '/recommendation-performance',
          icon: <FundProjectionScreenOutlined />,
          label: <Link to="/recommendation-performance">推荐绩效实验室</Link>,
        },
        {
          key: '/screener',
          icon: <RocketOutlined />,
          label: <Link to="/screener">AI 每日优选</Link>,
        },
      ],
    },
    {
      type: 'group',
      label: '量化交易',
      children: [
        { key: '/strategy', icon: <StockOutlined />, label: <Link to="/strategy">策略中心</Link> },
        {
          key: '/portfolio',
          icon: <PieChartOutlined />,
          label: <Link to="/portfolio">组合收益</Link>,
        },
        {
          key: '/backtest',
          icon: <LineChartOutlined />,
          label: <Link to="/backtest">回测分析</Link>,
        },
        {
          key: '/paper-trading',
          icon: <AccountBookOutlined />,
          label: <Link to="/paper-trading">模拟交易</Link>,
        },
        {
          key: '/risk-alerts',
          icon: <AlertOutlined />,
          label: <Link to="/risk-alerts">风控告警</Link>,
        },
      ],
    },
    {
      type: 'group',
      label: '系统与设置',
      children: [
        ...(user?.role === 'admin'
          ? [{ key: '/users', icon: <UserOutlined />, label: <Link to="/users">用户管理</Link> }]
          : []),
        { key: '/journals', icon: <BookOutlined />, label: <Link to="/journals">交易日记</Link> },
        { key: '/tasks', icon: <ClockCircleOutlined />, label: <Link to="/tasks">定时调度</Link> },
        {
          key: '/data-update',
          icon: <SyncOutlined />,
          label: <Link to="/data-update">系统监控</Link>,
        },
        {
          key: '/logs',
          icon: <BookOutlined />,
          label: <Link to="/logs">系统日志</Link>,
        },
        { key: '/profile', icon: <UserOutlined />, label: <Link to="/profile">个人中心</Link> },
      ],
    },
  ];

  const extractKeys = (items: any[]): any[] => {
    let keys: any[] = [];
    items.forEach(item => {
      if (item.children) {
        keys = keys.concat(item.children);
      } else {
        keys.push(item);
      }
    });
    return keys;
  };

  const selectedKey =
    extractKeys(mainMenuItems).find((item: any) => location.pathname.startsWith(item.key))?.key ||
    '/dashboard';

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
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    );
  }

  return (
    <Layout className="modern-layout">
      <Sider width={240} className="modern-sider">
        <div className="modern-sider-inner">
          <div>
            <div className="modern-logo">
              <BarChartOutlined className="logo-icon" />
              <span>QuantX</span>
            </div>
            <Menu
              mode="inline"
              selectedKeys={[selectedKey]}
              className="modern-menu"
              items={mainMenuItems}
            />
          </div>
        </div>
      </Sider>
      <Layout style={{ background: 'transparent' }}>
        <Header className="modern-header">
          {token && (
            <Dropdown menu={userMenuProps} placement="bottomRight" trigger={['click']}>
              <div
                className="header-user-dropdown"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'pointer',
                  padding: '4px 12px',
                  borderRadius: 8,
                  transition: 'background 0.2s',
                }}
              >
                <Avatar
                  size={32}
                  style={{ backgroundColor: '#1f3a5f', fontSize: 14, marginRight: 12 }}
                  icon={<UserOutlined />}
                  src={avatarSrc}
                />
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-main)' }}>
                  {displayUsername}
                </span>
              </div>
            </Dropdown>
          )}
        </Header>
        <Content className="modern-layout-content">
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
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
              element={
                <ProtectedRoute>
                  <PaperTrading />
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
              element={
                <ProtectedRoute>
                  <RecommendationPerformance />
                </ProtectedRoute>
              }
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
            <Route
              path="/journals"
              element={
                <ProtectedRoute>
                  <TradingJournal />
                </ProtectedRoute>
              }
            />
            <Route
              path="/strategy"
              element={
                <ProtectedRoute>
                  <Strategy />
                </ProtectedRoute>
              }
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
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
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
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
          colorBgContainer: '#fffdf8',
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
