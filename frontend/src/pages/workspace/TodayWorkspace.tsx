import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/rootReducer';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Dropdown,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import {
  AlertOutlined,
  BellOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  FireOutlined,
  FundOutlined,
  LineChartOutlined,
  ReloadOutlined,
  RightOutlined,
  RiseOutlined,
  BarChartOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePortfolio } from '../../contexts/PortfolioContext';
import dayjs, { Dayjs } from 'dayjs';
import {
  todayWorkspaceService,
  TodaySignalsData,
  ApplySignalsData,
  MultiFactorAlphaSignal,
  DragonHeadSignal,
  EarningsSurpriseSignal,
  KeyEventItem,
  UnreadRiskAlertItem,
} from '../../services/todayWorkspaceService';
import {
  buildTradingPlan,
  TradingPlanRow,
  TradingPlanSource,
  TradingPlanPriority,
  priorityTagColor,
  priorityLabel,
  sourceLabel,
} from './todayPlanHelpers';
import {
  buildSellSuggestions,
  SellSuggestionRow,
  SellSuggestionPriority,
  SellSuggestionSource,
  reasonLabel,
  reasonTagColor,
  sellPriorityLabel,
  sellPriorityTagColor,
  sellSourceLabel,
} from './todaySellHelpers';
import {
  AlertLevel,
  AlertsPanelFilterState,
  DerivedAlertCategory,
  DERIVED_CATEGORY_LABEL,
  DERIVED_CATEGORY_TAG_COLOR,
  emptyAlertsPanelFilterState,
  enrichAlerts,
  filterAlerts,
  hasActiveFilter,
  sortAlertsBySeverityThenTime,
  summarizeAlertsByCategory,
} from './alertsPanelHelpers';
import {
  addSnooze,
  buildAlertActionDescriptor,
  filterOutSnoozedAlerts,
  formatSnoozeRemaining,
  pruneExpiredSnoozes,
  readSnoozeMap,
  removeSnooze,
  SnoozeDuration,
  SNOOZE_DURATION_LABEL,
  SNOOZE_DURATION_ORDER,
  SnoozeMap,
  writeSnoozeMap,
} from './alertItemActionHelpers';
import { PositionRow, getPortfolio } from '../../services/portfolioWorkspaceService';
import {
  getMarketBriefToday,
  MarketBriefResult,
  truncateAIView,
} from '../../services/marketBriefService';
import {
  getMarketJudgmentToday,
  MarketJudgmentResult,
  MarketRegime,
  OvernightForeignQuote,
} from '../../services/marketJudgmentService';
import {
  getCallAuctionToday,
  CallAuctionAnomalyResult,
  AuctionAnomalyItem,
  AuctionAnomalyType,
} from '../../services/callAuctionService';
import api from '../../services/api';
import {
  listRiskAlerts,
  markAlertsAsRead,
  markAllRiskAlertsRead,
  markSingleRiskAlertRead,
  RiskAlertItem,
  RiskAlertListParams,
  AlertCategory,
  ALERT_CATEGORY_LABEL,
} from '../../services/riskAlertService';
// BK-4 (2026-06-24): 盘中行业资金流向 tab — lazy 加载该 tab 才加载 ECharts.
import IntradayCapitalFlowTab from './TodayWorkspace.IntradayCapitalFlowTab';
// CA-1b: v3 抖音风核心推荐 tab — 4 维评分卡片 + 5 档 playbook + 详情区.
import {
  getV3Recommendations,
  V3RecommendationData,
  V3RecommendationItem,
} from '../../services/v3RecommendationService';
import V3RecommendationCard from '../../components/trading/V3RecommendationCard';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;

/**
 * 今日作战 (Today Workspace) — US-018 完整实现。
 *
 * 布局：
 *   - 顶部 KPI 条：账户余额 / 昨日盈亏 / 当月收益 / 未读风险提醒数
 *     右上角 "一键应用全部信号到模拟盘" 按钮
 *   - 中部 3 列：MultiFactorAlpha 调仓 / DragonHead 候选 / EarningsSurprise 入选
 *   - 底部 2 列：今日关键事件（业绩预告 + 高连板涨停） / 风险告警未读列表
 *
 * 数据装载：mount 时调一次 GET /api/today/signals，全部数据放在一个 `data`
 * state 里；refresh 按钮重新拉取；一键应用按钮成功后跳转到 /workspace/portfolio。
 */

// US-070 [FE-031]: tab keys 抽到 module-scope 让 useEffect deps 干净 +
// AlertsBell 跳转 query 校验有单一事实源.
// CA-1: 'core_picks' 作为默认 tab — v3 抖音风刷卡片, 学习自抖音「炒股养家」的
// "信息密度集中 + 大字评分 + 一句话理由" 信息架构. 保留旧 4 tab 不删.
// Phase 3 (2026-06-27): tab 6 → 3 — 用户原话"页面太复杂".
//   核心推荐 (默认) / 今日信号 / 风险提醒
//   关键事件 → 折进核心推荐卡片下方 timeline (后续 story)
//   风控中心 → 合并到风险提醒, 用 filter level=HIGH 区分
//   资金流向 → 折进今日信号顶部带状图
// admin 仍能看到完整 6 tab (研究 / 调试). AlertsBell 跳转 ?tab=risk_center 仍兼容.
const TODAY_WORKSPACE_TABS_BASE: WorkspaceTab[] = [
  { key: 'core_picks', label: '核心推荐', icon: <FireOutlined /> },
  { key: 'signals', label: '今日信号', icon: <ThunderboltOutlined /> },
  { key: 'alerts', label: '风险提醒', icon: <AlertOutlined /> },
];
const TODAY_WORKSPACE_TABS_ADMIN_EXTRA: WorkspaceTab[] = [
  { key: 'events', label: '关键事件 (admin)', icon: <BellOutlined /> },
  { key: 'risk_center', label: '风控中心 (admin)', icon: <SafetyCertificateOutlined /> },
  // BK-4 (2026-06-24): 盘中行业资金流 (10min 自动刷新, 类似抖音"分时累计资金流")
  { key: 'capital_flow', label: '资金流向 (admin)', icon: <LineChartOutlined /> },
];
const TODAY_WORKSPACE_TAB_KEYS = [
  ...TODAY_WORKSPACE_TABS_BASE,
  ...TODAY_WORKSPACE_TABS_ADMIN_EXTRA,
].map(t => t.key);

