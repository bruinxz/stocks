import React from 'react';
import { Layout, ConfigProvider, Menu, Button, Avatar } from 'antd';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
  useNavigate,
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
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';

import Dashboard from './pages/Dashboard';
import Backtest from './pages/Backtest';
import Strategy from './pages/Strategy';
import Login from './pages/Login';
import Portfolio from './pages/Portfolio';
import Market from './pages/Market';
import DataUpdateStatus from './pages/DataUpdateStatus';

const { Header, Content, Sider } = Layout;

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const token = localStorage.getItem('token');
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
};

const AppContent: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const token = localStorage.getItem('token');
  const username = localStorage.getItem('username') || 'Admin';

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    navigate('/login');
  };

  const mainMenuItems = [
    { key: '/dashboard', icon: <DashboardOutlined />, label: <Link to="/dashboard">仪表盘</Link> },
    { key: '/market', icon: <AreaChartOutlined />, label: <Link to="/market">市场大盘</Link> },
    { key: '/strategy', icon: <StockOutlined />, label: <Link to="/strategy">策略中心</Link> },
    { key: '/backtest', icon: <LineChartOutlined />, label: <Link to="/backtest">回测分析</Link> },
    { key: '/portfolio', icon: <PieChartOutlined />, label: <Link to="/portfolio">组合模拟</Link> },
    { key: '/data-update', icon: <SyncOutlined />, label: <Link to="/data-update">系统监控</Link> },
  ];

  const selectedKey =
    mainMenuItems.find(item => location.pathname.startsWith(item.key))?.key || '/dashboard';

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
            <div className="header-user">
              <Avatar
                size={24}
                style={{ backgroundColor: '#4f46e5', fontSize: 12 }}
                icon={<UserOutlined />}
              />
              <span>{username}</span>
              <Button
                type="text"
                size="small"
                icon={<LogoutOutlined />}
                onClick={handleLogout}
                style={{ color: '#999', fontSize: 12 }}
              />
            </div>
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
              path="/portfolio"
              element={
                <ProtectedRoute>
                  <Portfolio />
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
              path="/data-update"
              element={
                <ProtectedRoute>
                  <DataUpdateStatus />
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
              path="/strategy"
              element={
                <ProtectedRoute>
                  <Strategy />
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
          colorPrimary: '#4f46e5',
          colorInfo: '#4f46e5',
          colorSuccess: '#10b981',
          colorWarning: '#f59e0b',
          colorError: '#ef4444',
          borderRadius: 8,
          fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif",
          colorBgContainer: '#ffffff',
          colorText: '#1a1a1a',
          colorTextSecondary: '#888',
        },
        components: {
          Button: { borderRadius: 6, controlHeight: 36, fontWeight: 500 },
          Card: { borderRadiusLG: 10 },
          Table: {
            borderRadius: 8,
            headerBg: '#fafafa',
            headerColor: '#888',
            rowHoverBg: '#fafafa',
          },
          Input: { borderRadius: 8, controlHeight: 36 },
          Select: { borderRadius: 8, controlHeight: 36 },
          DatePicker: { borderRadius: 8, controlHeight: 36 },
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
