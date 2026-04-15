import React from 'react';
import { Layout, ConfigProvider, Menu } from 'antd';
import { BrowserRouter as Router, Routes, Route, Link, Navigate } from 'react-router-dom';
import {
  DashboardOutlined,
  LineChartOutlined,
  StockOutlined,
  UserOutlined,
  PieChartOutlined,
  AreaChartOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';

import Dashboard from './pages/Dashboard';
import Backtest from './pages/Backtest';
import Strategy from './pages/Strategy';
import Login from './pages/Login';
import Portfolio from './pages/Portfolio';
import Market from './pages/Market';
import DataUpdateStatus from './pages/DataUpdateStatus';

const { Header, Content, Footer, Sider } = Layout;

const App: React.FC = () => {
  // 简单认证状态（实际项目中应使用状态管理）
  const isAuthenticated = true;

  const menuItems = [
    {
      key: '/dashboard',
      icon: <DashboardOutlined />,
      label: <Link to="/dashboard">仪表板</Link>,
    },
    {
      key: '/portfolio',
      icon: <PieChartOutlined />,
      label: <Link to="/portfolio">组合收益模拟</Link>,
    },
    {
      key: '/market',
      icon: <AreaChartOutlined />,
      label: <Link to="/market">大盘视图</Link>,
    },
    {
      key: '/data-update',
      icon: <SyncOutlined />,
      label: <Link to="/data-update">数据更新监控</Link>,
    },
    {
      key: '/backtest',
      icon: <LineChartOutlined />,
      label: <Link to="/backtest">回测管理</Link>,
    },
    {
      key: '/strategy',
      icon: <StockOutlined />,
      label: <Link to="/strategy">策略管理</Link>,
    },
    {
      key: '/login',
      icon: <UserOutlined />,
      label: <Link to="/login">登录</Link>,
    },
  ];

  return (
    <ConfigProvider locale={zhCN}>
      <Router>
        <Layout style={{ minHeight: '100vh' }}>
          <Header style={{ color: 'white', fontSize: '20px', fontWeight: 'bold' }}>
            A股股票回测系统
          </Header>
          <Layout>
            <Sider width={200} theme="light">
              <Menu
                mode="inline"
                defaultSelectedKeys={['/dashboard']}
                style={{ height: '100%', borderRight: 0 }}
                items={menuItems}
              />
            </Sider>
            <Layout style={{ padding: '0 24px 24px' }}>
              <Content style={{ padding: '24px', margin: 0, minHeight: 280 }}>
                <Routes>
                  <Route path="/" element={<Navigate to="/dashboard" replace />} />
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/portfolio" element={<Portfolio />} />
                  <Route path="/market" element={<Market />} />
                  <Route path="/data-update" element={<DataUpdateStatus />} />
                  <Route path="/backtest" element={<Backtest />} />
                  <Route path="/strategy" element={<Strategy />} />
                  <Route path="/login" element={<Login />} />
                </Routes>
              </Content>
              <Footer style={{ textAlign: 'center' }}>
                A-Share Stock Backtesting System ©2023
              </Footer>
            </Layout>
          </Layout>
        </Layout>
      </Router>
    </ConfigProvider>
  );
};

export default App;
