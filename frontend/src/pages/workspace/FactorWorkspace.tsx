import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Row,
  Slider,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Tooltip as AntTooltip,
  Typography,
  message,
} from 'antd';
import {
  AppstoreOutlined,
  DeleteOutlined,
  FundOutlined,
  SaveOutlined,
  SlidersOutlined,
  OrderedListOutlined,
  ReloadOutlined,
  BarChartOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import MacroEnvTab from './FactorWorkspace.MacroEnvTab';
import BlockTradesTab from './FactorWorkspace.BlockTradesTab';
import ETFFlowTab from './FactorWorkspace.ETFFlowTab';
import PolicyNewsTab from './FactorWorkspace.PolicyNewsTab';
import { computeAIWeights, computeWeightDeltas } from './factorAIWeightHelpers';
import {
  ComboTemplate,
  COMBO_TEMPLATE_NAME_MAX_LEN,
  deleteComboTemplate,
  listComboTemplates,
  saveComboTemplate,
} from './factorComboTemplateHelpers';
import { buildShortPickReason } from './factorPickReasonHelpers';
import {
  factorService,
  FactorDetailResponse,
  FactorIndustryHeatmapResponse,
  FactorOverviewItem,
  FactorOverviewResponse,
  FactorPreviewResponse,
  FactorPreviewSignal,
  IndustryBoardResponse,
  SentimentBoardResponse,
} from '../../services/factorService';

const { Text } = Typography;

/**
 * 选股因子 (Factor Workspace) — US-015 + US-074 行业热力 实现。
 *
 * 4 个 tab：
 *  - 因子总览：8 个因子卡片，展示注册元数据 + factor_scores 表覆盖统计
 *  - 权重调参：8 滑块（自动归一化到 100%）+ "预览" 按钮触发 POST /factors/preview
 *  - 今日选股清单：表格展示 MFA 最近一次调仓结果，可折叠看 8 因子 z_score 明细
 *  - 行业热力 (US-074)：行业 × 因子的 z_score 平均值 echarts 热力图
 *
 * 数据流：
 *   - 装载时并发拉 /factors/overview + /strategies/multi-factor/latest-picks
 *   - 用户在权重调参 tab 点 "预览" 触发 POST /factors/preview （独立请求，不污染主状态）
 *   - 行业热力 tab 首次进入时 lazy-fire GET /factors/industry-heatmap；缓存结果，
 *     刷新按钮 / 切换日期才会再次请求
 *   - 上方 KPI 条总是反映 overview 拉到的最新数据
 *
 * 边缘情况：
 *   - 后端 factor_scores 为空：所有数值显示 "—"，preview 按钮 disabled
 *   - API 请求失败：top-level Alert 显示错误（保留之前的成功数据）
 */

/** 默认 8 因子权重（与后端 DEFAULT_MULTI_FACTOR_ALPHA_WEIGHTS 一致） */
const DEFAULT_WEIGHTS: Record<string, number> = {
  value: 15,
  quality: 15,
  growth: 15,
  momentum: 15,
  low_vol: 10,
  northbound: 10,
  money_flow: 10,
  dragon_tiger: 10,
};

/** 因子风格分类的中文 + 颜色映射，统一展示视觉 */
const CATEGORY_DISPLAY: Record<string, { label: string; color: string }> = {
  value: { label: '价值', color: 'blue' },
  quality: { label: '质量', color: 'blue' },
  growth: { label: '成长', color: 'green' },
  momentum: { label: '动量', color: 'orange' },
  volatility: { label: '波动', color: 'blue' },
  liquidity: { label: '流动性', color: 'default' },
  sentiment: { label: '情绪', color: 'red' },
  flow: { label: '资金流', color: 'red' },
  event: { label: '事件', color: 'red' },
  other: { label: '其他', color: 'default' },
};

/**
 * US-045 因子健康列 (FE-006) — 4 档分类的 UI 表达 (Tag 颜色 + 中文 + 提示).
 *
 * 与后端 FactorController.classifyFactorHealth 4 档 (alpha/weak/unstable/unknown)
 * 严格一一对应; 颜色挑选:
 *   - alpha=green: 操盘手"放心用"
 *   - unstable=gold: 有方向但 IR 低, "谨慎用"
 *   - weak=red: 已失效, "停用"
 *   - unknown=default: 无数据, "先 compute IC"
 */
const FACTOR_HEALTH_DISPLAY: Record<
  'alpha' | 'weak' | 'unstable' | 'unknown',
  { label: string; color: string; tip: string }
> = {
  alpha: {
    label: '有效',
    color: 'green',
    tip: '|IC_90d| ≥ 0.03 且 |IC_IR| ≥ 0.3，因子稳定有 alpha',
  },
  unstable: {
    label: '不稳',
    color: 'default',
    tip: '有方向但 IC_IR 不够稳健，谨慎使用',
  },
  weak: { label: '失效', color: 'red', tip: '|IC_90d| < 0.01，因子已失效，建议停用' },
  unknown: {
    label: '无数据',
    color: 'default',
    tip: '近 90 日无 IC 报告，请等 FACTOR_IC_COMPUTE 跑完',
  },
};

/** IC_90d 数值染色: ≥0.03 绿 / ≤-0.03 红 (反向有效) / 其它默认; null → undefined 让组件用默认色 */
function ic90dColor(v: number | null): string | undefined {
  if (v === null || !Number.isFinite(v)) return undefined;
  if (v >= 0.03) return '#16a34a';
  if (v <= -0.03) return '#dc2626';
  return undefined;
}

/** IC_IR 数值染色: |ir|≥0.5 绿稳健 / |ir|≥0.3 不染色 (灰区) / |ir|<0.3 灰; null → undefined */
function icIrColor(v: number | null): string | undefined {
  if (v === null || !Number.isFinite(v)) return undefined;
  if (Math.abs(v) >= 0.5) return '#16a34a';
  return undefined;
}

/**
 * US-047 因子组合模板 (FE-008): 把 ISO 时间戳转成 "MM-DD HH:mm" 给 List item 副标题用.
 * 解析失败 / 空 返 "—". UI 兜底, 不抛错.
 */
function formatSavedAt(raw: string | null | undefined): string {
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const FactorWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'overview', label: '因子总览', icon: <FundOutlined /> },
    { key: 'weights', label: '权重调参', icon: <SlidersOutlined /> },
    { key: 'picks', label: '今日选股清单', icon: <OrderedListOutlined /> },
    { key: 'board', label: '行业决策', icon: <ThunderboltOutlined /> },
    { key: 'sentiment', label: '舆情雷达', icon: <BarChartOutlined /> },
    { key: 'macro', label: '宏观环境', icon: <FundOutlined /> },
    { key: 'block', label: '大宗交易', icon: <FundOutlined /> },
    // US-048 (FE-009) — 行业 ETF 申赎资金流 + 政策要闻 2 个新 tab
    { key: 'etf', label: 'ETF 资金流', icon: <FundOutlined /> },
    { key: 'policy', label: '政策要闻', icon: <FundOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('overview');

  // --- overview + latest picks (loaded together on mount) ---
  const [overview, setOverview] = useState<FactorOverviewResponse | null>(null);
  const [latestPicks, setLatestPicks] = useState<FactorPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [ov, pk] = await Promise.all([
        factorService.listFactorsOverview(),
        factorService.getLatestMultiFactorPicks(),
      ]);
      setOverview(ov);
      setLatestPicks(pk);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setLoadError(messageStr);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // --- weights tuning ---
  const [weights, setWeights] = useState<Record<string, number>>(() => ({ ...DEFAULT_WEIGHTS }));
  const [topN, setTopN] = useState<number>(30);
  const [industryNeutral, setIndustryNeutral] = useState<boolean>(true);
  const [maxPerIndustry, setMaxPerIndustry] = useState<number>(3);
  const [excludeST, setExcludeST] = useState<boolean>(true);
  const [excludeNew60d, setExcludeNew60d] = useState<boolean>(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<FactorPreviewResponse | null>(null);

  /** 当因子从 overview 拉回来时，把不在 default 列表的新因子（如 US-029+）补 0 权重 */
  useEffect(() => {
    if (!overview) return;
    setWeights(prev => {
      const next = { ...prev };
      for (const f of overview.factors) {
        if (!(f.name in next)) next[f.name] = 0;
      }
      return next;
    });
  }, [overview]);

  const weightSum = useMemo(
    () => Object.values(weights).reduce((acc, w) => acc + (Number.isFinite(w) ? w : 0), 0),
    [weights]
  );

  const handlePreview = useCallback(async () => {
    setPreviewLoading(true);
    try {
      // 后端要求 weight > 0；过滤掉 0 权重的因子
      const positiveWeights: Record<string, number> = {};
      for (const [name, w] of Object.entries(weights)) {
        if (w > 0) positiveWeights[name] = w;
      }
      if (Object.keys(positiveWeights).length === 0) {
        message.error('至少要给一个因子分配权重 > 0');
        setPreviewLoading(false);
        return;
      }
      const result = await factorService.previewFactorSelection({
        weights: positiveWeights,
        topN,
        industryNeutral,
        maxPerIndustry,
        excludeST,
        excludeNew60d,
      });
      setPreviewResult(result);
      message.success(`预览完成：${result.target_portfolio.length} 只候选`);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      message.error(`预览失败：${messageStr}`);
    } finally {
      setPreviewLoading(false);
    }
  }, [weights, topN, industryNeutral, maxPerIndustry, excludeST, excludeNew60d]);

  const handleResetWeights = useCallback(() => {
    setWeights({ ...DEFAULT_WEIGHTS });
    setTopN(30);
    setIndustryNeutral(true);
    setMaxPerIndustry(3);
    setExcludeST(true);
    setExcludeNew60d(true);
  }, []);

  // US-046 因子 AI 权重对照 (FE-007): 基于 overview 返的 (ic_90d, ic_ir, health_class)
  // 算 AI 推荐权重. useMemo cache 避免每次 render 重算 (factors 变才会重算).
  // 空 Map 等价于 "AI 暂无建议" — UI 那一侧 Tag 显示 '—'.
  const aiWeights = useMemo(() => computeAIWeights(overview?.factors ?? []), [overview?.factors]);

  /** "一键应用 AI 建议": 把 aiWeights 全套覆盖到 weights state, 其它参数不动 */
  const handleApplyAIWeights = useCallback(() => {
    if (Object.keys(aiWeights).length === 0) {
      message.warning('AI 暂无权重建议 — 请等 FACTOR_IC_COMPUTE 跑完最新一日 IC 报告');
      return;
    }
    setWeights(prev => {
      // 把所有当前 weights key 先归零, 再用 aiWeights 覆盖; 这样 prev 中存在但
      // aiWeights 不推荐的因子会被设成 0, 用户看到的就是"AI 视角的完整套用".
      const next: Record<string, number> = {};
      for (const k of Object.keys(prev)) next[k] = 0;
      for (const [k, v] of Object.entries(aiWeights)) next[k] = v;
      return next;
    });
    message.success(`已应用 AI 推荐 (${Object.keys(aiWeights).length} 个因子)`);
  }, [aiWeights]);

  // --- US-047 因子组合模板 save/load (FE-008) ---
  // localStorage-only 私有模板库. 与 [[factorAIWeightHelpers]] 同款纯 helper 模式,
  // FactorWorkspace 只负责 state + UI; 校验 / 落盘 / 解析 / 上限统一在
  // factorComboTemplateHelpers 里. 模板里包含全套权重 + 选股参数 (topN / industryNeutral
  // / maxPerIndustry / excludeST / excludeNew60d), load 时一次性灌回所有 setXxx,
  // 不需要再点 "预览" 之外的其他按钮就能复现该模板的选股逻辑.
  const [templates, setTemplates] = useState<ComboTemplate[]>(() => listComboTemplates());
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [pendingTemplateName, setPendingTemplateName] = useState('');
  const [loadModalOpen, setLoadModalOpen] = useState(false);

  const refreshTemplates = useCallback(() => {
    setTemplates(listComboTemplates());
  }, []);

  /** 弹出保存对话框. 当前若已选中某个模板 (pendingTemplateName 残留), 复用作默认名. */
  const openSaveModal = useCallback(() => {
    setPendingTemplateName(prev => prev || '');
    setSaveModalOpen(true);
  }, []);

  const handleConfirmSave = useCallback(() => {
    try {
      const list = saveComboTemplate({
        name: pendingTemplateName,
        weights,
        topN,
        industryNeutral,
        maxPerIndustry,
        excludeST,
        excludeNew60d,
      });
      setTemplates(list);
      setSaveModalOpen(false);
      message.success(`已保存模板「${pendingTemplateName.trim()}」`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      message.error(msg);
    }
  }, [
    pendingTemplateName,
    weights,
    topN,
    industryNeutral,
    maxPerIndustry,
    excludeST,
    excludeNew60d,
  ]);

  /** 把模板应用到当前 state: 一次性更新所有 6 个相关 setter. */
  const handleLoadTemplate = useCallback((tpl: ComboTemplate) => {
    setWeights(prev => {
      // 与 handleApplyAIWeights 同款做法: 先把 prev 已知的因子置 0, 再灌 tpl.weights,
      // 这样 tpl 没覆盖到的旧因子会变 0 (= "完整切到这个模板的视角"); 反之 tpl 中存在
      // 但 overview 还没 fetch 回来的新因子也能正确灌入, 等 overview 拉回后 UI 自然展示.
      const next: Record<string, number> = {};
      for (const k of Object.keys(prev)) next[k] = 0;
      for (const [k, v] of Object.entries(tpl.weights)) next[k] = v;
      return next;
    });
    setTopN(tpl.topN);
    setIndustryNeutral(tpl.industryNeutral);
    setMaxPerIndustry(tpl.maxPerIndustry);
    setExcludeST(tpl.excludeST);
    setExcludeNew60d(tpl.excludeNew60d);
    setPendingTemplateName(tpl.name);
    setLoadModalOpen(false);
    message.success(`已加载模板「${tpl.name}」`);
  }, []);

  const handleDeleteTemplate = useCallback((name: string) => {
    const list = deleteComboTemplate(name);
    setTemplates(list);
    message.success(`已删除模板「${name}」`);
  }, []);

  // --- 行业热力 (US-074) — lazy on first tab activation ---
  const [heatmap, setHeatmap] = useState<FactorIndustryHeatmapResponse | null>(null);
  const [heatmapLoading, setHeatmapLoading] = useState(false);
  const [heatmapError, setHeatmapError] = useState<string | null>(null);

  const loadHeatmap = useCallback(async () => {
    setHeatmapLoading(true);
    setHeatmapError(null);
    try {
      const data = await factorService.getIndustryHeatmap();
      setHeatmap(data);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setHeatmapError(messageStr);
    } finally {
      setHeatmapLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeKey !== 'heatmap') return;
    if (heatmap || heatmapLoading || heatmapError) return;
    void loadHeatmap();
  }, [activeKey, heatmap, heatmapLoading, heatmapError, loadHeatmap]);

  // --- 行业决策面板 (Batch AF 2026-06-18) — lazy on first tab activation ---
  // 替代老的因子 z_score 热力, 直接展示 IndustryFlow + LimitUp + 热门概念 真盘口数据。
  // 同款 lazy 三态判定: data || loading || error 短路, 仅在用户首次切到 'board' tab 时拉。
  const [board, setBoard] = useState<IndustryBoardResponse | null>(null);
  const [boardLoading, setBoardLoading] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);

  const loadBoard = useCallback(async () => {
    setBoardLoading(true);
    setBoardError(null);
    try {
      const data = await factorService.getIndustryBoard({ top: 40, lookback: 5 });
      setBoard(data);
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setBoardError(messageStr);
    } finally {
      setBoardLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeKey !== 'board') return;
    if (board || boardLoading || boardError) return;
    void loadBoard();
  }, [activeKey, board, boardLoading, boardError, loadBoard]);

  // --- 舆情雷达 (Batch AH 2026-06-18) — lazy on first tab activation ---
  // 同 board 三态判定范式: 仅当用户首次切到 'sentiment' tab 且无 data + 无 error 时才 fire.
  const [sentiment, setSentiment] = useState<SentimentBoardResponse | null>(null);
  const [sentimentLoading, setSentimentLoading] = useState(false);
  const [sentimentError, setSentimentError] = useState<string | null>(null);

  const loadSentiment = useCallback(async () => {
    setSentimentLoading(true);
    setSentimentError(null);
    try {
      const data = await factorService.getSentimentBoard({ top: 20 });
      setSentiment(data);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSentimentError(msg);
    } finally {
      setSentimentLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeKey !== 'sentiment') return;
    if (sentiment || sentimentLoading || sentimentError) return;
    void loadSentiment();
  }, [activeKey, sentiment, sentimentLoading, sentimentError, loadSentiment]);

  // --- US-094 因子详情抽屉 ---
  // 点击因子卡片 → 弹出 Drawer 展示：因子描述 / IC 历史曲线 / 5 等分组合净值曲线。
  // detail 数据缓存为 (factor_name → response) 一次拉取后切换其它卡片再回来不重复 fetch；
  // refresh 按钮 / 手动重试触发 reload。
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerFactor, setDrawerFactor] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, FactorDetailResponse>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const loadFactorDetail = useCallback(async (name: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const data = await factorService.getFactorDetail(name);
      setDetailCache(prev => ({ ...prev, [name]: data }));
    } catch (err: unknown) {
      const messageStr = err instanceof Error ? err.message : String(err);
      setDetailError(messageStr);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleCardClick = useCallback(
    (factor: FactorOverviewItem) => {
      setDrawerFactor(factor.name);
      setDrawerOpen(true);
      // 3 态短路（与 US-074 lazy-load 范式一致）：已在缓存 / 正在拉 / 已错过都不重复 fetch
      if (detailCache[factor.name] || detailLoading) return;
      void loadFactorDetail(factor.name);
    },
    [detailCache, detailLoading, loadFactorDetail]
  );

  const handleDrawerClose = useCallback(() => {
    setDrawerOpen(false);
    // 关闭后不立即清 factor name —— 让 Drawer 退场动画期间内容仍可见，避免闪烁
  }, []);

  const drawerDetail = drawerFactor ? detailCache[drawerFactor] : null;

  // --- KPI 计算 ---
  const totalUniverse = useMemo(() => {
    if (!overview?.factors?.length) return 0;
    return Math.max(...overview.factors.map(f => f.universe_size));
  }, [overview]);
  const registeredCount = overview?.factors.length ?? 0;
  const latestDateLabel = overview?.latest_trade_date ?? '—';

  const kpiSlot = (
    <Space size={32}>
      <Statistic title="已注册因子" value={registeredCount} suffix="个" />
      <Statistic title="覆盖股票" value={totalUniverse} suffix="只" />
      <Statistic title="最新计算日" value={latestDateLabel} />
    </Space>
  );

  const headerActions = (
    <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
      刷新
    </Button>
  );

  // --- render tab body ---
  let body: React.ReactNode;
  if (loadError) {
    body = (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={loadError}
        action={
          <Button size="small" onClick={refresh}>
            重试
          </Button>
        }
      />
    );
  } else if (activeKey === 'overview') {
    body = (
      <FactorOverviewTab
        factors={overview?.factors ?? []}
        loading={loading}
        onCardClick={handleCardClick}
      />
    );
  } else if (activeKey === 'weights') {
    body = (
      <WeightsTab
        factors={overview?.factors ?? []}
        weights={weights}
        weightSum={weightSum}
        aiWeights={aiWeights}
        topN={topN}
        industryNeutral={industryNeutral}
        maxPerIndustry={maxPerIndustry}
        excludeST={excludeST}
        excludeNew60d={excludeNew60d}
        previewLoading={previewLoading}
        previewResult={previewResult}
        onWeightChange={(name, value) =>
          setWeights(prev => ({ ...prev, [name]: Number.isFinite(value) ? value : 0 }))
        }
        onTopNChange={setTopN}
        onIndustryNeutralChange={setIndustryNeutral}
        onMaxPerIndustryChange={setMaxPerIndustry}
        onExcludeSTChange={setExcludeST}
        onExcludeNew60dChange={setExcludeNew60d}
        onPreview={handlePreview}
        onReset={handleResetWeights}
        onApplyAIWeights={handleApplyAIWeights}
        templates={templates}
        onOpenSaveTemplate={openSaveModal}
        onOpenLoadTemplate={() => {
          refreshTemplates();
          setLoadModalOpen(true);
        }}
      />
    );
  } else if (activeKey === 'heatmap') {
    body = (
      <IndustryHeatmapTab
        data={heatmap}
        loading={heatmapLoading}
        error={heatmapError}
        onReload={loadHeatmap}
      />
    );
  } else if (activeKey === 'board') {
    body = (
      <IndustryBoardTab
        data={board}
        loading={boardLoading}
        error={boardError}
        onReload={loadBoard}
      />
    );
  } else if (activeKey === 'sentiment') {
    body = (
      <SentimentBoardTab
        data={sentiment}
        loading={sentimentLoading}
        error={sentimentError}
        onReload={loadSentiment}
      />
    );
  } else if (activeKey === 'macro') {
    body = <MacroEnvTab />;
  } else if (activeKey === 'block') {
    body = <BlockTradesTab />;
  } else if (activeKey === 'etf') {
    // US-048 (FE-009): 行业 ETF 申赎资金流 — 内部 lazy fetch, 第一次切到该 tab 才拉
    body = <ETFFlowTab />;
  } else if (activeKey === 'policy') {
    // US-048 (FE-009): 政策要闻 — 从 market-news 流前端关键字过滤出政策类
    body = <PolicyNewsTab />;
  } else {
    // 'picks'
    body = <PicksTab picks={latestPicks} loading={loading} />;
  }

  return (
    <>
      <WorkspaceLayout
        title="选股因子"
        subtitle="统一管理因子库、权重调参与多因子选股结果。"
        tabs={tabs}
        activeKey={activeKey}
        onTabChange={setActiveKey}
        kpiSlot={kpiSlot}
        headerActions={headerActions}
      >
        {body}
      </WorkspaceLayout>
      <FactorDetailDrawer
        open={drawerOpen}
        onClose={handleDrawerClose}
        factorName={drawerFactor}
        detail={drawerDetail}
        loading={detailLoading}
        error={detailError}
        onRetry={drawerFactor ? () => loadFactorDetail(drawerFactor) : undefined}
      />
      {/* US-047 因子组合模板 — Save 对话框 */}
      <Modal
        title="保存因子组合模板"
        open={saveModalOpen}
        onCancel={() => setSaveModalOpen(false)}
        onOk={handleConfirmSave}
        okText="保存"
        cancelText="取消"
        okButtonProps={{
          disabled: pendingTemplateName.trim().length === 0,
          'data-testid': 'combo-template-save-confirm-btn',
        }}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Input
            placeholder="例如：高分红低估值 / 短期反转 / 成长动量"
            value={pendingTemplateName}
            onChange={e => setPendingTemplateName(e.target.value)}
            maxLength={COMBO_TEMPLATE_NAME_MAX_LEN}
            showCount
            onPressEnter={handleConfirmSave}
            data-testid="combo-template-name-input"
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            模板包含全部因子权重 + 选股参数 (Top-N / 行业中性 / 单行业上限 / 剔除 ST / 剔除次新).
            同名模板会被覆盖. 上限 20 个.
          </Text>
        </Space>
      </Modal>
      {/* US-047 因子组合模板 — Load 对话框 */}
      <Modal
        title="加载因子组合模板"
        open={loadModalOpen}
        onCancel={() => setLoadModalOpen(false)}
        footer={null}
        destroyOnClose
        width={560}
      >
        {templates.length === 0 ? (
          <Empty description="还没有保存过模板 — 调整 slider 后点 “保存模板” 即可创建" />
        ) : (
          <List
            dataSource={templates}
            data-testid="combo-template-list"
            renderItem={tpl => (
              <List.Item
                actions={[
                  <Button
                    key="load"
                    type="link"
                    onClick={() => handleLoadTemplate(tpl)}
                    data-testid={`combo-template-load-btn-${tpl.name}`}
                  >
                    加载
                  </Button>,
                  <Popconfirm
                    key="del"
                    title={`确定删除模板「${tpl.name}」？`}
                    okText="删除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() => handleDeleteTemplate(tpl.name)}
                  >
                    <Button
                      type="link"
                      danger
                      icon={<DeleteOutlined />}
                      data-testid={`combo-template-delete-btn-${tpl.name}`}
                    >
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={tpl.name}
                  description={
                    <Space wrap size={[6, 4]} style={{ fontSize: 12 }}>
                      <Tag>
                        {Object.keys(tpl.weights).filter(k => tpl.weights[k] > 0).length} 因子
                      </Tag>
                      <Tag>Top {tpl.topN}</Tag>
                      {tpl.industryNeutral && <Tag color="blue">行业中性</Tag>}
                      {tpl.excludeST && <Tag color="orange">剔除 ST</Tag>}
                      {tpl.excludeNew60d && <Tag color="orange">剔除次新</Tag>}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        保存于 {formatSavedAt(tpl.savedAt)}
                      </Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Modal>
    </>
  );
};

// ============================================================================
// Tab 1 — 因子总览
// ============================================================================

const FactorOverviewTab: React.FC<{
  factors: FactorOverviewItem[];
  loading: boolean;
  onCardClick?: (factor: FactorOverviewItem) => void;
}> = ({ factors, loading, onCardClick }) => {
  if (loading && factors.length === 0) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载因子总览…" />
        </div>
      </Card>
    );
  }
  if (factors.length === 0) {
    return (
      <Card>
        <Empty description="尚未注册任何因子（请运行 npm run compute:factors -- --date=YYYY-MM-DD）" />
      </Card>
    );
  }
  return (
    <Row gutter={[16, 16]}>
      {factors.map(factor => {
        const category = CATEGORY_DISPLAY[factor.category] ?? CATEGORY_DISPLAY.other;
        const coverageRatio =
          factor.universe_size > 0 ? factor.non_neutral_count / factor.universe_size : 0;
        const health = FACTOR_HEALTH_DISPLAY[factor.health_class] ?? FACTOR_HEALTH_DISPLAY.unknown;
        return (
          <Col xs={24} sm={12} lg={8} xxl={6} key={factor.name}>
            <Card
              hoverable
              style={{ height: '100%', cursor: onCardClick ? 'pointer' : 'default' }}
              onClick={onCardClick ? () => onCardClick(factor) : undefined}
              title={
                <Space>
                  <Text strong>{factor.name}</Text>
                  <Tag color={category.color}>{category.label}</Tag>
                  <AntTooltip title={health.tip}>
                    <Tag color={health.color} data-testid={`factor-health-tag-${factor.name}`}>
                      {health.label}
                    </Tag>
                  </AntTooltip>
                </Space>
              }
            >
              <Text type="secondary" style={{ fontSize: 12, display: 'block', minHeight: 36 }}>
                {factor.description}
              </Text>
              <Row gutter={8} style={{ marginTop: 12 }}>
                <Col span={12}>
                  <Statistic
                    title="最新计算日"
                    value={factor.latest_trade_date ?? '—'}
                    valueStyle={{ fontSize: 14 }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic
                    title="覆盖股票"
                    value={factor.universe_size}
                    suffix="只"
                    valueStyle={{ fontSize: 14 }}
                  />
                </Col>
              </Row>
              {/* US-045 因子健康列 (FE-006): IC_90d + IC_IR 双指标 */}
              <Row gutter={8} style={{ marginTop: 8 }}>
                <Col span={12}>
                  <AntTooltip title="近 90 日 IC 均值 (look_forward=20)；> 0.05 一般认为有 alpha">
                    <Statistic
                      title="IC_90d"
                      value={factor.ic_90d !== null ? factor.ic_90d.toFixed(3) : '—'}
                      valueStyle={{
                        fontSize: 14,
                        color: ic90dColor(factor.ic_90d),
                      }}
                    />
                  </AntTooltip>
                </Col>
                <Col span={12}>
                  <AntTooltip title="最新 IC report 的 IC_IR (信息比率)；|IC_IR| > 0.5 算稳健、> 1.0 优秀">
                    <Statistic
                      title="IC_IR"
                      value={factor.ic_ir !== null ? factor.ic_ir.toFixed(2) : '—'}
                      valueStyle={{
                        fontSize: 14,
                        color: icIrColor(factor.ic_ir),
                      }}
                    />
                  </AntTooltip>
                </Col>
              </Row>
              <div style={{ marginTop: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  有效覆盖率：
                </Text>
                <Text strong>{(coverageRatio * 100).toFixed(1)}%</Text>
                <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                  ({factor.non_neutral_count} / {factor.universe_size})
                </Text>
              </div>
            </Card>
          </Col>
        );
      })}
    </Row>
  );
};

// ============================================================================
// Tab 2 — 权重调参
// ============================================================================

interface WeightsTabProps {
  factors: FactorOverviewItem[];
  weights: Record<string, number>;
  weightSum: number;
  /** US-046 因子 AI 权重对照 (FE-007): 按 |IC_90d|×|IC_IR| 算出的归一化权重 %; 空 = AI 暂无建议 */
  aiWeights: Record<string, number>;
  topN: number;
  industryNeutral: boolean;
  maxPerIndustry: number;
  excludeST: boolean;
  excludeNew60d: boolean;
  previewLoading: boolean;
  previewResult: FactorPreviewResponse | null;
  onWeightChange: (name: string, value: number) => void;
  onTopNChange: (n: number) => void;
  onIndustryNeutralChange: (b: boolean) => void;
  onMaxPerIndustryChange: (n: number) => void;
  onExcludeSTChange: (b: boolean) => void;
  onExcludeNew60dChange: (b: boolean) => void;
  onPreview: () => void;
  onReset: () => void;
  /** US-046: 一键把所有 slider 设成 AI 推荐值 */
  onApplyAIWeights: () => void;
  /** US-047 因子组合模板 (FE-008): 已保存的模板数, 仅 用于 "加载模板" 按钮上的 Badge 显示 */
  templates: ComboTemplate[];
  /** US-047: 点 "保存模板" 唤起 Save Modal */
  onOpenSaveTemplate: () => void;
  /** US-047: 点 "加载模板" 唤起 Load Modal (内部 refreshTemplates 后弹出) */
  onOpenLoadTemplate: () => void;
}

const WeightsTab: React.FC<WeightsTabProps> = ({
  factors,
  weights,
  weightSum,
  aiWeights,
  topN,
  industryNeutral,
  maxPerIndustry,
  excludeST,
  excludeNew60d,
  previewLoading,
  previewResult,
  onWeightChange,
  onTopNChange,
  onIndustryNeutralChange,
  onMaxPerIndustryChange,
  onExcludeSTChange,
  onExcludeNew60dChange,
  onPreview,
  onReset,
  onApplyAIWeights,
  templates,
  onOpenSaveTemplate,
  onOpenLoadTemplate,
}) => {
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);

  if (factors.length === 0) {
    return (
      <Card>
        <Empty description="加载因子列表中…" />
      </Card>
    );
  }
  const previewColumns = buildPreviewColumns(
    Object.keys(weights).filter(k => weights[k] > 0),
    (row: FactorPreviewSignal) => setAiTarget({ symbol: row.stock_code, name: row.name || null })
  );
  // US-046 AI 权重对照: 当前用户权重 vs AI 权重的差额. 仅 AI 推荐过的因子有 delta.
  const weightDeltas = computeWeightDeltas(weights, aiWeights);
  const aiHasRecommendation = Object.keys(aiWeights).length > 0;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <SlidersOutlined />
            权重调参（合计 {weightSum.toFixed(1)} — 后端会自动归一化到 100%）
          </Space>
        }
        extra={
          <Space>
            <AntTooltip
              title={
                aiHasRecommendation
                  ? `按 |IC_90d|×|IC_IR| 算的归一化建议 (${
                      Object.keys(aiWeights).length
                    } 个有效因子). 点击后会覆盖所有 slider.`
                  : 'AI 暂无建议: 需要至少一个 health=alpha/unstable 的因子才能推荐, 请等 FACTOR_IC_COMPUTE 跑完'
              }
            >
              <Button
                icon={<BarChartOutlined />}
                onClick={onApplyAIWeights}
                disabled={!aiHasRecommendation}
                data-testid="apply-ai-weights-btn"
              >
                应用 AI 建议
              </Button>
            </AntTooltip>
            <Button onClick={onReset}>重置为默认</Button>
            {/* US-047 因子组合模板 (FE-008): Save + Load 入口 */}
            <Button
              icon={<SaveOutlined />}
              onClick={onOpenSaveTemplate}
              data-testid="combo-template-save-btn"
            >
              保存模板
            </Button>
            <Button
              icon={<AppstoreOutlined />}
              onClick={onOpenLoadTemplate}
              data-testid="combo-template-load-btn"
            >
              加载模板{templates.length > 0 ? ` (${templates.length})` : ''}
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              onClick={onPreview}
              loading={previewLoading}
            >
              预览选股
            </Button>
          </Space>
        }
      >
        <Row gutter={[24, 16]}>
          {factors.map(factor => {
            const category = CATEGORY_DISPLAY[factor.category] ?? CATEGORY_DISPLAY.other;
            const value = weights[factor.name] ?? 0;
            // US-046 AI 权重对照: 右侧显示 "AI N%" + "Δ +M%" 的 chip
            const aiVal = aiWeights[factor.name];
            const aiSuggested = typeof aiVal === 'number';
            const delta = aiSuggested ? weightDeltas[factor.name] ?? 0 : null;
            // delta 颜色: |delta| < 2% 灰色 (基本一致) / 正值 (用户高于 AI) 红 / 负值 (用户低于 AI) 绿
            const deltaColor =
              delta === null || Math.abs(delta) < 2 ? '#999' : delta > 0 ? '#dc2626' : '#16a34a';
            return (
              <Col xs={24} md={12} key={factor.name}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ minWidth: 120 }}>
                    <Tag color={category.color}>{category.label}</Tag>
                    <Text strong style={{ marginLeft: 4 }}>
                      {factor.name}
                    </Text>
                  </div>
                  <Slider
                    min={0}
                    max={50}
                    step={1}
                    value={value}
                    onChange={v => onWeightChange(factor.name, v as number)}
                    style={{ flex: 1 }}
                  />
                  <InputNumber
                    min={0}
                    max={100}
                    value={value}
                    onChange={v => onWeightChange(factor.name, Number(v) || 0)}
                    style={{ width: 80 }}
                    addonAfter="%"
                  />
                  {/* US-046 AI 权重对照: slider 右侧固定宽度 chip, 即使没建议也占位防错位 */}
                  <div
                    style={{
                      minWidth: 110,
                      textAlign: 'right',
                      fontSize: 12,
                      lineHeight: 1.4,
                    }}
                    data-testid={`ai-weight-chip-${factor.name}`}
                  >
                    {aiSuggested ? (
                      <>
                        <div>
                          <Text type="secondary">AI</Text>{' '}
                          <Text strong style={{ color: '#722ed1' }}>
                            {aiVal.toFixed(1)}%
                          </Text>
                        </div>
                        <div style={{ color: deltaColor }}>
                          Δ {delta! > 0 ? '+' : ''}
                          {delta!.toFixed(1)}%
                        </div>
                      </>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        AI —
                      </Text>
                    )}
                  </div>
                </div>
              </Col>
            );
          })}
        </Row>
        <Row gutter={16} style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed #eee' }}>
          <Col xs={12} md={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Top-N 持仓数
            </Text>
            <InputNumber
              value={topN}
              onChange={v => onTopNChange(Number(v) || 30)}
              min={1}
              max={500}
              style={{ width: '100%' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              行业中性
            </Text>
            <div>
              <Switch checked={industryNeutral} onChange={onIndustryNeutralChange} />
            </div>
          </Col>
          <Col xs={12} md={6}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              单行业最多
            </Text>
            <InputNumber
              value={maxPerIndustry}
              onChange={v => onMaxPerIndustryChange(Number(v) || 3)}
              min={1}
              max={50}
              disabled={!industryNeutral}
              style={{ width: '100%' }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Space direction="vertical" size={4}>
              <Space size={6}>
                <Switch size="small" checked={excludeST} onChange={onExcludeSTChange} />
                <Text style={{ fontSize: 12 }}>剔除 ST</Text>
              </Space>
              <Space size={6}>
                <Switch size="small" checked={excludeNew60d} onChange={onExcludeNew60dChange} />
                <Text style={{ fontSize: 12 }}>剔除次新 60 日</Text>
              </Space>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card title="预览选股结果">
        {!previewResult ? (
          <Empty description="点击右上角 “预览选股” 即可看到 Top-N 候选" />
        ) : (
          <>
            <Space
              size={24}
              style={{ marginBottom: 12, display: 'flex', flexWrap: 'wrap', rowGap: 8 }}
            >
              <Statistic
                title="目标组合"
                value={previewResult.target_portfolio.length}
                suffix="只"
              />
              <Statistic title="候选池" value={previewResult.universe_size} suffix="只" />
              <Statistic title="过滤后" value={previewResult.eligible_count} suffix="只" />
              <Statistic title="基准日" value={previewResult.trade_date} />
              <Space size={6}>
                <Tag>ST 剔除 {previewResult.filtered.st}</Tag>
                <Tag>次新剔除 {previewResult.filtered.new60d}</Tag>
                <Tag>行业 cap {previewResult.filtered.industry_capped}</Tag>
                <Tag>无因子数据 {previewResult.filtered.no_factor_data}</Tag>
              </Space>
            </Space>
            <Table<FactorPreviewSignal>
              size="small"
              columns={previewColumns}
              dataSource={previewResult.signals.filter(s => s.signal !== 'sell')}
              rowKey="stock_code"
              pagination={{ pageSize: 20, showSizeChanger: true }}
              scroll={{ x: 'max-content' }}
            />
          </>
        )}
      </Card>
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="factor_preview"
        />
      )}
    </Space>
  );
};

// ============================================================================
// Tab 3 — 今日选股清单（MFA 最新调仓）
// ============================================================================

const PicksTab: React.FC<{
  picks: FactorPreviewResponse | null;
  loading: boolean;
}> = ({ picks, loading }) => {
  const [aiTarget, setAiTarget] = useState<{ symbol: string; name: string | null } | null>(null);

  if (loading && !picks) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载最新调仓…" />
        </div>
      </Card>
    );
  }
  if (!picks || picks.note) {
    return (
      <Card>
        <Empty
          description={
            picks?.note ||
            'factor_scores 表为空 — 请先运行 npm run compute:factors -- --date=YYYY-MM-DD'
          }
        />
      </Card>
    );
  }
  const factorNames = picks.params
    ? Object.keys(picks.params.weights).filter(name => picks.params!.weights[name] > 0)
    : [];
  const columns = buildLatestPickColumns(factorNames, (row: FactorPreviewSignal) =>
    setAiTarget({ symbol: row.stock_code, name: row.name || null })
  );
  return (
    <Card
      title={
        <Space>
          <OrderedListOutlined />
          MultiFactorAlpha · {picks.trade_date} · 共 {picks.target_portfolio.length} 只
        </Space>
      }
      extra={
        <Space>
          <Tag color="blue">universe {picks.universe_size}</Tag>
          <Tag color="green">eligible {picks.eligible_count}</Tag>
          {picks.params && <Tag color="blue">topN {picks.params.topN}</Tag>}
        </Space>
      }
    >
      <Table<FactorPreviewSignal>
        size="small"
        columns={columns}
        dataSource={picks.signals}
        rowKey="stock_code"
        pagination={{ pageSize: 30, showSizeChanger: true }}
        expandable={{
          expandedRowRender: record => (
            <div style={{ padding: '8px 16px' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record.reason}
              </Text>
              <div style={{ marginTop: 8 }}>
                {Object.entries(record.factor_z_scores).map(([name, z]) => (
                  <Tag key={name} color={z > 0 ? 'green' : z < 0 ? 'red' : 'default'}>
                    {name}: {z.toFixed(2)}
                  </Tag>
                ))}
              </div>
            </div>
          ),
        }}
        scroll={{ x: 'max-content' }}
      />
      {aiTarget && (
        <AIStockAnalysisModal
          open={!!aiTarget}
          onClose={() => setAiTarget(null)}
          stockCode={aiTarget.symbol}
          stockName={aiTarget.name}
          taskLabel="factor_latest_pick"
        />
      )}
    </Card>
  );
};

// ============================================================================
// Tab 4 — 行业热力 (US-074)
// ============================================================================

/**
 * IndustryBoardTab — Batch AF (2026-06-18) 行业决策面板.
 *
 * 取代老的"行业 × 因子 z_score 热力": 用户在该 tab 一眼看到
 *   - 今日哪些板块在涨 + 主力净流入 (表格按 main_inflow desc)
 *   - 每个板块的"龙头股 + 涨幅 + 涨停个数" (能跟谁)
 *   - 近 5 日板块涨跌幅小型 sparkline (辨"持续轮动" vs "一日游")
 *   - 今日热门概念榜 (跨行业主题, 比如 'AI 算力' / '半导体存储')
 *
 * 数据来自后端 GET /api/factors/industry-board (IndustryFlow + LimitUpStock + SnowballHotKeyword).
 */
const IndustryBoardTab: React.FC<{
  data: IndustryBoardResponse | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}> = ({ data, loading, error, onReload }) => {
  if (loading && !data) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载行业决策面板…" />
        </div>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Alert
        type="error"
        showIcon
        message="加载行业决策面板失败"
        description={error}
        action={
          <Button size="small" onClick={onReload}>
            重试
          </Button>
        }
      />
    );
  }
  if (!data || data.industries.length === 0) {
    return (
      <Card>
        <Empty
          description={
            data?.note ||
            'industry_flows 表为空 — 请在 SchedulerService 启用 INDUSTRY_FLOW_SYNC 任务后再访问'
          }
        />
      </Card>
    );
  }

  // 单元格颜色: 涨幅越正越红, 越负越绿 (中国 A 股配色)
  const pctColor = (pct: number | null): string => {
    if (pct == null || !Number.isFinite(pct)) return '#999';
    return pct > 0 ? '#dc2626' : pct < 0 ? '#16a34a' : '#666';
  };
  const flowColor = (val: number | null): string => {
    if (val == null || !Number.isFinite(val)) return '#999';
    return val > 0 ? '#dc2626' : val < 0 ? '#16a34a' : '#666';
  };
  const fmtBigMoney = (val: number | null): string => {
    if (val == null || !Number.isFinite(val)) return '—';
    const abs = Math.abs(val);
    if (abs >= 1e8) return `${(val / 1e8).toFixed(2)} 亿`;
    if (abs >= 1e4) return `${(val / 1e4).toFixed(1)} 万`;
    return val.toFixed(0);
  };
  const fmtPct = (pct: number | null): string =>
    pct == null || !Number.isFinite(pct) ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {error && (
        <Alert
          type="warning"
          showIcon
          message="数据刷新失败 (展示上次缓存)"
          description={error}
          action={
            <Button size="small" onClick={onReload}>
              重试
            </Button>
          }
        />
      )}

      {/* 数据陈旧度告警 */}
      {data.lag_days != null && data.lag_days > 2 && (
        <Alert
          type={data.data_staleness === 'very_stale' ? 'error' : 'warning'}
          showIcon
          message={`⚠ 数据滞后 ${data.lag_days} 天 (当前 ${data.today_iso ?? '?'}, 数据 ${
            data.trade_date
          })`}
          description={
            data.data_staleness === 'very_stale'
              ? '行业资金流数据已超过 1 周未更新. 可能 AKShare 上游 endpoint 临时故障 (stock_sector_fund_flow_rank). 等待自动 cron 修复或手动 sync.'
              : '部分数据未更新到最新交易日, 决策时请留意时间差.'
          }
          style={{ marginBottom: 8 }}
        />
      )}

      {/* KPI Strip */}
      <Card size="small">
        <Space size={32} wrap>
          <Statistic
            title="数据日期"
            value={data.trade_date ?? '—'}
            valueStyle={
              data.lag_days != null && data.lag_days > 2 ? { color: '#fa8c16' } : undefined
            }
            suffix={
              data.lag_days != null && data.lag_days > 0 ? (
                <Tag color={data.data_staleness === 'very_stale' ? 'red' : 'orange'}>
                  滞后 {data.lag_days}d
                </Tag>
              ) : null
            }
          />
          <Statistic title="板块数" value={data.universe_size} suffix="个" />
          <Statistic title="涨停" value={data.limit_up_today ?? '—'} suffix="只" />
          <Statistic title="热门概念" value={data.hot_concepts.length} suffix="条" />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={onReload}>
            刷新
          </Button>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        {/* 左侧 — 行业排行榜 */}
        <Col xs={24} lg={16}>
          <Card
            title={
              <Space>
                <ThunderboltOutlined />
                今日板块强度榜 (按主力净流入排序)
                {data.trade_date && <Tag color="blue">{data.trade_date}</Tag>}
                <Tag>{data.industries.length} 个板块</Tag>
              </Space>
            }
            size="small"
          >
            <Table
              size="small"
              rowKey="industry_code"
              dataSource={data.industries}
              pagination={{ pageSize: 20, size: 'small' }}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: '板块',
                  dataIndex: 'industry_name',
                  width: 120,
                  fixed: 'left',
                  render: (name: string, row) => (
                    <div>
                      <div style={{ fontWeight: 500 }}>{name}</div>
                      <div style={{ fontSize: 12, color: '#999' }}>{row.industry_code}</div>
                    </div>
                  ),
                },
                {
                  title: '涨跌幅',
                  dataIndex: ['today', 'change_pct'],
                  width: 90,
                  align: 'right',
                  sorter: (a, b) =>
                    (a.today.change_pct ?? -Infinity) - (b.today.change_pct ?? -Infinity),
                  render: (v: number | null) => (
                    <span style={{ color: pctColor(v), fontWeight: 600 }}>{fmtPct(v)}</span>
                  ),
                },
                {
                  title: '主力净流入',
                  dataIndex: ['today', 'main_inflow'],
                  width: 110,
                  align: 'right',
                  sorter: (a, b) =>
                    (a.today.main_inflow ?? -Infinity) - (b.today.main_inflow ?? -Infinity),
                  render: (v: number | null) => (
                    <span style={{ color: flowColor(v), fontWeight: 500 }}>{fmtBigMoney(v)}</span>
                  ),
                },
                {
                  title: '占比',
                  dataIndex: ['today', 'main_inflow_ratio'],
                  width: 70,
                  align: 'right',
                  render: (v: number | null) => (
                    <span style={{ color: flowColor(v) }}>{fmtPct(v)}</span>
                  ),
                },
                {
                  title: '涨停',
                  dataIndex: ['today', 'limit_up_count'],
                  width: 60,
                  align: 'center',
                  sorter: (a, b) => a.today.limit_up_count - b.today.limit_up_count,
                  render: (v: number) =>
                    v > 0 ? <Tag color="red">{v}</Tag> : <span style={{ color: '#999' }}>0</span>,
                },
                {
                  title: '上涨/下跌',
                  width: 90,
                  align: 'center',
                  render: (_v, row) => {
                    const up = row.today.advancing_count ?? 0;
                    const dn = row.today.declining_count ?? 0;
                    return (
                      <span style={{ fontSize: 12 }}>
                        <span style={{ color: '#dc2626' }}>{up}</span>
                        <span style={{ color: '#999' }}> / </span>
                        <span style={{ color: '#16a34a' }}>{dn}</span>
                      </span>
                    );
                  },
                },
                {
                  title: '板块龙头',
                  width: 160,
                  render: (_v, row) => {
                    if (!row.today.leader_stock_name) {
                      return <span style={{ color: '#999' }}>—</span>;
                    }
                    return (
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 12 }}>
                          {row.today.leader_stock_name}{' '}
                          <span style={{ color: '#999', fontSize: 12 }}>
                            {row.today.leader_stock_code}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: pctColor(row.today.leader_stock_change_pct),
                          }}
                        >
                          {fmtPct(row.today.leader_stock_change_pct)}
                        </div>
                      </div>
                    );
                  },
                },
                {
                  title: `近 ${data.dates.length} 日涨跌幅`,
                  width: 200,
                  render: (_v, row) => <SparklinePctRow points={row.series} dates={data.dates} />,
                },
              ]}
              expandable={{
                expandedRowRender: row => (
                  <div style={{ padding: '8px 0', fontSize: 12 }}>
                    <Typography.Paragraph style={{ marginBottom: 4 }}>
                      <Text strong>{row.industry_name}</Text> · 近 {row.series.length} 日资金流向
                      (主力净占比):
                    </Typography.Paragraph>
                    <Space wrap>
                      {row.series.map(p => (
                        <Tag
                          key={p.trade_date}
                          color={
                            p.main_inflow_ratio == null
                              ? 'default'
                              : p.main_inflow_ratio > 0
                              ? 'red'
                              : 'green'
                          }
                        >
                          {p.trade_date.slice(5)}: {fmtPct(p.main_inflow_ratio)}
                        </Tag>
                      ))}
                    </Space>
                  </div>
                ),
              }}
            />
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              排序逻辑: 今日主力净流入 desc. 板块龙头股 = 当日涨幅最大且非一字板. 展开行查看近{' '}
              {data.dates.length} 日板块资金流强度.
            </Typography.Paragraph>
          </Card>
        </Col>

        {/* 右侧 — 今日热门概念 */}
        <Col xs={24} lg={8}>
          <Card
            title={
              <Space>
                <BarChartOutlined />
                今日热门概念
              </Space>
            }
            size="small"
          >
            {data.hot_concepts.length === 0 ? (
              <Empty description="今日 snowball_hot_keywords 无数据 — 请在 SchedulerService 启用 SNOWBALL_HOT_KEYWORD_SYNC" />
            ) : (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {data.hot_concepts.map((c, i) => (
                  <Card key={`${c.keyword}-${i}`} size="small" bodyStyle={{ padding: 12 }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <Text strong>{c.keyword}</Text>
                        {c.is_new && (
                          <Tag color="red" style={{ marginLeft: 6 }}>
                            新进
                          </Tag>
                        )}
                        {c.rank != null && <Tag style={{ marginLeft: 4 }}>#{c.rank}</Tag>}
                      </div>
                      <Tag color="blue">{c.heat_score.toLocaleString()}</Tag>
                    </div>
                    {c.related_stocks.length > 0 && (
                      <div style={{ fontSize: 12, color: '#666', marginTop: 4 }}>
                        关联:{' '}
                        {c.related_stocks.map(s => (
                          <Tag key={s.stock_code} style={{ marginBottom: 2 }}>
                            {s.stock_name || s.stock_code}
                          </Tag>
                        ))}
                      </div>
                    )}
                  </Card>
                ))}
              </Space>
            )}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              数据源: 雪球关注榜 top {data.hot_concepts.length}. heat_score = 当下关注人数,
              「新进」标签表示前一交易日榜内无此关键词.
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        💡 本面板为决策导向: <Text strong>板块强度榜</Text> 告诉你「今天主力在哪个板块」,{' '}
        <Text strong>龙头股</Text> 告诉你「能跟谁」, <Text strong>近 N 日序列</Text>{' '}
        告诉你「是日内异动还是持续轮动」, <Text strong>热门概念</Text> 告诉你「市场在炒哪个主题」.
        数据每日盘后由 SchedulerService 定时 sync 入库 (INDUSTRY_FLOW_SYNC / LIMIT_UP_SYNC /
        SNOWBALL_HOT_KEYWORD_SYNC).
      </Typography.Paragraph>

      {/* Batch AG (2026-06-18): 市场新闻时间线 — 给用户'今天市场在关心什么'的上下文 */}
      <Card
        title={
          <Space>
            <FundOutlined />
            今日要闻 (近 2 日, MARKET_NEWS_SYNC)
          </Space>
        }
        size="small"
      >
        {!data.recent_news || data.recent_news.length === 0 ? (
          <Empty
            description={
              <span style={{ fontSize: 12 }}>
                market_news 表无近 2 日数据 — 请在 SchedulerService 启用{' '}
                <Text code>MARKET_NEWS_SYNC</Text> 任务 (推荐盘中每 30 分钟一次)
              </span>
            }
          />
        ) : (
          <div
            style={{
              maxHeight: 400,
              overflowY: 'auto',
              borderLeft: '2px solid #f0f0f0',
              paddingLeft: 16,
            }}
          >
            {data.recent_news.map((n, i) => (
              <div
                key={`${n.publish_time}-${i}`}
                style={{
                  
                  marginLeft: -18,
                  paddingLeft: 14,
                  marginBottom: 12,
                  paddingBottom: 6,
                  borderBottom: '1px dashed #eee',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Text strong style={{ fontSize: 14 }} ellipsis={{ tooltip: n.title }}>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer">
                        {n.title}
                      </a>
                    ) : (
                      n.title
                    )}
                  </Text>
                  <Tag
                    color={n.source === 'cls' ? 'orange' : n.source === 'em' ? 'blue' : 'default'}
                  >
                    {n.source}
                  </Tag>
                </div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
                  {formatNewsTime(n.publish_time)} {n.category && <Tag>{n.category}</Tag>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </Space>
  );
};

/** 极简 sparkline: 5 个柱子, 红绿对照. 高度按 |pct| / max(|pct|) 归一. */
const SparklinePctRow: React.FC<{
  points: Array<{ trade_date: string; change_pct: number | null }>;
  dates: string[];
}> = ({ points, dates }) => {
  if (!points.length) return <span style={{ color: '#999' }}>—</span>;
  const max = Math.max(1, ...points.map(p => (p.change_pct == null ? 0 : Math.abs(p.change_pct))));
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', height: 28, gap: 3 }}>
      {dates.map(d => {
        const p = points.find(x => x.trade_date === d);
        const v = p?.change_pct ?? null;
        const h = v == null ? 4 : Math.max(2, (Math.abs(v) / max) * 24);
        const color = v == null ? '#e0e0e0' : v >= 0 ? '#dc2626' : '#16a34a';
        return (
          <div
            key={d}
            title={`${d}: ${v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%'}`}
            style={{
              width: 14,
              height: h,
              background: color,
              borderRadius: 8,
              opacity: v == null ? 0.4 : 0.85,
            }}
          />
        );
      })}
    </div>
  );
};

/** ISO 'YYYY-MM-DDTHH:mm:ss.sssZ' / 'YYYY-MM-DD HH:mm:ss' → 'MM-DD HH:mm' (本地友好). */
function formatNewsTime(raw: string | null | undefined): string {
  if (!raw) return '—';
  const s = String(raw);
  // ISO: 取月日时分
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) {
    return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  }
  // 'YYYY-MM-DD' only
  const md = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (md) return `${md[2]}-${md[3]}`;
  return s.slice(0, 16);
}

/**
 * SentimentBoardTab — Batch AH (2026-06-18) 舆情雷达面板.
 *
 * 5 个 Card 一站式展示:
 *   - Card 1 (lg=12): 全市场人气榜 (东财) top 20 — Table 按 hot_rank_em ASC
 *   - Card 2 (lg=12): 百度热搜榜 top 20 — Table 按 rank ASC
 *   - Card 3 (lg=12): 异动股 — Rank 突变 top 10 (今日 rank 较 5 日均值跃升)
 *   - Card 4 (lg=12): 情绪面散点 — 机构参与 vs 综合评分 (top-100 universe)
 *   - Card 5 (lg=24): 情绪类要闻 (近 2 日)
 *
 * 每个 Card 单独检查 data 子集为空时显示 Empty (per-block fallback, 同
 * TodayWorkspace 3-card 范式). block_errors 字段若存在则在对应 Card 上方
 * 显示 Alert warning.
 */
const SentimentBoardTab: React.FC<{
  data: SentimentBoardResponse | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}> = ({ data, loading, error, onReload }) => {
  if (loading && !data) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载舆情雷达…" />
        </div>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Alert
        type="error"
        showIcon
        message="加载舆情雷达失败"
        description={error}
        action={
          <Button size="small" onClick={onReload}>
            重试
          </Button>
        }
      />
    );
  }
  if (!data || (data.universe_size === 0 && data.note)) {
    return (
      <Card>
        <Empty
          description={
            data?.note ||
            'social_sentiment_snapshots 表为空 — 请在 SchedulerService 启用 SOCIAL_SENTIMENT_SYNC (Batch AH 已 seed) 或手动运行'
          }
        />
      </Card>
    );
  }

  const rankColor = (rank: number | null | undefined): string => {
    if (rank == null) return '#999';
    if (rank <= 10) return '#dc2626';
    if (rank <= 20) return '#fa8c16';
    if (rank <= 50) return '#faad14';
    return '#666';
  };
  const fmtNum = (v: number | null): string =>
    v == null || !Number.isFinite(v) ? '—' : v.toFixed(2);

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {error && (
        <Alert
          type="warning"
          showIcon
          message="数据刷新失败 (展示上次缓存)"
          description={error}
          action={
            <Button size="small" onClick={onReload}>
              重试
            </Button>
          }
        />
      )}

      {/* KPI strip */}
      {/* 数据陈旧度告警 */}
      {data.lag_days != null && data.lag_days > 2 && (
        <Alert
          type={data.data_staleness === 'very_stale' ? 'error' : 'warning'}
          showIcon
          message={`⚠ 数据滞后 ${data.lag_days} 天 (当前 ${data.today_iso ?? '?'}, 数据 ${
            data.trade_date
          })`}
          description="社媒/舆情数据未更新到最新交易日, 决策时请留意时间差."
          style={{ marginBottom: 8 }}
        />
      )}

      <Card size="small">
        <Space size={32} wrap>
          <Statistic
            title="数据日期"
            value={data.trade_date ?? '—'}
            valueStyle={
              data.lag_days != null && data.lag_days > 2 ? { color: '#fa8c16' } : undefined
            }
            suffix={
              data.lag_days != null && data.lag_days > 0 ? (
                <Tag color={data.data_staleness === 'very_stale' ? 'red' : 'orange'}>
                  滞后 {data.lag_days}d
                </Tag>
              ) : null
            }
          />
          <Statistic title="覆盖股票" value={data.universe_size} suffix="只" />
          <Statistic title="人气榜 top" value={data.today_hot_rank_top20.length} suffix="只" />
          <Statistic title="百度热搜" value={data.today_baidu_top20.length} suffix="条" />
          <Statistic title="今日异动" value={data.rank_breakouts.length} suffix="只" />
          <Statistic title="情绪要闻" value={data.recent_sentiment_news.length} suffix="条" />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={onReload}>
            刷新
          </Button>
        </Space>
      </Card>

      <Row gutter={[16, 16]}>
        {/* Card 1 — 东财人气榜 */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <ThunderboltOutlined style={{ color: '#dc2626' }} />
                全市场人气榜 (东财 top {data.today_hot_rank_top20.length})
              </Space>
            }
            size="small"
          >
            {data.block_errors?.today_hot_rank_top20 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`人气榜加载失败: ${data.block_errors.today_hot_rank_top20}`}
              />
            )}
            {data.today_hot_rank_top20.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日人气榜无数据" />
            ) : (
              <Table
                size="small"
                rowKey="stock_code"
                dataSource={data.today_hot_rank_top20}
                pagination={false}
                scroll={{ x: 'max-content', y: 360 }}
                columns={[
                  {
                    title: '排名',
                    dataIndex: 'hot_rank_em',
                    width: 56,
                    align: 'center',
                    render: (v: number) => (
                      <Tag
                        color={rankColor(v) === '#999' ? 'default' : undefined}
                        style={{ background: rankColor(v), color: 'white', border: 'none' }}
                      >
                        {v}
                      </Tag>
                    ),
                  },
                  {
                    title: '股票',
                    width: 140,
                    render: (_v, row) => (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{row.stock_name || '—'}</div>
                        <div style={{ fontSize: 12, color: '#999' }}>{row.stock_code}</div>
                      </div>
                    ),
                  },
                  {
                    title: '综合评分',
                    dataIndex: 'comment_score',
                    width: 80,
                    align: 'right',
                    sorter: (a, b) => (a.comment_score ?? -1) - (b.comment_score ?? -1),
                    render: (v: number | null) => <span style={{ fontSize: 12 }}>{fmtNum(v)}</span>,
                  },
                  {
                    title: '机构参与',
                    dataIndex: 'institution_participation',
                    width: 80,
                    align: 'right',
                    render: (v: number | null) => (
                      <span style={{ fontSize: 12 }}>{v == null ? '—' : `${v.toFixed(1)}%`}</span>
                    ),
                  },
                  {
                    title: '关注指数',
                    dataIndex: 'focus_index',
                    width: 80,
                    align: 'right',
                    render: (v: number | null) => <span style={{ fontSize: 12 }}>{fmtNum(v)}</span>,
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        {/* Card 2 — 百度热搜榜 */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <FundOutlined style={{ color: '#1890ff' }} />
                百度搜索热度榜 top {data.today_baidu_top20.length}
              </Space>
            }
            size="small"
          >
            {data.block_errors?.today_baidu_top20 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`百度热搜加载失败: ${data.block_errors.today_baidu_top20}`}
              />
            )}
            {data.today_baidu_top20.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="今日百度热搜无数据 — endpoint 可能暂不可用"
              />
            ) : (
              <Table
                size="small"
                rowKey={r => `${r.rank}-${r.keyword}`}
                dataSource={data.today_baidu_top20}
                pagination={false}
                scroll={{ x: 'max-content', y: 360 }}
                columns={[
                  {
                    title: '排名',
                    dataIndex: 'rank',
                    width: 56,
                    align: 'center',
                    render: (v: number) => (
                      <Tag
                        color={rankColor(v) === '#999' ? 'default' : undefined}
                        style={{ background: rankColor(v), color: 'white', border: 'none' }}
                      >
                        {v}
                      </Tag>
                    ),
                  },
                  {
                    title: '关键词',
                    dataIndex: 'keyword',
                    width: 130,
                    render: (v: string, row) => (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{v}</div>
                        {row.related_stock_code && (
                          <div style={{ fontSize: 12, color: '#1890ff' }}>
                            {row.related_stock_code}
                          </div>
                        )}
                      </div>
                    ),
                  },
                  {
                    title: '搜索指数',
                    dataIndex: 'search_index',
                    width: 90,
                    align: 'right',
                    render: (v: number | null) => (
                      <span style={{ fontSize: 12 }}>{v == null ? '—' : v.toLocaleString()}</span>
                    ),
                  },
                  {
                    title: '日环比',
                    dataIndex: 'change_rate',
                    width: 80,
                    align: 'right',
                    render: (v: number | null) => {
                      if (v == null) return <span style={{ fontSize: 12, color: '#999' }}>—</span>;
                      const color = v > 0 ? '#dc2626' : v < 0 ? '#16a34a' : '#666';
                      const arrow = v > 0 ? '↑' : v < 0 ? '↓' : '';
                      return (
                        <span style={{ fontSize: 12, color }}>
                          {arrow} {Math.abs(v).toFixed(2)}%
                        </span>
                      );
                    },
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        {/* Card 3 — 异动股 (rank 突变) */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <BarChartOutlined style={{ color: '#fa8c16' }} />
                异动股 — Rank 突变 top 10
              </Space>
            }
            size="small"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                今日 rank 较 5 日均值跃升越多 = 关注度突增
              </Typography.Text>
            }
          >
            {data.block_errors?.rank_breakouts && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`异动榜加载失败: ${data.block_errors.rank_breakouts}`}
              />
            )}
            {data.rank_breakouts.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="今日无 rank 突变股 (需要 ≥ 5 日历史)"
              />
            ) : (
              <Table
                size="small"
                rowKey="stock_code"
                dataSource={data.rank_breakouts}
                pagination={false}
                scroll={{ x: 'max-content', y: 360 }}
                columns={[
                  {
                    title: '股票',
                    width: 140,
                    render: (_v, row) => (
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 500 }}>{row.stock_name || '—'}</div>
                        <div style={{ fontSize: 12, color: '#999' }}>{row.stock_code}</div>
                      </div>
                    ),
                  },
                  {
                    title: '今日',
                    dataIndex: 'hot_rank_em',
                    width: 60,
                    align: 'center',
                    render: (v: number | null) => <Tag color="red">{v ?? '—'}</Tag>,
                  },
                  {
                    title: '5日均',
                    dataIndex: 'rank_5d_avg',
                    width: 70,
                    align: 'center',
                    render: (v: number | null) => (
                      <span style={{ fontSize: 12, color: '#999' }}>{fmtNum(v)}</span>
                    ),
                  },
                  {
                    title: 'Δ',
                    dataIndex: 'rank_breakout_delta',
                    width: 80,
                    align: 'right',
                    sorter: (a, b) => (a.rank_breakout_delta ?? 0) - (b.rank_breakout_delta ?? 0),
                    render: (v: number | null) => (
                      <span style={{ fontSize: 12, fontWeight: 600, color: '#dc2626' }}>
                        +{fmtNum(v)}
                      </span>
                    ),
                  },
                  {
                    title: '综合评分',
                    dataIndex: 'comment_score',
                    width: 80,
                    align: 'right',
                    render: (v: number | null) => <span style={{ fontSize: 12 }}>{fmtNum(v)}</span>,
                  },
                ]}
              />
            )}
          </Card>
        </Col>

        {/* Card 4 — 综合评分 top 30 横向柱状图 (替代散点, 更易读) */}
        <Col xs={24} lg={24}>
          <Card
            title={
              <Space>
                <FundOutlined style={{ color: '#722ed1' }} />
                综合评分 top 30 (东财综合得分 + 机构参与度叠层)
              </Space>
            }
            size="small"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                紫色 = 综合评分 (0-100), 橙色 = 机构参与度 (%)
              </Typography.Text>
            }
          >
            {data.block_errors?.sentiment_scatter && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`数据加载失败: ${data.block_errors.sentiment_scatter}`}
              />
            )}
            {data.sentiment_scatter.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今日无数据" />
            ) : (
              (() => {
                const top30 = [...data.sentiment_scatter]
                  .sort((a, b) => (b.comment_score ?? 0) - (a.comment_score ?? 0))
                  .slice(0, 30)
                  .map(s => ({
                    label: s.stock_name || s.stock_code,
                    code: s.stock_code,
                    comment_score: Number(s.comment_score?.toFixed(1) ?? 0),
                    // AKShare 返回 institution_participation 是 0-1 比例 (e.g. 0.48 = 48%)
                    // ×100 转成 0-100 百分比, 跟 comment_score 同尺度才能在同一 X 轴可视
                    institution_participation: Number(
                      ((s.institution_participation ?? 0) * 100).toFixed(1)
                    ),
                    hot_rank_em: s.hot_rank_em,
                  }));
                return (
                  <ResponsiveContainer width="100%" height={Math.max(420, top30.length * 22)}>
                    <BarChart
                      data={top30}
                      layout="vertical"
                      margin={{ top: 8, right: 32, bottom: 8, left: 64 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                      <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 12 }} />
                      <YAxis
                        type="category"
                        dataKey="label"
                        tick={{ fontSize: 12 }}
                        width={88}
                        interval={0}
                      />
                      <Tooltip
                        content={({ active, payload }: any) => {
                          if (!active || !payload?.[0]?.payload) return null;
                          const p = payload[0].payload;
                          return (
                            <div
                              style={{
                                background: 'white',
                                border: '1px solid #ddd',
                                padding: 8,
                                fontSize: 12,
                                borderRadius: 8,
                              }}
                            >
                              <div style={{ fontWeight: 500 }}>
                                {p.label} <span style={{ color: '#999' }}>{p.code}</span>
                              </div>
                              <div style={{ color: '#722ed1' }}>综合评分: {p.comment_score}</div>
                              <div style={{ color: '#fa8c16' }}>
                                机构参与: {p.institution_participation}%
                              </div>
                              {p.hot_rank_em != null && (
                                <div style={{ color: '#dc2626' }}>人气榜 #{p.hot_rank_em}</div>
                              )}
                            </div>
                          );
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar
                        dataKey="comment_score"
                        name="综合评分"
                        fill="#722ed1"
                        fillOpacity={0.85}
                        barSize={9}
                      />
                      <Bar
                        dataKey="institution_participation"
                        name="机构参与度 (%)"
                        fill="#fa8c16"
                        fillOpacity={0.85}
                        barSize={9}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                );
              })()
            )}
          </Card>
        </Col>

        {/* Card 5 — 情绪类要闻 */}
        <Col xs={24}>
          <Card
            title={
              <Space>
                <FundOutlined style={{ color: '#1890ff' }} />
                情绪类要闻 (近 2 日)
              </Space>
            }
            size="small"
            extra={
              data.keywords_used && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  关键词: {data.keywords_used.join(' / ')}
                </Typography.Text>
              )
            }
          >
            {data.block_errors?.recent_sentiment_news && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message={`情绪新闻加载失败: ${data.block_errors.recent_sentiment_news}`}
              />
            )}
            {data.recent_sentiment_news.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="近 2 日 market_news 无含情绪关键词的要闻"
              />
            ) : (
              <div
                style={{
                  maxHeight: 320,
                  overflowY: 'auto',
                  borderLeft: '2px solid #f0f0f0',
                  paddingLeft: 16,
                }}
              >
                {data.recent_sentiment_news.map((n, i) => (
                  <div
                    key={`${n.publish_time}-${i}`}
                    style={{
                      
                      marginLeft: -18,
                      paddingLeft: 14,
                      marginBottom: 10,
                      paddingBottom: 6,
                      borderBottom: '1px dashed #eee',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <Text strong style={{ fontSize: 14 }} ellipsis={{ tooltip: n.title }}>
                        {n.url ? (
                          <a href={n.url} target="_blank" rel="noopener noreferrer">
                            {n.title}
                          </a>
                        ) : (
                          n.title
                        )}
                      </Text>
                      <Tag
                        color={
                          n.source === 'cls' ? 'orange' : n.source === 'em' ? 'blue' : 'default'
                        }
                      >
                        {n.source}
                      </Tag>
                    </div>
                    <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
                      {formatNewsTime(n.publish_time)}
                      {n.category && <Tag style={{ marginLeft: 4 }}>{n.category}</Tag>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        💡 舆情雷达: <Text strong>东财人气榜</Text> 告诉你「全市场散户在看哪只」,{' '}
        <Text strong>百度搜索</Text> 是跨平台搜索热度的「散户视角」, <Text strong>Rank 突变</Text>{' '}
        找今日关注度突增的「异动股」, <Text strong>散点</Text> 看机构参与 vs 综合评分的分布找洼地,{' '}
        <Text strong>情绪要闻</Text> 提供宏观情绪上下文. 数据每日盘后由 SchedulerService 定时 sync
        (SOCIAL_SENTIMENT_SYNC 16:20 / MARKET_HOT_SEARCH_SYNC 16:40).
      </Typography.Paragraph>
    </Space>
  );
};

/**
 * IndustryHeatmapTab — echarts heatmap：行业 × 因子的 z_score 平均值。
 *
 * 视觉编码：
 *   - 横轴：所有已注册因子（数量与因子总览一致）
 *   - 纵轴：申万一级行业（按"行业 × 全因子 z 总和"降序——最受多因子青睐的行业排顶）
 *   - 颜色：z_score 平均值；负值红、正值绿、中性灰白；visualMap 对称 [-1.5, 1.5]
 *
 * 边缘情况：
 *   - factor_scores 表空 / 当日无数据 → 显示 Empty + 后端 note 文案
 *   - 行业有效格 < 1 → Alert 提示前端只能给出有限信息
 *   - 加载失败 → 顶部 Alert + 重试按钮（保留旧成功数据以减少闪烁）
 */
const IndustryHeatmapTab: React.FC<{
  data: FactorIndustryHeatmapResponse | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}> = ({ data, loading, error, onReload }) => {
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('table');
  const [sortFactor, setSortFactor] = useState<string>('');

  // 计算 heatmap 高度：每个行业 ~28px，留 100px 给坐标轴 / 标题，最少 360px
  const chartHeight = useMemo(() => {
    const rows = data?.industries.length ?? 0;
    return Math.max(360, Math.min(rows * 28 + 100, 1200));
  }, [data?.industries.length]);

  const option = useMemo(() => buildHeatmapOption(data), [data]);

  // 构造 table 数据：每行 = 一个行业，列 = 各因子的平均 z_score
  const tableRows = useMemo(() => {
    if (!data) return [];
    const cellMap = new Map<string, number>(); // key = `${industry}|${factor}`
    const sampleMap = new Map<string, number>();
    for (const c of data.cells) {
      const k = `${c.industry}|${c.factor}`;
      cellMap.set(k, c.avg_z);
      sampleMap.set(k, c.sample_size ?? 0);
    }
    return data.industries.map(ind => {
      const row: Record<string, any> = { industry: ind };
      let totalSample = 0;
      let factorSum = 0;
      let factorN = 0;
      for (const f of data.factors) {
        const k = `${ind}|${f}`;
        const z = cellMap.get(k);
        row[f] = z != null ? Number(z.toFixed(2)) : null;
        if (z != null) {
          factorSum += Math.abs(z);
          factorN += 1;
        }
        totalSample += sampleMap.get(k) || 0;
      }
      row._sample_count =
        totalSample > 0 ? Math.round(totalSample / Math.max(1, data.factors.length)) : 0;
      row._intensity = factorN > 0 ? factorSum / factorN : 0;
      return row;
    });
  }, [data]);

  const sortedRows = useMemo(() => {
    if (!sortFactor || sortFactor === '_intensity') {
      return [...tableRows].sort((a, b) => (b._intensity || 0) - (a._intensity || 0));
    }
    return [...tableRows].sort(
      (a, b) => (b[sortFactor] ?? -Infinity) - (a[sortFactor] ?? -Infinity)
    );
  }, [tableRows, sortFactor]);

  // 颜色映射: z 越正越红, 越负越绿
  const zColor = (z: number | null): string => {
    if (z == null) return '#f5f5f5';
    const clamped = Math.max(-2, Math.min(2, z));
    const intensity = Math.abs(clamped) / 2; // 0..1
    if (clamped >= 0) {
      // 红色系: rgba(207, 19, 34, 0..0.8)
      return `rgba(207, 19, 34, ${0.1 + intensity * 0.5})`;
    } else {
      // 绿色系
      return `rgba(20, 177, 67, ${0.1 + intensity * 0.5})`;
    }
  };

  if (loading && !data) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载行业热力…" />
        </div>
      </Card>
    );
  }
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {error && (
        <Alert
          type="error"
          showIcon
          message="加载行业热力失败"
          description={error}
          action={
            <Button size="small" onClick={onReload}>
              重试
            </Button>
          }
        />
      )}
      <Card
        title={
          <Space>
            <AppstoreOutlined />
            行业 × 因子热力
            {data?.trade_date && <Tag color="blue">{data.trade_date}</Tag>}
            <Tag>{data?.industries.length || 0} 个行业</Tag>
            <Tag>{data?.factors.length || 0} 个因子</Tag>
          </Space>
        }
        extra={
          <Space>
            {data?.universe_size != null && <Tag color="blue">命中 {data.universe_size} 只</Tag>}
            <Button.Group size="small">
              <Button
                type={viewMode === 'table' ? 'primary' : 'default'}
                onClick={() => setViewMode('table')}
              >
                表格
              </Button>
              <Button
                type={viewMode === 'chart' ? 'primary' : 'default'}
                onClick={() => setViewMode('chart')}
              >
                热力图
              </Button>
            </Button.Group>
            <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onReload}>
              刷新
            </Button>
          </Space>
        }
      >
        {!data || data.cells.length === 0 ? (
          <Empty
            description={
              data?.note ||
              'factor_scores 表为空 — 请先运行 npm run compute:factors -- --date=YYYY-MM-DD'
            }
          />
        ) : viewMode === 'chart' ? (
          <>
            <ReactECharts
              option={option}
              style={{ width: '100%', height: chartHeight }}
              notMerge
              opts={{ renderer: 'canvas' }}
            />
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              颜色越红 = 该行业在该因子上横截面 z_score 平均值越高；越绿越低。
            </Typography.Paragraph>
          </>
        ) : (
          <>
            <Space style={{ marginBottom: 12 }} wrap>
              <span style={{ fontSize: 12, color: '#666' }}>排序：</span>
              <Button.Group size="small">
                <Button
                  type={sortFactor === '_intensity' || !sortFactor ? 'primary' : 'default'}
                  onClick={() => setSortFactor('_intensity')}
                >
                  综合强度
                </Button>
                {data.factors.slice(0, 8).map(f => (
                  <Button
                    key={f}
                    type={sortFactor === f ? 'primary' : 'default'}
                    onClick={() => setSortFactor(f)}
                  >
                    {f}
                  </Button>
                ))}
              </Button.Group>
            </Space>
            <Table
              size="small"
              rowKey="industry"
              dataSource={sortedRows}
              pagination={{
                pageSize: 30,
                size: 'small',
                showSizeChanger: true,
                pageSizeOptions: ['20', '30', '50', '100'],
              }}
              scroll={{ x: 'max-content', y: 600 }}
              columns={[
                {
                  title: '行业',
                  dataIndex: 'industry',
                  width: 130,
                  fixed: 'left',
                  render: (v: string, r: any) => (
                    <div>
                      <div style={{ fontWeight: 500 }}>{v}</div>
                      <div style={{ fontSize: 12, color: '#999' }}>{r._sample_count} 只样本</div>
                    </div>
                  ),
                },
                ...data.factors.map(f => ({
                  title: <span style={{ fontSize: 12 }}>{f}</span>,
                  dataIndex: f,
                  width: 78,
                  align: 'center' as const,
                  sorter: (a: any, b: any) => (a[f] ?? -Infinity) - (b[f] ?? -Infinity),
                  render: (z: number | null) => (
                    <div
                      style={{
                        background: zColor(z),
                        padding: '4px 6px',
                        borderRadius: 8,
                        textAlign: 'center',
                        fontSize: 12,
                        fontWeight: z != null && Math.abs(z) > 1 ? 600 : 400,
                        color: z != null && Math.abs(z) > 1.5 ? '#fff' : '#333',
                      }}
                    >
                      {z != null ? z.toFixed(2) : '—'}
                    </div>
                  ),
                })),
              ]}
            />
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              单元格颜色越红 = z_score 越正（行业在该因子上整体占优），越绿 = 越负。点击表头排序。
            </Typography.Paragraph>
          </>
        )}
      </Card>
    </Space>
  );
};

/** 构造 echarts heatmap option；data 为 null/空时返回空骨架，避免组件挂载报错 */
function buildHeatmapOption(data: FactorIndustryHeatmapResponse | null): Record<string, unknown> {
  if (!data || data.cells.length === 0) {
    return { series: [] };
  }
  const xCategories = data.factors;
  const yCategories = data.industries;
  const xIndex = new Map<string, number>();
  xCategories.forEach((c, i) => xIndex.set(c, i));
  const yIndex = new Map<string, number>();
  yCategories.forEach((c, i) => yIndex.set(c, i));

  // 转换成 echarts heatmap 数据：[xIdx, yIdx, value]；过滤越界（防御性）
  const series: Array<[number, number, number]> = [];
  let absMax = 0.0001;
  for (const cell of data.cells) {
    const x = xIndex.get(cell.factor);
    const y = yIndex.get(cell.industry);
    if (x == null || y == null) continue;
    series.push([x, y, cell.avg_z]);
    if (Math.abs(cell.avg_z) > absMax) absMax = Math.abs(cell.avg_z);
  }
  // visualMap 对称范围：[-max, max]，且最低 1.5（避免极小波动被夸大色彩）
  const visualBound = Math.max(1.5, Number(absMax.toFixed(2)));

  return {
    grid: { left: 140, right: 30, top: 50, bottom: 80, containLabel: true },
    tooltip: {
      position: 'top',
      formatter: (params: { value: [number, number, number]; data: [number, number, number] }) => {
        const [xIdx, yIdx, v] = params.value;
        const factor = xCategories[xIdx] ?? '';
        const industry = yCategories[yIdx] ?? '';
        const cell = data.cells.find(c => c.factor === factor && c.industry === industry);
        const sample = cell?.sample_size ?? 0;
        return `${industry}<br/><b>${factor}</b><br/>平均 z = <b>${v.toFixed(
          3
        )}</b><br/>样本 ${sample} 只`;
      },
    },
    xAxis: {
      type: 'category',
      data: xCategories,
      splitArea: { show: true },
      axisLabel: { interval: 0, rotate: 30 },
    },
    yAxis: {
      type: 'category',
      data: yCategories,
      splitArea: { show: true },
      axisLabel: { interval: 0, fontSize: 12 },
    },
    visualMap: {
      min: -visualBound,
      max: visualBound,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 10,
      inRange: {
        // 红→白→绿 对称色带，与"涨绿跌红"A 股语义保持一致 (z 正 = 因子高 = 看多 = 绿)
        color: [
          '#d73027',
          '#f46d43',
          '#fdae61',
          '#fee08b',
          '#ffffbf',
          '#d9ef8b',
          '#a6d96a',
          '#66bd63',
          '#1a9850',
        ],
      },
    },
    series: [
      {
        name: 'avg_z',
        type: 'heatmap',
        data: series,
        label: { show: false },
        emphasis: {
          itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.4)' },
        },
      },
    ],
  };
}

