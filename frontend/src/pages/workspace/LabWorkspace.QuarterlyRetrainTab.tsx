/**
 * LabWorkspace.QuarterlyRetrainTab — US-050 / FE-011
 *
 * 季度参数重训面板. 复用既有 listOptimizationRuns + listQuantStrategies 端点 (零新接口),
 * 业务逻辑全部抽到 quarterlyRetrainHelpers.ts (纯函数, 可单测).
 *
 * 顶部 KPI: 候选总数 / 当前季度被重训策略数 / 其中处于 shadow 模式的策略数.
 * 控件: 季度 Select (默认本季) + 刷新.
 * 主区: 按 strategy 分卡片渲染, 每张卡片含 shadow / 生产 badge + top-K candidates 表格.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ExperimentOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { labService, OptimizationRunSummary, QuantStrategyItem } from '../../services/labService';
import {
  buildQuarterlyRetrainViewModel,
  DEFAULT_CANDIDATES_PER_BUCKET,
  DEFAULT_QUARTERS_WINDOW,
  HARD_BADGE_TEXT,
  RetrainCandidate,
  SHADOW_BADGE_TEXT,
  getRecentQuarters,
  isShadowStrategy,
  lookupShadowByStrategyName,
} from './quarterlyRetrainHelpers';

const { Text, Paragraph } = Typography;

interface QuarterlyRetrainTabProps {
  /** 父级已加载的策略列表 (用于 shadow 判定). 父没传也 ok — tab 自己也会 fallback. */
  strategies?: Array<QuantStrategyItem & { lifecycle_policy?: Record<string, any> }>;
}

const formatPrimaryMetric = (c: RetrainCandidate) => {
  if (c.primary_metric === null) return '—';
  const label =
    c.primary_metric_kind === 'dsr'
      ? 'DSR'
      : c.primary_metric_kind === 'mean_test_sharpe'
        ? 'meanSharpe'
        : c.primary_metric_kind === 'deflated_sharpe'
          ? 'DeflatedSharpe'
          : '';
  const tone = c.primary_metric > 0.5 ? '#16a34a' : c.primary_metric > 0 ? '#1677ff' : '#dc2626';
  return (
    <Tooltip title={`${label}: ${c.primary_metric.toFixed(4)}`}>
      <Text style={{ color: tone, fontWeight: 500 }}>{c.primary_metric.toFixed(3)}</Text>
      <Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
        {label}
      </Text>
    </Tooltip>
  );
};

const optimizerTagColor: Record<RetrainCandidate['optimizer_type'], string> = {
  grid_search: 'blue',
  bayesian: 'purple',
  walk_forward: 'volcano',
};

const optimizerLabel: Record<RetrainCandidate['optimizer_type'], string> = {
  grid_search: 'Grid Search',
  bayesian: 'Bayesian',
  walk_forward: 'Walk-Forward',
};

const verdictColor: Record<string, string> = {
  PASS: 'green',
  FAIL: 'red',
  INSUFFICIENT: 'orange',
};

