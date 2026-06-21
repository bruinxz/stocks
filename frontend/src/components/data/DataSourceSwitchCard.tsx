/**
 * US-064 [FE-025] DataWorkspace 数据源切换卡 — 主备源状态可视化.
 *
 * 与 [[SlaDashboardCard]] (US-061) / [[DataMissingAlertsCard]] (US-062) /
 * [[BulkBackfillButton]] (US-063) / DataHealthDashboard 并列嵌在
 * DataWorkspace "数据健康" tab. 五张卡职责互不重叠:
 *   - SLA 看板: 按 category 看 SLA 达成率 (晚了几天)
 *   - 数据缺失告警: 列出 "压根没数据 / 链路挂" 的具体源
 *   - 一键补抓: ops 主动触发同步
 *   - 本卡 (数据源切换): 每个能力的主备路由 + 状态 — 当 ops 想知道
 *     "哪个 provider 在主用 / 备用 / 异常 fallback" 时的唯一入口
 *   - DataHealthDashboard: 全量源卡片 (业务源维度)
 *
 * 数据源 /api/market/data-sources/health — 与 DataUpdateStatus.tsx 共用,
 * 后端 backend/src/data/services/DataSourceHealthService.ts 一次性返回
 * providers + routing_plans + quant_readiness, 本卡片只消费前两者.
 *
 * Pure helper [[buildDataSourceSwitchViewModel]] 落在 dataWorkspaceTabHelpers.ts,
 * 单测在 backend/tests/services/data-workspace-tab-helpers.test.ts.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ReloadOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  DataSourceHealthBundle,
  getDataSourceProvidersStatus,
} from '../../services/dataHealthService';
import {
  DATA_SOURCE_STATUS_COLOR,
  DATA_SOURCE_STATUS_LABEL,
  DATA_SOURCE_STATUS_TAG_COLOR,
  PRIMARY_COVERAGE_DEGRADED_MIN,
  PRIMARY_COVERAGE_HEALTHY_MIN,
  buildDataSourceSwitchViewModel,
} from '../../pages/workspace/dataWorkspaceTabHelpers';

const { Text, Paragraph } = Typography;

interface DataSourceSwitchCardProps {
  /** 上层若已拉过 healthBundle, 直接传入避免重复请求 (DataWorkspace 共享 state). */
  healthBundle?: DataSourceHealthBundle | null;
}

const LEVEL_TAG_COLOR: Record<'healthy' | 'degraded' | 'critical' | 'unknown', string> = {
  healthy: 'green',
  degraded: 'orange',
  critical: 'red',
  unknown: 'default',
};

const LEVEL_LABEL: Record<'healthy' | 'degraded' | 'critical' | 'unknown', string> = {
  healthy: '主链路覆盖完好',
  degraded: '主链路覆盖不足',
  critical: '主链路严重缺失',
  unknown: '数据不足',
};

