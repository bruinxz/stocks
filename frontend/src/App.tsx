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
  UserOutlined,
  LogoutOutlined,
  BarChartOutlined,
  DownOutlined,
  HomeOutlined,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { useSelector, useDispatch } from 'react-redux';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { RootState } from './store/rootReducer';
import { loginSuccess, logout } from './store/authSlice';
import { clearUserScopedStorage } from './utils/sessionCleanup';
import { authService } from './services/authService';
import { API_DOMAIN_URL } from './services/api';
import { PortfolioProvider } from './contexts/PortfolioContext';
import GlobalPortfolioSelector from './components/layout/GlobalPortfolioSelector';
import AlertsBell from './components/layout/AlertsBell';
import CriticalAlertModal from './components/layout/CriticalAlertModal';

// Phase 4 (2026-06-27) 清理: 删除 33 个 legacy pages (~ 4.1 万行)
// 仅保留 4 个 non-workspace 页面: Login / RecommendationTrace (deep link /signals/:id/trace)
// / StockDetail (/stock/:symbol) / HealthMonitor (DataWorkspace 内嵌). BacktestResults 仍保留
// 用于 LabStrategyDetail 的 /legacy/backtest/:id deep link.
const Login = lazy(() => import('./pages/Login'));
const BacktestResults = lazy(() => import('./components/backtest/BacktestResults'));
const RecommendationTrace = lazy(() => import('./pages/RecommendationTrace'));
const StockDetail = lazy(() => import('./pages/StockDetail'));

// Phase 6 (2026-06-27) — 新手主页 /home.
// 用户原话: "我是个股票的新手小白, 想要用这套系统来帮我自动化赚钱, 但是现在
// 还是太复杂". /home 是新手登录后的唯一一页 (无 tab 无侧栏), 3 区块 + 一键操作.
// 与简易版 /workspace/easy (教学暖纸色) 并存, 互不替代.
const HomeWorkspace = lazy(() => import('./pages/HomeWorkspace'));

// Unified workspace shells (US-001/US-002 + Easy mode).
const EasyQuantWorkspace = lazy(() => import('./pages/workspace/EasyQuantWorkspace'));
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
  SettingOutlined,
  ExperimentOutlined,
  DatabaseOutlined,
  PieChartOutlined,
  InfoCircleOutlined,
  RocketOutlined,
} from '@ant-design/icons';

import type { MenuProps } from 'antd';

const { Header, Content, Sider } = Layout;

const ProtectedRoute = ({ children }: { children: JSX.Element }) => {
  const token = localStorage.getItem('token');
  const location = useLocation();
  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return children;
};

/**
 * Phase 11 — Route-level page transition.
 *
 * 用 AnimatePresence + key=pathname 让每次 path 切换出一个 fade + 8px slide-up,
 * 持续 200ms. prefers-reduced-motion 用户直接 children, 跳过包装.
 *
 * 不动 Routes 自己 — 只在外层包一个 motion.div, 避免影响嵌套路由 / Navigate.
 */