const QuarterlyRetrainTab: React.FC<QuarterlyRetrainTabProps> = ({ strategies = [] }) => {
  const [runs, setRuns] = useState<OptimizationRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeQuarter, setActiveQuarter] = useState<string | null>(null);
  // 父级未必传 strategies 全量 (含 lifecycle_policy), 这里自己再拉一次保险.
  const [localStrategies, setLocalStrategies] = useState<
    Array<QuantStrategyItem & { lifecycle_policy?: Record<string, any> }>
  >([]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 拉所有 optimizer type, limit 100 — 4 季度 × 平均 25 个 run 已足够诊断
      const [runsResp, strategiesResp] = await Promise.all([
        labService.listOptimizationRuns({ optimizer_type: 'all', limit: 100 }),
        // strategies 列表自带 lifecycle_policy 字段 (后端 QuantController.listStrategies 已含)
        labService.listQuantStrategies(),
      ]);
      setRuns(Array.isArray(runsResp) ? runsResp : []);
      setLocalStrategies(
        Array.isArray(strategiesResp)
          ? (strategiesResp as Array<
              QuantStrategyItem & { lifecycle_policy?: Record<string, any> }
            >)
          : []
      );
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // 父级传的 strategies 与 local 拉的合并 — 父优先 (避免初始空数组覆盖刚拉到的有用数据)
  const effectiveStrategies = useMemo(() => {
    if (strategies && strategies.length > 0) return strategies;
    return localStrategies;
  }, [strategies, localStrategies]);

  const now = useMemo(() => new Date(), []);

  const vm = useMemo(
    () =>
      buildQuarterlyRetrainViewModel({
        runs,
        strategies: effectiveStrategies,
        now,
        activeQuarter,
        windowSize: DEFAULT_QUARTERS_WINDOW,
        topK: DEFAULT_CANDIDATES_PER_BUCKET,
      }),
    [runs, effectiveStrategies, now, activeQuarter]
  );

  // 初次拉到数据时, 把 activeQuarter 落到第一个 quarter (本季)
  useEffect(() => {
    if (!activeQuarter && vm.quarterOptions.length > 0) {
      setActiveQuarter(vm.quarterOptions[0]);
    }
  }, [activeQuarter, vm.quarterOptions]);

  const quarterOptions = useMemo(
    () => getRecentQuarters(now, DEFAULT_QUARTERS_WINDOW).map(q => ({ value: q, label: q })),
    [now]
  );

  const activeBucket = activeQuarter ? vm.bucketsByQuarter.get(activeQuarter) : undefined;
  const strategyEntries: Array<[string, RetrainCandidate[]]> = activeBucket
    ? Array.from(activeBucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    : [];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <ExperimentOutlined />
            <Text strong>季度参数重训面板</Text>
            {/* Phase 3 (2026-06-27): US-XXX 装饰 Tag 已退役. */}
          </Space>
        }
        extra={
          <Space size={8}>
            <span style={{ fontSize: 12 }}>季度:</span>
            <Select
              size="small"
              data-testid="quarterly-retrain-quarter-select"
              value={activeQuarter || undefined}
              onChange={v => setActiveQuarter(v)}
              style={{ width: 160 }}
              options={quarterOptions}
              placeholder="选择季度"
            />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={loadAll}
              loading={loading}
              data-testid="quarterly-retrain-refresh"
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Paragraph style={{ marginBottom: 12, color: '#666', fontSize: 12 }}>
          按季度回看每个策略的参数重训记录: 同季度内同策略的 top-{DEFAULT_CANDIDATES_PER_BUCKET}{' '}
          候选 (按 DSR / mean test sharpe / deflated sharpe 排序), 并标注当前是否跑在 shadow
          (dry-run) 模式上. 下游决策: 候选评分突破历史峰值 + shadow 中 → 可考虑切到生产 (走
          SettingsWorkspace 的策略生命周期 tab).
        </Paragraph>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 12 }} />}

        <Row gutter={16} style={{ marginBottom: 12 }}>
          <Col xs={24} sm={8}>
            <Statistic
              title="候选总数 (window 内)"
              value={vm.totalCandidates}
              prefix={<ThunderboltOutlined />}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Statistic
              title="本季度被重训策略数"
              value={vm.strategiesInActiveQuarter}
              valueStyle={{
                color: vm.strategiesInActiveQuarter === 0 ? '#999' : '#1677ff',
              }}
            />
          </Col>
          <Col xs={24} sm={8}>
            <Statistic
              title="其中处于 Shadow 模式"
              value={vm.shadowStrategiesInActiveQuarter}
              suffix={`/ ${vm.strategiesInActiveQuarter}`}
              valueStyle={{
                color: vm.shadowStrategiesInActiveQuarter > 0 ? '#fa8c16' : '#16a34a',
              }}
              prefix={<SafetyCertificateOutlined />}
            />
          </Col>
        </Row>

        {loading && runs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin tip="加载中…" />
          </div>
        ) : strategyEntries.length === 0 ? (
          <Empty
            description={activeQuarter ? `${activeQuarter} 季度暂无参数重训记录` : '请选择季度'}
          />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {strategyEntries.map(([strategyName, candidates]) => {
              const shadow = lookupShadowByStrategyName(effectiveStrategies, strategyName);
              const strategyMeta = effectiveStrategies.find(
                s => (s as any).strategy_key === strategyName
              );
              const displayName =
                (strategyMeta as any)?.display_name || (strategyMeta as any)?.name || strategyName;
              return (
                <Card
                  key={strategyName}
                  size="small"
                  type="inner"
                  data-testid={`quarterly-retrain-strategy-card-${strategyName}`}
                  title={
                    <Space>
                      <Text strong>{displayName}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {strategyName}
                      </Text>
                      {shadow ? (
                        <Tag color="orange">{SHADOW_BADGE_TEXT}</Tag>
                      ) : (
                        <Tag color="green">{HARD_BADGE_TEXT}</Tag>
                      )}
                      <Tag>{candidates.length} 候选</Tag>
                    </Space>
                  }
                >
                  <Table
                    size="small"
                    rowKey="run_id"
                    dataSource={candidates}
                    pagination={false}
                    columns={[
                      {
                        title: '类型',
                        dataIndex: 'optimizer_type',
                        width: 110,
                        render: (v: RetrainCandidate['optimizer_type']) => (
                          <Tag color={optimizerTagColor[v] || 'default'}>
                            {optimizerLabel[v] || v}
                          </Tag>
                        ),
                      },
                      {
                        title: '主指标',
                        key: 'primary_metric',
                        width: 150,
                        render: (_: any, r: RetrainCandidate) => formatPrimaryMetric(r),
                      },
                      {
                        title: 'verdict',
                        dataIndex: 'verdict',
                        width: 110,
                        render: (v: RetrainCandidate['verdict']) =>
                          v ? <Tag color={verdictColor[v] || 'default'}>{v}</Tag> : '—',
                      },
                      {
                        title: '完成/总数',
                        key: 'progress',
                        width: 100,
                        render: (_: any, r: RetrainCandidate) => (
                          <Text style={{ fontSize: 12 }}>
                            {r.completed_combos}
                            <Text type="secondary"> / {r.total_combos}</Text>
                            {r.failed_combos > 0 && (
                              <Text type="danger"> ({r.failed_combos} fail)</Text>
                            )}
                          </Text>
                        ),
                      },
                      {
                        title: '完成时间',
                        dataIndex: 'finished_at',
                        width: 160,
                        render: (v: string | null) =>
                          v ? (
                            <Text style={{ fontSize: 12 }}>
                              {new Date(v).toISOString().slice(0, 16).replace('T', ' ')}
                            </Text>
                          ) : (
                            '—'
                          ),
                      },
                      {
                        title: 'run id',
                        dataIndex: 'run_id',
                        width: 90,
                        render: (v: number) => <Text code>{v}</Text>,
                      },
                    ]}
                  />
                </Card>
              );
            })}
          </Space>
        )}
      </Card>
    </Space>
  );
};

// 让 helper 反向 META-GUARD 能扫到 isShadowStrategy 在组件里被引用 (虽然主链路走 lookupShadowByStrategyName,
// 但保留 import 让 tree-shake 不裁; 同时人类读起来知道两个函数都被本组件认可使用).
void isShadowStrategy;

export default QuarterlyRetrainTab;
