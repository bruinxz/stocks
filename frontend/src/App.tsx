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
  SettingOutlined as AdminEntryIcon,
} from '@ant-design/icons';
import zhCN from 'antd/locale/zh_CN';
import { useSelector, useDispatch } from 'react-redux';
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
  CompassOutlined,
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

  // Phase 6 (2026-06-27) — 主菜单 admin-only.
  // 用户原话: 新手"用不起来" → 普通用户登录直接进 /home, 不看任何菜单/侧栏.
  // admin 仍能从 /home 右上角 ⚙ 入 /admin/today (即 /workspace/today), 走老路径.
  // Phase 3 的 5 项菜单完全保留, 但只对 admin 渲染:
  //   1. 今日 (今日作战)
  //   2. 持仓
  //   3. 实验室
  //   4. 设置
  //   5. 数据中心 / 系统介绍 (admin only)
  // 注: 简易版 /workspace/easy 留在 admin 主菜单之外 — 由 App.tsx 自有路由进入.
  const isAdmin = user?.role === 'admin';
  const mainMenuItems: MenuProps['items'] = useMemo(() => {
    if (!isAdmin) {
      // 普通用户: 主菜单完全隐藏 — /home 一页搞定.
      return [];
    }
    return [
      menuLink('/workspace/today', <CompassOutlined />, '今日'),
      menuLink('/workspace/portfolio', <PieChartOutlined />, '持仓'),
      menuLink('/workspace/lab', <ExperimentOutlined />, '实验室'),
      menuLink('/workspace/settings', <SettingOutlined />, '设置'),
      menuLink('/workspace/data', <DatabaseOutlined />, '数据中心'),
      menuLink('/workspace/system', <InfoCircleOutlined />, '系统介绍'),
      menuLink('/workspace/easy', <RocketOutlined />, '简易版'),
    ];
  }, [isAdmin]);

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

  // Phase 6 (2026-06-27) — 新手主页 /home 短路渲染 (无 Sider / 无 admin Header).
  // 极简顶栏 = Logo + 用户名 + (admin 才看到) ⚙ 进 /admin/today (走 admin 旧菜单).
  // ProtectedRoute 仍生效 — 未登录跳 /login.
  if (location.pathname === '/home') {
    return (
      <div className="home-shell">
        <div className="home-topbar">
          <div className="home-topbar-brand">
            <BarChartOutlined className="home-topbar-brand-icon" />
            <span>我的投资</span>
          </div>
          <div className="home-topbar-actions">
            {isAdmin && (
              <Link to="/workspace/today" className="home-topbar-admin-link" title="进入管理后台">
                <AdminEntryIcon />
              </Link>
            )}
            {token && (
              <Dropdown menu={userMenuProps} placement="bottomRight" trigger={['click']}>
                <div className="home-topbar-user">
                  <Avatar
                    size={28}
                    style={{ backgroundColor: '#4338ca', fontSize: 12 }}
                    icon={<UserOutlined />}
                    src={avatarSrc}
                  />
                  <span className="home-topbar-user-name">{displayUsername}</span>
                  <DownOutlined style={{ fontSize: 10, color: 'var(--ink-3, #94a3b8)' }} />
                </div>
              </Dropdown>
            )}
          </div>
        </div>
        <Suspense fallback={routeFallback}>
          <Routes>
            <Route
              path="/home"
              element={
                <ProtectedRoute>
                  <HomeWorkspace />
                </ProtectedRoute>
              }
            />
          </Routes>
        </Suspense>
        <CriticalAlertModal />
      </div>
    );
  }

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
              {/* Phase 6 (2026-06-27) — 登录默认进 /home (新手主页),
                  admin 走右上 ⚙ 进 /admin/today (实为 /workspace/today). */}
              <Route path="/" element={<Navigate to="/home" replace />} />

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
        // Phase 5 (2026-06-27) — 视觉重设计 (方向 B: 极简专业).
        // 详见 docs/audit/design_system_2026_06_27.md. token 与 index.css :root
        // 严格保持同源 (--brand / --ink-1 / --bg-canvas / radius-1 / shadow-1).
        token: {
          colorPrimary: '#4338ca',
          colorInfo: '#4338ca',
          // A 股惯例 — 红涨绿跌. success 用于跌 (绿), error 用于涨 (红).
          colorSuccess: '#16a34a',
          colorWarning: '#d97706',
          colorError: '#dc2626',
          colorTextBase: '#0f172a',
          colorBgBase: '#ffffff',
          colorBgLayout: '#f8fafc',
          colorBgContainer: '#ffffff',
          colorBorder: '#e2e8f0',
          colorBorderSecondary: '#e2e8f0',
          colorText: '#0f172a',
          colorTextSecondary: '#475569',
          colorTextTertiary: '#94a3b8',
          colorLink: '#4338ca',
          borderRadius: 6,
          borderRadiusLG: 10,
          borderRadiusSM: 4,
          fontSize: 13,
          fontSizeLG: 15,
          fontSizeXL: 20,
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif",
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
          boxShadowSecondary: '0 4px 16px rgba(15, 23, 42, 0.08)',
          controlHeight: 32,
        },
        components: {
          Button: { borderRadius: 6, controlHeight: 32, fontWeight: 500 },
          Card: { borderRadiusLG: 10, paddingLG: 16 },
          Table: {
            borderRadius: 10,
            headerBg: '#f1f5f9',
            headerColor: '#475569',
            rowHoverBg: '#eef2ff',
            cellPaddingBlock: 10,
            cellPaddingInline: 12,
          },
          Input: { borderRadius: 6, controlHeight: 32 },
          Select: { borderRadius: 6, controlHeight: 32 },
          DatePicker: { borderRadius: 6, controlHeight: 32 },
          Tag: { borderRadiusSM: 4 },
          Statistic: { titleFontSize: 12, contentFontSize: 28 },
          Tabs: { titleFontSize: 13, inkBarColor: '#4338ca' },
          Modal: { borderRadiusLG: 10 },
          Drawer: { borderRadiusLG: 10 },
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
