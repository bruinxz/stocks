import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  InputNumber,
  Row,
  Slider,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  AppstoreOutlined,
  FundOutlined,
  SlidersOutlined,
  OrderedListOutlined,
  ReloadOutlined,
  RobotOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import AIStockAnalysisModal from '../../components/trading/AIStockAnalysisModal';
import {
  factorService,
  FactorDetailResponse,
  FactorIndustryHeatmapResponse,
  FactorOverviewItem,
  FactorOverviewResponse,
  FactorPreviewResponse,
  FactorPreviewSignal,
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
  quality: { label: '质量', color: 'cyan' },
  growth: { label: '成长', color: 'green' },
  momentum: { label: '动量', color: 'orange' },
  volatility: { label: '波动', color: 'purple' },
  liquidity: { label: '流动性', color: 'gold' },
  sentiment: { label: '情绪', color: 'magenta' },
  flow: { label: '资金流', color: 'red' },
  event: { label: '事件', color: 'volcano' },
  other: { label: '其他', color: 'default' },
};

const FactorWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'overview', label: '因子总览', icon: <FundOutlined /> },
    { key: 'weights', label: '权重调参', icon: <SlidersOutlined /> },
    { key: 'picks', label: '今日选股清单', icon: <OrderedListOutlined /> },
    { key: 'heatmap', label: '行业热力', icon: <AppstoreOutlined /> },
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
}

const WeightsTab: React.FC<WeightsTabProps> = ({
  factors,
  weights,
  weightSum,
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
            <Button onClick={onReset}>重置为默认</Button>
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
          {picks.params && <Tag color="purple">topN {picks.params.topN}</Tag>}
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
      sampleMap.set(k, c.sample_count ?? 0);
    }
    return data.industries.map((ind) => {
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
      row._sample_count = totalSample > 0 ? Math.round(totalSample / Math.max(1, data.factors.length)) : 0;
      row._intensity = factorN > 0 ? factorSum / factorN : 0;
      return row;
    });
  }, [data]);

  const sortedRows = useMemo(() => {
    if (!sortFactor || sortFactor === '_intensity') {
      return [...tableRows].sort((a, b) => (b._intensity || 0) - (a._intensity || 0));
    }
    return [...tableRows].sort((a, b) => (b[sortFactor] ?? -Infinity) - (a[sortFactor] ?? -Infinity));
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
            {data?.universe_size != null && <Tag color="purple">命中 {data.universe_size} 只</Tag>}
            <Button.Group size="small">
              <Button type={viewMode === 'table' ? 'primary' : 'default'} onClick={() => setViewMode('table')}>
                表格
              </Button>
              <Button type={viewMode === 'chart' ? 'primary' : 'default'} onClick={() => setViewMode('chart')}>
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
                {data.factors.slice(0, 8).map((f) => (
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
              pagination={{ pageSize: 30, size: 'small', showSizeChanger: true, pageSizeOptions: ['20', '30', '50', '100'] }}
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
                      <div style={{ fontSize: 11, color: '#999' }}>{r._sample_count} 只样本</div>
                    </div>
                  ),
                },
                ...data.factors.map((f) => ({
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
                        borderRadius: 3,
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
      axisLabel: { interval: 0, fontSize: 11 },
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
        <Text strong style={{ color: v > 0 ? '#52c41a' : '#f5222d' }}>
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
          <Text style={{ color: z > 0 ? '#52c41a' : z < 0 ? '#f5222d' : undefined }}>
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
                icon={<RobotOutlined />}
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
        <Text strong style={{ color: v > 0 ? '#52c41a' : '#f5222d' }}>
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
                icon={<RobotOutlined />}
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
  Q1: '#f5222d', // 空头组 红
  Q2: '#fa8c16',
  Q3: '#bfbfbf', // 中性 灰
  Q4: '#73d13d',
  Q5: '#52c41a', // 多头组 深绿
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
                  <XAxis dataKey="period_end" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
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
                  <XAxis dataKey="trade_date" tick={{ fontSize: 11 }} minTickGap={32} />
                  <YAxis
                    tick={{ fontSize: 11 }}
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
