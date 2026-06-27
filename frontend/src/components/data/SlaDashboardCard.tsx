/**
 * US-061 [FE-022] DataWorkspace SLA dashboard.
 *
 * 时效 SLA 可视化卡 — 嵌在 DataWorkspace.tsx 的 "数据健康" tab 顶部,
 * 与 SystemTopologyMap / ActivationDashboard / DataHealthDashboard 并列.
 *
 * - 顶部 1 行整体 KPI: 总源数 / 达成率 / 违约源数 / ready 状态
 * - 中间 3 列 (daily/periodic/event): 每类 attainment_pct + 档位 Tag + on_time/total
 * - 底部 blockers 列表 (有违约时显示, 全 healthy 时显示 success Alert)
 *
 * 视图模型派生自同一份 DataHealthStatusResponse — 不再调第二个 endpoint,
 * 让 SLA 与 DataHealthDashboard 永远基于同一数据 snapshot 派生. 与
 * [[buildShadowRunDashboardViewModel]] (US-051) 同款 "多维 → 一档" 思想.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Card, Col, Row, Space, Spin, Statistic, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { DataHealthStatusResponse, getDataHealthStatus } from '../../services/dataHealthService';
import {
  SLA_ATTAIN_DEGRADED_MIN,
  SLA_ATTAIN_HEALTHY_MIN,
  SLA_LEVEL_COLOR,
  SLA_LEVEL_LABEL,
  buildSlaDashboardViewModel,
} from '../../pages/workspace/dataWorkspaceTabHelpers';

const { Text, Paragraph } = Typography;

interface SlaDashboardCardProps {
  /** 上层若已拉过 healthResponse, 直接传入避免重复请求 (DataWorkspace 共享 state). */
  healthData?: DataHealthStatusResponse | null;
}

/** SLA dashboard 卡 — 与 DataHealthDashboard 并列, 顶部嵌在 "数据健康" tab. */
const SlaDashboardCard: React.FC<SlaDashboardCardProps> = ({ healthData }) => {
  // 若 caller 没传 healthData (e.g. 单测 / 独立挂载), 自己拉一次
  const [selfFetched, setSelfFetched] = useState<DataHealthStatusResponse | null>(null);
  const [selfLoading, setSelfLoading] = useState(false);
  useEffect(() => {
    if (healthData) return;
    setSelfLoading(true);
    getDataHealthStatus()
      .then(d => setSelfFetched(d))
      .catch(() => setSelfFetched(null))
      .finally(() => setSelfLoading(false));
  }, [healthData]);

  const effectiveData = healthData ?? selfFetched;
  const vm = useMemo(() => buildSlaDashboardViewModel(effectiveData), [effectiveData]);

  if (selfLoading && !effectiveData) {
    return (
      <Card style={{ marginBottom: 16 }} data-testid="sla-dashboard-card">
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin tip="SLA 看板加载中..." />
        </div>
      </Card>
    );
  }

  const overallColor = SLA_LEVEL_COLOR[vm.overall_level];
  const overallLabel = SLA_LEVEL_LABEL[vm.overall_level];

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined style={{ color: overallColor }} />
          <Text strong>数据源 SLA 时效看板</Text>
          <Tag
            color={
              vm.overall_level === 'critical'
                ? 'red'
                : vm.overall_level === 'degraded'
                  ? 'orange'
                  : vm.overall_level === 'healthy'
                    ? 'green'
                    : 'default'
            }
          >
            {overallLabel}
          </Tag>
        </Space>
      }
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          参考交易日 {vm.reference_trade_date ?? '—'}
        </Text>
      }
      style={{ marginBottom: 16 }}
      data-testid="sla-dashboard-card"
    >
      {/* ---- 顶部整体 KPI ---- */}
      <Row gutter={[16, 16]} align="middle" style={{ marginBottom: 12 }}>
        <Col xs={12} sm={6}>
          <Statistic
            title="总数据源"
            value={vm.total_sources}
            suffix="个"
            valueStyle={{ fontSize: 22 }}
          />
        </Col>
        <Col xs={12} sm={6}>
          <Tooltip
            title={`SLA 达成率 = on_time / (total - unknown); 健康线 ${SLA_ATTAIN_HEALTHY_MIN}% / 告警线 ${SLA_ATTAIN_DEGRADED_MIN}%`}
          >
            <Statistic
              title="整体达成率"
              value={vm.overall_attainment_pct ?? '—'}
              suffix={vm.overall_attainment_pct === null ? undefined : '%'}
              valueStyle={{ color: overallColor, fontSize: 22 }}
            />
          </Tooltip>
        </Col>
        <Col xs={12} sm={6}>
          <Statistic
            title="按时达成"
            value={vm.total_on_time}
            suffix="个"
            valueStyle={{ color: SLA_LEVEL_COLOR.healthy, fontSize: 22 }}
          />
        </Col>
        <Col xs={12} sm={6}>
          <Statistic
            title="SLA 违约"
            value={vm.total_breached}
            suffix="个"
            valueStyle={{
              color: vm.total_breached > 0 ? SLA_LEVEL_COLOR.critical : SLA_LEVEL_COLOR.healthy,
              fontSize: 22,
            }}
          />
        </Col>
      </Row>

      {/* ---- 中间: 3 类分组 ---- */}
      <Row gutter={[16, 16]} style={{ marginBottom: 12 }}>
        {vm.categories.map(cat => {
          const color = SLA_LEVEL_COLOR[cat.level];
          const tagText = SLA_LEVEL_LABEL[cat.level];
          return (
            <Col xs={24} sm={8} key={cat.category}>
              <Card
                size="small"
                bodyStyle={{ padding: 12 }}
                data-testid={`sla-category-${cat.category}`}
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space size={6}>
                    <Text strong>{cat.label}</Text>
                    <Tag
                      color={
                        cat.level === 'critical'
                          ? 'red'
                          : cat.level === 'degraded'
                            ? 'orange'
                            : cat.level === 'healthy'
                              ? 'green'
                              : 'default'
                      }
                    >
                      {tagText}
                    </Tag>
                  </Space>
                  <Space size={16}>
                    <Statistic
                      title="达成率"
                      value={cat.attainment_pct ?? '—'}
                      suffix={cat.attainment_pct === null ? undefined : '%'}
                      valueStyle={{ color, fontSize: 20 }}
                    />
                    <Statistic
                      title="按时 / 总"
                      value={`${cat.on_time}/${cat.total}`}
                      valueStyle={{ fontSize: 16 }}
                    />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    SLA 目标: lag ≤ {cat.target_lag_days} 个交易日
                    {cat.unknown > 0 ? `  · ${cat.unknown} 个状态未知` : ''}
                  </Text>
                </Space>
              </Card>
            </Col>
          );
        })}
      </Row>

      {/* ---- 底部 blockers / 全绿 success ---- */}
      {vm.ready && vm.total_sources > 0 ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="所有类别 SLA 达标"
          description={`总 ${vm.total_sources} 个数据源, ${vm.total_on_time} 个按时达成, 0 违约.`}
        />
      ) : vm.blockers.length > 0 ? (
        <Alert
          type={vm.overall_level === 'critical' ? 'error' : 'warning'}
          showIcon
          icon={
            vm.overall_level === 'critical' ? <ExclamationCircleOutlined /> : <WarningOutlined />
          }
          message={`SLA 未完全达成 (${vm.blockers.length} 项待处理)`}
          description={
            <ul style={{ marginBottom: 0, paddingLeft: 18 }} data-testid="sla-blockers">
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

export default SlaDashboardCard;