// ============================================================================
// Shared column builders
// ============================================================================

function buildPreviewColumns(
  factorNames: string[],
  onAnalyze?: (row: FactorPreviewSignal) => void
) {
  return [
    {
      title: '代码',
      dataIndex: 'stock_code',
      key: 'stock_code',
      width: 100,
      fixed: 'left' as const,
    },
    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
    { title: '行业', dataIndex: 'industry', key: 'industry', width: 120 },
    {
      title: '综合得分',
      dataIndex: 'composite_score',
      key: 'composite_score',
      width: 110,
      sorter: (a: FactorPreviewSignal, b: FactorPreviewSignal) =>
        a.composite_score - b.composite_score,
      defaultSortOrder: 'descend' as const,
      render: (v: number) => (
        <Text strong style={{ color: v > 0 ? '#16a34a' : '#dc2626' }}>
          {v.toFixed(3)}
        </Text>
      ),
    },
    {
      title: '信号',
      dataIndex: 'signal',
      key: 'signal',
      width: 80,
      render: (v: string) =>
        v === 'buy' ? (
          <Tag color="green">买入</Tag>
        ) : v === 'sell' ? (
          <Tag color="red">卖出</Tag>
        ) : (
          <Tag color="blue">持有</Tag>
        ),
    },
    ...factorNames.map(name => ({
      title: name,
      key: `f_${name}`,
      width: 80,
      render: (_: unknown, record: FactorPreviewSignal) => {
        const z = record.factor_z_scores[name] ?? 0;
        return (
          <Text style={{ color: z > 0 ? '#16a34a' : z < 0 ? '#dc2626' : undefined }}>
            {z.toFixed(2)}
          </Text>
        );
      },
    })),
    ...(onAnalyze
      ? [
          {
            title: 'AI 解读',
            key: 'ai_analyze',
            width: 110,
            fixed: 'right' as const,
            render: (_: unknown, record: FactorPreviewSignal) => (
              <Button
                size="small"
                icon={<BarChartOutlined />}
                onClick={() => onAnalyze(record)}
                title="AI 解读：基本面 / 技术面 / 资金面 / 新闻面 / 情绪面"
              >
                AI 解读
              </Button>
            ),
          },
        ]
      : []),
  ];
}

