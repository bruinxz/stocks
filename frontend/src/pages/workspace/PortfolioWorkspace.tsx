import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/rootReducer';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  List,
  Popconfirm,
  Radio,
  Row,
  Segmented,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  BarChartOutlined,
  BellOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  LineChartOutlined,
  RadarChartOutlined,
  ReadOutlined,
  ReloadOutlined,
  SettingOutlined,
  StopOutlined,
  UnorderedListOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import dayjs, { Dayjs } from 'dayjs';
import { AnimatePresence, motion } from 'framer-motion';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import WorkspaceHero from '../../components/layout/WorkspaceHero';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import TradeReasonCell from '../../components/trading/TradeReasonCell';
import PortfolioManagementPanel from '../../components/portfolio/PortfolioManagementPanel';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  portfolioWorkspaceService,
  PortfolioWithPositions,
  PositionRow,
  SnapshotRow,
  TradeRow,
  JournalSummary,
  JournalDetail,
  BenchmarkHistoryPoint,
  CorrelationReport,
  getCorrelationReport,
  IndustryConcentrationSummary,
  DailyAttributionReportRow,
} from '../../services/portfolioWorkspaceService';
import {
  buildIndustryConcentrationKpiViewModel,
  INDUSTRY_KPI_WARN_PCT,
  INDUSTRY_KPI_WARN_COLOR,
} from './industryConcentrationKpiHelpers';
import {
  buildDailyAttributionViewModel,
  DailyAttributionViewModel,
  DailyAttributionTradeRow,
} from './dailyAttributionHelpers';
import {
  buildPortfolioAttributionCardViewModel,
  PortfolioAttributionCardViewModel,
  AttributionPieSlice,
  AttributionTradeRow,
  ATTRIBUTION_POSITIVE_COLOR,
  ATTRIBUTION_NEGATIVE_COLOR,
} from './portfolioAttributionCardHelpers';
import {
  buildErrorPatternsViewModel,
  ErrorPatternsViewModel,
  ErrorPatternRow,
  ERROR_PATTERN_PRIORITY_COLOR,
  ERROR_PATTERN_PRIORITY_LABEL,
  ERROR_PATTERN_KIND_LABEL,
  formatMoney as formatPatternMoney,
  formatRatioPct as formatPatternRatio,
} from './errorPatternsHelpers';
import {
  JOURNAL_PERIOD_LABEL,
  JOURNAL_PERIOD_VALUES,
  JournalPeriod,
  JournalPeriodBucket,
  findBucket,
  groupJournalsByPeriod,
} from './journalPeriodHelpers';
import {
  buildPositionMetricsViewModel,
  POSITION_RISK_LEVEL_COLOR,
  POSITION_RISK_LEVEL_LABEL,
  DAYS_HELD_LEVEL_COLOR,
  DAYS_HELD_LEVEL_LABEL,
  formatPctOrDash as formatPositionPct,
  formatDaysHeld,
} from './positionMetricsHelpers';
import { usePortfolio } from '../../contexts/PortfolioContext';
import { translateAxiosTradingError, translateTradingError } from '../../utils/tradingErrorMap';
import {
  formatMoney,
  formatMoneyNumber,
} from '../../utils/formatMoney';
// PR-C 风控中心 v2 — "我的提醒" tab 复用 panel, positionSymbols 限定到当前持仓.
// AlertsBell 普通用户点击落到这里 (admin 落到 TodayWorkspace?tab=risk_center).
import RiskAlertCenterPanel from './RiskAlertCenterPanel';

const { Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;
const { TextArea } = Input;

/**
 * 持仓与复盘工作区 (Portfolio Workspace) — US-017 完整实现。
 *
 * 4 个 tab：
 *  - 当前持仓：表格 + 一键平仓 + inline 设置止损价
 *  - 资金曲线：净值 vs 沪深 300 + KPI 卡（总收益/年化/夏普/最大回撤/当月）
 *  - 交易明细：分页表格 + 方向/日期筛选
 *  - 复盘日记：左侧日期列表 + 右侧 detail + 追加手记
 *
 * 数据装载：mount 时 Promise.all 加载 portfolio + snapshots + trades + journal list
 *   →顶部 KPI strip 一次性绘制。Tab 切换不重新 fetch。复盘日记 detail
 *   按日期 lazy fetch。沪深 300 在切换"资金曲线" tab 时按需 fetch
 *   (避免登录即拉数据，加快首次加载)。
 */

const BENCHMARK_SYMBOL = 'sh.000300';
const BENCHMARK_LABEL = '沪深 300';

type WindowKey = '30d' | '90d' | '1y' | 'all';

const PortfolioWorkspace: React.FC = () => {
  // Phase 3 (2026-06-27): tab 8 → 4 (普通用户) / 8 (admin).
  // 普通用户: 当前持仓 (默认) / 交易明细 / 资金曲线 / 复盘日记.
  // 日归因 / AI 日记+错误模式 / 相关性矩阵 / 模拟盘管理 = 研究 / 高级功能.
  const isAdmin = useSelector((s: RootState) => s.auth.user?.role === 'admin');
  const tabs: WorkspaceTab[] = useMemo(() => {
    const baseTabs: WorkspaceTab[] = [
      // 合并 (2026-07-04): 用户原话 — "持仓与复盘这两个 Tab 可以合在一起没必要分开".
      // 「当前持仓」+「复盘日记」并入单个「持仓 · 复盘」tab: 上半区当前持仓,
      // 下半区复盘日记 (同一心智: 看着持仓做复盘). 普通用户一级 tab 5 → 4.
      { key: 'positions', label: '持仓 · 复盘', icon: <WalletOutlined /> },
      { key: 'trades', label: '交易明细', icon: <UnorderedListOutlined /> },
      { key: 'equity', label: '资金曲线', icon: <LineChartOutlined /> },
      // PR-C: 我的提醒 — 用户持仓相关告警 + 高优先级风控事件 (AlertsBell 普通用户落点).
      { key: 'alerts', label: '我的提醒', icon: <BellOutlined /> },
    ];
    if (isAdmin) {
      // 收敛 (2026-07-04): 4 个 admin 一级 tab (日归因/错误模式/相关性/模拟盘) 折进单个
      // "高级分析", 内部用二级 Segmented 切换, admin 一级从 9 → 6.
      baseTabs.push({ key: 'advanced', label: '高级分析 (admin)', icon: <BarChartOutlined /> });
    }
    return baseTabs;
  }, [isAdmin]);
  const [activeKey, setActiveKey] = useState<string>('positions');
  // 高级分析 (admin) 二级子视图.
  const [advancedSubView, setAdvancedSubView] = useState<
    'attribution' | 'error-patterns' | 'correlation' | 'manage'
  >('attribution');

  // PR-C: AlertsBell 普通用户点击 → /workspace/portfolio?tab=alerts.
  // 一次性应用 query (与 TodayWorkspace 同款模式), 之后用户手动切 tab 不被 query 覆盖.
  const location = useLocation();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    let tab = params.get('tab');
    // 合并 (2026-07-04): 复盘日记并入「持仓 · 复盘」, 旧 ?tab=journal 深链重定向到 positions.
    if (tab === 'journal') tab = 'positions';
    if (tab && tabs.some(t => t.key === tab)) {
      setActiveKey(tab);
    }
  }, [location.search, tabs]);

  // ---- 主数据 ----
  const [portfolioData, setPortfolioData] = useState<PortfolioWithPositions | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [journalList, setJournalList] = useState<JournalSummary[]>([]);
  // US-012: 行业集中度 KPI 快照 — 顶部 KPI 卡 + tooltip 用. null = 未加载完成 / 接口失败 (KPI 隐藏)
  const [industryConc, setIndustryConc] = useState<IndustryConcentrationSummary | null>(null);

  // 2026-06-17: 改用全局 PortfolioContext (顶部 selector). 删除本地 portfolioList/setSelectedPortfolioId.
  const { selectedPortfolioId } = usePortfolio();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // Batch L (2026-06-17): 切盘 race 保护 — snapshot 当前调用的 portfolio_id;
    // await 后比对, 若用户在 fetch 期间切了盘 → 静默丢响应不污染新盘 state.
    const callPortfolioId = selectedPortfolioId;
    try {
      const [pf, snaps, trd, jrn] = await Promise.all([
        portfolioWorkspaceService.getPortfolio(selectedPortfolioId),
        portfolioWorkspaceService.getSnapshots(selectedPortfolioId),
        portfolioWorkspaceService.getTradeHistory(selectedPortfolioId),
        portfolioWorkspaceService.listJournals(),
      ]);
      if (callPortfolioId !== selectedPortfolioId) return;
      setPortfolioData(pf);
      setSnapshots(snaps);
      setTrades(trd);
      setJournalList(jrn);
      // US-012: 行业集中度 KPI — 独立 fire-and-forget, 不阻塞主面板. 接口失败仅 reset
      // 不弹错误（其它面板已渲染，没必要因为 KPI 失败把整页变红）。
      portfolioWorkspaceService
        .getIndustryConcentrationSummary()
        .then(summary => {
          if (callPortfolioId !== selectedPortfolioId) return;
          setIndustryConc(summary);
        })
        .catch(() => {
          if (callPortfolioId !== selectedPortfolioId) return;
          setIndustryConc(null);
        });
    } catch (err: unknown) {
      if (callPortfolioId !== selectedPortfolioId) return;
      const messageStr = err instanceof Error ? err.message : String(err);
      setLoadError(messageStr);
    } finally {
      if (callPortfolioId === selectedPortfolioId) setLoading(false);
    }
  }, [selectedPortfolioId]);

  // selectedPortfolioId 变化时 refresh
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- 顶部 KPI 计算 ----
  const kpis = useMemo(() => {
    const positions = portfolioData?.positions || [];
    const totalValue = Number(portfolioData?.portfolio.total_value || 0);
    const cash = Number(portfolioData?.portfolio.current_cash || 0);
    const todayUnrealized = positions.reduce((acc, p) => acc + Number(p.unrealized_pnl || 0), 0);
    const equity = snapshots.map(s => Number(s.total_value));
    const dailyReturns = computeDailyReturns(equity);
    const maxDrawdownPct = equity.length >= 2 ? computeMaxDrawdownPct(equity) : 0;
    const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
    const monthSnaps = snapshots.filter(s => s.date >= monthStart);
    const monthReturnPct =
      monthSnaps.length >= 2
        ? (Number(monthSnaps[monthSnaps.length - 1].total_value) /
            Number(monthSnaps[0].total_value) -
            1) *
          100
        : 0;
    const totalReturnPct =
      snapshots.length >= 2
        ? (Number(snapshots[snapshots.length - 1].total_value) / Number(snapshots[0].total_value) -
            1) *
          100
        : 0;
    const annualizedReturnPct = annualizeReturnPct(snapshots);
    const sharpe = computeSharpeRatio(dailyReturns);
    // Batch BG (2026-06-23): 样本充分度 — 用户要"统计样本积累"指标判断 sharpe 是否可信
    // 业界经验: < 20 个交易日数据 sharpe 噪声极大不可信; 60+ 才有意义; 252 (1 年) 正经.
    const sampleDays = snapshots.length;
    const sampleConfidence: 'low' | 'medium' | 'high' =
      sampleDays < 20 ? 'low' : sampleDays < 60 ? 'medium' : 'high';
    // 胜率 = 上涨日 / 总日数 (粗略, 更准是 per-trade winrate 但需 close trade 数据)
    const winRate =
      dailyReturns.length > 0
        ? (dailyReturns.filter(r => r > 0).length / dailyReturns.length) * 100
        : 0;
    return {
      positionCount: positions.length,
      totalValue,
      cash,
      todayUnrealized,
      monthReturnPct,
      maxDrawdownPct,
      totalReturnPct,
      annualizedReturnPct,
      sampleDays,
      sampleConfidence,
      winRate,
      sharpe,
    };
  }, [portfolioData, snapshots]);

  // Phase 25 (2026-07-04): 合并 hero + KPI bar 为单条 — 去掉 kpiSlot 和 headerActions,
  // 把最大回撤、行业集中度并入 hero metrics, 刷新按钮移至 hero rightSlot 底部.
  // WorkspaceLayout hasKpiBar = false → 第二条 card 消失, 用户原话 "两个部分合在一起".
  const industryKpiVm = buildIndustryConcentrationKpiViewModel(industryConc);

  let body: React.ReactNode;
  if (loading && !portfolioData) {
    body = (
      <Card>
        <div style={{ textAlign: 'center', padding: 48 }}>
          <Spin tip="加载持仓与复盘数据中..." />
        </div>
      </Card>
    );
  } else if (loadError) {
    body = (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={loadError}
        action={
          <Button size="small" onClick={() => void refresh()}>
            重试
          </Button>
        }
      />
    );
  } else if (activeKey === 'positions') {
    // 合并 (2026-07-04): 当前持仓 (上) + 复盘日记 (下) 同屏, 一个 tab 内闭环.
    body = (
      <div className="ws-stack">
        <PositionsTab
          data={portfolioData}
          onChangeData={setPortfolioData}
          onAfterTrade={() => void refresh()}
        />
        <JournalTab list={journalList} onListRefresh={() => void refresh()} />
      </div>
    );
  } else if (activeKey === 'equity') {
    body = <EquityCurveTab snapshots={snapshots} kpis={kpis} />;
  } else if (activeKey === 'trades') {
    body = <TradesTab trades={trades} />;
  } else if (activeKey === 'alerts') {
    // PR-C: positionSymbols = 当前持仓代码 → panel "持仓相关" view 按此过滤;
    // 普通用户进入默认 positions view, 立刻看到自己关心的告警 (而非全局噪音).
    body = (
      <RiskAlertCenterPanel
        positionSymbols={(portfolioData?.positions ?? []).map(p => p.symbol)}
        initialView="positions"
        title="我的提醒"
        onUnreadCountChange={() => void refresh()}
      />
    );
  } else if (activeKey === 'advanced') {
    body = (
      <>
        <Segmented
          className="ws-tab-segmented"
          options={[
            { label: '日归因', value: 'attribution' },
            { label: '错误模式', value: 'error-patterns' },
            { label: '相关性矩阵', value: 'correlation' },
            { label: '模拟盘管理', value: 'manage' },
          ]}
          value={advancedSubView}
          onChange={v => setAdvancedSubView(v as typeof advancedSubView)}
        />
        {advancedSubView === 'attribution' ? (
          <DailyAttributionTab
            snapshots={snapshots}
            trades={trades}
            portfolioId={portfolioData?.portfolio?.id ?? null}
          />
        ) : advancedSubView === 'error-patterns' ? (
          <ErrorPatternsTab trades={trades} journalList={journalList} />
        ) : advancedSubView === 'correlation' ? (
          <CorrelationTab portfolioId={portfolioData?.portfolio?.id} />
        ) : (
          <PortfolioManagementPanel />
        )}
      </>
    );
  } else {
    body = null;
  }

  // Phase 25 hero — 单条 hero 承载所有 KPI + 刷新操作, 去掉第二条 KPI bar.
  // rightSlot: metrics 网格 (5 列) + 底部刷新按钮, 替代原来的 kpiSlot card.
  const heroMetrics = [
    {
      label: '总市值',
      value: formatMoneyNumber(kpis.totalValue),
      unit: '元',
      emphasis: true,
    },
    {
      label: '浮动盈亏',
      value:
        kpis.todayUnrealized === 0
          ? formatMoneyNumber(0)
          : (kpis.todayUnrealized > 0 ? '+' : '') + formatMoneyNumber(kpis.todayUnrealized),
      unit: '元',
      tone: kpis.todayUnrealized > 0 ? 'up' : kpis.todayUnrealized < 0 ? 'down' : undefined,
    },
    {
      label: '当月收益',
      value: `${kpis.monthReturnPct >= 0 ? '+' : ''}${kpis.monthReturnPct.toFixed(2)}`,
      unit: '%',
      tone: kpis.monthReturnPct > 0 ? 'up' : kpis.monthReturnPct < 0 ? 'down' : undefined,
    },
    {
      label: '最大回撤',
      value: kpis.maxDrawdownPct.toFixed(2),
      unit: '%',
      tone: 'down' as const,
    },
    {
      label: '持仓',
      value: kpis.positionCount,
      unit: '只',
    },
    ...(!industryKpiVm.hidden
      ? [
          {
            label: '行业集中度',
            value: industryKpiVm.pctNum.toFixed(2),
            unit: industryKpiVm.suffix.replace(/^[0-9.]+/, '').trim() || '%',
            tone:
              industryKpiVm.overAlert
                ? ('down' as const)
                : industryKpiVm.overWarn
                  ? ('down' as const)
                  : undefined,
          },
        ]
      : []),
  ];

  const hero = (
    <WorkspaceHero
      eyebrow="Portfolio · 实盘交易"
      title="持仓与复盘"
      subtitle="模拟盘持仓、资金曲线、交易明细与复盘日记 — 赚亏闭环 · 全链路真实数据"
      variant="violet"
      rightSlot={
        <div className="portfolio-hero-right">
          <div className="portfolio-hero-metrics">
            {heroMetrics.map((m, i) => {
              const valClass = [
                'ws-hero__metric-value',
                m.emphasis ? 'ws-hero__metric-value--lg' : '',
                m.tone === 'up' ? 'ws-hero__metric-value--up' : '',
                m.tone === 'down' ? 'ws-hero__metric-value--down' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <div key={i} className="ws-hero__metric">
                  <span className="ws-hero__metric-label">{m.label}</span>
                  <span className={valClass}>
                    {m.value}
                    {m.unit ? <span className="ws-hero__metric-unit">{m.unit}</span> : null}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="portfolio-hero-actions">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void refresh()}
              loading={loading}
              style={{ opacity: 0.75 }}
            >
              刷新
            </Button>
          </div>
        </div>
      }
    />
  );

  return (
    <WorkspaceLayout
      title="持仓与复盘"
      subtitle="模拟盘持仓、资金曲线、交易明细与复盘日记 — 赚亏闭环。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      hero={hero}
      themed
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={activeKey}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
    </WorkspaceLayout>
  );
};

export default PortfolioWorkspace;

// ===========================================================================
//  US-012 / US-057: 行业集中度 KPI（顶 KPI 卡）
// ===========================================================================
/**
 * AC 关键点（US-057 [FE-018] 落地; 渲染逻辑抽到 `industryConcentrationKpiHelpers`）：
 *   - 顶 KPI 显示最大行业集中度（按持仓市值聚合，分母 = 持仓市值之和，
 *     **不含 cash** — 与后端 US-012 IndustryConcentrationGuard 同款分母，
 *     保证 KPI / 告警 / 再平衡三处口径一致）；
 *   - **> 25% 红色**（AC 显示阈值；与后端 alert_pct=35% 解耦：25% 是 *提示*
 *     用户关注的早期 warning，35% 是 *写 RiskAlert* 的真正阈值）；
 *   - 未分类持仓（`__UNKNOWN__`）展示为"未分类"，让用户补数据；
 *   - 接口失败或 portfolio_id=null → KPI 隐藏（避免顶 KPI 卡掉链子）；
 *   - 空持仓 → 显示 0.00% 灰色（max_industry_pct=null）。
 */
// 重新 export 以保持向后兼容 (其它 component 可能 import 这些常量).
export { INDUSTRY_KPI_WARN_PCT, INDUSTRY_KPI_WARN_COLOR };

interface IndustryConcentrationKpiProps {
  summary: IndustryConcentrationSummary | null;
}

const IndustryConcentrationKpi: React.FC<IndustryConcentrationKpiProps> = ({ summary }) => {
  const vm = buildIndustryConcentrationKpiViewModel(summary);
  // 接口失败 / 还未加载 → 隐藏 KPI（避免显示 NaN 或撑空位）
  if (vm.hidden) return null;
  const tooltip = (
    <div style={{ minWidth: 220 }}>
      {vm.tooltipLines.map((line, idx) => (
        <div
          key={idx}
          style={
            vm.overAlert && line.startsWith('⚠')
              ? { color: INDUSTRY_KPI_WARN_COLOR, marginTop: 4 }
              : undefined
          }
        >
          {line}
        </div>
      ))}
    </div>
  );
  return (
    <Tooltip title={tooltip} placement="bottom">
      <Statistic
        title="行业集中度"
        value={vm.pctNum}
        precision={2}
        suffix={vm.suffix}
        valueStyle={{ color: vm.color }}
      />
    </Tooltip>
  );
};

// ===========================================================================
//  Tab 1: 当前持仓
// ===========================================================================
interface PositionsTabProps {
  data: PortfolioWithPositions | null;
  onChangeData: (data: PortfolioWithPositions) => void;
  onAfterTrade: () => void;
}

const PositionsTab: React.FC<PositionsTabProps> = ({ data, onChangeData, onAfterTrade }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  // 修复 (2026-06-17): 子组件用 context 拿 selectedPortfolioId, 不再依赖 prop 透传
  const { selectedPortfolioId } = usePortfolio();
  // US-076 — 编辑 state 扩展为 (positionId, field) tuple，止损与止盈复用同一套
  // 编辑 / 保存 / 取消机制，避免两个独立 state 各管一边导致同行同时进入两个编辑态。
  const [editingPositionId, setEditingPositionId] = useState<number | null>(null);
  const [editingField, setEditingField] = useState<'stop_loss' | 'take_profit' | null>(null);
  const [editingValue, setEditingValue] = useState<number | null>(null);
  const [savingLimit, setSavingLimit] = useState(false);
  const [closingSymbol, setClosingSymbol] = useState<string | null>(null);
  // US-055 — AI 解读 modal target
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);

  // 防御性按 id 升序排序：后端 PaperTradingFacade.getPortfolio 已加
  // `order: [['id','ASC']]`，这里再 useMemo 做一道保险，避免任何中间路径
  // （e.g. service 转换 / 后续调用方 mutate）把顺序打乱导致表格行次序漂移。
  const positions = useMemo(() => {
    const list = data?.positions || [];
    return [...list].sort((a, b) => Number(a.id) - Number(b.id));
  }, [data?.positions]);
  const totalValue = Number(data?.portfolio.total_value || 0);

  const handleStartEdit = (row: PositionRow, field: 'stop_loss' | 'take_profit') => {
    setEditingPositionId(row.id);
    setEditingField(field);
    const initial =
      field === 'stop_loss'
        ? row.stop_loss_price !== null
          ? Number(row.stop_loss_price)
          : null
        : row.take_profit_price !== null
          ? Number(row.take_profit_price)
          : null;
    setEditingValue(initial);
  };

  const handleCancelEdit = () => {
    setEditingPositionId(null);
    setEditingField(null);
    setEditingValue(null);
  };

  const handleSaveStopLoss = async (row: PositionRow) => {
    setSavingLimit(true);
    // Batch L (2026-06-17): 切盘 race 保护 — 把调用时的 selectedPortfolioId snapshot
    // 起来, await 后比对. 用户切到别盘则不回写当前盘 state (防止把别盘响应灌入当前盘).
    const callPortfolioId = selectedPortfolioId;
    try {
      const result = await portfolioWorkspaceService.setPositionStopLoss(row.id, {
        stop_loss_price: editingValue,
      });
      if (callPortfolioId !== selectedPortfolioId) {
        // 用户已切盘, 静默丢弃响应不污染当前盘
        return;
      }
      if (data) {
        const next: PortfolioWithPositions = {
          ...data,
          positions: data.positions.map(p =>
            p.id === row.id ? { ...p, stop_loss_price: result.stop_loss_price } : p
          ),
        };
        onChangeData(next);
      }
      message.success(
        result.stop_loss_price === null
          ? '已清除止损价'
          : `${row.name || row.symbol} 止损价 ¥${result.stop_loss_price}`
      );
      handleCancelEdit();
    } catch (err: any) {
      const info = err?.response
        ? translateAxiosTradingError(err)
        : translateTradingError({ message: err?.message || String(err) });
      message.error(info.title);
      if (info.hint) setTimeout(() => message.info(info.hint!, 5), 150);
    } finally {
      setSavingLimit(false);
    }
  };

  const handleSaveTakeProfit = async (row: PositionRow) => {
    setSavingLimit(true);
    const callPortfolioId = selectedPortfolioId; // Batch L: 切盘 race 保护
    try {
      const result = await portfolioWorkspaceService.setPositionTakeProfit(row.id, {
        take_profit_price: editingValue,
      });
      if (callPortfolioId !== selectedPortfolioId) return;
      if (data) {
        const next: PortfolioWithPositions = {
          ...data,
          positions: data.positions.map(p =>
            p.id === row.id ? { ...p, take_profit_price: result.take_profit_price } : p
          ),
        };
        onChangeData(next);
      }
      message.success(
        result.take_profit_price === null
          ? '已清除止盈价'
          : `${row.name || row.symbol} 止盈价 ¥${result.take_profit_price}`
      );
      handleCancelEdit();
    } catch (err: any) {
      const info = err?.response
        ? translateAxiosTradingError(err)
        : translateTradingError({ message: err?.message || String(err) });
      message.error(info.title);
      if (info.hint) setTimeout(() => message.info(info.hint!, 5), 150);
    } finally {
      setSavingLimit(false);
    }
  };

  const handleClosePosition = async (row: PositionRow) => {
    setClosingSymbol(row.symbol);
    const callPortfolioId = selectedPortfolioId; // Batch L: 切盘 race 保护
    try {
      const result = await portfolioWorkspaceService.placeTrade({
        symbol: row.symbol,
        direction: 'SELL',
        quantity: row.quantity,
        portfolio_id: selectedPortfolioId, // 修复 CRITICAL #C1 (2026-06-17): 显式传当前选盘, 防错卖
      });
      if (callPortfolioId !== selectedPortfolioId) {
        // 用户切盘后, 这条 SELL 已成交但前端不再属于当前盘 — 让 onAfterTrade 仍 fire 拉新盘数据
        onAfterTrade();
        return;
      }
      const pnl = result.realized_pnl ?? 0;
      message.success(
        `已平仓 ${row.name || row.symbol}：成交价 ¥${result.execute_price.toFixed(2)}，实现盈亏 ${
          pnl >= 0 ? '+' : ''
        }¥${pnl.toFixed(2)}`
      );
      onAfterTrade();
    } catch (err: any) {
      const info = err?.response
        ? translateAxiosTradingError(err)
        : translateTradingError({ message: err?.message || String(err) });
      message.error(info.title);
      if (info.hint) setTimeout(() => message.info(info.hint!, 5), 150);
    } finally {
      setClosingSymbol(null);
    }
  };

  if (positions.length === 0) {
    return (
      <Card>
        <Empty
          description={
            <Space direction="vertical" align="center">
              <Text>当前没有持仓。</Text>
              <Text type="secondary">
                在「主页」查看今日买卖信号并落地实盘，或到「实验室」运行回测后建仓。
              </Text>
            </Space>
          }
        />
      </Card>
    );
  }

  const columns = [
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 110,
      render: (v: string) => (
        <a onClick={() => navigate(`/stock/${v}`)}>
          <Text code>{v}</Text>
        </a>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (v: string | null, row: PositionRow) =>
        v ? <a onClick={() => navigate(`/stock/${row.symbol}`)}>{v}</a> : row.symbol,
    },
    {
      title: '买入日',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 110,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '-'),
    },
    {
      title: '买入价',
      dataIndex: 'avg_cost',
      key: 'avg_cost',
      width: 90,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '现价',
      dataIndex: 'current_price',
      key: 'current_price',
      width: 90,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 80,
      align: 'right' as const,
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '浮盈',
      dataIndex: 'unrealized_pnl',
      key: 'unrealized_pnl',
      width: 150,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        const pnl = Number(row.unrealized_pnl);
        const cost = Number(row.avg_cost) * Number(row.quantity);
        const pct = cost > 0 ? (pnl / cost) * 100 : 0;
        return (
          <Space size={4}>
            <span style={{ color: pnlColor(pnl), fontWeight: 500 }}>
              {pnl >= 0 ? '+' : ''}¥{pnl.toFixed(2)}
            </span>
            <Tag color={pnl >= 0 ? 'green' : 'red'} style={{ marginLeft: 4 }}>
              {pct >= 0 ? '+' : ''}
              {pct.toFixed(2)}%
            </Tag>
          </Space>
        );
      },
    },
    {
      title: '占比',
      key: 'weight',
      width: 90,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        if (totalValue <= 0) return '-';
        const w = (Number(row.market_value) / totalValue) * 100;
        return `${w.toFixed(2)}%`;
      },
    },
    {
      // US-058 [FE-019] — ATR(14) % 列, 反映当前波动率 (backend 用 30 天 bars 算).
      // 三档分级与 PerStockStopLossGuard / Donchian/Turtle 拒入门槛 8% 对齐.
      title: (
        <Tooltip title="ATR(14) 相对最新 close 的百分比 — 反映持仓近期波动率. ≥8%=极高 / 5-8%=警戒 / <5%=正常">
          ATR%
        </Tooltip>
      ),
      key: 'atr_pct',
      width: 100,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        const vm = buildPositionMetricsViewModel({
          atr_pct: row.atr_pct ?? null,
          current_price: row.current_price,
          highest_price: row.highest_price ?? null,
          created_at: row.created_at,
        });
        if (vm.atrLevel === 'unknown') {
          return <Text type="secondary">—</Text>;
        }
        return (
          <Tooltip title={POSITION_RISK_LEVEL_LABEL[vm.atrLevel]}>
            <Tag color={POSITION_RISK_LEVEL_COLOR[vm.atrLevel]}>{formatPositionPct(vm.atrPct)}</Tag>
          </Tooltip>
        );
      },
    },
    {
      // US-058 [FE-019] — 当前回撤 % = (highest_price - current_price) / highest_price
      // highest_price 由 TrailingStopGuard 每日收盘后写; 新仓首日没跑 guard 显示 "—".
      title: (
        <Tooltip title="当前回撤 = (持仓期间最高价 - 现价) / 最高价 × 100%. ≥15%=深度 / 8-15%=警戒 / <8%=健康">
          回撤
        </Tooltip>
      ),
      key: 'dd_pct',
      width: 100,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        const vm = buildPositionMetricsViewModel({
          atr_pct: row.atr_pct ?? null,
          current_price: row.current_price,
          highest_price: row.highest_price ?? null,
          created_at: row.created_at,
        });
        if (vm.ddLevel === 'unknown') {
          return <Text type="secondary">—</Text>;
        }
        return (
          <Tooltip title={POSITION_RISK_LEVEL_LABEL[vm.ddLevel]}>
            <Tag color={POSITION_RISK_LEVEL_COLOR[vm.ddLevel]}>{formatPositionPct(vm.ddPct)}</Tag>
          </Tooltip>
        );
      },
    },
    {
      // US-058 [FE-019] — 持仓天数 (自然日, 不扣周末). 新仓蓝色 / 长期 (>180天) 灰色.
      title: (
        <Tooltip title="持仓天数 (自然日, 不扣周末/节假日). <7=新仓 / 7-180=正常 / >180=长期">
          持仓天数
        </Tooltip>
      ),
      key: 'days_held',
      width: 110,
      align: 'right' as const,
      render: (_: any, row: PositionRow) => {
        const vm = buildPositionMetricsViewModel({
          atr_pct: row.atr_pct ?? null,
          current_price: row.current_price,
          highest_price: row.highest_price ?? null,
          created_at: row.created_at,
        });
        if (vm.daysHeldLevel === 'unknown') {
          return <Text type="secondary">—</Text>;
        }
        const label = DAYS_HELD_LEVEL_LABEL[vm.daysHeldLevel];
        const color = DAYS_HELD_LEVEL_COLOR[vm.daysHeldLevel];
        // normal 档不显示额外 Tag (避免视觉噪音), 仅显示天数; fresh/long 用 Tag 高亮.
        if (vm.daysHeldLevel === 'normal') {
          return <span>{formatDaysHeld(vm.daysHeld)}</span>;
        }
        return (
          <Space size={4}>
            <span>{formatDaysHeld(vm.daysHeld)}</span>
            {label && <Tag color={color}>{label}</Tag>}
          </Space>
        );
      },
    },
    {
      title: '止损价',
      key: 'stop_loss',
      width: 200,
      render: (_: any, row: PositionRow) => {
        const currentPrice = Number(row.current_price);
        if (editingPositionId === row.id && editingField === 'stop_loss') {
          return (
            <Space size={4}>
              <InputNumber
                value={editingValue}
                onChange={v => setEditingValue(v as number | null)}
                min={0}
                step={0.01}
                precision={2}
                placeholder="留空清除"
                style={{ width: 110 }}
                size="small"
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={savingLimit}
                onClick={() => void handleSaveStopLoss(row)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
            </Space>
          );
        }
        const stopLoss = row.stop_loss_price !== null ? Number(row.stop_loss_price) : null;
        // 止损价 ≥ 现价 = 警告（下一交易日开盘可能立即触发）
        const isAboveCurrent = stopLoss !== null && stopLoss >= currentPrice;
        return (
          <Space size={4}>
            {stopLoss === null ? (
              <Text type="secondary">未设置</Text>
            ) : (
              <Tooltip
                title={
                  isAboveCurrent
                    ? '止损价已 ≥ 当前现价，下一交易日开盘可能立即触发'
                    : `距现价 ${(((currentPrice - stopLoss) / currentPrice) * 100).toFixed(2)}%`
                }
              >
                <Tag color={isAboveCurrent ? 'red' : 'orange'}>¥{stopLoss.toFixed(2)}</Tag>
              </Tooltip>
            )}
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleStartEdit(row, 'stop_loss')}
            />
          </Space>
        );
      },
    },
    {
      // US-076 — 止盈价：止损的对偶，现价 ≥ 止盈价时变绿提示用户考虑减仓
      title: '止盈价',
      key: 'take_profit',
      width: 200,
      render: (_: any, row: PositionRow) => {
        const currentPrice = Number(row.current_price);
        if (editingPositionId === row.id && editingField === 'take_profit') {
          return (
            <Space size={4}>
              <InputNumber
                value={editingValue}
                onChange={v => setEditingValue(v as number | null)}
                min={0}
                step={0.01}
                precision={2}
                placeholder="留空清除"
                style={{ width: 110 }}
                size="small"
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={savingLimit}
                onClick={() => void handleSaveTakeProfit(row)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
            </Space>
          );
        }
        const takeProfit = row.take_profit_price !== null ? Number(row.take_profit_price) : null;
        // 止盈价 ≤ 现价 = 绿色提示（目标已达 / 应考虑减仓）
        const isReached = takeProfit !== null && takeProfit <= currentPrice;
        return (
          <Space size={4}>
            {takeProfit === null ? (
              <Text type="secondary">未设置</Text>
            ) : (
              <Tooltip
                title={
                  isReached
                    ? '现价已 ≥ 止盈价，目标已达成，可考虑减仓或平仓'
                    : `距现价 ${(((takeProfit - currentPrice) / currentPrice) * 100).toFixed(2)}%`
                }
              >
                <Tag color={isReached ? 'green' : 'blue'}>¥{takeProfit.toFixed(2)}</Tag>
              </Tooltip>
            )}
            <Button
              size="small"
              type="text"
              icon={<EditOutlined />}
              onClick={() => handleStartEdit(row, 'take_profit')}
            />
          </Space>
        );
      },
    },
    {
      title: '所属策略',
      key: 'strategy',
      width: 110,
      // 真正的策略归属来自 PaperTradingAttribution / RecommendationOutcome 链路；
      // 这里用占位"手动"，待 US-088 完善游资归属 / signal→position join 后再展开。
      render: () => <Tag>手动</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: any, row: PositionRow) => (
        <Space size="small">
          <Button
            size="small"
            icon={<BarChartOutlined />}
            onClick={() => setAiTarget({ symbol: row.symbol, name: row.name || null })}
            title="AI 解读：基本面 / 技术面 / 资金面 / 新闻面 / 情绪面"
          >
            AI 解读
          </Button>
          <Popconfirm
            title={`确认平仓 ${row.name || row.symbol} 全部 ${row.quantity.toLocaleString()} 股？`}
            okText="平仓"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleClosePosition(row)}
          >
            <Button
              size="small"
              danger
              icon={<StopOutlined />}
              loading={closingSymbol === row.symbol}
            >
              平仓
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <WalletOutlined />
          <span>当前持仓 · {positions.length} 只</span>
          <Tag color="blue">
            总市值 {formatMoney(positions.reduce((acc, p) => acc + Number(p.market_value), 0))}
          </Tag>
          <Tag>现金 {formatMoney(Number(data?.portfolio.current_cash || 0))}</Tag>
        </Space>
      }
    >
      {isMobile ? (
        <div className="workspace-mobile-card-list">
          {positions.map(row => (
            <PositionMobileCard
              key={row.id}
              row={row}
              totalValue={totalValue}
              editingPositionId={editingPositionId}
              editingField={editingField}
              editingValue={editingValue}
              setEditingValue={setEditingValue}
              savingLimit={savingLimit}
              closingSymbol={closingSymbol}
              handleStartEdit={handleStartEdit}
              handleCancelEdit={handleCancelEdit}
              handleSaveStopLoss={handleSaveStopLoss}
              handleSaveTakeProfit={handleSaveTakeProfit}
              handleClosePosition={handleClosePosition}
              onOpenAI={() => setAiTarget({ symbol: row.symbol, name: row.name || null })}
            />
          ))}
        </div>
      ) : (
        <Table<PositionRow>
          rowKey="id"
          size="middle"
          dataSource={positions}
          columns={columns as any}
          pagination={false}
          scroll={{ x: 1800 }}
        />
      )}
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="portfolio_position"
        />
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// PositionMobileCard (US-095) — mobile-only card rendering for a single
// position row. Replaces the wide desktop table when window < 768px. Keeps
// the same edit / close / AI buttons but stacks them vertically so labels
// stay readable and tap targets are ≥ 38px tall.
// ---------------------------------------------------------------------------
interface PositionMobileCardProps {
  row: PositionRow;
  totalValue: number;
  editingPositionId: number | null;
  editingField: 'stop_loss' | 'take_profit' | null;
  editingValue: number | null;
  setEditingValue: (v: number | null) => void;
  savingLimit: boolean;
  closingSymbol: string | null;
  handleStartEdit: (row: PositionRow, field: 'stop_loss' | 'take_profit') => void;
  handleCancelEdit: () => void;
  handleSaveStopLoss: (row: PositionRow) => Promise<void>;
  handleSaveTakeProfit: (row: PositionRow) => Promise<void>;
  handleClosePosition: (row: PositionRow) => Promise<void>;
  onOpenAI: () => void;
}

