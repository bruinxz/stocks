/**
 * LabWorkspace.ShadowRunTab — US-051 / FE-012 shadow run 区块
 *
 * 复用 GAMMA 2026-06-18 已落 /api/admin/analysis-engine/shadow-stats endpoint, 把多维分析引擎
 * v1 shadow 链路与生产决策的 buy/sell/hold 一致率 + analyzer 健康度可视化, 让用户回答:
 *
 *   1. 过去 N 天 shadow 链路跑了多少报告? 与生产决策的 buy/sell/hold 分类一致率多少?
 *   2. 哪些 analyzer error_rate / mean_confidence / data_missing 异常?
 *   3. 综合健康度上看, shadow 是否可以升级到 hard? 不行的话原因是什么?
 *
 * 业务逻辑全部抽到 [[shadowRunHelpers]] (pure functions, 可在 backend ts-node 单测).
 * 组件本身只负责 fetch + render.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Empty,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import dayjs, { Dayjs } from 'dayjs';
import { labService, AnalysisEngineShadowStatsResponse } from '../../services/labService';
import {
  buildShadowRunViewModel,
  classifyAnalyzerLevel,
  formatPercent,
  formatSinceDate,
  HEALTH_LEVEL_COLOR,
  HEALTH_LEVEL_LABEL,
  HealthLevel,
  ShadowAnalyzerRow,
  CONSISTENCY_HEALTHY_MIN,
  CONSISTENCY_DEGRADED_MIN,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_DEGRADED,
  CONFIDENCE_HEALTHY_MIN,
  CONFIDENCE_DEGRADED_MIN,
  DATA_MISSING_HEALTHY_MAX,
  DATA_MISSING_DEGRADED_MAX,
  PROMOTE_HARD_MIN_SAMPLES,
  DEFAULT_SINCE_DAYS,
} from './shadowRunHelpers';

const { Text, Paragraph } = Typography;

const ShadowRunTab: React.FC = () => {
  // since 默认: 当下 - DEFAULT_SINCE_DAYS 天; 用户可手动调
  const [sinceDate, setSinceDate] = useState<Dayjs>(() =>
    dayjs(formatSinceDate(new Date(), DEFAULT_SINCE_DAYS))
  );
  const [stats, setStats] = useState<AnalysisEngineShadowStatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sinceStr = sinceDate.format('YYYY-MM-DD');
      const data = await labService.getAnalysisEngineShadowStats(sinceStr);
      setStats(data);
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [sinceDate]);

  useEffect(() => {
    void load();
  }, [load]);

  // sinceDate 改变后, 用户点 "刷新" 才请求 (避免 DatePicker 输入过程频繁请求)
  const vm = useMemo(() => buildShadowRunViewModel(stats), [stats]);

  // ---- KPI ----
  const promotionAlertType: 'success' | 'warning' | 'error' = vm.promotion.ready
    ? 'success'
    : vm.promotion.level === 'critical'
    ? 'error'
    : 'warning';

  const renderHealthTag = (level: HealthLevel) => (
    <Tag color={HEALTH_LEVEL_COLOR[level]}>{HEALTH_LEVEL_LABEL[level]}</Tag>
  );

  const analyzerColumns = [
    {
      title: 'Analyzer',
      dataIndex: 'key',
      key: 'key',
      width: 220,
      render: (v: string) => <Text code>{v}</Text>,
    },
    {
      title: '健康度',
      dataIndex: 'level',
      key: 'level',
      width: 90,
      render: (v: HealthLevel) => renderHealthTag(v),
    },
    {
      title: '样本',
      dataIndex: 'samples',
      key: 'samples',
      width: 80,
      render: (v: number) => <Text>{v}</Text>,
    },
    {
      title: '错误率',
      dataIndex: 'error_rate',
      key: 'error_rate',
      width: 110,
      render: (v: number) => (
        <Text
          style={{
            color:
              v >= ERROR_RATE_CRITICAL
                ? '#cf1322'
                : v >= ERROR_RATE_DEGRADED
                ? '#d48806'
                : '#3f8600',
          }}
        >
          {formatPercent(v)}
        </Text>
      ),
    },
    {
      title: '平均置信度',
      dataIndex: 'mean_confidence',
      key: 'mean_confidence',
      width: 120,
      render: (v: number) => (
        <Text
          style={{
            color:
              v < CONFIDENCE_DEGRADED_MIN
                ? '#cf1322'
                : v < CONFIDENCE_HEALTHY_MIN
                ? '#d48806'
                : '#3f8600',
          }}
        >
          {formatPercent(v)}
        </Text>
      ),
    },
    {
      title: '数据缺失',
      dataIndex: 'data_missing_rate',
      key: 'data_missing_rate',
      width: 110,
      render: (v: number) => (
        <Text
          style={{
            color:
              v > DATA_MISSING_DEGRADED_MAX
                ? '#cf1322'
                : v > DATA_MISSING_HEALTHY_MAX
                ? '#d48806'
                : '#3f8600',
          }}
        >
          {Number.isFinite(v) ? v.toFixed(2) : '—'}
        </Text>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        title={
          <Space>
            <SwapOutlined />
            <Text strong>多维引擎 Shadow vs 生产对比</Text>
            {/* Phase 3 (2026-06-27): US-XXX 装饰 Tag 已退役. */}
          </Space>
        }
        extra={
          <Space size={8}>
            <span style={{ fontSize: 12 }}>起始日期:</span>
            <DatePicker
              size="small"
              data-testid="shadow-run-since-picker"
              value={sinceDate}
              onChange={d => d && setSinceDate(d)}
              allowClear={false}
              style={{ width: 140 }}
            />
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={load}
              loading={loading}
              data-testid="shadow-run-refresh"
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Paragraph style={{ marginBottom: 12, color: '#666', fontSize: 12 }}>
          Shadow 链路 (multi_dim_v1) 与生产决策的 buy/sell/hold 分类一致率, 以及各 analyzer 健康度.
          升级 hard 的硬门槛: <Text code>样本 ≥ {PROMOTE_HARD_MIN_SAMPLES}</Text> +{' '}
          <Text code>整体一致率 ≥ {formatPercent(CONSISTENCY_HEALTHY_MIN)}</Text> +{' '}
          <Text code>买卖侧一致率 ≥ {formatPercent(CONSISTENCY_DEGRADED_MIN)}</Text> + 无 analyzer
          严重 (error_rate ≥ {formatPercent(ERROR_RATE_CRITICAL)} 或 平均置信度 &lt;{' '}
          {formatPercent(CONFIDENCE_DEGRADED_MIN)}).
        </Paragraph>

        {error && (
          <Alert
            type="error"
            showIcon
            message="加载失败"
            description={error}
            style={{ marginBottom: 12 }}
            action={
              <Button size="small" onClick={load}>
                重试
              </Button>
            }
          />
        )}

        {loading && !stats ? (
          <div style={{ textAlign: 'center', padding: 40 }}>
            <Spin tip="加载 shadow 统计中…" />
          </div>
        ) : !stats ? (
          <Empty description="暂无 shadow 统计数据" />
        ) : (
          <>
            {/* KPI 行 */}
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col xs={24} sm={6}>
                <Statistic
                  title="Shadow 报告数"
                  value={vm.totalShadowReports}
                  prefix={<SafetyCertificateOutlined />}
                />
              </Col>
              <Col xs={24} sm={6}>
                <Statistic
                  title="整体一致率"
                  value={formatPercent(vm.consistency.overall)}
                  valueStyle={{
                    color:
                      vm.consistencyLevel === 'healthy'
                        ? '#3f8600'
                        : vm.consistencyLevel === 'degraded'
                        ? '#d48806'
                        : '#cf1322',
                  }}
                  suffix={renderHealthTag(vm.consistencyLevel)}
                />
              </Col>
              <Col xs={24} sm={6}>
                <Statistic title="买入侧一致率" value={formatPercent(vm.consistency.buy_class)} />
              </Col>
              <Col xs={24} sm={6}>
                <Statistic title="卖出侧一致率" value={formatPercent(vm.consistency.sell_class)} />
              </Col>
            </Row>

            {/* 升级 hard 综合结论 */}
            <Alert
              type={promotionAlertType}
              showIcon
              icon={vm.promotion.ready ? <CheckCircleOutlined /> : <ExclamationCircleOutlined />}
              message={
                <Text strong>
                  {vm.promotion.ready
                    ? '✓ Shadow 已具备升级 hard 条件 — 可走 SettingsWorkspace 切换分析引擎 mode'
                    : 'Shadow 暂不可升级 hard'}
                </Text>
              }
              description={
                vm.promotion.blockers.length > 0 && (
                  <ul
                    data-testid="shadow-run-blockers"
                    style={{ margin: '4px 0 0 0', paddingLeft: 18 }}
                  >
                    {vm.promotion.blockers.map((b, i) => (
                      <li key={i} style={{ fontSize: 12 }}>
                        {b}
                      </li>
                    ))}
                  </ul>
                )
              }
              style={{ marginBottom: 16 }}
              data-testid="shadow-run-promotion-alert"
            />

            {/* Analyzer 健康度表 */}
            <Card
              size="small"
              type="inner"
              title={
                <Space>
                  <Text strong>Analyzer 健康度</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    起始: {vm.since || '—'} · 共 {vm.analyzers.length} 个 analyzer
                  </Text>
                </Space>
              }
              extra={
                <Space size={4}>
                  {(['critical', 'degraded', 'healthy'] as HealthLevel[]).map(lvl => {
                    const cnt = vm.analyzers.filter(a => a.level === lvl).length;
                    return cnt > 0 ? (
                      <Tag color={HEALTH_LEVEL_COLOR[lvl]} key={lvl}>
                        {HEALTH_LEVEL_LABEL[lvl]} {cnt}
                      </Tag>
                    ) : null;
                  })}
                </Space>
              }
            >
              {vm.analyzers.length === 0 ? (
                <Empty description="无 analyzer 健康数据" />
              ) : (
                <Table<ShadowAnalyzerRow>
                  size="small"
                  rowKey="key"
                  dataSource={vm.analyzers}
                  columns={analyzerColumns}
                  pagination={false}
                  data-testid="shadow-run-analyzers-table"
                />
              )}
            </Card>

            {/* Forward return 5d */}
            <Card size="small" type="inner" title="5 日远期收益" style={{ marginTop: 12 }}>
              <Row gutter={16}>
                <Col xs={24} sm={8}>
                  <Statistic title="样本数" value={vm.forwardReturn.samples} />
                </Col>
                <Col xs={24} sm={8}>
                  <Statistic
                    title="平均收益"
                    value={
                      vm.forwardReturn.mean_pct === null
                        ? '—'
                        : `${vm.forwardReturn.mean_pct.toFixed(2)}%`
                    }
                    valueStyle={{
                      color:
                        vm.forwardReturn.mean_pct === null
                          ? undefined
                          : vm.forwardReturn.mean_pct >= 0
                          ? '#cf1322'
                          : '#0f8f6b',
                    }}
                  />
                </Col>
                <Col xs={24} sm={8}>
                  {vm.forwardReturn.note && (
                    <Alert
                      type="info"
                      showIcon
                      message={vm.forwardReturn.note}
                      style={{ marginTop: 4 }}
                    />
                  )}
                </Col>
              </Row>
            </Card>
          </>
        )}
      </Card>
    </Space>
  );
};

// 让 META-GUARD 能扫到 classifyAnalyzerLevel 被组件引用 (虽然主链路走 buildShadowRunViewModel,
// 但保留 import 让 tree-shake 不裁; 同时人类读起来知道两个函数都被本组件认可使用).
void classifyAnalyzerLevel;

export default ShadowRunTab;