function buildLatestPickColumns(
  _factorNames: string[],
  onAnalyze?: (row: FactorPreviewSignal) => void
) {
  return [
    {
      title: '代码',
      dataIndex: 'stock_code',
      key: 'stock_code',
      width: 100,
      fixed: 'left' as const,
    },
    { title: '名称', dataIndex: 'name', key: 'name', width: 140 },
    { title: '行业', dataIndex: 'industry', key: 'industry', width: 130 },
    {
      title: '综合得分',
      dataIndex: 'composite_score',
      key: 'composite_score',
      width: 110,
      sorter: (a: FactorPreviewSignal, b: FactorPreviewSignal) =>
        a.composite_score - b.composite_score,
      defaultSortOrder: 'descend' as const,
      render: (v: number) => (
        <Text strong style={{ color: v > 0 ? '#16a34a' : '#dc2626' }}>
          {v.toFixed(3)}
        </Text>
      ),
    },
    {
      title: '上次调仓动作',
      dataIndex: 'signal',
      key: 'signal',
      width: 130,
      render: (v: string) =>
        v === 'buy' ? (
          <Tag color="green">买入（新进）</Tag>
        ) : v === 'sell' ? (
          <Tag color="red">卖出（剔除）</Tag>
        ) : (
          <Tag color="blue">持有</Tag>
        ),
    },
    {
      title: '理由',
      key: 'inline_reason',
      width: 260,
      render: (_: unknown, record: FactorPreviewSignal) => {
        const short = buildShortPickReason(record);
        // Tooltip 显示 backend 原始 reason + composite (展开行也有, 这里给"不点展开"
        // 的用户兜底); 列默认显示 inline 短理由 (top-2 因子贡献), 与 US-049 PRD AC
        // "列表内嵌短理由"对齐.
        const fullTip = record.reason || short;
        return (
          <AntTooltip title={fullTip} mouseEnterDelay={0.2}>
            <Text style={{ fontSize: 12 }} type="secondary">
              {short}
            </Text>
          </AntTooltip>
        );
      },
    },
    ...(onAnalyze
      ? [
          {
            title: 'AI 解读',
            key: 'ai_analyze',
            width: 110,
            fixed: 'right' as const,
            render: (_: unknown, record: FactorPreviewSignal) => (
              <Button
                size="small"
                icon={<BarChartOutlined />}
                onClick={() => onAnalyze(record)}
                title="AI 解读：基本面 / 技术面 / 资金面 / 新闻面 / 情绪面"
              >
                AI 解读
              </Button>
            ),
          },
        ]
      : []),
  ];
}