const PositionMobileCard: React.FC<PositionMobileCardProps> = ({
  row,
  totalValue,
  editingPositionId,
  editingField,
  editingValue,
  setEditingValue,
  savingLimit,
  closingSymbol,
  handleStartEdit,
  handleCancelEdit,
  handleSaveStopLoss,
  handleSaveTakeProfit,
  handleClosePosition,
  onOpenAI,
}) => {
  const pnl = Number(row.unrealized_pnl);
  const cost = Number(row.avg_cost) * Number(row.quantity);
  const pct = cost > 0 ? (pnl / cost) * 100 : 0;
  const weightPct = totalValue > 0 ? (Number(row.market_value) / totalValue) * 100 : 0;
  const currentPrice = Number(row.current_price);
  const stopLoss = row.stop_loss_price !== null ? Number(row.stop_loss_price) : null;
  const takeProfit = row.take_profit_price !== null ? Number(row.take_profit_price) : null;
  const stopLossAboveCurrent = stopLoss !== null && stopLoss >= currentPrice;
  const takeProfitReached = takeProfit !== null && takeProfit <= currentPrice;
  const isEditingStop = editingPositionId === row.id && editingField === 'stop_loss';
  const isEditingTake = editingPositionId === row.id && editingField === 'take_profit';

  return (
    <Card size="small">
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Space size={8} align="center" style={{ marginBottom: 6 }}>
          <Text strong style={{ fontSize: 14 }}>
            {row.name || row.symbol}
          </Text>
          <Text code style={{ fontSize: 12 }}>
            {row.symbol}
          </Text>
        </Space>

        <div className="workspace-mobile-card-row">
          <span className="label">浮盈</span>
          <span className="value" style={{ color: pnlColor(pnl), fontWeight: 600 }}>
            {pnl >= 0 ? '+' : ''}¥{pnl.toFixed(2)}{' '}
            <Tag color={pnl >= 0 ? 'green' : 'red'} style={{ marginLeft: 4 }}>
              {pct >= 0 ? '+' : ''}
              {pct.toFixed(2)}%
            </Tag>
          </span>
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">买入价 / 现价</span>
          <span className="value">
            ¥{Number(row.avg_cost).toFixed(2)} → ¥{currentPrice.toFixed(2)}
          </span>
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">数量 / 占比</span>
          <span className="value">
            {row.quantity.toLocaleString()} 股 · {weightPct.toFixed(2)}%
          </span>
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">买入日</span>
          <span className="value">
            {row.created_at ? dayjs(row.created_at).format('YYYY-MM-DD') : '-'}
          </span>
        </div>

        {/* US-058 [FE-019] — 高级指标 ATR / DD / 持仓天数 (mobile 一行展示) */}
        {(() => {
          const vm = buildPositionMetricsViewModel({
            atr_pct: row.atr_pct ?? null,
            current_price: row.current_price,
            highest_price: row.highest_price ?? null,
            created_at: row.created_at,
          });
          return (
            <div className="workspace-mobile-card-row">
              <span className="label">ATR / 回撤 / 天数</span>
              <span className="value">
                <Space size={4} wrap>
                  {vm.atrLevel === 'unknown' ? (
                    <Text type="secondary">ATR —</Text>
                  ) : (
                    <Tag color={POSITION_RISK_LEVEL_COLOR[vm.atrLevel]}>
                      ATR {formatPositionPct(vm.atrPct)}
                    </Tag>
                  )}
                  {vm.ddLevel === 'unknown' ? (
                    <Text type="secondary">回撤 —</Text>
                  ) : (
                    <Tag color={POSITION_RISK_LEVEL_COLOR[vm.ddLevel]}>
                      DD {formatPositionPct(vm.ddPct)}
                    </Tag>
                  )}
                  <span>{formatDaysHeld(vm.daysHeld)}</span>
                  {vm.daysHeldLevel !== 'unknown' &&
                    vm.daysHeldLevel !== 'normal' &&
                    DAYS_HELD_LEVEL_LABEL[vm.daysHeldLevel] && (
                      <Tag color={DAYS_HELD_LEVEL_COLOR[vm.daysHeldLevel]}>
                        {DAYS_HELD_LEVEL_LABEL[vm.daysHeldLevel]}
                      </Tag>
                    )}
                </Space>
              </span>
            </div>
          );
        })()}

        <div className="workspace-mobile-card-row">
          <span className="label">止损价</span>
          {isEditingStop ? (
            <Space size={4}>
              <InputNumber
                value={editingValue}
                onChange={v => setEditingValue(v as number | null)}
                min={0}
                step={0.01}
                precision={2}
                placeholder="留空清除"
                style={{ width: 110 }}
                size="small"
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={savingLimit}
                onClick={() => void handleSaveStopLoss(row)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
            </Space>
          ) : (
            <span className="value">
              {stopLoss === null ? (
                <Text type="secondary">未设置</Text>
              ) : (
                <Tag color={stopLossAboveCurrent ? 'red' : 'orange'}>¥{stopLoss.toFixed(2)}</Tag>
              )}
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                onClick={() => handleStartEdit(row, 'stop_loss')}
                style={{ marginLeft: 4 }}
              />
            </span>
          )}
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">止盈价</span>
          {isEditingTake ? (
            <Space size={4}>
              <InputNumber
                value={editingValue}
                onChange={v => setEditingValue(v as number | null)}
                min={0}
                step={0.01}
                precision={2}
                placeholder="留空清除"
                style={{ width: 110 }}
                size="small"
              />
              <Button
                size="small"
                type="primary"
                icon={<CheckOutlined />}
                loading={savingLimit}
                onClick={() => void handleSaveTakeProfit(row)}
              />
              <Button size="small" icon={<CloseOutlined />} onClick={handleCancelEdit} />
            </Space>
          ) : (
            <span className="value">
              {takeProfit === null ? (
                <Text type="secondary">未设置</Text>
              ) : (
                <Tag color={takeProfitReached ? 'green' : 'blue'}>¥{takeProfit.toFixed(2)}</Tag>
              )}
              <Button
                size="small"
                type="text"
                icon={<EditOutlined />}
                onClick={() => handleStartEdit(row, 'take_profit')}
                style={{ marginLeft: 4 }}
              />
            </span>
          )}
        </div>

        <div className="workspace-mobile-card-actions">
          <Button icon={<BarChartOutlined />} onClick={onOpenAI} size="middle">
            AI 解读
          </Button>
          <Popconfirm
            title={`确认平仓 ${row.name || row.symbol} 全部 ${row.quantity.toLocaleString()} 股？`}
            okText="平仓"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleClosePosition(row)}
          >
            <Button
              danger
              icon={<StopOutlined />}
              loading={closingSymbol === row.symbol}
              size="middle"
            >
              平仓
            </Button>
          </Popconfirm>
        </div>
      </Space>
    </Card>
  );
};