/** 数据源切换卡 — 嵌在 DataWorkspace "数据健康" tab. */
const DataSourceSwitchCard: React.FC<DataSourceSwitchCardProps> = ({ healthBundle }) => {
  // 若 caller 没传, 自己拉一次 (与 SlaDashboardCard / DataMissingAlertsCard 同模式)
  const [selfFetched, setSelfFetched] = useState<DataSourceHealthBundle | null>(null);
  const [selfLoading, setSelfLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (healthBundle) return;
    setSelfLoading(true);
    setFetchError(null);
    getDataSourceProvidersStatus(false)
      .then(d => setSelfFetched(d))
      .catch(err => {
        setSelfFetched(null);
        setFetchError(err?.message || '获取数据源健康状态失败');
      })
      .finally(() => setSelfLoading(false));
  }, [healthBundle]);

  const effectiveData = healthBundle ?? selfFetched;
  const vm = useMemo(() => buildDataSourceSwitchViewModel(effectiveData), [effectiveData]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setFetchError(null);
    try {
      const next = await getDataSourceProvidersStatus(true);
      setSelfFetched(next);
    } catch (err: any) {
      setFetchError(err?.message || '主动探测失败');
    } finally {
      setRefreshing(false);
    }
  };

  if (selfLoading && !effectiveData) {
    return (
      <Card style={{ marginBottom: 16 }} data-testid="data-source-switch-card">
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin tip="数据源主备状态加载中..." />
        </div>
      </Card>
    );
  }

  const levelColor = DATA_SOURCE_STATUS_COLOR[vm.primary_coverage_level] || '#bfbfbf';

  return (
    <Card
      title={
        <Space>
          <SwapOutlined style={{ color: levelColor }} />
          <Text strong>数据源主备切换</Text>
          <Tag color={LEVEL_TAG_COLOR[vm.primary_coverage_level]}>
            {LEVEL_LABEL[vm.primary_coverage_level]}
          </Tag>
        </Space>
      }
      extra={
        <Space>
          <Tooltip
            title={`重新探测会真正访问每个 provider 的 health endpoint, 耗时 5-15s; 默认仅读 DB 缓存`}
          >
            <Button
              icon={<ReloadOutlined spin={refreshing} />}
              size="small"
              loading={refreshing}
              disabled={Boolean(healthBundle)}
              onClick={handleRefresh}
              data-testid="data-source-switch-refresh-btn"
            >
              重新探测
            </Button>
          </Tooltip>
        </Space>
      }
      style={{ marginBottom: 16 }}
      data-testid="data-source-switch-card"
    >
      {fetchError ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="读取数据源健康状态失败"
          description={fetchError}
        />
      ) : null}

      {/* ---- 顶部整体 KPI ---- */}
      <Row gutter={[16, 16]} align="middle" style={{ marginBottom: 12 }}>
        <Col xs={12} sm={6}>
          <Statistic
            title="已注册"
            value={vm.total_providers}
            suffix="个"
            valueStyle={{ fontSize: 22 }}
          />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic
            title="健康"
            value={vm.healthy_providers}
            suffix="个"
            valueStyle={{ color: DATA_SOURCE_STATUS_COLOR.healthy, fontSize: 22 }}
          />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic
            title="异常"
            value={vm.unhealthy_providers}
            suffix="个"
            valueStyle={{
              color:
                vm.unhealthy_providers > 0
                  ? DATA_SOURCE_STATUS_COLOR.unhealthy
                  : DATA_SOURCE_STATUS_COLOR.healthy,
              fontSize: 22,
            }}
          />
        </Col>
        <Col xs={12} sm={6}>
          <Tooltip
            title={`主链路覆盖率 = 主用源 healthy 的 feature 数 / 总 ${vm.features.length} feature; 健康线 ${PRIMARY_COVERAGE_HEALTHY_MIN}% / 告警线 ${PRIMARY_COVERAGE_DEGRADED_MIN}%`}
          >
            <Statistic
              title="主链路覆盖"
              value={vm.primary_coverage_pct ?? '—'}
              suffix={vm.primary_coverage_pct === null ? undefined : '%'}
              valueStyle={{ color: levelColor, fontSize: 22 }}
            />
          </Tooltip>
        </Col>
      </Row>

      {/* ---- 中间: features 路由矩阵 ---- */}
      <Card
        type="inner"
        size="small"
        title="核心能力主备路由"
        style={{ marginBottom: 12 }}
        data-testid="data-source-switch-features"
        bodyStyle={{ padding: '8px 12px' }}
      >
        {vm.features.length === 0 ? (
          <Empty description="暂无路由计划" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="feature"
            dataSource={vm.features}
            data-testid="data-source-switch-features-table"
            columns={[
              {
                title: '能力',
                dataIndex: 'feature_label',
                key: 'feature_label',
                width: 130,
                render: (label: string, row: any) => (
                  <Space direction="vertical" size={0}>
                    <Text strong>{label}</Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {row.feature}
                    </Text>
                  </Space>
                ),
              },
              {
                title: '主用源',
                dataIndex: 'primary',
                key: 'primary',
                render: (primary: any) => {
                  if (!primary) {
                    return (
                      <Tag color="red" data-testid="primary-missing">
                        无主链路
                      </Tag>
                    );
                  }
                  const color =
                    DATA_SOURCE_STATUS_TAG_COLOR[primary.status] || ('default' as const);
                  const lab = DATA_SOURCE_STATUS_LABEL[primary.status] || primary.status;
                  return (
                    <Space size={6}>
                      <Text strong>{primary.provider_label}</Text>
                      <Tag color={color}>{lab}</Tag>
                      {primary.is_preferred ? <Tag color="blue">已指定</Tag> : null}
                    </Space>
                  );
                },
              },
              {
                title: '备用源',
                dataIndex: 'backups',
                key: 'backups',
                render: (backups: any[]) => {
                  if (!backups || backups.length === 0) {
                    return (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        无可用备用
                      </Text>
                    );
                  }
                  return (
                    <Space wrap size={4}>
                      {backups.map((b, idx) => {
                        const color =
                          DATA_SOURCE_STATUS_TAG_COLOR[b.status] || ('default' as const);
                        return (
                          <React.Fragment key={b.provider_name}>
                            {idx > 0 ? (
                              <ArrowRightOutlined style={{ color: '#bfbfbf', fontSize: 10 }} />
                            ) : null}
                            <Tooltip
                              title={
                                b.route_reason ||
                                `健康分 ${b.health_score} · ${
                                  DATA_SOURCE_STATUS_LABEL[b.status] || b.status
                                }`
                              }
                            >
                              <Tag color={color} style={{ marginInlineEnd: 0 }}>
                                {b.provider_label}
                              </Tag>
                            </Tooltip>
                          </React.Fragment>
                        );
                      })}
                    </Space>
                  );
                },
              },
            ]}
          />
        )}
      </Card>

      {/* ---- 底部 providers 详表 ---- */}
      <Card
        type="inner"
        size="small"
        title={
          <Space>
            <ApiOutlined />
            <span>Provider 健康清单</span>
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({vm.enabled_providers}/{vm.total_providers} 启用 · 平均分 {vm.avg_health_score})
            </Text>
          </Space>
        }
        style={{ marginBottom: 12 }}
        data-testid="data-source-switch-providers"
        bodyStyle={{ padding: '8px 12px' }}
      >
        {vm.providers.length === 0 ? (
          <Empty description="暂无 provider" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table
            size="small"
            pagination={false}
            rowKey="provider_name"
            dataSource={vm.providers}
            data-testid="data-source-switch-providers-table"
            columns={[
              {
                title: 'Provider',
                dataIndex: 'provider_label',
                key: 'provider_label',
                render: (label: string, row: any) => (
                  <Space direction="vertical" size={0}>
                    <Text strong>{label}</Text>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {row.provider_name} · 优先级 {row.priority}
                    </Text>
                  </Space>
                ),
              },
              {
                title: '状态',
                dataIndex: 'status',
                key: 'status',
                width: 90,
                render: (status: string, row: any) => {
                  const color = DATA_SOURCE_STATUS_TAG_COLOR[status] || ('default' as const);
                  const lab = DATA_SOURCE_STATUS_LABEL[status] || status;
                  return (
                    <Space direction="vertical" size={0}>
                      <Tag color={color} data-testid={`provider-status-${row.provider_name}`}>
                        {lab}
                      </Tag>
                      {row.is_enabled ? null : (
                        <Text type="secondary" style={{ fontSize: 10 }}>
                          未启用
                        </Text>
                      )}
                    </Space>
                  );
                },
              },
              {
                title: '健康分',
                dataIndex: 'health_score',
                key: 'health_score',
                width: 80,
                render: (score: number, row: any) => (
                  <Text
                    style={{
                      color:
                        DATA_SOURCE_STATUS_COLOR[row.status] || DATA_SOURCE_STATUS_COLOR.unknown,
                    }}
                  >
                    {score}
                  </Text>
                ),
              },
              {
                title: '延迟',
                dataIndex: 'last_latency_ms',
                key: 'last_latency_ms',
                width: 80,
                render: (lat: number | null) =>
                  lat === null ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      —
                    </Text>
                  ) : (
                    <Text style={{ fontSize: 12 }}>{lat}ms</Text>
                  ),
              },
              {
                title: '最近异常',
                dataIndex: 'last_error',
                key: 'last_error',
                render: (err: string | null, row: any) => {
                  if (!err) {
                    return (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        无
                      </Text>
                    );
                  }
                  return (
                    <Tooltip
                      title={`${
                        row.consecutive_failures > 0
                          ? `连续失败 ${row.consecutive_failures} 次 · `
                          : ''
                      }${err}`}
                    >
                      <Text
                        type="danger"
                        style={{ fontSize: 12, maxWidth: 240, display: 'inline-block' }}
                        ellipsis
                      >
                        {err}
                      </Text>
                    </Tooltip>
                  );
                },
              },
            ]}
          />
        )}
      </Card>

      {/* ---- 底部 ready / blockers ---- */}
      {vm.ready && vm.total_providers > 0 ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="所有核心能力均有健康主链路, 备用源就绪"
          description={`${vm.healthy_providers}/${vm.enabled_providers} provider 健康; 主链路覆盖 ${vm.primary_coverage_pct}% (>= ${PRIMARY_COVERAGE_HEALTHY_MIN}%)`}
        />
      ) : vm.blockers.length > 0 ? (
        <Alert
          type={vm.primary_coverage_level === 'critical' ? 'error' : 'warning'}
          showIcon
          icon={
            vm.primary_coverage_level === 'critical' ? (
              <ExclamationCircleOutlined />
            ) : (
              <WarningOutlined />
            )
          }
          message={`数据源未就绪 (${vm.blockers.length} 项待处理)`}
          description={
            <ul
              style={{ marginBottom: 0, paddingLeft: 18 }}
              data-testid="data-source-switch-blockers"
            >
              {vm.blockers.map((b, i) => (
                <li key={i}>
                  <Paragraph style={{ marginBottom: 4 }}>{b}</Paragraph>
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
    </Card>
  );
};

export default DataSourceSwitchCard;