export default FactorWorkspace;

// ============================================================================
// FactorDetailDrawer (US-094) — 点击因子卡片打开
// ============================================================================

/**
 * FactorDetailDrawer — 因子详情抽屉。
 *
 * 3 段内容：
 *   - 因子元数据（name / category / description / period / effective_trade_days）
 *   - IC 历史曲线（recharts LineChart；X = period_end，Y = ic_mean）
 *   - 5 等分组合累计净值曲线 Q1..Q5（recharts LineChart；起点 1.0；Q5=多头组绿，
 *     Q1=空头组红，中间灰阶；按 trade_date ASC）
 *
 * 设计选择：
 *   - 用 recharts 不用 echarts —— FactorWorkspace 已用了 echarts (行业热力)；这里
 *     用 recharts 跟 BacktestResults / LiveTrading / QuantBacktestLab 一致 (项目里
 *     时序曲线主选 recharts；热力图主选 echarts)，降低样式认知。
 *   - 480px 宽 drawer 与项目其它 Drawer 模板 (US-062 Copilot) 一致；中等宽足以
 *     放下双图表 + 描述。
 *   - 4 态短路：loading / error+retry / empty (note) / success；同 US-074 lazy
 *     load 范式。空 data 仍渲染 Drawer skeleton，避免闪烁。
 */