// ===========================================================================
//  Tab 2: 资金曲线
// ===========================================================================
interface EquityCurveTabProps {
  snapshots: SnapshotRow[];
  kpis: {
    totalReturnPct: number;
    annualizedReturnPct: number;
    sharpe: number;
    maxDrawdownPct: number;
    monthReturnPct: number;
    sampleDays: number;
    sampleConfidence: 'low' | 'medium' | 'high';
    winRate: number;
  };
}

const EquityCurveTab: React.FC<EquityCurveTabProps> = ({ snapshots, kpis }) => {
  const [windowKey, setWindowKey] = useState<WindowKey>('all');
  const [benchmarkSeries, setBenchmarkSeries] = useState<BenchmarkHistoryPoint[]>([]);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState<string | null>(null);

  const sliced = useMemo(
    () => sliceSnapshotsByWindow(snapshots, windowKey),
    [snapshots, windowKey]
  );

  useEffect(() => {
    if (sliced.length === 0) {
      setBenchmarkSeries([]);
      return;
    }
    const startDate = sliced[0].date;
    const endDate = sliced[sliced.length - 1].date;
    setBenchmarkLoading(true);
    setBenchmarkError(null);
    portfolioWorkspaceService
      .fetchBenchmarkHistory(BENCHMARK_SYMBOL, startDate, endDate)
      .then(setBenchmarkSeries)
      .catch((err: unknown) => {
        const messageStr = err instanceof Error ? err.message : String(err);
        setBenchmarkError(messageStr);
        setBenchmarkSeries([]);
      })
      .finally(() => setBenchmarkLoading(false));
  }, [sliced]);

  const chartData = useMemo(() => {
    if (sliced.length === 0) return [];
    const baseValue = Number(sliced[0].total_value);
    const benchmarkBase = benchmarkSeries[0]?.close ?? 0;
    const benchmarkByDate = new Map<string, number>();
    benchmarkSeries.forEach(p => benchmarkByDate.set(p.date, p.close));
    return sliced.map(s => {
      const myNetValue = baseValue > 0 ? (Number(s.total_value) / baseValue) * 100 : 100;
      const bClose = benchmarkByDate.get(s.date);
      const benchmarkNetValue =
        bClose !== undefined && benchmarkBase > 0 ? (bClose / benchmarkBase) * 100 : null;
      return {
        date: s.date,
        my: Number(myNetValue.toFixed(4)),
        benchmark: benchmarkNetValue !== null ? Number(benchmarkNetValue.toFixed(4)) : null,
      };
    });
  }, [sliced, benchmarkSeries]);

  if (snapshots.length === 0) {
    return (
      <Card>
        <Empty
          description={
            <Space direction="vertical" align="center">
              <Text>暂无资金曲线快照。</Text>
              <Text type="secondary">
                下一笔交易完成后会自动写入今日 snapshot，多日累计即可看到走势。
              </Text>
            </Space>
          }
        />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <LineChartOutlined />
            <span>净值曲线 vs {BENCHMARK_LABEL}（首日归一化为 100）</span>
            {benchmarkLoading && <Tag color="processing">基准加载中</Tag>}
          </Space>
        }
        extra={
          <Segmented<WindowKey>
            options={[
              { label: '近 30 日', value: '30d' },
              { label: '近 90 日', value: '90d' },
              { label: '近 1 年', value: '1y' },
              { label: '全部', value: 'all' },
            ]}
            value={windowKey}
            onChange={v => setWindowKey(v as WindowKey)}
          />
        }
      >
        {benchmarkError && (
          <Alert
            type="warning"
            showIcon
            message="基准指数加载失败"
            description={benchmarkError}
            style={{ marginBottom: 12 }}
          />
        )}
        <div style={{ width: '100%', height: 340 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 12, right: 20, left: 0, bottom: 12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} minTickGap={32} />
              <YAxis
                domain={['dataMin - 1', 'dataMax + 1']}
                tick={{ fontSize: 12 }}
                tickFormatter={(v: number) => `${v.toFixed(1)}`}
              />
              <RechartsTooltip
                formatter={(value: number) => [`${value.toFixed(2)}`, '净值']}
                labelFormatter={(label: string) => `日期：${label}`}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="my"
                name="我的净值"
                stroke="#1677ff"
                dot={false}
                strokeWidth={2}
              />
              <Line
                type="monotone"
                dataKey="benchmark"
                name={BENCHMARK_LABEL}
                stroke="#ff7a45"
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card title="绩效指标">
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="总收益"
              value={kpis.totalReturnPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(kpis.totalReturnPct) }}
            />
          </Col>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="年化收益"
              value={kpis.annualizedReturnPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(kpis.annualizedReturnPct) }}
            />
          </Col>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="最大回撤"
              value={kpis.maxDrawdownPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: '#dc2626' }}
            />
          </Col>
          <Col xs={12} sm={8} md={5}>
            <Statistic
              title="夏普率"
              value={kpis.sharpe}
              precision={2}
              valueStyle={{ color: kpis.sharpe >= 1 ? '#4338ca' : undefined }}
            />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic
              title="当月收益"
              value={kpis.monthReturnPct}
              precision={2}
              suffix="%"
              valueStyle={{ color: pnlColor(kpis.monthReturnPct) }}
            />
          </Col>
        </Row>
        {/* Batch BG (2026-06-23): 样本充分度 + 胜率 — 让用户判断 sharpe 可信度 */}
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={12} sm={8} md={6}>
            <Statistic
              title={
                <Tooltip title="夏普率统计意义需 60+ 个交易日, 当前数据点不足时夏普可能是 lucky 也可能 unlucky">
                  <span>统计样本 (交易日) ⓘ</span>
                </Tooltip>
              }
              value={kpis.sampleDays}
              suffix="日"
              valueStyle={{
                color:
                  kpis.sampleConfidence === 'high'
                    ? '#16a34a'
                    : kpis.sampleConfidence === 'medium'
                      ? '#fa8c16'
                      : '#dc2626',
              }}
            />
            <div style={{ fontSize: 12, color: '#999', marginTop: 4 }}>
              {kpis.sampleConfidence === 'high'
                ? '✓ 样本充足, 指标可信'
                : kpis.sampleConfidence === 'medium'
                  ? '⚠ 样本中等 (建议 60+ 日)'
                  : '⚠ 样本不足 < 20 日, 指标不可信'}
            </div>
          </Col>
          <Col xs={12} sm={8} md={6}>
            <Statistic
              title={
                <Tooltip title="日级胜率 — 上涨日数 / 总日数 (粗略). 业界 > 55% 算合格策略.">
                  <span>日级胜率 ⓘ</span>
                </Tooltip>
              }
              value={kpis.winRate}
              precision={1}
              suffix="%"
              valueStyle={{
                color: kpis.winRate >= 55 ? '#16a34a' : kpis.winRate >= 45 ? undefined : '#dc2626',
              }}
            />
          </Col>
        </Row>
      </Card>
    </Space>
  );
};