const RouteTransition: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const reduceMotion = useReducedMotion();
  if (reduceMotion) return <>{children}</>;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={location.pathname}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        className="page-transition-wrap"
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
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
  [/^\/screener(\/.*)?$/, '/workspace/lab'],
  // Phase 3 (2026-06-27): 选股因子合并到实验室二级 tab — /workspace/factors 已不在主菜单.
  [/^\/workspace\/factors(\/.*)?$/, '/workspace/lab'],
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

  // Phase 7 (2026-06-28) — 主菜单"统一一套".
  // 用户反馈: "我即是管理员, 也是新手小白想学习量化, 不想让页面分离开" + "简易版
  // 那个 Tab 和页面怎么没有了". 修复:
  //   1. 所有用户看一样的菜单 (admin 只多 2 项 admin-only 数据/系统);
  //   2. 简易版回主菜单作为"教学路径";
  //   3. /home 仍是默认登录页, 但通过顶栏"更多功能"下拉也能进任意菜单.
  // 5 项基础 + 2 项 admin-only:
  //   主页 / 简易版 / 持仓 / 实验室 / 设置  (admin: + 数据中心 / 系统介绍)
  // /workspace/today 不再上一级菜单 — /home 已是新手的"今日入口", admin 可通过
  // 实验室 / 数据中心 / 顶栏更多 进入. 路由仍保留 (deep link 兼容).
  const isAdmin = user?.role === 'admin';
  const mainMenuItems: MenuProps['items'] = useMemo(() => {
    const items: MenuProps['items'] = [
      menuLink('/home', <HomeOutlined />, '主页'),
      menuLink('/workspace/easy', <RocketOutlined />, '简易版'),
      menuLink('/workspace/portfolio', <PieChartOutlined />, '持仓'),
      menuLink('/workspace/lab', <ExperimentOutlined />, '实验室'),
      menuLink('/workspace/settings', <SettingOutlined />, '设置'),
    ];
    if (isAdmin) {
      items.push(menuLink('/workspace/data', <DatabaseOutlined />, '数据中心'));
      items.push(menuLink('/workspace/system', <InfoCircleOutlined />, '系统介绍'));
    }
    return items;
  }, [isAdmin]);

  const flatMenuItems = useMemo(() => flattenMenu(mainMenuItems), [mainMenuItems]);
  const menuPath = useMemo(() => resolveMenuPath(location.pathname), [location.pathname]);
  const selectedMenu =
    flatMenuItems
      .filter(item => menuPath === item.key || menuPath.startsWith(`${item.key}/`))
      .sort((a, b) => b.key.length - a.key.length)[0] || flatMenuItems[0];
  const selectedKey = selectedMenu?.key || '/home';
  const currentSection = selectedMenu?.section || '工作台';
  const currentPageTitle = selectedMenu?.title || '主页';
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

  // Phase 7.5 (2026-06-28) — /home 改回走标准 ModernAppLayout (Sider + Header).
  // 用户反馈: "主页为什么没有导航栏, 布局要保持一致".
  // Phase 6/7 的短路渲染让 /home 没有左侧 sider, 与其他 workspace 不一致.
  // 现在 /home 与 /workspace/* 共用同一 shell, 视觉统一.
  // (短路保留给 /workspace/easy — 简易版要独占整屏)

  if (location.pathname.startsWith('/workspace/easy')) {
    return (
      <Suspense fallback={routeFallback}>
        <Routes>
          <Route
            path="/workspace/easy"
            element={
              <ProtectedRoute>
                <EasyQuantWorkspace />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/workspace/easy" replace />} />
        </Routes>
      </Suspense>
    );
  }

  return (
    <Layout className="modern-layout">
      <Sider width={220} className="modern-sider">
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
                    style={{ backgroundColor: '#0a0a0a', fontSize: 14 }}
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
            <RouteTransition>
              <Routes location={location}>
              {/* Phase 6 (2026-06-27) — 登录默认进 /home (新手主页),
                  admin 走右上 ⚙ 进 /admin/today (实为 /workspace/today). */}
              <Route path="/" element={<Navigate to="/home" replace />} />

              {/* Phase 7.5 (2026-06-28) — /home 加入标准 Layout, 与其他 workspace 视觉一致. */}
              <Route
                path="/home"
                element={
                  <ProtectedRoute>
                    <HomeWorkspace />
                  </ProtectedRoute>
                }
              />

              {/* Unified workspaces (US-001) */}
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

              {/* Pages still reachable for deep links — kept off the menu.
                  Phase 4 (2026-06-27): 18 个 /legacy/* 路由全部移除 (对应 page 已删).
                  仅保留 /legacy/backtest/:id (LabStrategyDetail 仍 Link 过来) +
                  /signals/:id/trace + /recommendation-trade-outcomes/:id. */}
              <Route
                path="/legacy/backtest/:id"
                element={
                  <ProtectedRoute>
                    <BacktestDetailRoute />
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

              {/* Anything else: 回 /home (新手主页) — Phase 6 之前是 /workspace/today */}
              <Route path="*" element={<Navigate to="/home" replace />} />
              </Routes>
            </RouteTransition>
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
        // Phase 14 (2026-06-28) — Stripe Dashboard 视觉重构 (减法).
        // brand 从 violet #7c3aed 切到 Stripe 紫 #635bff (与官网 Dashboard 同源).
        // 全站圆角收 6/8 (不再 10/16); shadow 收 2 档极轻; Tabs/Menu/Table 全部走
        // Stripe 风 (灰底 thead UPPERCASE / underline tab / 浅紫 menu selected).
        token: {
          colorPrimary: '#635bff',
          colorInfo: '#635bff',
          // A 股惯例 — 红涨绿跌. success 用于跌 (绿), error 用于涨 (红).
          colorSuccess: '#16a34a',
          colorWarning: '#f59e0b',
          colorError: '#dc2626',
          colorTextBase: '#0a0a0a',
          colorBgBase: '#ffffff',
          colorBgLayout: '#fafafa',
          colorBgContainer: '#ffffff',
          colorBorder: '#e5e7eb',
          colorBorderSecondary: '#f3f4f6',
          colorText: '#0a0a0a',
          colorTextSecondary: '#374151',
          colorTextTertiary: '#6b7280',
          colorLink: '#635bff',
          colorLinkHover: '#7a73ff',
          borderRadius: 6,
          borderRadiusLG: 8,
          borderRadiusSM: 4,
          fontSize: 14,
          fontSizeLG: 16,
          fontSizeXL: 18,
          fontSizeHeading1: 28,
          fontSizeHeading2: 20,
          fontSizeHeading3: 18,
          fontSizeHeading4: 16,
          fontFamily:
            "'Inter', 'PingFang SC', system-ui, -apple-system, 'Microsoft YaHei', sans-serif",
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
          boxShadowSecondary: '0 1px 2px rgba(0,0,0,0.04)',
          controlHeight: 36,
          controlHeightLG: 40,
          motionDurationFast: '120ms',
          motionDurationMid: '200ms',
          motionDurationSlow: '300ms',
        },
        components: {
          Button: {
            borderRadius: 6,
            controlHeight: 36,
            controlHeightLG: 40,
            fontWeight: 500,
            primaryShadow: '0 1px 2px rgba(0,0,0,0.05)',
          },
          Card: {
            borderRadiusLG: 8,
            paddingLG: 20,
            boxShadowTertiary: '0 1px 2px rgba(0,0,0,0.04)',
            colorBorderSecondary: '#e5e7eb',
          },
          Table: {
            borderRadius: 8,
            headerBg: '#fafafa',
            headerColor: '#6b7280',
            headerSplitColor: 'transparent',
            rowHoverBg: '#fafafa',
            cellPaddingBlock: 14,
            cellPaddingInline: 16,
          },
          Input: { borderRadius: 6, controlHeight: 36 },
          Select: { borderRadius: 6, controlHeight: 36 },
          DatePicker: { borderRadius: 6, controlHeight: 36 },
          Tag: { borderRadiusSM: 4 },
          Statistic: {
            titleFontSize: 11,
            contentFontSize: 28,
            fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
          },
          Tabs: {
            titleFontSize: 14,
            inkBarColor: '#635bff',
            itemSelectedColor: '#0a0a0a',
            itemHoverColor: '#0a0a0a',
            itemColor: '#6b7280',
          },
          Modal: { borderRadiusLG: 8 },
          Drawer: { borderRadiusLG: 8 },
          Menu: {
            itemHeight: 36,
            itemBorderRadius: 6,
            itemSelectedBg: '#f5f4ff',
            itemSelectedColor: '#635bff',
            itemHoverBg: '#f3f4f6',
          },
          Segmented: {
            itemSelectedBg: '#ffffff',
            itemSelectedColor: '#0a0a0a',
            trackBg: '#f3f4f6',
          },
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