interface FactorDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  factorName: string | null;
  detail: FactorDetailResponse | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}

const QUINTILE_COLORS: Record<'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5', string> = {
  Q1: '#dc2626', // 空头组 红
  Q2: '#fa8c16',
  Q3: '#bfbfbf', // 中性 灰
  Q4: '#73d13d',
  Q5: '#16a34a', // 多头组 深绿
};

const FactorDetailDrawer: React.FC<FactorDetailDrawerProps> = ({
  open,
  onClose,
  factorName,
  detail,
  loading,
  error,
  onRetry,
}) => {
  const category = detail
    ? CATEGORY_DISPLAY[detail.category] ?? CATEGORY_DISPLAY.other
    : CATEGORY_DISPLAY.other;

  return (
    <Drawer
      title={
        <Space>
          <FundOutlined />
          <Text strong>{factorName ?? '因子详情'}</Text>
          {detail && <Tag color={category.color}>{category.label}</Tag>}
        </Space>
      }
      placement="right"
      width={720}
      open={open}
      onClose={onClose}
      destroyOnClose={false}
    >
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载因子详情…" />
        </div>
      )}
      {!loading && error && (
        <Alert
          type="error"
          showIcon
          message="加载失败"
          description={error}
          action={
            onRetry && (
              <Button size="small" onClick={onRetry}>
                重试
              </Button>
            )
          }
        />
      )}
      {!loading && !error && detail && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="描述">
              {detail.description || <Text type="secondary">（无描述）</Text>}
            </Descriptions.Item>
            <Descriptions.Item label="分类">
              <Tag color={category.color}>{category.label}</Tag>
              <Text type="secondary">{detail.category}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="数据窗口">
              {detail.period_start && detail.period_end
                ? `${detail.period_start} ~ ${detail.period_end}`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="有效交易日">
              {detail.effective_trade_days} / {detail.quintile_curves.length}
            </Descriptions.Item>
          </Descriptions>

          {detail.note && <Alert type="info" showIcon message={detail.note} />}

          <Card
            size="small"
            title={
              <Space>
                <Text strong>IC 历史曲线</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  （rank IC，正值越大因子有效；接近 0 = 失效）
                </Text>
              </Space>
            }
          >
            {detail.ic_history.length === 0 ? (
              <Empty
                description="尚无 IC 数据 — 请先运行 npm run report:factor-ic"
                imageStyle={{ height: 60 }}
              />
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <LineChart
                  data={detail.ic_history}
                  margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="period_end" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} domain={['auto', 'auto']} />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      value != null ? value.toFixed(4) : '—',
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={0} stroke="#999" strokeDasharray="2 2" />
                  <Line
                    type="monotone"
                    dataKey="ic_mean"
                    name="IC 均值"
                    stroke="#1890ff"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="ic_ir"
                    name="IC IR"
                    stroke="#722ed1"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>

          <Card
            size="small"
            title={
              <Space>
                <Text strong>5 等分组合累计净值</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  （Q5 = 高分多头组，Q1 = 低分空头组；起点 1.0）
                </Text>
              </Space>
            }
          >
            {detail.quintile_curves.length === 0 ? (
              <Empty
                description="尚无横截面数据 — 请先运行 npm run compute:factors"
                imageStyle={{ height: 60 }}
              />
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <LineChart
                  data={detail.quintile_curves}
                  margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="trade_date" tick={{ fontSize: 12 }} minTickGap={32} />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    domain={['auto', 'auto']}
                    tickFormatter={v => Number(v).toFixed(3)}
                  />
                  <Tooltip
                    formatter={(value: number, name: string) => [
                      value != null ? Number(value).toFixed(4) : '—',
                      name,
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine y={1} stroke="#999" strokeDasharray="2 2" />
                  {(['Q1', 'Q2', 'Q3', 'Q4', 'Q5'] as const).map(q => (
                    <Line
                      key={q}
                      type="monotone"
                      dataKey={q}
                      stroke={QUINTILE_COLORS[q]}
                      strokeWidth={q === 'Q1' || q === 'Q5' ? 2 : 1.2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Space>
      )}
      {!loading && !error && !detail && factorName && <Empty description="尚未加载因子详情" />}
    </Drawer>
  );
};
