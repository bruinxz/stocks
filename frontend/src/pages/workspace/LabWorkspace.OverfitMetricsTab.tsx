/**
 * LabWorkspace.OverfitMetricsTab — US-052 / FE-013 OverfitMetrics 显示
 *
 * 复用既有 GET /api/quant/optimization-runs endpoint, 把 GridSearch / Bayesian /
 * Walk-Forward 三类 optimizer 的 DSR (Deflated Sharpe Ratio) + PBO (Probability
 * of Backtest Overfitting) 跨 run 可视化, 让操盘手一眼回答:
 *
 *   1. 最近 N 个 optimization run 里, verdict=PASS / FAIL / INSUFFICIENT 分布?
 *   2. 平均 DSR / PBO 多少? 触发 critical 的具体哪些 run?
 *   3. 整批 run 综合是否可以批量 promote 参数版本? 不行的话哪条原因 block 了?
 *
 * 业务逻辑全部抽到 [[overfitMetricsHelpers]] (pure functions, backend ts-node 单测).
 * 组件本身只负责 fetch + render, 与 [[ShadowRunTab]] / [[QuarterlyRetrainTab]]
 * 一脉相承的范式.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { labService, OptimizationRunSummary } from '../../services/labService';
import {
  buildOverfitMetricsViewModel,
  formatPercent,
  formatRatio,
  HEALTH_LEVEL_COLOR,
  HEALTH_LEVEL_LABEL,
  HealthLevel,
  OverfitMetricRow,
  VERDICT_COLOR,
  VERDICT_LABEL,
  DSR_PASS_THRESHOLD,
  DSR_DEGRADED_MIN,
  PBO_FAIL_THRESHOLD,
  PBO_DEGRADED_MIN,
  DEFAULT_RUNS_LIMIT,
} from './overfitMetricsHelpers';

const { Text } = Typography;

const OPTIMIZER_TYPE_LABEL: Record<string, string> = {
  all: '全部',
  grid_search: 'Grid Search',
  bayesian: 'Bayesian',
  walk_forward: 'Walk-Forward',
};

const OPTIMIZER_TYPE_COLOR: Record<string, string> = {
  grid_search: 'blue',
  bayesian: 'purple',
  walk_forward: 'volcano',
  unknown: 'default',
};

const OverfitMetricsTab: React.FC = () => {
  const [optimizerType, setOptimizerType] = useState<
    'all' | 'grid_search' | 'bayesian' | 'walk_forward'
  >('all');
  const [limit, setLimit] = useState<number>(DEFAULT_RUNS_LIMIT);
  const [runs, setRuns] = useState<OptimizationRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await labService.listOptimizationRuns({
        optimizer_type: optimizerType,
        limit,
      });
      setRuns(data);
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [optimizerType, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  const vm = useMemo(() => buildOverfitMetricsViewModel(runs), [runs]);

  const renderHealthTag = (level: HealthLevel) => (
    <Tag color={HEALTH_LEVEL_COLOR[level]}>{HEALTH_LEVEL_LABEL[level]}</Tag>
  );

  const promotionAlertType: 'success' | 'warning' | 'error' = vm.promotion.ready
    ? 'success'
    : vm.promotion.level === 'critical'
      ? 'error'
      : 'warning';

  // ---- Table columns ----
  const columns = useMemo(
    () => [
      {
        title: 'verdict',
        key: 'verdict',
        width: 110,
        render: (_: any, row: OverfitMetricRow) => (
          <Tag color={VERDICT_COLOR[row.metric.verdict]}>{VERDICT_LABEL[row.metric.verdict]}</Tag>
        ),
      },
      {
        title: '类型',
        dataIndex: 'optimizer_type',
        key: 'optimizer_type',
        width: 120,
        render: (v: string) => (
          <Tag color={OPTIMIZER_TYPE_COLOR[v] || 'default'}>{OPTIMIZER_TYPE_LABEL[v] || v}</Tag>
        ),
      },
      {
        title: '策略',
        dataIndex: 'strategy_name',
        key: 'strategy_name',
        ellipsis: true,
      },
      {
        title: (
          <Space size={4}>
            <span>DSR</span>
            <Tooltip
              title={`Deflated Sharpe Ratio — DSR ≥ ${DSR_PASS_THRESHOLD} = 大概率非过拟合; ≥ ${DSR_DEGRADED_MIN} = 警惕; < ${DSR_DEGRADED_MIN} = 高风险`}
            >
              <QuestionCircleOutlined style={{ fontSize: 12, color: '#999' }} />
            </Tooltip>
          </Space>
        ),
        key: 'dsr',
        width: 130,
        render: (_: any, row: OverfitMetricRow) => (
          <Space size={4}>
            <Text>{formatRatio(row.metric.dsr)}</Text>
            {renderHealthTag(row.metric.dsrLevel)}
          </Space>
        ),
      },
      {
        title: (
          <Space size={4}>
            <span>PBO</span>
            <Tooltip
              title={`Probability of Backtest Overfitting — PBO < ${PBO_DEGRADED_MIN} = 健康; < ${PBO_FAIL_THRESHOLD} = 警惕; ≥ ${PBO_FAIL_THRESHOLD} = 严重过拟合; 仅 CPCV walk-forward 才有`}
            >
              <QuestionCircleOutlined style={{ fontSize: 12, color: '#999' }} />
            </Tooltip>
          </Space>
        ),
        key: 'pbo',
        width: 130,
        render: (_: any, row: OverfitMetricRow) => (
          <Space size={4}>
            <Text>{formatRatio(row.metric.pbo)}</Text>
            {row.metric.pbo !== null && renderHealthTag(row.metric.pboLevel)}
          </Space>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 90,
      },
      {
        title: '创建时间',
        dataIndex: 'created_at',
        key: 'created_at',
        width: 140,
        render: (v: string) => (v ? dayjs(v).format('MM-DD HH:mm') : '—'),
      },
    ],
    []
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {/* Header bar */}
      <Card size="small" className="modern-card">
        <Row align="middle" gutter={16}>
          <Col flex="auto">
            <Space>
              <SafetyCertificateOutlined style={{ color: 'var(--primary)' }} />
              <Text strong>OverfitMetrics 显示</Text>
              <Text type="secondary">
                跨 optimizer (GridSearch / Bayesian / Walk-Forward) 的 DSR (Deflated Sharpe) + PBO
                看板, 帮助过拟合检测后再 promote 参数 — Phase 1 学术严谨性升级
              </Text>
            </Space>
          </Col>
          <Col>
            <Space>
              <span style={{ fontSize: 12 }}>类型:</span>
              <Select
                size="small"
                value={optimizerType}
                onChange={v => setOptimizerType(v)}
                style={{ width: 140 }}
                options={[
                  { value: 'all', label: '全部' },
                  { value: 'grid_search', label: 'Grid Search' },
                  { value: 'bayesian', label: 'Bayesian' },
                  { value: 'walk_forward', label: 'Walk-Forward' },
                ]}
              />
              <span style={{ fontSize: 12 }}>最近:</span>
              <InputNumber
                size="small"
                min={5}
                max={200}
                step={10}
                value={limit}
                onChange={v => setLimit(Number(v) || DEFAULT_RUNS_LIMIT)}
                style={{ width: 80 }}
              />
              <Button
                icon={<ReloadOutlined />}
                size="small"
                onClick={load}
                loading={loading}
                data-testid="overfit-metrics-refresh"
              >
                刷新
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {error && <Alert type="error" message={error} showIcon />}

      {/* KPI strip */}
      <Card size="small" className="modern-card" title="批量过拟合健康度">
        <Row gutter={16}>
          <Col span={4}>
            <Statistic title="run 总数" value={vm.total} suffix="个" />
          </Col>
          <Col span={4}>
            <Statistic
              title="PASS"
              value={vm.distribution.pass}
              valueStyle={{ color: '#16a34a' }}
              prefix={<CheckCircleOutlined />}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="FAIL"
              value={vm.distribution.fail}
              valueStyle={{ color: '#dc2626' }}
              prefix={<ExclamationCircleOutlined />}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="INSUFFICIENT"
              value={vm.distribution.insufficient}
              valueStyle={{ color: '#888' }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="通过率"
              value={
                vm.distribution.passRate != null
                  ? (vm.distribution.passRate * 100).toFixed(1) + '%'
                  : '—'
              }
              valueStyle={{
                color:
                  vm.distribution.passRate == null
                    ? '#888'
                    : vm.distribution.passRate >= 0.7
                      ? '#16a34a'
                      : vm.distribution.passRate >= 0.5
                        ? '#fa8c16'
                        : '#dc2626',
              }}
            />
          </Col>
          <Col span={4}>
            <Statistic
              title="平均 DSR / PBO"
              valueRender={() => (
                <Space size={6}>
                  <Text strong style={{ fontSize: 18 }}>
                    {formatRatio(vm.meanDsr)}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    /
                  </Text>
                  <Text strong style={{ fontSize: 18 }}>
                    {formatRatio(vm.meanPbo)}
                  </Text>
                </Space>
              )}
            />
          </Col>
        </Row>
      </Card>

      {/* Promotion readiness */}
      <Alert
        data-testid="overfit-metrics-promotion-alert"
        type={promotionAlertType}
        showIcon
        message={
          <Space>
            <Text strong>批量 promote 就绪结论:</Text>
            <Tag color={HEALTH_LEVEL_COLOR[vm.promotion.level]}>
              {vm.promotion.ready ? '可批量 promote' : HEALTH_LEVEL_LABEL[vm.promotion.level]}
            </Tag>
          </Space>
        }
        description={
          vm.promotion.ready ? (
            <Text type="secondary">
              全部门槛满足: 样本量足够, 通过率 ≥ 50%, 无单 run 触发 PBO 严重过拟合.
            </Text>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {vm.promotion.blockers.map((blocker, i) => (
                <li key={i}>
                  <Text type="secondary">{blocker}</Text>
                </li>
              ))}
            </ul>
          )
        }
      />

      {/* Runs table */}
      <Card size="small" className="modern-card" title="最近 optimization run (按 verdict 优先)">
        {vm.rows.length === 0 && !loading ? (
          <Empty
            description="尚未拉取到 optimization run — 在 Walk-Forward / Grid / Bayesian 触发后会出现"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          <Table<OverfitMetricRow>
            rowKey="id"
            dataSource={vm.rows}
            columns={columns as any}
            loading={loading}
            pagination={{ pageSize: 20 }}
            size="small"
            scroll={{ x: 'max-content' }}
          />
        )}
        <div style={{ marginTop: 12, fontSize: 12, color: '#999' }}>
          <Text type="secondary">
            * PASS = DSR ≥ {DSR_PASS_THRESHOLD} 且 (PBO 缺失 或 {'<'} {PBO_FAIL_THRESHOLD}); FAIL =
            DSR {'<'} {DSR_PASS_THRESHOLD} 或 PBO ≥ {PBO_FAIL_THRESHOLD}; INSUFFICIENT = DSR/PBO
            字段缺失. 排序: FAIL 最前, 让最需关注的 run 一眼可见.
            {formatPercent(vm.distribution.passRate)} 是当前已下定论 (PASS+FAIL) 的通过率.
          </Text>
        </div>
      </Card>
    </Space>
  );
};

export default OverfitMetricsTab;