// ===========================================================================
//  Tab 3 (US-055 + US-123): 日归因卡
// ===========================================================================
/**
 * US-055 [FE-016] PortfolioWorkspace 日归因卡 — 把"最近交易日的资金变化
 * + realized/unrealized 拆解 + top contributor/detractor"汇总到一张卡.
 *
 * US-123 [PM-010] 扩展 — 把 backend `daily_attribution_reports` 真值卡 (6 维
 * pie + best/worst + AI summary) 叠加在 heuristic 卡上方: backend 报告就绪
 * 时优先展示真值, 未跑 / 失败 / 404 时 fallback 到 US-055 的 heuristic 视图.
 * 两者互补 — heuristic 是 "用 snapshot+trade 现算" 占位卡 (周末/节假日 cron
 * 不跑时仍能看), backend 是 "AttributionEngine + AIAttributionSummary 真值".
 *
 * 数据源:
 *   - heuristic 卡: 复用顶层已加载的 `snapshots` + `trades`, 不打 API.
 *   - backend 卡: GET /api/portfolio/:id/attribution/daily (PM-007 / US-084
 *     route), 由 cron DAILY_ATTRIBUTION_GENERATE (PM-006 / US-083) 在 17:00
 *     工作日 upsert. 404 = "当日报告不存在" → 隐藏 backend 卡仅显示 heuristic.
 *
 * 渲染逻辑全部在 `dailyAttributionHelpers.buildDailyAttributionViewModel` +
 * `portfolioAttributionCardHelpers.buildPortfolioAttributionCardViewModel`,
 * 本 component 只负责绘制 — 与 [[前端 pure helper 模板]] 同款.
 */
interface DailyAttributionTabProps {
  snapshots: SnapshotRow[];
  trades: TradeRow[];
  portfolioId: number | null;
}

const DailyAttributionTab: React.FC<DailyAttributionTabProps> = ({
  snapshots,
  trades,
  portfolioId,
}) => {
  const vm: DailyAttributionViewModel = useMemo(
    () => buildDailyAttributionViewModel(snapshots, trades),
    [snapshots, trades]
  );

  // US-123 [PM-010] backend 真值卡 — 按 portfolioId 拉今日 cron 报告.
  // 404 / 网络错误 → setReport(null) + 隐藏 backend 卡, 不阻塞 heuristic 视图.
  const [backendReport, setBackendReport] = useState<DailyAttributionReportRow | null>(null);
  const [backendLoading, setBackendLoading] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);

  useEffect(() => {
    if (!portfolioId) {
      setBackendReport(null);
      return;
    }
    // 切盘 race 保护 — snapshot portfolioId, await 后比对
    const callId = portfolioId;
    setBackendLoading(true);
    setBackendError(null);
    portfolioWorkspaceService
      .getDailyAttributionReport(portfolioId)
      .then(r => {
        if (callId !== portfolioId) return;
        setBackendReport(r);
      })
      .catch((err: unknown) => {
        if (callId !== portfolioId) return;
        const msg = err instanceof Error ? err.message : String(err);
        setBackendError(msg);
        setBackendReport(null);
      })
      .finally(() => {
        if (callId === portfolioId) setBackendLoading(false);
      });
  }, [portfolioId]);

  const backendVm: PortfolioAttributionCardViewModel = useMemo(
    () => buildPortfolioAttributionCardViewModel(backendReport),
    [backendReport]
  );

  if (vm.hidden && backendVm.hidden) {
    return (
      <Card title="日归因">
        <Empty
          description={
            <Space direction="vertical" align="center">
              <Text>暂无足够数据计算日归因。</Text>
              <Text type="secondary">至少需要 2 个交易日的资金快照才能算出当日变化。</Text>
            </Space>
          }
        />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* US-123 [PM-010] backend 真值卡 — 在 cron 报告就绪时显示 */}
      {!backendVm.hidden && (
        <BackendAttributionCard vm={backendVm} loading={backendLoading} error={backendError} />
      )}
      {backendVm.hidden && backendLoading && (
        <Card title="日归因 (cron 报告加载中...)">
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        </Card>
      )}
      {backendVm.hidden && !backendLoading && portfolioId !== null && (
        <Alert
          type="info"
          showIcon
          message="当日 cron 归因报告尚未生成"
          description={
            backendError
              ? `加载失败: ${backendError}. 下方仍展示 snapshot + trade 现算结果.`
              : '17:00 工作日 cron (DAILY_ATTRIBUTION_GENERATE) 跑完后才有 6 维 pie + AI summary. 下方先用 snapshot + trade 现算结果占位.'
          }
          style={{ marginBottom: 0 }}
        />
      )}
      {!vm.hidden && (
        <Card
          title={
            <Space>
              <BarChartOutlined />
              <span>
                {vm.anchorDate} 日归因 (heuristic 现算, 对比 {vm.prevDate})
              </span>
            </Space>
          }
        >
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={8} md={5}>
              <Statistic
                title="当日 P&L"
                value={vm.dailyPnl}
                precision={2}
                prefix="¥"
                valueStyle={{ color: vm.pnlColor }}
              />
            </Col>
            <Col xs={12} sm={8} md={5}>
              <Statistic
                title="当日收益率"
                value={vm.dailyReturnPct}
                precision={2}
                suffix="%"
                valueStyle={{ color: vm.pnlColor }}
              />
            </Col>
            <Col xs={12} sm={8} md={5}>
              <Tooltip title="当日 SELL 单的 realized_pnl 之和">
                <Statistic
                  title="已实现盈亏"
                  value={vm.realizedPnl}
                  precision={2}
                  prefix="¥"
                  valueStyle={{ color: pnlColor(vm.realizedPnl) }}
                />
              </Tooltip>
            </Col>
            <Col xs={12} sm={8} md={5}>
              <Tooltip title="当日 P&L − 已实现 = 持仓 mark-to-market 变化 + 当日 BUY 的浮动盈亏">
                <Statistic
                  title="浮动盈亏变化"
                  value={vm.unrealizedChange}
                  precision={2}
                  prefix="¥"
                  valueStyle={{ color: pnlColor(vm.unrealizedChange) }}
                />
              </Tooltip>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Statistic
                title="成交笔数"
                value={vm.tradeCount}
                suffix={
                  vm.tradeCount > 0 ? `（买 ${vm.buyCount} / 卖 ${vm.sellCount}）` : undefined
                }
              />
            </Col>
          </Row>
        </Card>
      )}

      {!vm.hidden && (
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Card title={<span style={{ color: DAILY_PNL_POSITIVE_COLOR_LOCAL }}>Top 正贡献</span>}>
              {vm.topContributors.length === 0 ? (
                <Empty description="今日无盈利平仓" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Table<DailyAttributionTradeRow>
                  dataSource={vm.topContributors}
                  pagination={false}
                  size="small"
                  rowKey="id"
                  columns={[
                    {
                      title: '标的',
                      dataIndex: 'name',
                      key: 'name',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Text strong>{row.name || row.symbol}</Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {row.symbol}
                          </Text>
                        </Space>
                      ),
                    },
                    {
                      title: 'Realized P&L',
                      dataIndex: 'realized_pnl',
                      key: 'realized_pnl',
                      align: 'right',
                      render: (v: number) => (
                        <Text strong style={{ color: DAILY_PNL_POSITIVE_COLOR_LOCAL }}>
                          +¥{v.toFixed(2)}
                        </Text>
                      ),
                    },
                    {
                      title: '成交额',
                      dataIndex: 'amount',
                      key: 'amount',
                      align: 'right',
                      render: (v: number) => `¥${v.toFixed(2)}`,
                    },
                  ]}
                />
              )}
            </Card>
          </Col>
          <Col xs={24} md={12}>
            <Card title={<span style={{ color: DAILY_PNL_NEGATIVE_COLOR_LOCAL }}>Top 负贡献</span>}>
              {vm.topDetractors.length === 0 ? (
                <Empty description="今日无亏损平仓" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <Table<DailyAttributionTradeRow>
                  dataSource={vm.topDetractors}
                  pagination={false}
                  size="small"
                  rowKey="id"
                  columns={[
                    {
                      title: '标的',
                      dataIndex: 'name',
                      key: 'name',
                      render: (_, row) => (
                        <Space direction="vertical" size={0}>
                          <Text strong>{row.name || row.symbol}</Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {row.symbol}
                          </Text>
                        </Space>
                      ),
                    },
                    {
                      title: 'Realized P&L',
                      dataIndex: 'realized_pnl',
                      key: 'realized_pnl',
                      align: 'right',
                      render: (v: number) => (
                        <Text strong style={{ color: DAILY_PNL_NEGATIVE_COLOR_LOCAL }}>
                          ¥{v.toFixed(2)}
                        </Text>
                      ),
                    },
                    {
                      title: '成交额',
                      dataIndex: 'amount',
                      key: 'amount',
                      align: 'right',
                      render: (v: number) => `¥${v.toFixed(2)}`,
                    },
                  ]}
                />
              )}
            </Card>
          </Col>
        </Row>
      )}
    </Space>
  );
};

// ---------------------------------------------------------------------------
// US-123 [PM-010] — backend cron 报告卡 (6 维 pie + best/worst + AI summary)
// ---------------------------------------------------------------------------
interface BackendAttributionCardProps {
  vm: PortfolioAttributionCardViewModel;
  loading: boolean;
  error: string | null;
}