const TodayWorkspace: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  // US-070 [FE-031]: tab keys 静态 — 用 module-scope const 让 useMemo 不需要 deps,
  // 同时 AlertsBell 点击带的 ?tab= query 也只能落在这 4 个 key 里. 字符串数组
  // inline 在 JSX 之外, 防 React Hook deps lint 抱怨 + 重渲不重建.
  // Phase 3: admin 看完整 6 tab, 普通用户只看 3 (核心推荐 / 信号 / 风险提醒).
  const isAdmin = useSelector((s: RootState) => s.auth.user?.role === 'admin');
  const tabs: WorkspaceTab[] = useMemo(
    () =>
      isAdmin
        ? [...TODAY_WORKSPACE_TABS_BASE, ...TODAY_WORKSPACE_TABS_ADMIN_EXTRA]
        : TODAY_WORKSPACE_TABS_BASE,
    [isAdmin]
  );
  // CA-1: 默认 tab = 'core_picks' (v3 抖音风刷卡片).
  // 旧 4 tab 仍然由 ?tab= query 显式选中 (AlertsBell 跳转兼容).
  const [activeKey, setActiveKey] = useState('core_picks');

  // US-070 [FE-031] AlertsBell 跳转支持 — 顶部 Bell 点击会带 `?tab=risk_center`,
  // 进入本页时应用 query 一次, 之后用户切 tab 不再被 query 覆盖.
  // 与 SettingsWorkspace 同款 "一次性应用 query" 模式 (refresh 即失效, 防与
  // 用户手动切 tab 抢状态). useLocation().search 变化时重新应用 (允许用户从
  // Bell 反复回到风控中心).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const tab = params.get('tab');
    if (tab && TODAY_WORKSPACE_TAB_KEYS.includes(tab)) {
      setActiveKey(tab);
    }
  }, [location.search]);

  // Batch AR (2026-06-21): tab 切换用 navigate(..., { replace: true }) 同步到
  // URL — 解决 "用户在本页连续切 4 个 tab, 浏览器后退要按 4 次才回到 dashboard".
  // replace=true 保证 tab 切换不进 history stack, 后退键直接回上一页.
  const handleTabChange = useCallback(
    (key: string) => {
      setActiveKey(key);
      navigate(`${location.pathname}?tab=${encodeURIComponent(key)}`, { replace: true });
    },
    [navigate, location.pathname]
  );

  const [data, setData] = useState<TodaySignalsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // US-044 / FE-005: 当前持仓 (供 SellSuggestionCard 计算硬触发止损/止盈).
  // 与 todaySignals 一起拉, 任一失败仅本卡片降级, 不阻塞其它面板.
  const [positions, setPositions] = useState<PositionRow[] | null>(null);

  // ---- CA-1 v3 推荐 (核心推荐 tab) 独立 lazy-load 状态 ----
  // 三态独立 (data / loading / error) 套 [[lazy-load tab data 三态判定]] pattern:
  // 只在 activeKey==='core_picks' 且未加载未失败时触发, 与 TodaySignals 完全解耦.
  const [v3Data, setV3Data] = useState<V3RecommendationData | null>(null);
  const [v3Loading, setV3Loading] = useState(false);
  const [v3Error, setV3Error] = useState<string | null>(null);

  // CA-1 详情 modal target — 复用 AIStockAnalysisModal (5 维 v1 / 8 维 v2 自动选).
  const [v3DetailTarget, setV3DetailTarget] = useState<{
    symbol: string;
    name: string | null;
  } | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplySignalsData | null>(null);
  // 2026-06-17: 全局选盘. KPI / MFA 差分基线 / 一键下单都跟随选盘.
  const { selectedPortfolioId, portfolios } = usePortfolio();

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // Batch L (2026-06-17): 切盘 race 保护, 同 PortfolioWorkspace.
    const callPortfolioId = selectedPortfolioId;
    try {
      // US-044: positions 与 todaySignals 并行拉, positions 失败仅 SellSuggestionCard
      // 降级显示 "持仓加载失败" 不影响 BUY 计划/策略卡 — 与 MarketJudgment / CallAuction
      // 卡片同款 fail-OPEN 思想.
      const [signalsResult, portfolioResult] = await Promise.allSettled([
        todayWorkspaceService.getTodaySignals({
          portfolio_id: selectedPortfolioId,
        }),
        getPortfolio(selectedPortfolioId ?? undefined),
      ]);
      if (callPortfolioId !== selectedPortfolioId) return;
      if (signalsResult.status === 'fulfilled') {
        setData(signalsResult.value);
      } else {
        const msg =
          signalsResult.reason instanceof Error
            ? signalsResult.reason.message
            : String(signalsResult.reason);
        setLoadError(msg);
      }
      if (portfolioResult.status === 'fulfilled') {
        setPositions(portfolioResult.value.positions ?? []);
      } else {
        // positions 加载失败不阻塞其它面板, 卡片自己降级
        setPositions(null);
      }
    } catch (err: unknown) {
      if (callPortfolioId !== selectedPortfolioId) return;
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
    } finally {
      if (callPortfolioId === selectedPortfolioId) setLoading(false);
    }
  }, [selectedPortfolioId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- CA-1 v3 推荐 lazy-load ----
  // 套 [[lazy-load tab data 三态判定]] pattern: 用户首次切到 core_picks 才拉.
  // 刷新按钮 / 错误重试都直接调 loadV3.
  const loadV3 = useCallback(async () => {
    setV3Loading(true);
    setV3Error(null);
    try {
      // limit=5: 后端默认 3, 加 limit 显式触发 elastic 取数 (>3 时也会按 5 截断).
      const res = await getV3Recommendations({ limit: 5 });
      setV3Data(res);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setV3Error(msg);
    } finally {
      setV3Loading(false);
    }
  }, []);

  useEffect(() => {
    if (activeKey !== 'core_picks') return;
    if (v3Data || v3Loading || v3Error) return;
    void loadV3();
  }, [activeKey, v3Data, v3Loading, v3Error, loadV3]);

  // ----- 顶部 KPI -----
  const kpiSlot = useMemo(() => {
    const account = data?.account;
    const totalValue = account?.total_value ?? 0;
    // 后端 pnl_yesterday = today.total_value - 最近一次 (排除今天) snapshot
    // = "今日相对昨日收盘的浮盈" → 用户语境下的「今日盈亏」（旧标签 "昨日盈亏" 易误解）
    const pnlToday = account?.pnl_yesterday ?? null;
    const pnlMonth = account?.pnl_month_to_date ?? null;
    const totalReturn = account?.total_return ?? null;
    const totalReturnPct = account?.total_return_pct ?? null;
    const unreadCount = data?.unread_alert_count ?? 0;
    // AT-2 (2026-06-21): 顶部加 "当前盘 · 策略 chip / 因子 chip" 让用户一眼看到当前选盘用的策略和因子.
    const currentPortfolio = portfolios.find(p => p.id === selectedPortfolioId);
    const strategyChips = currentPortfolio?.strategy_display ?? [];
    const factorChips = currentPortfolio?.factor_display ?? [];
    return (
      <Space size={24} wrap>
        <Statistic
          title="账户净值"
          value={totalValue}
          precision={2}
          prefix="¥"
          valueStyle={{ color: '#1677ff' }}
        />
        <Statistic
          title="今日盈亏"
          value={pnlToday ?? 0}
          precision={2}
          prefix={pnlToday != null ? '¥' : ''}
          suffix={pnlToday == null ? ' —' : ''}
          valueStyle={{ color: pnlColor(pnlToday) }}
        />
        <Statistic
          title="当月收益"
          value={pnlMonth ?? 0}
          precision={2}
          prefix={pnlMonth != null ? '¥' : ''}
          suffix={pnlMonth == null ? ' —' : ''}
          valueStyle={{ color: pnlColor(pnlMonth) }}
        />
        <Statistic
          title="总收益"
          value={totalReturn ?? 0}
          precision={2}
          prefix={totalReturn != null ? '¥' : ''}
          suffix={
            totalReturn == null
              ? ' —'
              : totalReturnPct != null
                ? ` (${(totalReturnPct * 100).toFixed(2)}%)`
                : ''
          }
          valueStyle={{ color: pnlColor(totalReturn) }}
        />
        <Statistic
          title="未读风险"
          value={unreadCount}
          suffix="条"
          valueStyle={{ color: unreadCount > 0 ? '#dc2626' : '#16a34a' }}
        />
        {currentPortfolio && (strategyChips.length > 0 || factorChips.length > 0) && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 200 }}>
            <span style={{ fontSize: 12, color: '#8c8c8c' }}>
              当前盘 · {currentPortfolio.name}
              {currentPortfolio.auto_trade_enabled ? ' · 🟣 自动跟单' : ''}
            </span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
              {strategyChips.slice(0, 3).map(s => (
                <span
                  key={`strat-${s.key}`}
                  title={s.brief || s.key}
                  style={{
                    background: '#e6f4ff',
                    color: '#1677ff',
                    padding: '0 6px',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  {s.name}
                </span>
              ))}
              {strategyChips.length > 3 && (
                <span style={{ fontSize: 12, color: '#8c8c8c' }}>+{strategyChips.length - 3}</span>
              )}
              {factorChips.slice(0, 3).map(f => (
                <span
                  key={`fac-${f.key}`}
                  title={`${f.category} · ${f.key}`}
                  style={{
                    background: '#f6ffed',
                    color: '#16a34a',
                    padding: '0 6px',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                >
                  {f.name}
                </span>
              ))}
              {factorChips.length > 3 && (
                <span style={{ fontSize: 12, color: '#8c8c8c' }}>+{factorChips.length - 3}</span>
              )}
            </span>
          </div>
        )}
      </Space>
    );
  }, [data, portfolios, selectedPortfolioId]);

  // ----- 一键应用全部信号 -----
  const totalBuyCount = useMemo(() => {
    if (!data) return 0;
    const mfa = data.multi_factor.signals.filter(s => s.signal === 'buy').length;
    const dh = data.dragon_head.candidates.filter(s => s.signal === 'buy').length;
    const ev = data.earnings_surprise.candidates.filter(s => s.signal === 'buy').length;
    return mfa + dh + ev;
  }, [data]);

  const handleApplyAll = useCallback(async () => {
    if (!data || totalBuyCount === 0) {
      message.info('当前没有可下单的 BUY 信号');
      return;
    }
    setApplying(true);
    try {
      const result = await todayWorkspaceService.applyTodaySignals({
        trade_date: data.trade_date ?? undefined,
        portfolio_id: selectedPortfolioId,
      });
      setApplyResult(result);
      message.success(
        `下单完成：成功 ${result.placed} 条，跳过 ${result.skipped} 条 — 即将跳转持仓页`
      );
      // 2 秒后跳转持仓页（给用户时间看到 modal）
      setTimeout(() => {
        navigate('/workspace/portfolio');
      }, 1800);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`一键应用失败：${msg}`);
    } finally {
      setApplying(false);
    }
  }, [data, totalBuyCount, navigate]);

  const headerActions = (
    <Space>
      <Button
        icon={<ReloadOutlined />}
        onClick={() => {
          // CA-1: core_picks tab 走独立 loadV3, 其它 tab 走 refresh.
          // 用户体感: 当前 tab 的"刷新"刷当前 tab 的数据, 不会触发其它 tab fetch.
          if (activeKey === 'core_picks') void loadV3();
          else void refresh();
        }}
        loading={activeKey === 'core_picks' ? v3Loading : loading}
      >
        刷新
      </Button>
      {/* 系统自主决策：每日 14:35 cron 按 score>75 + 风控 8 道 guard 自动下单；
          不再需要"一键应用"暴力全买。用户可在"持仓与复盘"查看结果。
          保留 apply 逻辑但不显示按钮。*/}
    </Space>
  );

  // ----- body -----
  let body: React.ReactNode = null;
  if (activeKey === 'core_picks') {
    // CA-1: core_picks 走独立 v3 状态机, 与 TodaySignals 完全解耦.
    body = (
      <CorePicksPanel
        data={v3Data}
        loading={v3Loading}
        error={v3Error}
        onReload={() => void loadV3()}
        onClickDetail={item => setV3DetailTarget({ symbol: item.symbol, name: item.name ?? null })}
      />
    );
  } else if (loading && !data) {
    body = (
      <Card>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载今日作战信号..." />
        </div>
      </Card>
    );
  } else if (loadError) {
    body = (
      <Card>
        <Alert
          message="加载失败"
          description={loadError}
          type="error"
          showIcon
          action={
            <Button size="small" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  } else if (!data) {
    body = (
      <Card>
        <Empty description="暂无数据" />
      </Card>
    );
  } else if (activeKey === 'signals') {
    body = <SignalsPanel data={data} positions={positions} />;
  } else if (activeKey === 'events') {
    body = <EventsPanel events={data.key_events} tradeDate={data.trade_date} />;
  } else if (activeKey === 'alerts') {
    body = <AlertsPanel alerts={data.unread_alerts} totalCount={data.unread_alert_count} />;
  } else if (activeKey === 'risk_center') {
    body = <RiskAlertCenterPanel onUnreadCountChange={refresh} />;
  } else if (activeKey === 'capital_flow') {
    // BK-4 (2026-06-24): 盘中行业资金流 (10min auto-refresh, 截图类多线图)
    body = <IntradayCapitalFlowTab />;
  }

  const subtitle = data?.trade_date
    ? `开盘前一目了然 · 信号 as-of ${data.trade_date}`
    : '开盘前一目了然：多策略当日信号、关键事件与风险提醒。';

  return (
    <>
      <WorkspaceLayout
        title="今日作战"
        subtitle={subtitle}
        tabs={tabs}
        activeKey={activeKey}
        onTabChange={handleTabChange}
        kpiSlot={kpiSlot}
        headerActions={headerActions}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* hotfix-AL (2026-06-21): MarketJudgment / CallAuction / MarketBrief
              是 "今日大盘速读" 概览, 只属于 "今日信号" tab. 此前一直把这 3 张大卡
              render 在所有 tab 之上 (~600-800px 高), 用户点击 "关键事件 / 风险提醒
              / 风控中心" 后 activeKey state 确实改了, 但实际 body 内容被推到屏幕
              下方看不到, 体感"点击无反应". 改成只在 signals tab 渲染. */}
          {activeKey === 'signals' && (
            <>
              <MarketJudgmentCard />
              <CallAuctionCard portfolioId={selectedPortfolioId ?? null} />
              <MarketBriefCard />
            </>
          )}
          {body}
        </Space>
      </WorkspaceLayout>
      <ApplyResultModal
        result={applyResult}
        onClose={() => setApplyResult(null)}
        onGotoPortfolio={() => {
          setApplyResult(null);
          navigate('/workspace/portfolio');
        }}
      />
      {/* CA-1 v3 推荐卡片点击 "查看完整分析" — 复用 AIStockAnalysisModal. */}
      {v3DetailTarget && (
        <AIStockAnalysisModal
          open={!!v3DetailTarget}
          onClose={() => setV3DetailTarget(null)}
          stockCode={v3DetailTarget.symbol}
          stockName={v3DetailTarget.name}
          taskLabel="today_v3_core_pick"
        />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// MarketJudgmentCard (US-040 / FE-001) — 今日大盘判断
// ---------------------------------------------------------------------------

/**
 * 「今日大盘判断」开盘前一张卡片。
 *
 * 3 段（AC）:
 *   - 昨夜外盘   4 个海外指数（恒指/纳指/标普/道指）涨跌幅 + 均值
 *   - 大盘 regime   bull/bear/range/rebound/stress/unknown + ATR 高波动调整
 *   - 仓位建议   regime → 默认仓位 + ATR 调整后 0..1 百分比 + 人话原因
 *
 * 状态语义（与 MarketBriefCard 同款）：
 *   - ok       全部成功，淡蓝 banner;
 *   - partial  单维失败，黄色 Alert 显示 components.<x>.error;
 *   - failed   全失败，红色 Alert + brief 仍展示 fallback 文案.
 *
 * 容错: getMarketJudgmentToday throw → 卡片内 Alert + 重试按钮, 不影响下方信号面板.
 */
const MarketJudgmentCard: React.FC = () => {
  const [data, setData] = useState<MarketJudgmentResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getMarketJudgmentToday();
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const titleNode = (
    <Space size={8}>
      <FundOutlined style={{ color: '#1677ff' }} />
      <span>今日大盘判断</span>
      {data?.trade_date && <Tag color="blue">{data.trade_date}</Tag>}
      {data?.status === 'partial' && <Tag color="orange">部分数据待补</Tag>}
      {data?.status === 'failed' && <Tag color="red">数据全缺</Tag>}
      {data && (
        <Tag color={regimeTagColor(data.regime)}>
          {data.regime_label || regimeLabelFallback(data.regime)}
        </Tag>
      )}
    </Space>
  );

  const extra = (
    <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
      刷新
    </Button>
  );

  if (loading && !data) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin tip="加载今日大盘判断..." />
        </div>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Alert
          type="error"
          showIcon
          message="今日大盘判断加载失败"
          description={error}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  if (!data) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Empty description="暂无数据" />
      </Card>
    );
  }

  const regimeError = data.components?.regime?.error || null;
  const foreignError = data.components?.overnight_foreign?.error || null;
  const positionPctDisplay = Number.isFinite(data.suggested_position_pct)
    ? `${Math.round(data.suggested_position_pct * 100)}%`
    : '—';
  const positionColor = positionPctColor(data.suggested_position_pct);

  return (
    <Card size="small" title={titleNode} extra={extra}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* 第一行：建议仓位 + regime KPI + ATR + 20d return */}
        <Row gutter={[12, 8]} align="middle">
          <Col xs={12} md={6}>
            <Tooltip title={data.suggested_position_reason}>
              <Statistic
                title={
                  <Space size={4}>
                    <span style={{ fontSize: 12 }}>建议仓位</span>
                    <Tag color={positionColor.tag} style={{ fontSize: 12, padding: '0 4px' }}>
                      {data.suggested_position_label}
                    </Tag>
                  </Space>
                }
                value={positionPctDisplay}
                valueStyle={{ fontSize: 18, fontWeight: 600, color: positionColor.text }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title={regimeError || '基准: 沪深 300'}>
              <Statistic
                title="大盘环境"
                value={data.regime_label || regimeLabelFallback(data.regime)}
                valueStyle={{ fontSize: 18, color: regimeStatColor(data.regime) }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip
              title={
                data.benchmark_atr_14d_pct == null
                  ? '基准 ATR 数据缺失'
                  : data.benchmark_atr_14d_pct >= 5
                    ? '极高波动（已下调建议仓位 10%）'
                    : data.benchmark_atr_14d_pct >= 3
                      ? '高波动（已下调建议仓位 5%）'
                      : '波动正常'
              }
            >
              <Statistic
                title="基准 ATR 14d"
                value={
                  data.benchmark_atr_14d_pct == null
                    ? '—'
                    : `${data.benchmark_atr_14d_pct.toFixed(2)}%`
                }
                valueStyle={{ fontSize: 18, color: atrColor(data.benchmark_atr_14d_pct) }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="基准 20d 收益"
              value={
                data.benchmark_return_20d_pct == null
                  ? '—'
                  : `${
                      data.benchmark_return_20d_pct >= 0 ? '+' : ''
                    }${data.benchmark_return_20d_pct.toFixed(2)}%`
              }
              valueStyle={{
                fontSize: 18,
                color:
                  data.benchmark_return_20d_pct == null
                    ? undefined
                    : data.benchmark_return_20d_pct >= 0
                      ? '#dc2626'
                      : '#16a34a',
              }}
            />
          </Col>
        </Row>

        {/* 第二行：昨夜外盘 4 个海外指数 */}
        <div>
          <Space size={4} style={{ marginBottom: 6 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              昨夜外盘
            </Text>
            {data.overnight_summary?.count > 0 && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                · 均值{' '}
                <span style={{ color: overnightAvgColor(data.overnight_summary.avg_change_pct) }}>
                  {data.overnight_summary.avg_change_pct >= 0 ? '+' : ''}
                  {data.overnight_summary.avg_change_pct.toFixed(2)}%
                </span>
              </Text>
            )}
            {foreignError && (
              <Tooltip title={foreignError}>
                <Tag color="orange" style={{ fontSize: 12 }}>
                  数据缺失
                </Tag>
              </Tooltip>
            )}
          </Space>
          {data.overnight_foreign.length > 0 ? (
            <Row gutter={[12, 8]}>
              {data.overnight_foreign.map((idx: OvernightForeignQuote) => (
                <Col xs={12} md={6} key={idx.symbol}>
                  <Tooltip
                    title={
                      <>
                        <div>收盘: {idx.current.toFixed(2)}</div>
                        <div>涨跌: {idx.change.toFixed(2)}</div>
                        <div>涨跌幅: {idx.change_pct.toFixed(2)}%</div>
                      </>
                    }
                  >
                    <Statistic
                      title={<span style={{ fontSize: 12 }}>{idx.name}</span>}
                      value={idx.current}
                      precision={2}
                      suffix={
                        <span
                          style={{
                            fontSize: 12,
                            marginLeft: 6,
                            color: idx.change_pct >= 0 ? '#dc2626' : '#16a34a',
                          }}
                        >
                          {idx.change_pct >= 0 ? '+' : ''}
                          {idx.change_pct.toFixed(2)}%
                        </span>
                      }
                      valueStyle={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: idx.change_pct >= 0 ? '#dc2626' : '#16a34a',
                      }}
                    />
                  </Tooltip>
                </Col>
              ))}
            </Row>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Text>
          )}
        </div>

        {/* 第三行：一句话 brief */}
        <div style={{ paddingLeft: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            今日小结
          </Text>
          <Paragraph style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5, color: '#262626' }}>
            {data.brief}
          </Paragraph>
        </div>

        {data.status !== 'ok' && (
          <Alert
            type={data.status === 'failed' ? 'error' : 'warning'}
            showIcon
            message={data.message}
            style={{ marginBottom: 0 }}
          />
        )}
      </Space>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// CallAuctionCard (US-041 / FE-002) — 集合竞价异动
// ---------------------------------------------------------------------------

/**
 * 「集合竞价异动」9:25 后展示一字 / 高开 / 低开异动。
 *
 * Universe (待观察池) = 昨日 LimitUpStock (连板/强势股池) + 当前 portfolio 持仓.
 *
 * 时机:
 *   - 9:25 前: 卡片显示 timing 提示, 不展示行情 (集合竞价未结束);
 *   - 9:25 后: 拉行情并 join universe, 展示命中异动的股票.
 *
 * 状态语义 (与 MarketJudgmentCard 同款):
 *   - ok       全部成功, 淡蓝 banner;
 *   - partial  单维失败, 黄色 Alert 显示 components.<x>.error;
 *   - failed   全失败, 红色 Alert.
 *
 * 自动刷新:
 *   - 9:25-9:35 之间每 20s 自动 refresh (集合竞价后开盘前的关键窗口);
 *   - 其它时段 mount 拉一次, 用户手动 refresh.
 */
const CallAuctionCard: React.FC<{ portfolioId: number | null }> = ({ portfolioId }) => {
  const [data, setData] = useState<CallAuctionAnomalyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await getCallAuctionToday({
        portfolio_id: portfolioId ?? undefined,
      });
      setData(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [portfolioId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 9:25-9:35 之间每 20s 自动 refresh (关键窗口, 行情快速变化)
  useEffect(() => {
    const isAuctionWindow = (): boolean => {
      const now = dayjs();
      const day = now.day();
      if (day === 0 || day === 6) return false;
      const minutes = now.hour() * 60 + now.minute();
      return minutes >= 9 * 60 + 25 && minutes <= 9 * 60 + 35;
    };
    if (!isAuctionWindow()) return;
    const tm = setInterval(() => void load(), 20_000);
    return () => clearInterval(tm);
  }, [load]);

  const titleNode = (
    <Space size={8}>
      <ThunderboltOutlined style={{ color: '#fa8c16' }} />
      <span>集合竞价异动</span>
      {data?.trade_date && <Tag color="orange">{data.trade_date}</Tag>}
      {data?.server_clock && (
        <Tag color={data.is_after_auction ? 'green' : 'default'}>{data.server_clock}</Tag>
      )}
      {data && !data.is_after_auction && <Tag color="default">集合竞价未结束</Tag>}
      {data?.status === 'partial' && <Tag color="orange">部分数据待补</Tag>}
      {data?.status === 'failed' && <Tag color="red">数据全缺</Tag>}
    </Space>
  );

  const extra = (
    <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
      刷新
    </Button>
  );

  if (loading && !data) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin tip="加载集合竞价异动..." />
        </div>
      </Card>
    );
  }

  if (error && !data) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Alert
          type="error"
          showIcon
          message="集合竞价异动加载失败"
          description={error}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  if (!data) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Empty description="暂无数据" />
      </Card>
    );
  }

  const timingError = data.components?.timing?.error || null;
  const universeError = data.components?.universe?.error || null;
  const quotesError = data.components?.quotes?.error || null;

  return (
    <Card size="small" title={titleNode} extra={extra}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* KPI 行: 观察池 / 一字 / 高开 / 低开 */}
        <Row gutter={[12, 8]} align="middle">
          <Col xs={12} md={6}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>观察池</span>}
              value={data.universe_size}
              suffix="只"
              valueStyle={{ fontSize: 18, fontWeight: 600, color: '#1677ff' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title="一字板 — 开 = 高 = 低 = 涨停, 通常买不到">
              <Statistic
                title={<span style={{ fontSize: 12 }}>一字板</span>}
                value={data.summary.one_word_count}
                suffix="只"
                valueStyle={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: data.summary.one_word_count > 0 ? '#dc2626' : '#8c8c8c',
                }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title={`高开 ≥ +${3}% — 跳空缺口入选范围`}>
              <Statistic
                title={<span style={{ fontSize: 12 }}>高开</span>}
                value={data.summary.gap_up_count}
                suffix="只"
                valueStyle={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: data.summary.gap_up_count > 0 ? '#dc2626' : '#8c8c8c',
                }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={6}>
            <Tooltip title={`低开 ≤ -${3}% — 止损 / 减持信号`}>
              <Statistic
                title={<span style={{ fontSize: 12 }}>低开</span>}
                value={data.summary.gap_down_count}
                suffix="只"
                valueStyle={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: data.summary.gap_down_count > 0 ? '#16a34a' : '#8c8c8c',
                }}
              />
            </Tooltip>
          </Col>
        </Row>

        {/* timing 提示: 集合竞价未结束 */}
        {timingError && (
          <Alert type="info" showIcon message={timingError} style={{ marginBottom: 0 }} />
        )}

        {/* 异动列表 */}
        {data.anomalies.length === 0 ? (
          <Empty
            description={
              data.is_after_auction ? '集合竞价后无异动 (全部平开)' : '集合竞价未结束, 暂无开盘价'
            }
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Table<AuctionAnomalyItem>
            size="small"
            rowKey="symbol"
            dataSource={data.anomalies}
            pagination={false}
            scroll={{ x: 'max-content', y: 320 }}
            columns={[
              {
                title: '异动',
                dataIndex: 'anomaly_type',
                width: 80,
                render: (v: AuctionAnomalyType) => auctionTypeTag(v),
                filters: [
                  { text: '一字板', value: 'one_word' },
                  { text: '高开', value: 'gap_up' },
                  { text: '低开', value: 'gap_down' },
                ],
                onFilter: (val, row) => row.anomaly_type === val,
              },
              {
                title: '代码',
                dataIndex: 'symbol',
                width: 100,
                render: (v: string) => (
                  <a onClick={() => navigate(`/stock/${v}`)}>
                    <Text code style={{ fontSize: 12 }}>
                      {v}
                    </Text>
                  </a>
                ),
              },
              {
                title: '名称',
                dataIndex: 'name',
                width: 110,
                ellipsis: true,
                render: (v: string | null, row: AuctionAnomalyItem) =>
                  v ? <a onClick={() => navigate(`/stock/${row.symbol}`)}>{v}</a> : '—',
              },
              {
                title: '开盘涨跌',
                dataIndex: 'open_change_pct',
                width: 90,
                align: 'right' as const,
                sorter: (a: AuctionAnomalyItem, b: AuctionAnomalyItem) =>
                  (a.open_change_pct ?? 0) - (b.open_change_pct ?? 0),
                render: (v: number | null) =>
                  v == null ? (
                    <Text type="secondary">—</Text>
                  ) : (
                    <Text strong style={{ color: v >= 0 ? '#dc2626' : '#16a34a' }}>
                      {v >= 0 ? '+' : ''}
                      {v.toFixed(2)}%
                    </Text>
                  ),
              },
              {
                title: '开/昨收',
                key: 'open_prev',
                width: 130,
                render: (_: unknown, row: AuctionAnomalyItem) => (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {row.open != null ? row.open.toFixed(2) : '—'} /{' '}
                    {row.prev_close != null ? row.prev_close.toFixed(2) : '—'}
                  </Text>
                ),
              },
              {
                title: '来源',
                key: 'source_tags',
                width: 130,
                render: (_: unknown, row: AuctionAnomalyItem) => (
                  <Space size={4} wrap>
                    {row.was_yesterday_limit_up && row.continuous_days != null && (
                      <Tag color="red">{row.continuous_days}板</Tag>
                    )}
                    {row.is_position && <Tag color="blue">持仓</Tag>}
                    {row.industry && <Tag color="blue">{row.industry}</Tag>}
                  </Space>
                ),
              },
              {
                title: '说明',
                dataIndex: 'note',
                ellipsis: true,
                render: (v: string) => (
                  <Tooltip title={v} placement="topLeft">
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {v}
                    </Text>
                  </Tooltip>
                ),
              },
            ]}
          />
        )}

        {/* brief 一句话 */}
        <div style={{ paddingLeft: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            异动小结
          </Text>
          <Paragraph style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5, color: '#262626' }}>
            {data.brief}
          </Paragraph>
        </div>

        {/* 错误折叠成单 Alert (universe/quotes 失败) */}
        {data.status !== 'ok' && !timingError && (
          <Alert
            type={data.status === 'failed' ? 'error' : 'warning'}
            showIcon
            message={data.message}
            description={[universeError, quotesError].filter(Boolean).join(' / ') || undefined}
            style={{ marginBottom: 0 }}
          />
        )}
      </Space>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// MarketBriefCard (US-073) — 顶部 AI 大盘速读
// ---------------------------------------------------------------------------

/**
 * 「AI 大盘速读」开盘前一张卡片。
 *
 * 5 个数值 KPI + 1 句 AI 观点 ─ 全部数据由 GET /api/ai/market-brief/today 一次返回。
 * 后端 SchedulerService 每个交易日 08:30 cron 触发生成；首次访问 / cron miss
 * 时 controller 走 getTodayBrief 懒求值兜底。
 *
 * 状态语义：
 *   - ok            → 5 维齐全，淡蓝色 banner；
 *   - partial       → 部分维度缺失，黄色 banner；
 *   - failed        → 5 维全缺，红色 banner 但 AI heuristic 仍可显示「数据待补」。
 *
 * 容错：
 *   - getMarketBriefToday throw → 卡片内显示 Alert，刷新按钮重试，不影响下方信号面板；
 *   - components.<x>.error 单项失败 → KPI 渲染「—」，无 tooltip 噪音。
 */
const MarketBriefCard: React.FC = () => {
  const [brief, setBrief] = useState<MarketBriefResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtimeIndexes, setRealtimeIndexes] = useState<
    Array<{
      symbol: string;
      name: string;
      current: number;
      change_pct: number;
      change: number;
      open: number;
      high: number;
      low: number;
      prev_close: number;
      time: string;
    }>
  >([]);

  const loadBrief = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getMarketBriefToday({ refresh });
      setBrief(result);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBrief();
  }, [loadBrief]);

  // 实时拉 4 个主要指数。
  // 交易时段（周一-周五 9:25-15:05）每 15s 一次；非交易时段每 5min 一次（拿收盘价）。
  useEffect(() => {
    const isTradingHours = (): boolean => {
      const now = dayjs();
      const day = now.day(); // 0=Sun, 6=Sat
      if (day === 0 || day === 6) return false;
      const minutes = now.hour() * 60 + now.minute();
      // 9:25-11:35 或 12:55-15:05（盘前/盘后留几分钟买卖单结算）
      return (minutes >= 565 && minutes <= 695) || (minutes >= 775 && minutes <= 905);
    };

    const fetchRealtime = async () => {
      try {
        const resp = await api.get(
          '/market/realtime-indexes?symbols=sh.000300,sh.000001,sz.399001,sz.399006'
        );
        const arr = resp.data?.data?.indexes || [];
        if (arr.length > 0) {
          setRealtimeIndexes(
            arr.map((hs: any) => ({
              symbol: hs.symbol,
              name: hs.name,
              current: hs.current,
              change_pct: hs.change_pct,
              change: hs.change,
              open: hs.open,
              high: hs.high,
              low: hs.low,
              prev_close: hs.prev_close,
              time: hs.time,
            }))
          );
        }
      } catch {
        // 静默，保留上次数据
      }
    };

    void fetchRealtime();
    const interval = isTradingHours() ? 15_000 : 300_000; // 交易时段 15s / 非交易时段 5min
    const tm = setInterval(fetchRealtime, interval);
    return () => clearInterval(tm);
  }, []);

  const titleNode = (
    <Space size={8}>
      <BarChartOutlined style={{ color: '#722ed1' }} />
      <span>AI 大盘速读</span>
      {brief?.trade_date && <Tag color="blue">{brief.trade_date}</Tag>}
      {brief?.status === 'partial' && <Tag color="orange">部分数据待补</Tag>}
      {brief?.status === 'failed' && <Tag color="red">数据全缺</Tag>}
      {brief?.nlp_engine && (
        <Tag color={brief.nlp_engine === 'trading_agents' ? 'blue' : 'default'}>
          {brief.nlp_engine === 'trading_agents' ? 'TradingAgents' : '启发式兜底'}
        </Tag>
      )}
    </Space>
  );

  const extra = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={loading}
      onClick={() => void loadBrief(true)}
    >
      重新生成
    </Button>
  );

  if (loading && !brief) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin tip="加载 AI 大盘速读..." />
        </div>
      </Card>
    );
  }

  if (error && !brief) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Alert
          type="error"
          showIcon
          message="AI 大盘速读加载失败"
          description={error}
          action={
            <Button size="small" onClick={() => void loadBrief()}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  if (!brief) {
    return (
      <Card size="small" title={titleNode} extra={extra}>
        <Empty description="暂无数据" />
      </Card>
    );
  }

  const benchmark = brief.components?.benchmark;
  const northbound = brief.components?.northbound;
  const limitUp = brief.components?.limit_up;
  // US-043 / FE-004 AC: ≤ 150 字 — 后端已 hard-cap, 前端再加一层 hint 截断防御
  // (DB 历史脏数据 / 老缓存绕过后端 cap 时 UI 不会撑爆).
  const aiView = truncateAIView(brief.ai_view) || '今日观点暂无';

  return (
    <Card size="small" title={titleNode} extra={extra}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* 第一行：4 个指数实时报价 + AI 观点 */}
        <Row gutter={[12, 8]} align="middle">
          {realtimeIndexes.length > 0 ? (
            <>
              {realtimeIndexes.map(idx => (
                <Col xs={12} md={6} lg={4} key={idx.symbol}>
                  <Tooltip
                    title={
                      <>
                        <div>今开: {idx.open.toFixed(2)}</div>
                        <div>昨收: {idx.prev_close.toFixed(2)}</div>
                        <div>今高: {idx.high.toFixed(2)}</div>
                        <div>今低: {idx.low.toFixed(2)}</div>
                        <div>更新: {idx.time}</div>
                      </>
                    }
                  >
                    <Statistic
                      title={
                        <Space size={4}>
                          <span style={{ fontSize: 12 }}>{idx.name}</span>
                          <Tag
                            color="green"
                            style={{
                              marginLeft: 0,
                              fontSize: 12,
                              padding: '0 4px',
                              lineHeight: '14px',
                            }}
                          >
                            LIVE
                          </Tag>
                        </Space>
                      }
                      value={idx.current}
                      precision={2}
                      suffix={
                        <span
                          style={{
                            fontSize: 12,
                            marginLeft: 6,
                            color: idx.change_pct >= 0 ? '#dc2626' : '#16a34a',
                          }}
                        >
                          {idx.change_pct >= 0 ? '+' : ''}
                          {idx.change_pct.toFixed(2)}%
                        </span>
                      }
                      valueStyle={{
                        fontSize: 18,
                        fontWeight: 600,
                        color: idx.change_pct >= 0 ? '#dc2626' : '#16a34a',
                      }}
                    />
                  </Tooltip>
                </Col>
              ))}
              <Col xs={24} lg={8}>
                <div style={{ paddingLeft: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    AI 一句话观点
                  </Text>
                  <Paragraph
                    style={{
                      margin: '4px 0 0',
                      fontSize: 14,
                      lineHeight: 1.5,
                      color: '#262626',
                    }}
                  >
                    {aiView}
                  </Paragraph>
                </div>
              </Col>
            </>
          ) : (
            // 实时数据未拉到时的兜底：用 brief 静态数据
            <>
              <Col xs={12} md={8} lg={5}>
                <Statistic
                  title="上日收盘 (沪深300)"
                  value={brief.prev_close ?? '—'}
                  precision={brief.prev_close == null ? undefined : 2}
                  valueStyle={{ fontSize: 18 }}
                />
              </Col>
              <Col xs={12} md={8} lg={5}>
                <Tooltip title={benchmark?.error || ''}>
                  <Statistic
                    title={
                      brief.open_change_pct != null
                        ? `今日开盘 (${
                            brief.open_change_pct >= 0 ? '+' : ''
                          }${brief.open_change_pct.toFixed(2)}%)`
                        : '今日开盘'
                    }
                    value={brief.today_open ?? '—'}
                    precision={brief.today_open == null ? undefined : 2}
                    valueStyle={{
                      fontSize: 18,
                      color: openChangeColor(brief.open_change_pct),
                    }}
                  />
                </Tooltip>
              </Col>
              <Col xs={24} md={24} lg={14}>
                <div style={{ paddingLeft: 8 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    AI 一句话观点
                  </Text>
                  <Paragraph style={{ margin: '4px 0 0', fontSize: 14, lineHeight: 1.5 }}>
                    {aiView}
                  </Paragraph>
                </div>
              </Col>
            </>
          )}
        </Row>

        {/* 第二行：北向 + 涨停 (昨日静态数据) */}
        <Row gutter={[12, 8]} align="middle">
          <Col xs={12} md={8} lg={6}>
            <Tooltip title={northbound?.error || ''}>
              <Statistic
                title="昨日北向净买入"
                value={brief.northbound_net_amount ?? '—'}
                precision={brief.northbound_net_amount == null ? undefined : 2}
                suffix={brief.northbound_net_amount == null ? '' : ' 亿'}
                valueStyle={{
                  fontSize: 18,
                  color: northboundColor(brief.northbound_net_amount),
                }}
              />
            </Tooltip>
          </Col>
          <Col xs={12} md={8} lg={6}>
            <Tooltip title={limitUp?.error || ''}>
              <Statistic
                title="昨日涨停数"
                value={brief.limit_up_count ?? '—'}
                suffix={brief.limit_up_count == null ? '' : ' 家'}
                valueStyle={{
                  fontSize: 18,
                  color: limitUpColor(brief.limit_up_count),
                }}
              />
            </Tooltip>
          </Col>
        </Row>

        {brief.status !== 'ok' && (
          <Alert
            type={brief.status === 'failed' ? 'error' : 'warning'}
            showIcon
            message={brief.message}
            style={{ marginBottom: 0 }}
          />
        )}
      </Space>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// CA-1 CorePicksPanel — v3 抖音风核心推荐 (默认 tab)
// ---------------------------------------------------------------------------

/**
 * 「核心推荐」抖音风刷卡片 — 替代 v1 "今日信号" 作为默认登陆视角.
 *
 * 信息架构 (学习自抖音 / "炒股养家" 风格):
 *   1. 顶部漏斗条 — "今日筛选 {scanned} 只候选 / {candidate} 只达标 / 推荐 {selected} 只"
 *      让用户对 "为什么是这几只" 有量化感知, 不再是黑盒;
 *   2. 下方 5 张大卡 (lg 双列, xs 单列) — V3RecommendationCard 渲染.
 *
 * 数据流:
 *   - 数据由父组件 lazy-load 后通过 props 传入 (避免本组件持有 fetch 逻辑导致难测试);
 *   - 详情 modal trigger 走 props.onClickDetail, 父组件统一收口 modal state.
 *
 * 容错三态:
 *   - loading 无数据 → Spin
 *   - error → Alert + 重试
 *   - data 为空 (recommendations.length===0) → Empty 提示 cron pipeline 未跑
 */
const CorePicksPanel: React.FC<{
  data: V3RecommendationData | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onClickDetail: (item: V3RecommendationItem) => void;
}> = ({ data, loading, error, onReload, onClickDetail }) => {
  if (loading && !data) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载核心推荐..." />
        </div>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Card>
        <Alert
          type="warning"
          showIcon
          message="核心推荐加载失败"
          description={error}
          action={
            <Button size="small" onClick={onReload}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }
  const recommendations = data?.recommendations ?? [];
  const funnel = data?.funnel;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* 顶部漏斗条 — 学习自抖音「炒股养家」"信息密度集中 + 一目了然" 的展示风格. */}
      <Card size="small" data-testid="core-picks-funnel">
        <Row gutter={[16, 8]} align="middle">
          <Col xs={8}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>今日筛选</span>}
              value={funnel?.scanned ?? '—'}
              suffix={funnel?.scanned != null ? ' 只候选' : ''}
              valueStyle={{ fontSize: 18, color: '#1677ff' }}
            />
          </Col>
          <Col xs={8}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>达标</span>}
              value={funnel?.candidate ?? '—'}
              suffix={funnel?.candidate != null ? ' 只' : ''}
              valueStyle={{ fontSize: 18, color: '#722ed1' }}
            />
          </Col>
          <Col xs={8}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>核心推荐</span>}
              value={funnel?.selected ?? recommendations.length}
              suffix=" 只"
              valueStyle={{ fontSize: 18, color: '#dc2626', fontWeight: 700 }}
            />
          </Col>
        </Row>
        {funnel?.as_of && (
          <div style={{ marginTop: 4 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              as-of {funnel.as_of}
            </Text>
          </div>
        )}
      </Card>

      {recommendations.length === 0 ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space direction="vertical" size={4} align="center">
                <Text>今日尚无核心推荐</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  请确认 quant pipeline cron 已运行 (analysis_engine archive → AIInvestmentSignal);
                  或切换到「今日信号」tab 查看其它策略.
                </Text>
              </Space>
            }
          />
        </Card>
      ) : (
        <Row gutter={[16, 16]} data-testid="core-picks-grid">
          {recommendations.map(item => (
            <Col xs={24} lg={12} key={`${item.symbol}-${item.signal_id}`}>
              <V3RecommendationCard item={item} onClickDetail={onClickDetail} />
            </Col>
          ))}
        </Row>
      )}
    </Space>
  );
};

// ---------------------------------------------------------------------------
// SignalsPanel — 中部 3 列卡片 + 底部 2 列（事件 + 告警预览）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// TradingPlanCard (US-042 / FE-003) — 今日交易计划卡 (统一 BUY 清单)
// ---------------------------------------------------------------------------

/**
 * 「今日交易计划」把 3 个策略 (multi_factor / dragon_head / earnings_surprise)
 * 当日 BUY 信号合并 → 去重 → 优先级排序成一条统一的"今日可下单清单"。
 *
 * 设计:
 *   - 数据全部来自 props.data, 不发请求 — buildTradingPlan 是 pure helper, 同
 *     输入永远同输出 (便于 React render 一致性);
 *   - 同股多策略命中合并到一行, sources Tag 展示所有命中来源;
 *   - priority 排序: high (龙头 / 业绩 100%+) → medium (业绩 / mfa 强 alpha) →
 *     low (mfa 弱 alpha);
 *   - 跳转: 点击代码/名称 → /stock/{symbol}; AI 解读按钮 → AIStockAnalysisModal.
 *
 * 与下方 3 张策略卡的边界: 策略卡展示"为什么进选" (因子分 / 连板数 / 业绩增幅
 * 等策略私有信息), 本卡片是"今天我要买这些股" 的工作流入口 — 用户先看本卡决
 * 定下单清单, 不需要在 3 张卡之间来回切.
 */
const TradingPlanCard: React.FC<{ data: TodaySignalsData }> = ({ data }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);

  const rows = useMemo(() => buildTradingPlan(data), [data]);

  const counts = useMemo(() => {
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const r of rows) {
      if (r.priority === 'high') high += 1;
      else if (r.priority === 'medium') medium += 1;
      else low += 1;
    }
    return { total: rows.length, high, medium, low };
  }, [rows]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#722ed1' }} />
          <span>今日交易计划</span>
          <Tag color="blue">{counts.total} 只</Tag>
        </Space>
      }
      extra={
        <Space size={8}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            合并 3 策略 BUY 信号
          </Text>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={24} wrap>
          <Statistic
            title="强烈推荐"
            value={counts.high}
            valueStyle={{ color: '#dc2626', fontSize: 18 }}
          />
          <Statistic
            title="建议关注"
            value={counts.medium}
            valueStyle={{ color: '#1677ff', fontSize: 18 }}
          />
          <Statistic
            title="可选加仓"
            value={counts.low}
            valueStyle={{ color: '#999', fontSize: 18 }}
          />
        </Space>
        {rows.length === 0 ? (
          <Empty
            description="今日 3 策略均无 BUY 信号 (空仓观望)"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : isMobile ? (
          <div className="workspace-mobile-card-list">
            {rows.map(row => (
              <Card key={row.stock_code} size="small">
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Tag color={priorityTagColor(row.priority)}>{priorityLabel(row.priority)}</Tag>
                    <Text strong style={{ fontSize: 14 }}>
                      {row.name ?? row.stock_code}
                    </Text>
                    <Text code style={{ fontSize: 12 }}>
                      {row.stock_code}
                    </Text>
                    {row.industry && <Tag color="blue">{row.industry}</Tag>}
                  </Space>
                  <Space size={4} wrap>
                    {row.sources.map(s => (
                      <Tag key={s} color={planSourceTagColor(s)}>
                        {sourceLabel(s)}
                      </Tag>
                    ))}
                  </Space>
                  {row.reason && (
                    <Paragraph style={{ margin: '4px 0 0 0', fontSize: 12 }} type="secondary">
                      {row.reason}
                    </Paragraph>
                  )}
                  <div className="workspace-mobile-card-actions">
                    <Button
                      icon={<BarChartOutlined />}
                      onClick={() =>
                        setAiTarget({
                          symbol: row.stock_code,
                          name: row.name,
                        })
                      }
                    >
                      AI 解读
                    </Button>
                  </div>
                </Space>
              </Card>
            ))}
          </div>
        ) : (
          <Table<TradingPlanRow>
            size="small"
            rowKey="stock_code"
            dataSource={rows}
            pagination={false}
            scroll={{ x: 'max-content', y: 360 }}
            columns={[
              {
                title: '优先级',
                dataIndex: 'priority',
                width: 80,
                render: (v: TradingPlanPriority) => (
                  <Tag color={priorityTagColor(v)}>{priorityLabel(v)}</Tag>
                ),
                filters: [
                  { text: '强烈', value: 'high' },
                  { text: '建议', value: 'medium' },
                  { text: '可选', value: 'low' },
                ],
                onFilter: (val, row) => row.priority === val,
              },
              {
                title: '代码',
                dataIndex: 'stock_code',
                width: 92,
                render: (v: string) => (
                  <a onClick={() => navigate(`/stock/${v}`)}>
                    <Text code>{v}</Text>
                  </a>
                ),
              },
              {
                title: '名称',
                dataIndex: 'name',
                width: 110,
                ellipsis: true,
                render: (v: string | null, row: TradingPlanRow) =>
                  v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
              },
              {
                title: '行业',
                dataIndex: 'industry',
                width: 100,
                ellipsis: true,
                render: (v: string | null) => (v ? <Tag color="blue">{v}</Tag> : '—'),
              },
              {
                title: '来源策略',
                dataIndex: 'sources',
                width: 200,
                render: (sources: TradingPlanSource[]) => (
                  <Space size={4} wrap>
                    {sources.map(s => (
                      <Tag key={s} color={planSourceTagColor(s)}>
                        {sourceLabel(s)}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '理由',
                dataIndex: 'reason',
                ellipsis: { showTitle: false },
                render: (v: string) =>
                  v ? (
                    <Tooltip title={v} placement="topLeft">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {v}
                      </Text>
                    </Tooltip>
                  ) : (
                    <Text type="secondary">—</Text>
                  ),
              },
              {
                title: '参考价',
                dataIndex: 'reference_price',
                width: 80,
                align: 'right' as const,
                render: (v: number | null) =>
                  v != null && Number.isFinite(v) ? v.toFixed(2) : '—',
              },
              {
                title: '操作',
                key: 'actions',
                width: 110,
                fixed: 'right' as const,
                render: (_: unknown, row: TradingPlanRow) => (
                  <Space size={4}>
                    <Button
                      size="small"
                      type="link"
                      onClick={() => navigate(`/stock/${row.stock_code}`)}
                    >
                      详情
                    </Button>
                    <Button
                      size="small"
                      icon={<BarChartOutlined />}
                      onClick={() =>
                        setAiTarget({
                          symbol: row.stock_code,
                          name: row.name,
                        })
                      }
                    >
                      AI
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Space>
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="today_trading_plan"
        />
      )}
    </Card>
  );
};

/** US-042 source → Tag 颜色: 与策略卡 header 图标色一致, UI 跨卡片一眼对应 */
function planSourceTagColor(s: TradingPlanSource): string {
  if (s === 'dragon_head') return 'orange'; // 与 DragonHeadCard 同色
  if (s === 'earnings_surprise') return 'green'; // 与 EarningsSurpriseCard 同色
  return 'blue'; // multi_factor 与 MultiFactorCard 同色
}

// ---------------------------------------------------------------------------
// SellSuggestionCard (US-044 / FE-005) — 今日卖出建议卡
// ---------------------------------------------------------------------------

/**
 * 「今日卖出建议」把当前持仓 + 今日 3 策略 SELL 信号合并 → 去重 → 优先级排序成
 * 一条"今日可减仓清单"。
 *
 * 设计 (与 TradingPlanCard US-042 对偶):
 *   - 数据 = positions (PortfolioWithPositions.positions) + props.data (3 策略 sell);
 *   - 同股多 source 命中合并到一行, reason 取最严重 (止损 > 止盈 > 减持);
 *   - priority 排序: high (止损必卖, 红) → medium (止盈考虑, 绿) → low (减持, 橙);
 *   - 操作: 点击代码/名称 → /stock/{symbol}; 减仓按钮 → /workspace/portfolio (用户
 *     去当前持仓页用现有止损/止盈编辑或手动 SELL 下单, 本卡片只提示不撮合 —
 *     与 backend PerStockStopLossGuard / RebalanceEngine 真撮合路径解耦);
 *   - 默认阈值 -7% 止损 / +20% 止盈 与 backend PerStockStopLossGuard.DEFAULT
 *     对齐, 避免 UI 与后台行为不一致.
 *
 * 容错:
 *   - positions=null (加载失败) → 卡片显示 Alert "持仓加载失败, 卖出建议暂不可
 *     用", 不阻塞下方策略卡;
 *   - 持仓非空但无任何卖出触发 → Empty "今日无卖出建议 (持仓健康)".
 */
const SellSuggestionCard: React.FC<{
  data: TodaySignalsData;
  positions: PositionRow[] | null;
}> = ({ data, positions }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const rows = useMemo(() => buildSellSuggestions(positions, data), [positions, data]);

  const counts = useMemo(() => {
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const r of rows) {
      if (r.priority === 'high') high += 1;
      else if (r.priority === 'medium') medium += 1;
      else low += 1;
    }
    return { total: rows.length, high, medium, low };
  }, [rows]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <WarningOutlined style={{ color: '#dc2626' }} />
          <span>今日卖出建议</span>
          <Tag color="red">{counts.total} 只</Tag>
        </Space>
      }
      extra={
        <Space size={8}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            止损 / 止盈 / 减持
          </Text>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space size={24} wrap>
          <Statistic
            title="必卖止损"
            value={counts.high}
            valueStyle={{ color: '#dc2626', fontSize: 18 }}
          />
          <Statistic
            title="考虑止盈"
            value={counts.medium}
            valueStyle={{ color: '#16a34a', fontSize: 18 }}
          />
          <Statistic
            title="渐进减持"
            value={counts.low}
            valueStyle={{ color: '#fa8c16', fontSize: 18 }}
          />
        </Space>
        {positions == null ? (
          <Alert
            type="warning"
            showIcon
            message="持仓数据加载失败"
            description="卖出建议依赖当前持仓 + 实时价, 请稍后刷新页面重试。"
          />
        ) : rows.length === 0 ? (
          <Empty
            description="今日无卖出建议 (持仓健康, 无止损/止盈/减持触发)"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : isMobile ? (
          <div className="workspace-mobile-card-list">
            {rows.map(row => (
              <Card key={row.stock_code} size="small">
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={8} wrap>
                    <Tag color={sellPriorityTagColor(row.priority)}>
                      {sellPriorityLabel(row.priority)}
                    </Tag>
                    <Tag color={reasonTagColor(row.reason)}>{reasonLabel(row.reason)}</Tag>
                    <Text strong style={{ fontSize: 14 }}>
                      {row.name ?? row.stock_code}
                    </Text>
                    <Text code style={{ fontSize: 12 }}>
                      {row.stock_code}
                    </Text>
                  </Space>
                  <Space size={4} wrap>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      持仓 {row.quantity} 股
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      浮动{' '}
                      <span style={{ color: pnlColor(row.unrealized_pnl) }}>
                        {row.unrealized_pnl_pct != null
                          ? `${(row.unrealized_pnl_pct * 100).toFixed(1)}%`
                          : '—'}
                      </span>
                    </Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      建议卖 {Math.round(row.suggested_sell_ratio * 100)}%
                    </Text>
                  </Space>
                  {row.reason_text && (
                    <Paragraph style={{ margin: '4px 0 0 0', fontSize: 12 }} type="secondary">
                      {row.reason_text}
                    </Paragraph>
                  )}
                  <div className="workspace-mobile-card-actions">
                    <Button
                      size="small"
                      type="primary"
                      danger
                      onClick={() => navigate('/workspace/portfolio')}
                    >
                      去减仓
                    </Button>
                  </div>
                </Space>
              </Card>
            ))}
          </div>
        ) : (
          <Table<SellSuggestionRow>
            size="small"
            rowKey="stock_code"
            dataSource={rows}
            pagination={false}
            scroll={{ x: 'max-content', y: 360 }}
            columns={[
              {
                title: '优先级',
                dataIndex: 'priority',
                width: 80,
                render: (v: SellSuggestionPriority) => (
                  <Tag color={sellPriorityTagColor(v)}>{sellPriorityLabel(v)}</Tag>
                ),
                filters: [
                  { text: '必卖', value: 'high' },
                  { text: '考虑', value: 'medium' },
                  { text: '减持', value: 'low' },
                ],
                onFilter: (val, row) => row.priority === val,
              },
              {
                title: '原因',
                dataIndex: 'reason',
                width: 70,
                render: (v: SellSuggestionRow['reason']) => (
                  <Tag color={reasonTagColor(v)}>{reasonLabel(v)}</Tag>
                ),
              },
              {
                title: '代码',
                dataIndex: 'stock_code',
                width: 92,
                render: (v: string) => (
                  <a onClick={() => navigate(`/stock/${v}`)}>
                    <Text code>{v}</Text>
                  </a>
                ),
              },
              {
                title: '名称',
                dataIndex: 'name',
                width: 110,
                ellipsis: true,
                render: (v: string | null, row: SellSuggestionRow) =>
                  v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
              },
              {
                title: '持仓',
                dataIndex: 'quantity',
                width: 80,
                align: 'right' as const,
                render: (v: number) => `${v} 股`,
              },
              {
                title: '成本/现价',
                key: 'price',
                width: 110,
                align: 'right' as const,
                render: (_: unknown, row: SellSuggestionRow) =>
                  `${row.avg_cost.toFixed(2)} / ${row.current_price.toFixed(2)}`,
              },
              {
                title: '浮动',
                dataIndex: 'unrealized_pnl_pct',
                width: 90,
                align: 'right' as const,
                sorter: (a, b) => (a.unrealized_pnl_pct ?? 0) - (b.unrealized_pnl_pct ?? 0),
                render: (v: number | null, row: SellSuggestionRow) => (
                  <span style={{ color: pnlColor(row.unrealized_pnl) }}>
                    {v != null && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : '—'}
                  </span>
                ),
              },
              {
                title: '来源',
                dataIndex: 'sources',
                width: 200,
                render: (sources: SellSuggestionSource[]) => (
                  <Space size={4} wrap>
                    {sources.map(s => (
                      <Tag key={s}>{sellSourceLabel(s)}</Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '理由',
                dataIndex: 'reason_text',
                ellipsis: { showTitle: false },
                render: (v: string) =>
                  v ? (
                    <Tooltip title={v} placement="topLeft">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {v}
                      </Text>
                    </Tooltip>
                  ) : (
                    <Text type="secondary">—</Text>
                  ),
              },
              {
                title: '建议卖出',
                dataIndex: 'suggested_sell_ratio',
                width: 90,
                align: 'right' as const,
                render: (v: number) => `${Math.round(v * 100)}%`,
              },
              {
                title: '操作',
                key: 'actions',
                width: 90,
                fixed: 'right' as const,
                render: (_: unknown, _row: SellSuggestionRow) => (
                  <Button
                    size="small"
                    type="link"
                    danger
                    onClick={() => navigate('/workspace/portfolio')}
                  >
                    去减仓
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Space>
    </Card>
  );
};

const SignalsPanel: React.FC<{ data: TodaySignalsData; positions: PositionRow[] | null }> = ({
  data,
  positions,
}) => {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <TradingPlanCard data={data} />
      <SellSuggestionCard data={data} positions={positions} />
      <Row gutter={[16, 16]}>
        <Col xs={24}>
          <MultiFactorCard
            tradeDate={data.multi_factor.trade_date}
            signals={data.multi_factor.signals}
            newPicks={data.multi_factor.new_picks}
            drops={data.multi_factor.drops}
            keeps={data.multi_factor.keeps}
            error={data.multi_factor.error}
          />
        </Col>
        <Col xs={24} lg={12}>
          <DragonHeadCard
            tradeDate={data.dragon_head.trade_date}
            candidates={data.dragon_head.candidates}
            eligibleCount={data.dragon_head.eligible_count}
            limitUpPoolSize={data.dragon_head.limit_up_pool_size}
            marketSentimentValue={data.dragon_head.market_sentiment_value}
            marketSentimentBlocked={data.dragon_head.market_sentiment_blocked}
            filterStats={data.dragon_head.filter_stats}
            error={data.dragon_head.error}
          />
        </Col>
        <Col xs={24} lg={12}>
          <EarningsSurpriseCard
            tradeDate={data.earnings_surprise.trade_date}
            candidates={data.earnings_surprise.candidates}
            forecastPoolSize={data.earnings_surprise.forecast_pool_size}
            eligibleCount={data.earnings_surprise.eligible_count}
            error={data.earnings_surprise.error}
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <FireOutlined style={{ color: '#fa541c' }} />
                <span>今日关键事件</span>
                <Tag color="orange">{data.key_events.length}</Tag>
              </Space>
            }
          >
            <KeyEventsList events={data.key_events.slice(0, 8)} compact />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            size="small"
            title={
              <Space>
                <AlertOutlined style={{ color: '#dc2626' }} />
                <span>风险告警 · 未读</span>
                <Tag color="red">{data.unread_alert_count}</Tag>
              </Space>
            }
          >
            <RiskAlertsList alerts={data.unread_alerts.slice(0, 8)} compact />
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

// ---------------------------------------------------------------------------
// 3 个策略卡片
// ---------------------------------------------------------------------------

const MultiFactorCard: React.FC<{
  tradeDate: string | null;
  signals: MultiFactorAlphaSignal[];
  newPicks: number;
  drops: number;
  keeps: number;
  error?: string;
}> = ({ tradeDate, signals, newPicks, drops, keeps, error }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);
  const buys = signals.filter(s => s.signal === 'buy').slice(0, 30);
  const sells = signals.filter(s => s.signal === 'sell').slice(0, 10);
  return (
    <Card
      size="small"
      title={
        <Space>
          <FundOutlined style={{ color: '#1677ff' }} />
          <span>多因子 Alpha 调仓</span>
          {tradeDate && <Tag color="blue">{tradeDate}</Tag>}
        </Space>
      }
    >
      {error ? (
        <Alert type="warning" message={error} showIcon />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic
              title="新进入选"
              value={newPicks}
              valueStyle={{ color: '#dc2626', fontSize: 18 }}
            />
            <Statistic title="保留" value={keeps} valueStyle={{ color: '#1677ff', fontSize: 18 }} />
            <Statistic title="剔除" value={drops} valueStyle={{ color: '#999', fontSize: 18 }} />
          </Space>
          {buys.length > 0 && (
            <>
              <Text strong style={{ fontSize: 12 }}>
                新进入选 (top {buys.length})
              </Text>
              {isMobile ? (
                <div className="workspace-mobile-card-list">
                  {buys.map(row => (
                    <Card key={row.stock_code} size="small">
                      <Space direction="vertical" size={2} style={{ width: '100%' }}>
                        <Space size={8}>
                          <Text strong style={{ fontSize: 14 }}>
                            {row.name ?? row.stock_code}
                          </Text>
                          <Text code style={{ fontSize: 12 }}>
                            {row.stock_code}
                          </Text>
                          {row.industry && <Tag color="blue">{row.industry}</Tag>}
                        </Space>
                        <div className="workspace-mobile-card-row">
                          <span className="label">总分</span>
                          <span className="value">
                            <Text strong>{row.composite_score?.toFixed(2)}</Text>
                          </span>
                        </div>
                        <div className="workspace-mobile-card-actions">
                          <Button
                            icon={<BarChartOutlined />}
                            onClick={() =>
                              setAiTarget({
                                symbol: row.stock_code,
                                name: row.name || null,
                              })
                            }
                          >
                            AI 解读
                          </Button>
                        </div>
                      </Space>
                    </Card>
                  ))}
                </div>
              ) : (
                <Table
                  size="small"
                  rowKey="stock_code"
                  dataSource={buys}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  columns={[
                    {
                      title: '代码',
                      dataIndex: 'stock_code',
                      width: 92,
                      render: (v: string) => (
                        <a onClick={() => navigate(`/stock/${v}`)}>
                          <Text code>{v}</Text>
                        </a>
                      ),
                    },
                    {
                      title: '名称',
                      dataIndex: 'name',
                      width: 110,
                      render: (v: string | null | undefined, row: MultiFactorAlphaSignal) =>
                        v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
                    },
                    {
                      title: '行业',
                      dataIndex: 'industry',
                      width: 110,
                      render: (v: string | null | undefined) =>
                        v ? <Tag color="blue">{v}</Tag> : '—',
                    },
                    {
                      title: '综合分',
                      dataIndex: 'composite_score',
                      width: 78,
                      align: 'right' as const,
                      sorter: (a: MultiFactorAlphaSignal, b: MultiFactorAlphaSignal) =>
                        (a.composite_score ?? 0) - (b.composite_score ?? 0),
                      render: (v: number) => (
                        <Text strong style={{ color: '#dc2626' }}>
                          {v?.toFixed(3)}
                        </Text>
                      ),
                    },
                    {
                      title: '主要因子',
                      key: 'top_factors',
                      width: 220,
                      render: (_: unknown, row: MultiFactorAlphaSignal) => {
                        const zs = row.factor_z_scores || {};
                        const sorted = Object.entries(zs)
                          .filter(([_k, v]) => typeof v === 'number' && Math.abs(v as number) > 0.5)
                          .sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number))
                          .slice(0, 3);
                        if (!sorted.length) return <Text type="secondary">—</Text>;
                        return (
                          <Space size={4} wrap>
                            {sorted.map(([k, v]) => (
                              <Tag key={k} color={(v as number) > 0 ? 'red' : 'green'}>
                                {k}: {(v as number).toFixed(2)}
                              </Tag>
                            ))}
                          </Space>
                        );
                      },
                    },
                    {
                      title: '操作',
                      key: 'actions',
                      width: 160,
                      fixed: 'right' as const,
                      render: (_: unknown, row: MultiFactorAlphaSignal) => (
                        <Space size={4}>
                          <Button
                            size="small"
                            type="link"
                            onClick={() => navigate(`/stock/${row.stock_code}`)}
                          >
                            趋势
                          </Button>
                          <Button
                            size="small"
                            icon={<BarChartOutlined />}
                            onClick={() =>
                              setAiTarget({
                                symbol: row.stock_code,
                                name: row.name || null,
                              })
                            }
                          >
                            AI
                          </Button>
                        </Space>
                      ),
                    },
                  ]}
                />
              )}
            </>
          )}
          {sells.length > 0 && (
            <>
              <Text strong style={{ fontSize: 12 }}>
                剔除 ({drops} 只，展示前 {sells.length} 只)
              </Text>
              <List
                size="small"
                dataSource={sells}
                renderItem={item => (
                  <List.Item style={{ padding: '4px 0' }}>
                    <Space>
                      <Text code>{item.stock_code}</Text>
                      <Text type="secondary">{item.name || '—'}</Text>
                    </Space>
                  </List.Item>
                )}
              />
            </>
          )}
          {buys.length === 0 && sells.length === 0 && (
            <Empty description="今日无调仓变动" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Space>
      )}
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="today_multifactor_pick"
        />
      )}
    </Card>
  );
};

const DragonHeadCard: React.FC<{
  tradeDate: string | null;
  candidates: DragonHeadSignal[];
  eligibleCount: number;
  limitUpPoolSize?: number;
  marketSentimentValue?: number | null;
  marketSentimentBlocked?: boolean;
  filterStats?: Record<string, number>;
  error?: string;
}> = ({
  tradeDate,
  candidates,
  eligibleCount,
  limitUpPoolSize,
  marketSentimentValue,
  marketSentimentBlocked,
  filterStats,
  error,
}) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  // 自动诊断 0 候选原因
  const diagnosisReason = useMemo(() => {
    if (candidates.length > 0) return null;
    if (marketSentimentBlocked) {
      return `市场情绪指数 ${marketSentimentValue?.toFixed(
        1
      )} 低于阈值，已暂停新开仓。已有持仓正常出场。`;
    }
    if (limitUpPoolSize === 0) {
      return `当日无涨停股。等待今日盘后龙虎榜 + 涨停板数据同步。`;
    }
    if (filterStats) {
      const topFail = Object.entries(filterStats)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])[0];
      if (topFail) {
        const labelMap: Record<string, string> = {
          fail_industry_top: '行业不在 top10',
          fail_industry_unknown: '股票行业未知',
          fail_continuous_days: '连板数超范围',
          fail_meta_missing: '缺市值数据',
          fail_market_cap: '市值不在 30-200 亿',
          fail_famous_yz: '无游资席位净流入',
          one_word_board: '一字板（无法参与）',
          sentiment_blocked: '市场情绪低被阻塞',
        };
        return `涨停池 ${limitUpPoolSize} 股，全部被过滤。主要原因: ${
          labelMap[topFail[0]] || topFail[0]
        }（${topFail[1]} 只）`;
      }
    }
    return null;
  }, [
    candidates.length,
    limitUpPoolSize,
    marketSentimentBlocked,
    marketSentimentValue,
    filterStats,
  ]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <RiseOutlined style={{ color: '#fa541c' }} />
          <span>短线龙头候选</span>
          {tradeDate && <Tag color="orange">{tradeDate}</Tag>}
          {marketSentimentValue != null && (
            <Tooltip title={`市场情绪 ${marketSentimentValue.toFixed(1)} / 阈值 30`}>
              <Tag color={marketSentimentBlocked ? 'red' : 'green'}>
                情绪 {marketSentimentValue.toFixed(1)}
              </Tag>
            </Tooltip>
          )}
        </Space>
      }
    >
      {error ? (
        <Alert type="warning" message={error} showIcon />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic
              title="今日 BUY"
              value={candidates.length}
              valueStyle={{ color: '#dc2626', fontSize: 18 }}
            />
            <Statistic
              title="涨停池"
              value={limitUpPoolSize ?? 0}
              suffix="只"
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
            <Statistic
              title="通过 5 维"
              value={eligibleCount}
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
          </Space>
          {diagnosisReason && (
            <Alert
              type={marketSentimentBlocked ? 'info' : 'warning'}
              message={diagnosisReason}
              showIcon
              style={{ fontSize: 12 }}
            />
          )}
          {candidates.length === 0 ? (
            <Empty description="今日无符合条件的龙头候选" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : isMobile ? (
            <div className="workspace-mobile-card-list">
              {candidates.map(row => (
                <Card key={row.stock_code} size="small">
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={8}>
                      <Text strong style={{ fontSize: 14 }}>
                        {row.name ?? row.stock_code}
                      </Text>
                      <Text code style={{ fontSize: 12 }}>
                        {row.stock_code}
                      </Text>
                      {row.continuous_days != null && (
                        <Tag color="red">{row.continuous_days}板</Tag>
                      )}
                      {row.industry && <Tag color="blue">{row.industry}</Tag>}
                    </Space>
                    {row.reason && (
                      <Paragraph style={{ margin: '4px 0 0 0', fontSize: 12 }} type="secondary">
                        {row.reason}
                      </Paragraph>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
          ) : (
            <Table
              size="small"
              rowKey="stock_code"
              dataSource={candidates}
              pagination={false}
              columns={[
                {
                  title: '代码',
                  dataIndex: 'stock_code',
                  width: 90,
                  render: (v: string) => (
                    <a onClick={() => navigate(`/stock/${v}`)}>
                      <Text code>{v}</Text>
                    </a>
                  ),
                },
                {
                  title: '名称',
                  dataIndex: 'name',
                  width: 110,
                  ellipsis: true,
                  render: (v: string | null | undefined, row: any) =>
                    v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
                },
                {
                  title: '连板',
                  dataIndex: 'continuous_days',
                  width: 56,
                  align: 'right' as const,
                  render: (v: number | undefined) =>
                    v != null ? <Tag color="red">{v}板</Tag> : '—',
                },
                {
                  title: '行业',
                  dataIndex: 'industry',
                  width: 80,
                  ellipsis: true,
                  render: (v: string | null | undefined) => (v ? <Tag color="blue">{v}</Tag> : '—'),
                },
              ]}
              expandable={{
                expandedRowRender: (row: DragonHeadSignal) => (
                  <Paragraph style={{ margin: 0, fontSize: 12 }} type="secondary">
                    {row.reason}
                  </Paragraph>
                ),
                rowExpandable: (row: DragonHeadSignal) => !!row.reason,
              }}
            />
          )}
        </Space>
      )}
    </Card>
  );
};

const EarningsSurpriseCard: React.FC<{
  tradeDate: string | null;
  candidates: EarningsSurpriseSignal[];
  forecastPoolSize: number;
  eligibleCount: number;
  error?: string;
}> = ({ tradeDate, candidates, forecastPoolSize, eligibleCount, error }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  return (
    <Card
      size="small"
      title={
        <Space>
          <ThunderboltOutlined style={{ color: '#16a34a' }} />
          <span>业绩超预期入选</span>
          {tradeDate && <Tag color="green">{tradeDate}</Tag>}
        </Space>
      }
    >
      {error ? (
        <Alert type="warning" message={error} showIcon />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic
              title="今日 BUY"
              value={candidates.length}
              valueStyle={{ color: '#dc2626', fontSize: 18 }}
            />
            <Statistic
              title="当日公告"
              value={forecastPoolSize}
              valueStyle={{ color: '#999', fontSize: 18 }}
            />
            <Statistic
              title="双确认通过"
              value={eligibleCount}
              valueStyle={{ color: '#1677ff', fontSize: 18 }}
            />
          </Space>
          {candidates.length === 0 ? (
            <Empty
              description="今日无通过双确认的业绩超预期入选"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : isMobile ? (
            <div className="workspace-mobile-card-list">
              {candidates.map(row => (
                <Card key={row.stock_code} size="small">
                  <Space direction="vertical" size={2} style={{ width: '100%' }}>
                    <Space size={8}>
                      <Text strong style={{ fontSize: 14 }}>
                        {row.name ?? row.stock_code}
                      </Text>
                      <Text code style={{ fontSize: 12 }}>
                        {row.stock_code}
                      </Text>
                      {row.profit_change_low != null && (
                        <Tag color="red">{`${Math.round(row.profit_change_low)}%+`}</Tag>
                      )}
                      {row.forecast_type && <Tag color="green">{row.forecast_type}</Tag>}
                    </Space>
                    {row.reason && (
                      <Paragraph style={{ margin: '4px 0 0 0', fontSize: 12 }} type="secondary">
                        {row.reason}
                      </Paragraph>
                    )}
                  </Space>
                </Card>
              ))}
            </div>
          ) : (
            <Table
              size="small"
              rowKey="stock_code"
              dataSource={candidates}
              pagination={false}
              columns={[
                {
                  title: '代码',
                  dataIndex: 'stock_code',
                  width: 90,
                  render: (v: string) => (
                    <a onClick={() => navigate(`/stock/${v}`)}>
                      <Text code>{v}</Text>
                    </a>
                  ),
                },
                {
                  title: '名称',
                  dataIndex: 'name',
                  width: 110,
                  ellipsis: true,
                  render: (v: string | null | undefined, row: any) =>
                    v ? <a onClick={() => navigate(`/stock/${row.stock_code}`)}>{v}</a> : '—',
                },
                {
                  title: '预告',
                  dataIndex: 'forecast_type',
                  width: 60,
                  render: (v: string | null | undefined) => v ?? '—',
                },
                {
                  title: '增幅',
                  dataIndex: 'profit_change_low',
                  width: 70,
                  align: 'right' as const,
                  render: (v: number | null | undefined) =>
                    v != null ? <Tag color="red">{`${Math.round(v)}%+`}</Tag> : '—',
                },
              ]}
              expandable={{
                expandedRowRender: (row: EarningsSurpriseSignal) => (
                  <Paragraph style={{ margin: 0, fontSize: 12 }} type="secondary">
                    {row.reason}
                  </Paragraph>
                ),
                rowExpandable: (row: EarningsSurpriseSignal) => !!row.reason,
              }}
            />
          )}
        </Space>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// 关键事件 + 风险告警 panel/list
// ---------------------------------------------------------------------------

const EventsPanel: React.FC<{ events: KeyEventItem[]; tradeDate: string | null }> = ({
  events,
  tradeDate,
}) => {
  return (
    <Card
      size="small"
      title={
        <Space>
          <FireOutlined style={{ color: '#fa541c' }} />
          <span>今日关键事件{tradeDate ? ` · ${tradeDate}` : ''}</span>
        </Space>
      }
      extra={<Tag color="orange">{events.length}</Tag>}
    >
      <KeyEventsList events={events} />
    </Card>
  );
};

const KeyEventsList: React.FC<{ events: KeyEventItem[]; compact?: boolean }> = ({
  events,
  compact = false,
}) => {
  if (events.length === 0) {
    return <Empty description="今日无关键事件" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <List
      size={compact ? 'small' : 'default'}
      dataSource={events}
      renderItem={item => (
        <List.Item style={{ padding: compact ? '6px 0' : '10px 0' }}>
          <Space align="start" style={{ width: '100%' }}>
            {eventTypeIcon(item.event_type)}
            <div style={{ flex: 1 }}>
              <Space>
                <Text code>{item.stock_code}</Text>
                <Text strong>{item.stock_name ?? '—'}</Text>
                {eventTypeTag(item.event_type)}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {item.summary}
                </Text>
              </div>
            </div>
          </Space>
        </List.Item>
      )}
    />
  );
};

/**
 * AlertsPanel — "今日作战" 风险提醒 tab 的核心面板.
 *
 * 历史 (US-018 → US-071 → US-072):
 *   - US-018: 仅 RiskAlertsList 无过滤
 *   - US-071: 4 个 category KPI Tag + level/category/search 过滤 + reset
 *   - US-072: 每条 AlertItem 加 snooze 1h/1d/1w + 一键执行 (Dropdown + Button)
 *
 * 与 RiskAlertCenterPanel (risk_center sub-tab) 的边界 — 见
 * [[alertsPanelHelpers]] 顶部 jsdoc. 简言之: 本组件消费 /api/today/signals
 * 返的 unread_alerts (cap=20) 做就地过滤 + snooze, 不再次访问 backend; 重操作走
 * "风控中心" tab. data-testid 让 webapp-testing skill 可验收.
 *
 * Snooze 持久化 = localStorage (单设备), 与 [[alertItemActionHelpers]] 顶部
 * jsdoc 同款 trade-off. 一键执行根据 derived_category 派发到不同路由 — 详见
 * [[buildAlertActionDescriptor]].
 */
const AlertsPanel: React.FC<{ alerts: UnreadRiskAlertItem[]; totalCount: number }> = ({
  alerts,
  totalCount,
}) => {
  const navigate = useNavigate();
  const [filterState, setFilterState] = useState<AlertsPanelFilterState>(() =>
    emptyAlertsPanelFilterState()
  );
  // snoozeMap 初始化时顺手 prune 一次, 不让 localStorage 无限膨胀.
  // 与 [[pruneExpiredSnoozes]] jsdoc 推荐的"挂载先 prune" 一致.
  const [snoozeMap, setSnoozeMap] = useState<SnoozeMap>(() => {
    const raw = readSnoozeMap();
    const pruned = pruneExpiredSnoozes(raw, Date.now());
    if (Object.keys(pruned).length !== Object.keys(raw).length) {
      writeSnoozeMap(pruned);
    }
    return pruned;
  });
  // 每 60s tick 强制重渲 — 让 "snooze 剩余时间" Tag 和 "已过期自动恢复"
  // 不依赖外部事件. 与 AlertsBell 60s 轮询同步, 视觉一致.
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => forceTick(x => x + 1), 60 * 1000);
    return () => window.clearInterval(t);
  }, []);

  // enrich 一次, 过滤 / 排序 / 分类 全消费 EnrichedAlert (避免重复 derive).
  const enriched = useMemo(() => enrichAlerts(alerts), [alerts]);
  // snooze 过滤要走在 category KPI 之前, 让 KPI bar 也不计入 snoozed alerts —
  // 与 PRD 验收"snooze 后该 alert 在 panel 消失" 同语义.
  const visibleAfterSnooze = useMemo(
    () => filterOutSnoozedAlerts(enriched, snoozeMap, Date.now()),
    // snoozeMap 变化 (snooze / 取消) 立即重新过滤; enriched 是上一层 alerts 派生.
    // 故意不把 Date.now() 加进 deps — 60s tick 已经 forceTick 触发重渲.
    [enriched, snoozeMap]
  );
  const categorySummary = useMemo(
    () => summarizeAlertsByCategory(visibleAfterSnooze),
    [visibleAfterSnooze]
  );
  const visibleAlerts = useMemo(
    () => sortAlertsBySeverityThenTime(filterAlerts(visibleAfterSnooze, filterState)),
    [visibleAfterSnooze, filterState]
  );
  const hasFilter = hasActiveFilter(filterState);
  const snoozedCount = useMemo(
    () => Math.max(0, enriched.length - visibleAfterSnooze.length),
    [enriched.length, visibleAfterSnooze.length]
  );

  // ------- snooze action handlers -------

  /**
   * 执行 snooze — 更新 state + 持久化 + toast 反馈. 失败 (quota / private mode)
   * fail-OPEN 不抛, 仅 toast.warning.
   */
  const handleSnooze = useCallback((alertId: number, duration: SnoozeDuration) => {
    setSnoozeMap(prev => {
      const next = addSnooze(prev, alertId, duration, Date.now());
      const ok = writeSnoozeMap(next);
      if (!ok) {
        message.warning('静音状态未能持久化 (浏览器存储不可用), 仅当前会话生效');
      } else {
        message.success(`已${SNOOZE_DURATION_LABEL[duration]}`);
      }
      return next;
    });
  }, []);

  /** 取消 snooze (用户主动撤回). */
  const handleUnsnooze = useCallback((alertId: number) => {
    setSnoozeMap(prev => {
      const next = removeSnooze(prev, alertId);
      writeSnoozeMap(next);
      return next;
    });
    message.success('已恢复显示');
  }, []);

  /**
   * 一键执行 — 根据 derived_category 跳路由, 可选自动 mark-read.
   *
   * mark-read 失败不阻塞跳转 (fail-OPEN); 失败仅 console, 不弹 toast 干扰用户.
   */
  const handleExecuteAction = useCallback(
    (
      enrichedItem: { id: number } & {
        derived_category: DerivedAlertCategory;
        symbol: string;
      }
    ) => {
      const action = buildAlertActionDescriptor(enrichedItem as never);
      if (action.markReadOnAction) {
        markSingleRiskAlertRead(enrichedItem.id).catch(err => {
          // 与 alertsBell fail-OPEN 思想一致: mark-read 失败仅日志.
          // eslint-disable-next-line no-console
          console.warn('[AlertsPanel] markSingleRiskAlertRead failed', err);
        });
      }
      navigate(action.href);
    },
    [navigate]
  );

  return (
    <Card
      size="small"
      data-testid="alerts-panel"
      title={
        <Space wrap>
          <AlertOutlined style={{ color: '#dc2626' }} />
          <span>风险告警未读列表</span>
          <Tag color="red">{totalCount}</Tag>
          {hasFilter && (
            <Tag color="blue" data-testid="alerts-panel-filtered-count">
              过滤后 {visibleAlerts.length}
            </Tag>
          )}
          {snoozedCount > 0 && (
            <Tag color="blue" data-testid="alerts-panel-snoozed-count">
              已静音 {snoozedCount}
            </Tag>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* category KPI bar */}
        <Row gutter={[8, 8]} data-testid="alerts-panel-category-kpi">
          {categorySummary.map(c => (
            <Col key={c.category} xs={12} sm={6}>
              <Card
                size="small"
                hoverable
                data-testid={`alerts-panel-category-${c.category}`}
                style={{
                  borderColor: filterState.category === c.category ? '#1677ff' : undefined,
                  background:
                    filterState.category === c.category ? 'rgba(22,119,255,0.04)' : undefined,
                }}
                onClick={() => {
                  // 单击 KPI 卡 toggle 该 category 过滤; 再次点击同 category 清除.
                  setFilterState(s => ({
                    ...s,
                    category: s.category === c.category ? undefined : c.category,
                  }));
                }}
              >
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={4}>
                    <Tag color={DERIVED_CATEGORY_TAG_COLOR[c.category]}>{c.label}</Tag>
                    <Text strong style={{ fontSize: 18 }}>
                      {c.total}
                    </Text>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    高 {c.high} · 中 {c.medium} · 低 {c.low}
                  </Text>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>

        {/* 过滤栏 */}
        <Row gutter={[8, 8]} align="middle" data-testid="alerts-panel-filters">
          <Col xs={12} md={6}>
            <Select<AlertLevel>
              placeholder="级别"
              allowClear
              style={{ width: '100%' }}
              value={filterState.level}
              onChange={v => setFilterState(s => ({ ...s, level: v }))}
              options={[
                { label: '高 (HIGH)', value: 'HIGH' },
                { label: '中 (MEDIUM)', value: 'MEDIUM' },
                { label: '低 (LOW)', value: 'LOW' },
              ]}
              data-testid="alerts-panel-filter-level"
            />
          </Col>
          <Col xs={12} md={6}>
            <Select<DerivedAlertCategory>
              placeholder="分类"
              allowClear
              style={{ width: '100%' }}
              value={filterState.category}
              onChange={v => setFilterState(s => ({ ...s, category: v }))}
              options={[
                { label: '持仓', value: 'position' },
                { label: '市场', value: 'market' },
                { label: '单股', value: 'individual' },
                { label: '数据', value: 'data' },
              ]}
              data-testid="alerts-panel-filter-category"
            />
          </Col>
          <Col xs={24} md={9}>
            <Input.Search
              placeholder="代码 / 名称 / 内容 关键词搜索"
              allowClear
              value={filterState.search ?? ''}
              onChange={e => setFilterState(s => ({ ...s, search: e.target.value }))}
              onSearch={v => setFilterState(s => ({ ...s, search: v }))}
              data-testid="alerts-panel-filter-search"
            />
          </Col>
          <Col xs={24} md={3}>
            <Button
              size="small"
              disabled={!hasFilter}
              onClick={() => setFilterState(emptyAlertsPanelFilterState())}
              data-testid="alerts-panel-reset-filter"
              block
            >
              重置
            </Button>
          </Col>
        </Row>

        {/* 列表 */}
        {visibleAlerts.length === 0 ? (
          <Empty
            description={hasFilter ? '无符合条件的告警' : '暂无未读风险告警'}
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <List
            size="default"
            dataSource={visibleAlerts}
            data-testid="alerts-panel-list"
            renderItem={item => {
              const action = buildAlertActionDescriptor(item);
              // 注意: visibleAlerts 已经 filterOutSnoozedAlerts, 渲染到的 item
              // 此刻必然 NOT snoozed (snoozeMap[item.id] 要么不存在要么已过期).
              // snooze 状态 Tag 仅在 toolbar 用 snoozedCount 显示, 单条 item 不必再画.
              const snoozeMenuItems = SNOOZE_DURATION_ORDER.map(d => ({
                key: d,
                label: SNOOZE_DURATION_LABEL[d],
                onClick: () => handleSnooze(item.id, d),
              }));
              return (
                <List.Item
                  style={{ padding: '10px 0' }}
                  data-testid={`alerts-panel-item-${item.id}`}
                >
                  <Space align="start" style={{ width: '100%' }}>
                    {levelIcon(item.derived_level)}
                    <div style={{ flex: 1 }}>
                      <Space size={6} wrap>
                        <Text code>{item.symbol}</Text>
                        <Text strong>{item.name || '—'}</Text>
                        {levelTag(item.derived_level)}
                        <Tag color={DERIVED_CATEGORY_TAG_COLOR[item.derived_category]}>
                          {DERIVED_CATEGORY_LABEL[item.derived_category]}
                        </Tag>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {dayjs(item.created_at).format('MM-DD HH:mm')}
                        </Text>
                      </Space>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {item.message}
                        </Text>
                      </div>
                    </div>
                    <Space size={4} direction="vertical" align="end">
                      <Button
                        size="small"
                        type="primary"
                        icon={<RightOutlined />}
                        data-testid={`alerts-panel-item-action-${item.id}`}
                        data-action-type={action.actionType}
                        onClick={() => {
                          handleExecuteAction(item);
                        }}
                      >
                        {action.label}
                      </Button>
                      <Dropdown
                        menu={{ items: snoozeMenuItems }}
                        trigger={['click']}
                        placement="bottomRight"
                      >
                        <Button
                          size="small"
                          icon={<ClockCircleOutlined />}
                          data-testid={`alerts-panel-item-snooze-${item.id}`}
                        >
                          静音
                        </Button>
                      </Dropdown>
                    </Space>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
        {snoozedCount > 0 && (
          <Card
            size="small"
            type="inner"
            data-testid="alerts-panel-snoozed-list"
            title={
              <Space size={4}>
                <ClockCircleOutlined />
                <span>已静音告警 ({snoozedCount})</span>
              </Space>
            }
          >
            <List
              size="small"
              dataSource={enriched.filter(a => snoozeMap[String(a.id)])}
              renderItem={item => {
                const entry = snoozeMap[String(item.id)];
                if (!entry) return null;
                return (
                  <List.Item
                    style={{ padding: '6px 0' }}
                    data-testid={`alerts-panel-snoozed-item-${item.id}`}
                  >
                    <Space wrap style={{ width: '100%' }}>
                      <Text code>{item.symbol}</Text>
                      <Text>{item.name || '—'}</Text>
                      <Tag color="blue">{formatSnoozeRemaining(Date.now(), entry.until)}</Tag>
                      <Button
                        size="small"
                        type="link"
                        data-testid={`alerts-panel-unsnooze-${item.id}`}
                        onClick={() => handleUnsnooze(item.id)}
                      >
                        恢复显示
                      </Button>
                    </Space>
                  </List.Item>
                );
              }}
            />
          </Card>
        )}
      </Space>
    </Card>
  );
};

const RiskAlertsList: React.FC<{ alerts: UnreadRiskAlertItem[]; compact?: boolean }> = ({
  alerts,
  compact = false,
}) => {
  if (alerts.length === 0) {
    return <Empty description="暂无未读风险告警" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <List
      size={compact ? 'small' : 'default'}
      dataSource={alerts}
      renderItem={item => (
        <List.Item style={{ padding: compact ? '6px 0' : '10px 0' }}>
          <Space align="start" style={{ width: '100%' }}>
            {levelIcon(item.level)}
            <div style={{ flex: 1 }}>
              <Space>
                <Text code>{item.symbol}</Text>
                <Text strong>{item.name || '—'}</Text>
                {levelTag(item.level)}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {item.message}
                </Text>
              </div>
            </div>
          </Space>
        </List.Item>
      )}
    />
  );
};

// ---------------------------------------------------------------------------
// US-077 RiskAlertCenterPanel — 风控告警中心（分页 + 过滤 + 批量已读）
// ---------------------------------------------------------------------------

/**
 * 风控告警中心 sub-tab。
 *
 * 与 `AlertsPanel`（前 3 tab 的未读预览）的区别：
 *   - AlertsPanel = 来自 /api/today/signals 的最近 N 条未读 list view（只展示）；
 *   - 本组件 = 来自 /api/risk-alerts/list 的全量分页 table（可过滤 / 批量已读）。
 *
 * Filter：level (HIGH/MEDIUM/LOW) / type (持仓/市场/单股) / date range / is_read。
 * 批量已读：表格 rowSelection multiple → 顶部按钮 "标记选中已读 (N)"；
 *           标记完后自动 reload 当前分页，并通过 `onUnreadCountChange` 让父组件
 *           更新 KPI 条的未读徽标。
 *
 * 错误处理：单 try/catch + 顶部 Alert + 重试按钮（同 SignalsPanel / AlertsPanel）。
 */
const RiskAlertCenterPanel: React.FC<{ onUnreadCountChange?: () => void }> = ({
  onUnreadCountChange,
}) => {
  const [items, setItems] = useState<RiskAlertItem[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [filterLevel, setFilterLevel] = useState<'HIGH' | 'MEDIUM' | 'LOW' | undefined>(undefined);
  const [filterType, setFilterType] = useState<AlertCategory | undefined>(undefined);
  const [filterDateRange, setFilterDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [filterIsRead, setFilterIsRead] = useState<boolean | undefined>(undefined);
  const [filterSearch, setFilterSearch] = useState<string>('');

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [marking, setMarking] = useState(false);

  // 组装 query — useMemo 让 effect deps 稳定
  const queryParams = useMemo<RiskAlertListParams>(() => {
    const params: RiskAlertListParams = { page, limit: pageSize };
    if (filterLevel) params.level = filterLevel;
    if (filterType) params.type = filterType;
    if (filterIsRead !== undefined) params.is_read = filterIsRead;
    if (filterSearch.trim()) params.search = filterSearch.trim();
    if (filterDateRange?.[0]) params.date_from = filterDateRange[0].format('YYYY-MM-DD');
    if (filterDateRange?.[1]) params.date_to = filterDateRange[1].format('YYYY-MM-DD');
    return params;
  }, [page, pageSize, filterLevel, filterType, filterIsRead, filterSearch, filterDateRange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listRiskAlerts(queryParams);
      setItems(res.items);
      setTotal(res.total);
      setUnreadCount(res.unread_count);
      // 切换分页 / 过滤后清空选中（防止跨页选 ID 误标）
      setSelectedIds([]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [queryParams]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMarkSelected = useCallback(async () => {
    if (selectedIds.length === 0) {
      message.info('请先选择告警');
      return;
    }
    setMarking(true);
    try {
      const res = await markAlertsAsRead(selectedIds);
      message.success(`已标记 ${res.updated} 条告警为已读`);
      setSelectedIds([]);
      await load();
      onUnreadCountChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`批量标记失败：${msg}`);
    } finally {
      setMarking(false);
    }
  }, [selectedIds, load, onUnreadCountChange]);

  const handleMarkAll = useCallback(async () => {
    setMarking(true);
    try {
      await markAllRiskAlertsRead();
      message.success('已将全部未读告警标记为已读');
      await load();
      onUnreadCountChange?.();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(`一键已读失败：${msg}`);
    } finally {
      setMarking(false);
    }
  }, [load, onUnreadCountChange]);

  const handleResetFilters = useCallback(() => {
    setFilterLevel(undefined);
    setFilterType(undefined);
    setFilterDateRange(null);
    setFilterIsRead(undefined);
    setFilterSearch('');
    setPage(1);
  }, []);

  const rowSelection: TableRowSelection<RiskAlertItem> = {
    selectedRowKeys: selectedIds,
    onChange: keys => setSelectedIds(keys.map(k => Number(k))),
    getCheckboxProps: row => ({
      // 已读告警不需要再次标记 (post-action 状态防呆)
      disabled: row.is_read,
    }),
  };

  // 当前分页内的未读条数（用于 "已全选" 边界感知）
  const unreadOnPage = useMemo(() => items.filter(i => !i.is_read).length, [items]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <SafetyCertificateOutlined style={{ color: '#722ed1' }} />
          <span>风控告警中心</span>
          <Tag color={unreadCount > 0 ? 'red' : 'green'}>未读 {unreadCount}</Tag>
          <Tag color="default">总计 {total}</Tag>
        </Space>
      }
      extra={
        <Space>
          <Button
            icon={<ReloadOutlined />}
            onClick={() => void load()}
            loading={loading}
            size="small"
          >
            刷新
          </Button>
          <Button
            type="primary"
            icon={<CheckCircleOutlined />}
            disabled={selectedIds.length === 0 || marking}
            loading={marking && selectedIds.length > 0}
            onClick={() => void handleMarkSelected()}
            size="small"
          >
            标记选中已读 ({selectedIds.length})
          </Button>
          <Popconfirm
            title="将所有未读告警标记为已读？"
            description={`此操作会更新 ${unreadCount} 条未读告警，无法撤销`}
            okText="确认"
            cancelText="取消"
            onConfirm={handleMarkAll}
            disabled={unreadCount === 0 || marking}
          >
            <Button
              danger
              disabled={unreadCount === 0 || marking}
              loading={marking && selectedIds.length === 0}
              size="small"
            >
              一键全部已读
            </Button>
          </Popconfirm>
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {error && (
          <Alert
            type="error"
            showIcon
            message="加载失败"
            description={error}
            action={
              <Button size="small" onClick={() => void load()}>
                重试
              </Button>
            }
          />
        )}

        {/* 过滤栏 */}
        <Row gutter={[8, 8]} align="middle">
          <Col xs={12} md={4}>
            <Select<'HIGH' | 'MEDIUM' | 'LOW'>
              placeholder="级别"
              allowClear
              style={{ width: '100%' }}
              value={filterLevel}
              onChange={v => {
                setFilterLevel(v);
                setPage(1);
              }}
              options={[
                { label: '高 (HIGH)', value: 'HIGH' },
                { label: '中 (MEDIUM)', value: 'MEDIUM' },
                { label: '低 (LOW)', value: 'LOW' },
              ]}
            />
          </Col>
          <Col xs={12} md={4}>
            <Select<AlertCategory>
              placeholder="类型"
              allowClear
              style={{ width: '100%' }}
              value={filterType}
              onChange={v => {
                setFilterType(v);
                setPage(1);
              }}
              options={[
                { label: '持仓', value: 'position' },
                { label: '市场', value: 'market' },
                { label: '单股', value: 'individual' },
              ]}
            />
          </Col>
          <Col xs={24} md={7}>
            <RangePicker
              style={{ width: '100%' }}
              value={filterDateRange ?? undefined}
              onChange={dates => {
                setFilterDateRange(dates as [Dayjs | null, Dayjs | null] | null);
                setPage(1);
              }}
              placeholder={['开始日期', '结束日期']}
            />
          </Col>
          <Col xs={12} md={4}>
            <Select<'all' | 'unread' | 'read'>
              placeholder="读取状态"
              style={{ width: '100%' }}
              value={filterIsRead === undefined ? 'all' : filterIsRead ? 'read' : 'unread'}
              onChange={v => {
                setFilterIsRead(v === 'all' ? undefined : v === 'read');
                setPage(1);
              }}
              options={[
                { label: '全部', value: 'all' },
                { label: '未读', value: 'unread' },
                { label: '已读', value: 'read' },
              ]}
            />
          </Col>
          <Col xs={24} md={5}>
            <Input.Search
              placeholder="代码/名称模糊搜索"
              allowClear
              value={filterSearch}
              onChange={e => setFilterSearch(e.target.value)}
              onSearch={() => setPage(1)}
            />
          </Col>
          <Col xs={24} md={24}>
            <Space>
              <Button size="small" onClick={handleResetFilters}>
                重置过滤
              </Button>
              {selectedIds.length > 0 && (
                <Text type="secondary">
                  已选 {selectedIds.length} 条（当前页未读 {unreadOnPage} 条）
                </Text>
              )}
            </Space>
          </Col>
        </Row>

        <Table<RiskAlertItem>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={items}
          rowSelection={rowSelection}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['20', '30', '50', '100'],
            showTotal: (n, range) => `共 ${n} 条，当前 ${range[0]}-${range[1]}`,
            onChange: (p, ps) => {
              setPage(p);
              if (ps !== pageSize) setPageSize(ps);
            },
          }}
          locale={{ emptyText: <Empty description="无符合过滤条件的告警" /> }}
          columns={[
            {
              title: '级别',
              dataIndex: 'level',
              width: 80,
              render: (v: string) => levelTag(v),
              filters: [
                { text: '高', value: 'HIGH' },
                { text: '中', value: 'MEDIUM' },
                { text: '低', value: 'LOW' },
              ],
              onFilter: (val, row) => row.level === val,
            },
            {
              title: '类型',
              dataIndex: 'category',
              width: 80,
              render: (v: AlertCategory) => categoryTag(v),
            },
            {
              title: '代码 / 名称',
              key: 'symbol_name',
              width: 240,
              render: (_: unknown, row: RiskAlertItem) => (
                <Space direction="vertical" size={0}>
                  <Text code style={{ fontSize: 12 }}>
                    {row.symbol}
                  </Text>
                  <Text strong>{row.name || '—'}</Text>
                </Space>
              ),
            },
            {
              title: '内容',
              dataIndex: 'message',
              ellipsis: { showTitle: false },
              render: (v: string) => (
                <Tooltip title={v} placement="topLeft">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {v}
                  </Text>
                </Tooltip>
              ),
            },
            {
              title: '规则',
              dataIndex: 'rule_id',
              width: 140,
              ellipsis: true,
              render: (v: string | null | undefined) =>
                v ? (
                  <Tag color="blue" style={{ fontSize: 12 }}>
                    {v}
                  </Tag>
                ) : (
                  <Text type="secondary">—</Text>
                ),
            },
            {
              title: '时间',
              dataIndex: 'created_at',
              width: 150,
              render: (v: string) => (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {dayjs(v).format('MM-DD HH:mm:ss')}
                </Text>
              ),
              sorter: (a, b) => dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf(),
              defaultSortOrder: 'descend',
            },
            {
              title: '状态',
              dataIndex: 'is_read',
              width: 70,
              render: (v: boolean) =>
                v ? <Tag color="default">已读</Tag> : <Tag color="red">未读</Tag>,
            },
          ]}
        />
      </Space>
    </Card>
  );
};

// ---------------------------------------------------------------------------
// 下单结果 modal
// ---------------------------------------------------------------------------

const ApplyResultModal: React.FC<{
  result: ApplySignalsData | null;
  onClose: () => void;
  onGotoPortfolio: () => void;
}> = ({ result, onClose, onGotoPortfolio }) => {
  return (
    <Modal
      open={!!result}
      title="一键应用信号结果"
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button key="goto" type="primary" onClick={onGotoPortfolio}>
          前往持仓页
        </Button>,
      ]}
      width={720}
    >
      {result && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Space size={24}>
            <Statistic title="成功" value={result.placed} valueStyle={{ color: '#16a34a' }} />
            <Statistic title="跳过/失败" value={result.skipped} valueStyle={{ color: '#999' }} />
            <Statistic title="交易日" value={result.trade_date ?? '—'} />
          </Space>
          <Table
            size="small"
            rowKey={(r, idx) => `${r.symbol}-${idx}`}
            dataSource={result.orders}
            pagination={false}
            scroll={{ y: 320 }}
            columns={[
              {
                title: '策略',
                dataIndex: 'strategy',
                width: 110,
                render: (v: string) => strategyTag(v),
              },
              { title: '代码', dataIndex: 'symbol', width: 100 },
              { title: '名称', dataIndex: 'name', ellipsis: true },
              {
                title: '数量',
                dataIndex: 'quantity',
                width: 80,
                align: 'right' as const,
              },
              {
                title: '状态',
                dataIndex: 'status',
                width: 80,
                render: (v: string) => orderStatusTag(v),
              },
              { title: '原因', dataIndex: 'reason', ellipsis: true },
            ]}
          />
        </Space>
      )}
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pnlColor(value: number | null): string {
  if (value == null || value === 0) return undefined as unknown as string;
  return value > 0 ? '#dc2626' : '#16a34a';
}

/** US-040 regime → tag 颜色（与建议仓位强度同源色谱） */
function regimeTagColor(regime: MarketRegime): string {
  switch (regime) {
    case 'bull':
      return 'red';
    case 'rebound':
      return 'orange';
    case 'range':
      return 'blue';
    case 'bear':
      return 'green';
    case 'stress':
      return 'magenta';
    case 'unknown':
    default:
      return 'default';
  }
}

/** US-040 regime → statistic 文字色 */
function regimeStatColor(regime: MarketRegime): string | undefined {
  switch (regime) {
    case 'bull':
      return '#dc2626';
    case 'rebound':
      return '#fa8c16';
    case 'range':
      return '#1677ff';
    case 'bear':
      return '#16a34a';
    case 'stress':
      return '#a8071a';
    default:
      return undefined;
  }
}

/** US-040 regime 英文 → 中文兜底（后端 regime_label 通常已给, 兜底防 null） */
function regimeLabelFallback(regime: MarketRegime): string {
  const map: Record<MarketRegime, string> = {
    bull: '强势上行',
    rebound: '反弹修复',
    range: '震荡均衡',
    bear: '下行弱势',
    stress: '极端压力',
    unknown: '未知环境',
  };
  return map[regime] || '未知环境';
}

/** US-040 建议仓位百分比 → 颜色（重 red / 中 blue / 谨慎 orange / 空 gray） */
function positionPctColor(pct: number): { text: string; tag: string } {
  if (!Number.isFinite(pct)) return { text: '#999', tag: 'default' };
  if (pct >= 0.7) return { text: '#dc2626', tag: 'red' };
  if (pct >= 0.4) return { text: '#1677ff', tag: 'blue' };
  if (pct >= 0.1) return { text: '#fa8c16', tag: 'orange' };
  return { text: '#8c8c8c', tag: 'default' };
}

/** US-040 ATR 颜色：极高紫 / 高橙 / 正常默认 / null 灰 */
function atrColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value >= 5) return '#722ed1';
  if (value >= 3) return '#fa8c16';
  return undefined;
}

/** US-040 外盘均值色：>0 红 / <0 绿 / 0 默认 */
function overnightAvgColor(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '#8c8c8c';
  return value > 0 ? '#dc2626' : '#16a34a';
}

/** US-073 沪深300 开盘涨跌色：>0 红涨，<0 绿跌，0/null 中性 */
function openChangeColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? '#dc2626' : '#16a34a';
}

/** US-073 北向资金色：净流入红，净流出绿 */
function northboundColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? '#dc2626' : '#16a34a';
}

/** US-073 涨停数色：≥80 红（赚钱效应强），≤30 灰（赚钱效应弱），否则默认 */
function limitUpColor(value: number | null): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  if (value >= 80) return '#dc2626';
  if (value <= 30) return '#8c8c8c';
  return undefined;
}

function eventTypeTag(t: KeyEventItem['event_type']): React.ReactNode {
  if (t === 'earnings_surprise') return <Tag color="red">超预期</Tag>;
  if (t === 'earnings_announcement') return <Tag color="blue">业绩</Tag>;
  return <Tag color="orange">连板</Tag>;
}

/** US-041 集合竞价异动 type → tag. */
function auctionTypeTag(t: AuctionAnomalyType): React.ReactNode {
  if (t === 'one_word') return <Tag color="red">一字</Tag>;
  if (t === 'gap_up') return <Tag color="red">高开</Tag>;
  if (t === 'gap_down') return <Tag color="green">低开</Tag>;
  return <Tag>{t}</Tag>;
}

function eventTypeIcon(t: KeyEventItem['event_type']): React.ReactNode {
  if (t === 'earnings_surprise') return <ThunderboltOutlined style={{ color: '#dc2626' }} />;
  if (t === 'earnings_announcement') return <FundOutlined style={{ color: '#1677ff' }} />;
  return <RiseOutlined style={{ color: '#fa541c' }} />;
}

function levelTag(level: string): React.ReactNode {
  const upper = (level || '').toUpperCase();
  if (upper === 'HIGH') return <Tag color="red">高</Tag>;
  if (upper === 'MEDIUM') return <Tag color="orange">中</Tag>;
  if (upper === 'LOW') return <Tag color="blue">低</Tag>;
  return <Tag>{level}</Tag>;
}

function levelIcon(level: string): React.ReactNode {
  const upper = (level || '').toUpperCase();
  if (upper === 'HIGH') return <WarningOutlined style={{ color: '#dc2626' }} />;
  return <AlertOutlined style={{ color: '#fa8c16' }} />;
}

/** US-077 风控中心 — 告警类别 tag */
function categoryTag(category: AlertCategory): React.ReactNode {
  if (category === 'position') return <Tag color="blue">{ALERT_CATEGORY_LABEL.position}</Tag>;
  if (category === 'market') return <Tag color="blue">{ALERT_CATEGORY_LABEL.market}</Tag>;
  return <Tag color="blue">{ALERT_CATEGORY_LABEL.individual}</Tag>;
}

function strategyTag(strategy: string): React.ReactNode {
  if (strategy === 'multi_factor') return <Tag color="blue">多因子</Tag>;
  if (strategy === 'dragon_head') return <Tag color="orange">龙头</Tag>;
  if (strategy === 'earnings_surprise') return <Tag color="green">业绩超预期</Tag>;
  return <Tag>{strategy}</Tag>;
}

function orderStatusTag(status: string): React.ReactNode {
  if (status === 'placed') return <Tag color="green">成功</Tag>;
  if (status === 'skipped') return <Tag color="default">跳过</Tag>;
  return <Tag color="red">失败</Tag>;
}

export default TodayWorkspace;