const BackendAttributionCard: React.FC<BackendAttributionCardProps> = ({ vm, loading, error }) => {
  const titleNode = (
    <Space>
      <BarChartOutlined />
      <span>{vm.date} 日归因 (cron 真值)</span>
      {vm.status === 'ok' && <Tag color="green">已生成</Tag>}
      {vm.status === 'skipped' && <Tag color="default">已跳过</Tag>}
      {vm.status === 'failed' && <Tag color="red">失败</Tag>}
      {loading && <Tag color="processing">刷新中</Tag>}
    </Space>
  );
  const statusBanner =
    vm.status !== 'ok' ? (
      <Alert
        type={vm.status === 'failed' ? 'error' : 'warning'}
        showIcon
        style={{ marginBottom: 12 }}
        message={vm.status === 'failed' ? '归因报告生成失败' : '当日归因被跳过'}
        description={vm.statusReason || '查看 logs 排查; 数据仍按现有 breakdown 展示.'}
      />
    ) : null;
  const errorBanner = error ? (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      message="cron 报告加载失败"
      description={error}
    />
  ) : null;
  return (
    <Card title={titleNode}>
      {statusBanner}
      {errorBanner}
      {/* 顶部 KPI 一栏 */}
      <Row gutter={[16, 16]} style={{ marginBottom: 12 }}>
        <Col xs={12} sm={8} md={5}>
          <Statistic
            title="当日 P&L"
            value={vm.totalPnl}
            precision={2}
            prefix="¥"
            valueStyle={{ color: pnlColor(vm.totalPnl) }}
          />
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Statistic
            title="当日收益率"
            value={vm.totalPnlPct ?? 0}
            precision={2}
            suffix={vm.totalPnlPct == null ? ' —' : '%'}
            valueStyle={{ color: pnlColor(vm.totalPnl) }}
          />
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Tooltip title="当日 SELL realized_pnl 之和 (后端口径)">
            <Statistic
              title="已实现"
              value={vm.realizedPnl}
              precision={2}
              prefix="¥"
              valueStyle={{ color: pnlColor(vm.realizedPnl) }}
            />
          </Tooltip>
        </Col>
        <Col xs={12} sm={8} md={5}>
          <Tooltip title="残差 (运气) = 总盈亏 − 已知 6 维之和; |残差|/|总盈亏| 越大说明可解释性越弱">
            <Statistic
              title="残差"
              value={vm.residual}
              precision={2}
              prefix="¥"
              valueStyle={{ color: pnlColor(vm.residual) }}
            />
          </Tooltip>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Statistic
            title="成交笔数"
            value={vm.tradeCount}
            suffix={vm.tradeCount > 0 ? `（买 ${vm.buyCount} / 卖 ${vm.sellCount}）` : undefined}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        {/* 6 维 pie */}
        <Col xs={24} md={12}>
          <Card size="small" type="inner" title="6 维归因分布">
            {vm.totalAbs <= 0 ? (
              <Empty description="6 维 placeholder 全 0 — 等待 PM-002 真填值" />
            ) : (
              <div style={{ width: '100%', height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={vm.pieData.filter(s => s.absValue > 0)}
                      dataKey="absValue"
                      nameKey="label"
                      cx="50%"
                      cy="50%"
                      outerRadius={90}
                      labelLine={false}
                      label={(entry: AttributionPieSlice) =>
                        `${entry.label} ${(entry.pctOfAbs * 100).toFixed(0)}%`
                      }
                    >
                      {vm.pieData
                        .filter(s => s.absValue > 0)
                        .map(s => (
                          <Cell key={s.key} fill={s.color} />
                        ))}
                    </Pie>
                    <RechartsTooltip
                      formatter={(value: number, _name: string, ctx: any) => {
                        const slice: AttributionPieSlice | undefined = ctx?.payload;
                        if (!slice) return [`¥${value.toFixed(2)}`, ''];
                        const sign = slice.value >= 0 ? '+' : '';
                        return [`${sign}¥${slice.value.toFixed(2)}`, slice.label];
                      }}
                    />
                    <Legend
                      formatter={(_value: string, entry: any) => {
                        const slice: AttributionPieSlice | undefined = entry?.payload;
                        if (!slice) return _value;
                        const sign = slice.value >= 0 ? '+' : '';
                        return `${slice.label} (${sign}¥${slice.value.toFixed(0)})`;
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>
        </Col>
        {/* AI summary + 行业 / 因子 top */}
        <Col xs={24} md={12}>
          <Card
            size="small"
            type="inner"
            title={
              <Space>
                <span>AI 复盘摘要</span>
                <Tag color={vm.aiSummaryIsBackend ? 'blue' : 'default'}>
                  {vm.aiSummaryIsBackend ? 'LLM 真值' : '前端兜底'}
                </Tag>
              </Space>
            }
          >
            <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
              {vm.aiSummary || <Text type="secondary">（无摘要）</Text>}
            </Paragraph>
            {vm.industryTop.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                  行业贡献 Top:
                </Text>
                <Space wrap size={[4, 4]}>
                  {vm.industryTop.map(it => {
                    const pnl = Number(it.pnl) || 0;
                    return (
                      <Tag key={it.industry} color={pnl >= 0 ? 'green' : 'red'}>
                        {it.industry} {pnl >= 0 ? '+' : ''}¥{pnl.toFixed(0)}
                      </Tag>
                    );
                  })}
                </Space>
              </div>
            )}
            {vm.factorTop.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                  因子贡献 Top:
                </Text>
                <Space wrap size={[4, 4]}>
                  {vm.factorTop.map(it => {
                    const pnl = Number(it.pnl) || 0;
                    return (
                      <Tag key={it.factor} color={pnl >= 0 ? 'green' : 'red'}>
                        {it.factor} {pnl >= 0 ? '+' : ''}¥{pnl.toFixed(0)}
                      </Tag>
                    );
                  })}
                </Space>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* Best / Worst (backend cron 输出, 与 heuristic 现算独立) */}
      <Row gutter={[16, 16]} style={{ marginTop: 12 }}>
        <Col xs={24} md={12}>
          <Card
            size="small"
            type="inner"
            title={<span style={{ color: ATTRIBUTION_POSITIVE_COLOR }}>Best 3 (cron)</span>}
          >
            {vm.bestTrades.length === 0 ? (
              <Empty description="今日无盈利平仓" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Table<AttributionTradeRow>
                dataSource={vm.bestTrades}
                pagination={false}
                size="small"
                rowKey="id"
                columns={[
                  {
                    title: '标的',
                    dataIndex: 'name',
                    key: 'name',
                    render: (_, row) => (
                      <Space direction="vertical" size={0}>
                        <Text strong>{row.name || row.symbol}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {row.symbol}
                        </Text>
                      </Space>
                    ),
                  },
                  {
                    title: 'Realized',
                    dataIndex: 'realized_pnl',
                    key: 'realized_pnl',
                    align: 'right',
                    render: (v: number, row) => (
                      <Space direction="vertical" size={0} align="end">
                        <Text strong style={{ color: ATTRIBUTION_POSITIVE_COLOR }}>
                          +¥{v.toFixed(2)}
                        </Text>
                        {row.realized_pnl_pct !== null && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {row.realized_pnl_pct >= 0 ? '+' : ''}
                            {row.realized_pnl_pct.toFixed(2)}%
                          </Text>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} md={12}>
          <Card
            size="small"
            type="inner"
            title={<span style={{ color: ATTRIBUTION_NEGATIVE_COLOR }}>Worst 3 (cron)</span>}
          >
            {vm.worstTrades.length === 0 ? (
              <Empty description="今日无亏损平仓" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Table<AttributionTradeRow>
                dataSource={vm.worstTrades}
                pagination={false}
                size="small"
                rowKey="id"
                columns={[
                  {
                    title: '标的',
                    dataIndex: 'name',
                    key: 'name',
                    render: (_, row) => (
                      <Space direction="vertical" size={0}>
                        <Text strong>{row.name || row.symbol}</Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {row.symbol}
                        </Text>
                      </Space>
                    ),
                  },
                  {
                    title: 'Realized',
                    dataIndex: 'realized_pnl',
                    key: 'realized_pnl',
                    align: 'right',
                    render: (v: number, row) => (
                      <Space direction="vertical" size={0} align="end">
                        <Text strong style={{ color: ATTRIBUTION_NEGATIVE_COLOR }}>
                          ¥{v.toFixed(2)}
                        </Text>
                        {row.realized_pnl_pct !== null && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {row.realized_pnl_pct >= 0 ? '+' : ''}
                            {row.realized_pnl_pct.toFixed(2)}%
                          </Text>
                        )}
                      </Space>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>
    </Card>
  );
};

// Card title 颜色 — 与 helper 内部常量同步, 避免 component 内再 import 一遍.
const DAILY_PNL_POSITIVE_COLOR_LOCAL = '#16a34a';
const DAILY_PNL_NEGATIVE_COLOR_LOCAL = '#dc2626';

// ===========================================================================
//  Tab 4: 交易明细
// ===========================================================================
interface TradesTabProps {
  trades: TradeRow[];
}

const TradesTab: React.FC<TradesTabProps> = ({ trades }) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [directionFilter, setDirectionFilter] = useState<'all' | 'BUY' | 'SELL'>('all');
  const [dateRange, setDateRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [strategyFilter, setStrategyFilter] = useState<string>('all');

  const filtered = useMemo(() => {
    return trades.filter(t => {
      if (directionFilter !== 'all' && t.direction !== directionFilter) return false;
      if (dateRange && dateRange[0] && dateRange[1]) {
        const day = dayjs(t.created_at);
        if (day.isBefore(dateRange[0], 'day') || day.isAfter(dateRange[1], 'day')) return false;
      }
      // 策略筛选当前为 placeholder：仅 BUY = "手动 / 自动跟单" 流水
      // 真正策略归属来自 QuantSignal join (US-088 之后)
      if (strategyFilter === 'manual' && t.realized_pnl !== null) return false;
      return true;
    });
  }, [trades, directionFilter, dateRange, strategyFilter]);

  if (trades.length === 0) {
    return (
      <Card>
        <Empty description="暂无交易记录" />
      </Card>
    );
  }

  const columns = [
    {
      title: '日期',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 160,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
      defaultSortOrder: 'descend' as const,
      sorter: (a: TradeRow, b: TradeRow) =>
        dayjs(a.created_at).valueOf() - dayjs(b.created_at).valueOf(),
    },
    {
      title: '代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 110,
      render: (v: string) => (
        <a onClick={() => navigate(`/stock/${v}`)}>
          <Text code>{v}</Text>
        </a>
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
      render: (v: string, row: TradeRow) =>
        v ? <a onClick={() => navigate(`/stock/${row.symbol}`)}>{v}</a> : '—',
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      width: 80,
      render: (v: string) =>
        v === 'BUY' ? <Tag color="green">买入</Tag> : <Tag color="red">卖出</Tag>,
    },
    {
      title: '成交价',
      dataIndex: 'execute_price',
      key: 'execute_price',
      width: 100,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      width: 90,
      align: 'right' as const,
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      width: 120,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toLocaleString()}`,
    },
    {
      title: '手续费',
      dataIndex: 'commission',
      key: 'commission',
      width: 90,
      align: 'right' as const,
      render: (v: number) => `¥${Number(v).toFixed(2)}`,
    },
    {
      title: '实现盈亏',
      dataIndex: 'realized_pnl',
      key: 'realized_pnl',
      width: 120,
      align: 'right' as const,
      render: (v: number | null) => {
        if (v === null || v === undefined) return <Text type="secondary">-</Text>;
        return (
          <span style={{ color: pnlColor(v), fontWeight: 500 }}>
            {v >= 0 ? '+' : ''}¥{Number(v).toFixed(2)}
          </span>
        );
      },
    },
    {
      // AL-3 (2026-06-21): 用户原话 "买入卖出的时候需要额外补充上原因".
      // TradeReasonCell 行内显示 summary, Popover 展开完整 evidence / key_reasons / risk_trigger.
      title: '操作理由',
      key: 'trade_reason',
      width: 240,
      render: (_v: unknown, row: TradeRow) => (
        <TradeReasonCell
          trade_reason={row.trade_reason}
          trade_reason_summary={row.trade_reason_summary}
        />
      ),
    },
  ];

  return (
    <Card
      title={
        <Space>
          <UnorderedListOutlined />
          <span>交易明细 · 共 {filtered.length} 笔（最近 100 条）</span>
        </Space>
      }
      extra={
        <Space wrap>
          <Radio.Group
            value={directionFilter}
            onChange={e => setDirectionFilter(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            size="small"
          >
            <Radio.Button value="all">全部</Radio.Button>
            <Radio.Button value="BUY">买入</Radio.Button>
            <Radio.Button value="SELL">卖出</Radio.Button>
          </Radio.Group>
          <Select
            size="small"
            value={strategyFilter}
            onChange={setStrategyFilter}
            style={{ width: 140 }}
            options={[
              { label: '全部策略', value: 'all' },
              { label: '仅 BUY 流水', value: 'manual' },
            ]}
          />
          <RangePicker
            size="small"
            value={dateRange as any}
            onChange={v => setDateRange(v as any)}
            allowClear
          />
        </Space>
      }
    >
      <Table<TradeRow>
        rowKey="id"
        size="middle"
        dataSource={filtered}
        columns={columns as any}
        scroll={{ x: 1250 }}
        pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: ['10', '20', '50'] }}
        style={{ display: isMobile ? 'none' : undefined }}
      />
      {isMobile && (
        <div className="workspace-mobile-card-list">
          {filtered
            .slice()
            .sort((a, b) => dayjs(b.created_at).valueOf() - dayjs(a.created_at).valueOf())
            .slice(0, 50)
            .map(row => (
              <TradeMobileCard key={row.id} row={row} />
            ))}
          {filtered.length > 50 && (
            <Text type="secondary" style={{ textAlign: 'center', display: 'block', padding: 12 }}>
              已展示最近 50 笔，桌面端可查看完整分页表格
            </Text>
          )}
        </div>
      )}
    </Card>
  );
};

// ---------------------------------------------------------------------------
// TradeMobileCard (US-095) — mobile-only render for a single trade row.
// ---------------------------------------------------------------------------
const TradeMobileCard: React.FC<{ row: TradeRow }> = ({ row }) => {
  const realizedPnl = row.realized_pnl;
  return (
    <Card size="small">
      <Space direction="vertical" size={2} style={{ width: '100%' }}>
        <Space size={8} align="center" style={{ marginBottom: 4 }}>
          {row.direction === 'BUY' ? <Tag color="green">买入</Tag> : <Tag color="red">卖出</Tag>}
          <Text strong style={{ fontSize: 14 }}>
            {row.name || row.symbol}
          </Text>
          <Text code style={{ fontSize: 12 }}>
            {row.symbol}
          </Text>
        </Space>

        <div className="workspace-mobile-card-row">
          <span className="label">时间</span>
          <span className="value">{dayjs(row.created_at).format('YYYY-MM-DD HH:mm')}</span>
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">成交价 × 数量</span>
          <span className="value">
            ¥{Number(row.execute_price).toFixed(2)} × {row.quantity.toLocaleString()}
          </span>
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">金额</span>
          <span className="value">¥{Number(row.amount).toLocaleString()}</span>
        </div>

        <div className="workspace-mobile-card-row">
          <span className="label">手续费</span>
          <span className="value">¥{Number(row.commission).toFixed(2)}</span>
        </div>

        {realizedPnl !== null && realizedPnl !== undefined && (
          <div className="workspace-mobile-card-row">
            <span className="label">实现盈亏</span>
            <span
              className="value"
              style={{ color: pnlColor(Number(realizedPnl)), fontWeight: 600 }}
            >
              {Number(realizedPnl) >= 0 ? '+' : ''}¥{Number(realizedPnl).toFixed(2)}
            </span>
          </div>
        )}

        {/* AL-3 (2026-06-21): 操作理由 */}
        <div className="workspace-mobile-card-row" style={{ alignItems: 'flex-start' }}>
          <span className="label">操作理由</span>
          <span className="value" style={{ flex: 1, textAlign: 'right' }}>
            <TradeReasonCell
              trade_reason={row.trade_reason}
              trade_reason_summary={row.trade_reason_summary}
              maxInlineChars={28}
            />
          </span>
        </div>
      </Space>
    </Card>
  );
};

// ===========================================================================
//  Tab 4: 复盘日记
// ===========================================================================
interface JournalTabProps {
  list: JournalSummary[];
  onListRefresh: () => void;
}

const JournalTab: React.FC<JournalTabProps> = ({ list, onListRefresh }) => {
  const [selectedDate, setSelectedDate] = useState<string | null>(
    list.length > 0 ? list[0].date : null
  );
  const [detail, setDetail] = useState<JournalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [noteContent, setNoteContent] = useState('');
  const [appending, setAppending] = useState(false);

  // US-056 [FE-017]: 周/月/季 聚合 — period='day' 时直接走原日历表;
  // 选 week/month/quarter 时 helper 把 list 分桶, 用户先选桶再下钻具体日.
  const [periodKey, setPeriodKey] = useState<JournalPeriod>('day');
  const [selectedBucketKey, setSelectedBucketKey] = useState<string | null>(null);
  const periodBuckets = useMemo<JournalPeriodBucket[]>(
    () => (periodKey === 'day' ? [] : groupJournalsByPeriod(list, periodKey)),
    [list, periodKey]
  );
  const currentBucket = useMemo<JournalPeriodBucket | null>(
    () => (periodKey === 'day' ? null : findBucket(periodBuckets, selectedBucketKey)),
    [periodKey, periodBuckets, selectedBucketKey]
  );
  // period 切换时默认选中第一个桶 (最近期)
  useEffect(() => {
    if (periodKey === 'day') return;
    if (periodBuckets.length === 0) {
      setSelectedBucketKey(null);
      return;
    }
    if (!selectedBucketKey || !periodBuckets.some(b => b.key === selectedBucketKey)) {
      setSelectedBucketKey(periodBuckets[0].key);
    }
  }, [periodKey, periodBuckets, selectedBucketKey]);

  useEffect(() => {
    if (!selectedDate) {
      setDetail(null);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    portfolioWorkspaceService
      .getJournalDetail(selectedDate)
      .then(d => setDetail(d))
      .catch((err: unknown) => {
        const messageStr = err instanceof Error ? err.message : String(err);
        setDetailError(messageStr);
      })
      .finally(() => setDetailLoading(false));
  }, [selectedDate]);

  const handleAppend = async () => {
    if (!selectedDate || !noteContent.trim()) {
      message.warning('请先选择日期并输入手记内容');
      return;
    }
    setAppending(true);
    try {
      const result = await portfolioWorkspaceService.appendJournalNote(selectedDate, noteContent);
      message.success('已追加手记');
      setNoteContent('');
      setDetail(prev => (prev ? { ...prev, user_notes: result.user_notes } : prev));
      const hasDate = list.some(j => j.date === selectedDate);
      if (!hasDate) {
        onListRefresh();
      }
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(messageStr);
    } finally {
      setAppending(false);
    }
  };

  return (
    <div className="journal-tab-wrap">
    <Row gutter={[20, 16]}>
      <Col xs={24} md={8} lg={6}>
        <Card
          size="small"
          title={
            <Space>
              <ReadOutlined />
              <span>
                {periodKey === 'day' ? '日期列表' : `${JOURNAL_PERIOD_LABEL[periodKey]}聚合`}
              </span>
            </Space>
          }
          extra={
            <DatePicker
              size="small"
              allowClear
              placeholder="选择任意日"
              value={selectedDate ? dayjs(selectedDate) : null}
              onChange={d => setSelectedDate(d ? d.format('YYYY-MM-DD') : null)}
            />
          }
        >
          {/* US-056 [FE-017]: 维度切换 — day/week/month/quarter */}
          <Segmented<JournalPeriod>
            block
            size="small"
            options={JOURNAL_PERIOD_VALUES.map(v => ({
              label: JOURNAL_PERIOD_LABEL[v],
              value: v,
            }))}
            value={periodKey}
            onChange={v => setPeriodKey(v as JournalPeriod)}
            style={{ marginBottom: 8 }}
          />
          {periodKey !== 'day' ? (
            periodBuckets.length === 0 ? (
              <Empty
                description={
                  <Text type="secondary">暂无可聚合的复盘记录。先在「日」维度下追加手记。</Text>
                }
              />
            ) : (
              <List
                size="small"
                dataSource={periodBuckets}
                renderItem={(bucket: JournalPeriodBucket) => (
                  <List.Item
                    onClick={() => setSelectedBucketKey(bucket.key)}
                    style={{
                      cursor: 'pointer',
                      background: selectedBucketKey === bucket.key ? '#e6f4ff' : 'transparent',
                      padding: '6px 12px',
                      borderRadius: 8,
                    }}
                  >
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Space wrap>
                        <Text strong style={{ fontSize: 14 }}>
                          {bucket.label}
                        </Text>
                        <Tag>{bucket.journalCount} 篇</Tag>
                      </Space>
                      <Space wrap size={4}>
                        {bucket.dominantMood && (
                          <Tag color="blue" style={{ marginInlineEnd: 0 }}>
                            {bucket.dominantMood}
                          </Tag>
                        )}
                        {bucket.topTags.slice(0, 3).map(t => (
                          <Tag key={t} style={{ marginInlineEnd: 0 }}>
                            {t}
                          </Tag>
                        ))}
                      </Space>
                    </Space>
                  </List.Item>
                )}
              />
            )
          ) : list.length === 0 ? (
            <Empty
              description={
                <Text type="secondary">
                  暂无 AI 复盘。可直接在日期选择器选任意日，追加手记自动建档。
                </Text>
              }
            />
          ) : (
            <List
              size="small"
              dataSource={list}
              renderItem={(item: JournalSummary) => (
                <List.Item
                  onClick={() => setSelectedDate(item.date)}
                  style={{
                    cursor: 'pointer',
                    background: selectedDate === item.date ? '#e6f4ff' : 'transparent',
                    padding: '6px 12px',
                    borderRadius: 8,
                  }}
                >
                  <Space>
                    <Text strong>{item.date}</Text>
                    {item.mood && item.mood !== '未生成' ? (
                      <Tag color="blue">{item.mood}</Tag>
                    ) : (
                      <Tag>无 AI 总结</Tag>
                    )}
                  </Space>
                </List.Item>
              )}
            />
          )}
        </Card>
      </Col>
      <Col xs={24} md={16} lg={18}>
        {periodKey !== 'day' && currentBucket && (
          <Card
            size="small"
            style={{ marginBottom: 12 }}
            title={
              <Space>
                <ReadOutlined />
                <span>{currentBucket.label} · 期内概览</span>
                <Tag>{currentBucket.journalCount} 篇</Tag>
              </Space>
            }
          >
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {currentBucket.startDate} ~ {currentBucket.endDate}
              </Text>
              {Object.keys(currentBucket.moodCounts).length > 0 && (
                <Space wrap>
                  <Text type="secondary">情绪分布:</Text>
                  {Object.entries(currentBucket.moodCounts).map(([m, c]) => (
                    <Tag key={m} color={m === currentBucket.dominantMood ? 'purple' : undefined}>
                      {m} × {c}
                    </Tag>
                  ))}
                </Space>
              )}
              {currentBucket.topTags.length > 0 && (
                <Space wrap>
                  <Text type="secondary">高频标签:</Text>
                  {currentBucket.topTags.slice(0, 8).map(t => (
                    <Tag key={t}>{t}</Tag>
                  ))}
                </Space>
              )}
              <div>
                <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                  期内日记 (点击下钻):
                </Text>
                <Space wrap>
                  {currentBucket.journals.map(j => (
                    <Button
                      key={j.id}
                      size="small"
                      type={selectedDate === j.date ? 'primary' : 'default'}
                      onClick={() => setSelectedDate(j.date)}
                    >
                      {j.date}
                    </Button>
                  ))}
                </Space>
              </div>
            </Space>
          </Card>
        )}
        <Card
          size="small"
          title={
            <Space>
              <ReadOutlined />
              <span>{selectedDate ? `${selectedDate} 复盘` : '请选择日期'}</span>
              {detail?.mood && detail.mood !== '未生成' && <Tag color="blue">{detail.mood}</Tag>}
            </Space>
          }
        >
          {detailLoading ? (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <Spin />
            </div>
          ) : detailError ? (
            <Alert type="error" showIcon message="加载日记失败" description={detailError} />
          ) : !selectedDate ? (
            <Empty description="左侧点击日期或上方选择任意日" />
          ) : !detail ? (
            <Empty
              description={
                <Space direction="vertical" align="center">
                  <Text type="secondary">该日期还没有复盘记录。</Text>
                  <Text type="secondary">AI 自动复盘待 US-087 实现；在下方输入手记即可建档。</Text>
                </Space>
              }
            />
          ) : (
            <Space direction="vertical" size={20} style={{ width: '100%' }}>
              <JournalSection title="市场总结" content={detail.market_summary} />
              <JournalSection title="持仓点评" content={detail.portfolio_analysis} />
              {detail.action_plan && (
                <JournalSection title="明日策略" content={detail.action_plan} />
              )}
              {detail.tags && detail.tags.length > 0 && (
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                    标签：
                  </Text>
                  <Space wrap>
                    {detail.tags.map(t => (
                      <Tag key={t}>{t}</Tag>
                    ))}
                  </Space>
                </div>
              )}
              <div>
                <Text strong style={{ display: 'block', marginBottom: 8 }}>
                  我的手记
                </Text>
                {detail.user_notes && detail.user_notes.length > 0 ? (
                  <Timeline
                    items={detail.user_notes.map(n => ({
                      color: 'blue',
                      children: (
                        <>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {dayjs(n.created_at).format('YYYY-MM-DD HH:mm')}
                          </Text>
                          <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                            {n.content}
                          </Paragraph>
                        </>
                      ),
                    }))}
                  />
                ) : (
                  <Text type="secondary">暂无手记，在下方输入框追加。</Text>
                )}
              </div>
            </Space>
          )}
          {selectedDate && (
            <div style={{ marginTop: 16 }}>
              <TextArea
                rows={3}
                placeholder="追加一条手记（最长 5000 字）..."
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                maxLength={5000}
                showCount
              />
              <div style={{ marginTop: 8, textAlign: 'right' }}>
                <Button
                  type="primary"
                  loading={appending}
                  onClick={() => void handleAppend()}
                  disabled={!noteContent.trim()}
                >
                  追加手记
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Col>
    </Row>
    </div>
  );
};

interface JournalSectionProps {
  title: string;
  content: string;
}

const JournalSection: React.FC<JournalSectionProps> = ({ title, content }) => (
  <div>
    <Text strong style={{ display: 'block', marginBottom: 4 }}>
      {title}
    </Text>
    <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0, color: '#444' }}>
      {content || <Text type="secondary">（无内容）</Text>}
    </Paragraph>
  </div>
);

// ===========================================================================
//  Tab 5: AI 日记 + 错误模式 (US-059 [FE-020])
// ===========================================================================
/**
 * AC 关键点 (US-059 [FE-020] 落地; 渲染逻辑抽到 `errorPatternsHelpers`):
 *   - 数据源完全复用已加载的 trades + journalList — 不打新 API. backend
 *     TradeRootCauseClassifier 已存在但 trade_root_cause endpoint 未挂在
 *     paper_trading 路径上, 待 followup. 当前用现有字段推 4 类 pattern:
 *     repeat_loss (反复踩雷) / large_loss (大额亏损) / same_day_streak
 *     (单日连亏) / chronic_loss (慢性失血).
 *   - AI 日记摘要: 算 mood='AI' (与 EnhancedTradingJournalService 同源) /
 *     用户手写 / 未填三态计数 + 近 7/30 天活跃度 + tag top-10.
 *   - 配色复用 SellSuggestionCard 业务语义 (critical=红/high=橙/medium=黄/
 *     low=灰), 与 [[前端 pure helper 模板]] 排序 3 段稳定一致.
 *   - hidden=true (无 SELL 且无 journal) → 显示 Empty 占位; 全盈利但 SELL>0
 *     → 显示 KPI 0% 亏损率 + "无错误模式" 提示.
 *   - **UI 提示 + backend 独立执行 二元结构** (与 US-044 SellSuggestionCard
 *     同思想): 本 tab 只展示 + 让用户点 trade 跳交易明细, 不调任何写接口.
 */
interface ErrorPatternsTabProps {
  trades: TradeRow[];
  journalList: JournalSummary[];
}

const ErrorPatternsTab: React.FC<ErrorPatternsTabProps> = ({ trades, journalList }) => {
  const vm: ErrorPatternsViewModel = useMemo(
    () => buildErrorPatternsViewModel(trades, journalList),
    [trades, journalList]
  );
  if (vm.hidden) {
    return (
      <Empty
        description={
          <Space direction="vertical" align="center">
            <Text type="secondary">暂无足够数据生成错误模式分析。</Text>
            <Text type="secondary">
              建议先建立持仓与交易, 待 AI 日记 (US-087 cron) 跑起来后再回看。
            </Text>
          </Space>
        }
      />
    );
  }
  return (
    <Row gutter={[16, 16]}>
      {/* 顶部 KPI: 亏损率 / 亏损笔数 / 总亏损金额 */}
      <Col xs={24}>
        <Card size="small" title="盘后复盘 KPI">
          <Row gutter={16}>
            <Col xs={12} md={6}>
              <Statistic
                title="已结仓亏损率"
                value={vm.lossRate * 100}
                precision={1}
                suffix="%"
                valueStyle={
                  vm.lossRate > 0.5 ? { color: ERROR_PATTERN_PRIORITY_COLOR.critical } : undefined
                }
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="亏损笔数"
                value={vm.lossTradeCount}
                suffix={`/ ${vm.sellTradeCount}`}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="累计亏损金额"
                value={vm.totalRealizedLoss}
                precision={2}
                prefix="¥"
                valueStyle={
                  vm.totalRealizedLoss > 0
                    ? { color: ERROR_PATTERN_PRIORITY_COLOR.critical }
                    : undefined
                }
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="识别错误模式"
                value={vm.patterns.length}
                suffix={`种 / 共 ${vm.lossTradeCount} 笔亏损`}
              />
            </Col>
          </Row>
        </Card>
      </Col>

      {/* 错误模式列表 */}
      <Col xs={24} lg={16}>
        <Card
          size="small"
          title="错误模式"
          extra={<Text type="secondary">基于已结仓 SELL 推算</Text>}
        >
          {vm.patterns.length === 0 ? (
            <Empty description="未检测到典型错误模式 (赞 👍)" />
          ) : (
            <List
              size="small"
              dataSource={vm.patterns}
              renderItem={(row: ErrorPatternRow) => (
                <List.Item key={row.key}>
                  <Space direction="vertical" style={{ width: '100%' }} size={2}>
                    <Space>
                      <Tag color={ERROR_PATTERN_PRIORITY_COLOR[row.priority]}>
                        {ERROR_PATTERN_PRIORITY_LABEL[row.priority]}
                      </Tag>
                      <Tag>{ERROR_PATTERN_KIND_LABEL[row.kind]}</Tag>
                      <Text strong>{row.title}</Text>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {row.detail}
                      {row.tradeIds.length > 0 && (
                        <span style={{ marginLeft: 8 }}>
                          (涉及 trade id: {row.tradeIds.slice(0, 5).join(', ')}
                          {row.tradeIds.length > 5 ? `, +${row.tradeIds.length - 5}` : ''})
                        </span>
                      )}
                    </Text>
                  </Space>
                </List.Item>
              )}
            />
          )}
        </Card>
      </Col>

      {/* AI 日记摘要 */}
      <Col xs={24} lg={8}>
        <Card size="small" title="AI 日记摘要">
          {vm.journalSummary.hidden ? (
            <Empty description="暂无 AI 日记" />
          ) : (
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <Row gutter={8}>
                <Col span={12}>
                  <Statistic
                    title="AI 自动覆盖"
                    value={formatPatternRatio(vm.journalSummary.aiCoverageRatio, 1)}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="总日记数"
                    value={vm.journalSummary.totalCount}
                    suffix={`AI ${vm.journalSummary.aiCount} / 手写 ${vm.journalSummary.handCount}`}
                  />
                </Col>
              </Row>
              <Row gutter={8}>
                <Col span={12}>
                  <Statistic title="近 7 天" value={vm.journalSummary.last7dCount} suffix="天" />
                </Col>
                <Col span={12}>
                  <Statistic title="近 30 天" value={vm.journalSummary.last30dCount} suffix="天" />
                </Col>
              </Row>
              {vm.journalSummary.topTags.length > 0 && (
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
                    高频标签 Top {vm.journalSummary.topTags.length}：
                  </Text>
                  <Space wrap size={[4, 4]}>
                    {vm.journalSummary.topTags.map(t => (
                      <Tag key={t.tag}>
                        {t.tag} <Text type="secondary">({t.count})</Text>
                      </Tag>
                    ))}
                  </Space>
                </div>
              )}
              {vm.journalSummary.unlabeledCount > 0 && (
                <Alert
                  type="info"
                  showIcon
                  message={`${vm.journalSummary.unlabeledCount} 条未标 mood`}
                  description={`建议给历史日记补 mood/tag 让 AI 模式识别更准 (用 ¥${formatPatternMoney(
                    vm.totalRealizedLoss
                  )} 的代价学到的教训别浪费)`}
                />
              )}
            </Space>
          )}
        </Card>
      </Col>
    </Row>
  );
};

// ===========================================================================
//  Helpers
// ===========================================================================

function pnlColor(value: number): string | undefined {
  // Phase 5 (2026-06-27): A 股惯例红涨绿跌. 旧实现误把上涨上绿色 (国际惯例),
  // 与 FactorWorkspace / TodayWorkspace 不一致, 在持仓盈亏列表造成"看到绿色以为亏了".
  // 颜色与 index.css :root 的 --up / --down 保持同源.
  if (value > 0) return '#dc2626';
  if (value < 0) return '#16a34a';
  return undefined;
}

function computeDailyReturns(equity: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    if (equity[i - 1] > 0 && Number.isFinite(equity[i])) {
      out.push(equity[i] / equity[i - 1] - 1);
    }
  }
  return out;
}

function computeMaxDrawdownPct(equity: number[]): number {
  let peak = equity[0] || 0;
  let maxDd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

function computeSharpeRatio(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((acc, v) => acc + v, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(252);
}

function annualizeReturnPct(snapshots: SnapshotRow[]): number {
  if (snapshots.length < 2) return 0;
  const first = Number(snapshots[0].total_value);
  const last = Number(snapshots[snapshots.length - 1].total_value);
  if (first <= 0) return 0;
  const days = dayjs(snapshots[snapshots.length - 1].date).diff(dayjs(snapshots[0].date), 'day');
  if (days <= 0) return 0;
  const totalReturn = last / first;
  if (totalReturn <= 0) return 0;
  // 按 365 自然日折算到 1 年
  return (Math.pow(totalReturn, 365 / days) - 1) * 100;
}

function sliceSnapshotsByWindow(snapshots: SnapshotRow[], window: WindowKey): SnapshotRow[] {
  if (window === 'all' || snapshots.length === 0) return snapshots;
  const lastDate = dayjs(snapshots[snapshots.length - 1].date);
  const lookback = window === '30d' ? 30 : window === '90d' ? 90 : window === '1y' ? 365 : 0;
  if (lookback === 0) return snapshots;
  const cutoff = lastDate.subtract(lookback, 'day');
  return snapshots.filter(s => !dayjs(s.date).isBefore(cutoff));
}

// ============================================================
// Phase 6: 持仓相关性热力图 + cluster
// ============================================================

const CorrelationTab: React.FC<{ portfolioId?: number }> = ({ portfolioId }) => {
  const [report, setReport] = useState<CorrelationReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookbackDays, setLookbackDays] = useState(60);
  const [clusterThreshold, setClusterThreshold] = useState(0.7);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await getCorrelationReport({
        portfolio_id: portfolioId,
        lookback_days: lookbackDays,
        cluster_threshold: clusterThreshold,
      });
      setReport(r);
    } catch (err: any) {
      setError(err?.message || '加载失败');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [portfolioId, lookbackDays, clusterThreshold]);

  useEffect(() => {
    void load();
  }, [load]);

  // 颜色映射: -1 (深蓝) → 0 (白) → +1 (深红)
  const corrColor = (v: number | null): string => {
    if (v === null) return '#f0f0f0';
    const x = Math.max(-1, Math.min(1, v));
    if (x >= 0) {
      // 0→1: white→red
      const r = 255;
      const g = Math.round(255 * (1 - x));
      const b = Math.round(255 * (1 - x));
      return `rgb(${r},${g},${b})`;
    }
    // -1→0: blue→white
    const r = Math.round(255 * (1 + x));
    const g = Math.round(255 * (1 + x));
    const b = 255;
    return `rgb(${r},${g},${b})`;
  };

  const levelTag: Record<string, { color: string; label: string }> = {
    high: { color: 'green', label: '✅ 高分散度' },
    medium: { color: 'orange', label: '⚠️ 中等分散度' },
    low: { color: 'red', label: '❌ 低分散度（持仓相关性偏高）' },
    insufficient: { color: 'default', label: '— 数据不足' },
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <RadarChartOutlined />
            <Text strong>持仓相关性矩阵</Text>
            <Tag color="blue">Phase 6</Tag>
          </Space>
        }
        extra={
          <Space size={8}>
            <span style={{ fontSize: 12 }}>回看:</span>
            <Select
              size="small"
              value={lookbackDays}
              onChange={v => setLookbackDays(v)}
              options={[
                { value: 30, label: '30d' },
                { value: 60, label: '60d' },
                { value: 90, label: '90d' },
                { value: 120, label: '120d' },
              ]}
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12 }}>阈值:</span>
            <InputNumber
              size="small"
              min={0.3}
              max={0.95}
              step={0.05}
              value={clusterThreshold}
              onChange={v => setClusterThreshold(typeof v === 'number' ? v : 0.7)}
              style={{ width: 80 }}
            />
            <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}
        {loading && !report && <Spin tip="计算中..." />}
        {report && (
          <>
            <Space wrap size={8} style={{ marginBottom: 12 }}>
              <Tag>持仓数 {report.position_count}</Tag>
              <Tag color={levelTag[report.diversification_level].color}>
                {levelTag[report.diversification_level].label}
              </Tag>
              {report.avg_off_diagonal_correlation !== null && (
                <Tag>平均相关性 {report.avg_off_diagonal_correlation.toFixed(3)}</Tag>
              )}
              {report.insufficient_data_symbols.length > 0 && (
                <Tooltip title={report.insufficient_data_symbols.join(', ')}>
                  <Tag color="default">数据不足 {report.insufficient_data_symbols.length} 只</Tag>
                </Tooltip>
              )}
            </Space>

            {report.matrix.symbols.length >= 2 ? (
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    borderCollapse: 'collapse',
                    fontSize: 12,
                    width: 'auto',
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        style={{
                          padding: '4px 8px',
                          textAlign: 'left',
                          borderBottom: '1px solid #eee',
                          fontSize: 12,
                        }}
                      >
                        symbol
                      </th>
                      {report.matrix.symbols.map(s => (
                        <th
                          key={s}
                          style={{
                            padding: '4px 6px',
                            textAlign: 'center',
                            borderBottom: '1px solid #eee',
                            fontSize: 12,
                            writingMode: 'vertical-rl',
                            height: 80,
                          }}
                        >
                          {s}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.matrix.symbols.map((sRow, i) => (
                      <tr key={sRow}>
                        <td
                          style={{
                            padding: '4px 8px',
                            fontWeight: 500,
                            borderRight: '1px solid #eee',
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {sRow}
                        </td>
                        {report.matrix.matrix[i].map((cell, j) => (
                          <td
                            key={j}
                            style={{
                              padding: '4px 6px',
                              textAlign: 'center',
                              background: corrColor(cell),
                              border: '1px solid #fff',
                              minWidth: 36,
                              color: cell !== null && Math.abs(cell) > 0.7 ? '#000' : '#666',
                              fontWeight: cell !== null && Math.abs(cell) > 0.7 ? 600 : 400,
                            }}
                            title={
                              cell === null
                                ? '数据不足'
                                : `corr(${sRow}, ${report.matrix.symbols[j]}) = ${cell.toFixed(3)}`
                            }
                          >
                            {cell === null ? '—' : cell.toFixed(2)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div
                  style={{
                    marginTop: 12,
                    fontSize: 12,
                    color: '#888',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  色阶:
                  <span style={{ background: 'rgb(0,0,255)', padding: '2px 8px' }}>-1</span>
                  <span
                    style={{
                      background: 'rgb(255,255,255)',
                      padding: '2px 8px',
                      border: '1px solid #ddd',
                    }}
                  >
                    0
                  </span>
                  <span style={{ background: 'rgb(255,0,0)', padding: '2px 8px' }}>+1</span>
                </div>
              </div>
            ) : (
              <Alert
                type="info"
                showIcon
                message="持仓数不足或数据缺失"
                description="需要至少 2 只持仓且每只有 30 日以上 daily close 数据才能算相关性。"
              />
            )}
          </>
        )}
      </Card>

      {report && report.high_correlation_clusters.length > 0 && (
        <Card
          size="small"
          title={
            <Space>
              <ExclamationCircleOutlined style={{ color: '#dc2626' }} />
              <Text strong>高相关性 Cluster 警告</Text>
              <Tag color="error">{report.high_correlation_clusters.length} 个 cluster</Tag>
            </Space>
          }
        >
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="这些股票走势高度同步 — 系统性 risk-off 时会一起跌"
            description="建议考虑减仓或加入反向 beta 资产降低组合相关性。"
          />
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {report.high_correlation_clusters.map((c, i) => (
              <Card key={i} size="small" type="inner">
                <Row gutter={[12, 8]}>
                  <Col xs={24} md={8}>
                    <Statistic
                      title="cluster 成员"
                      value={c.members.length}
                      suffix={` 只 (${c.members.join(', ')})`}
                      valueStyle={{ fontSize: 14 }}
                    />
                  </Col>
                  <Col xs={12} md={5}>
                    <Statistic
                      title="平均相关性"
                      value={c.avg_correlation}
                      precision={3}
                      valueStyle={{ fontSize: 14, color: '#dc2626' }}
                    />
                  </Col>
                  <Col xs={12} md={5}>
                    <Statistic
                      title="占组合"
                      value={c.pct_of_portfolio}
                      suffix="%"
                      precision={1}
                      valueStyle={{ fontSize: 14 }}
                    />
                  </Col>
                  <Col xs={24} md={6}>
                    {c.dominant_industry && <Tag color="red">主导行业: {c.dominant_industry}</Tag>}
                  </Col>
                </Row>
              </Card>
            ))}
          </Space>
        </Card>
      )}
    </Space>
  );
};
