/**
 * US-062 [FE-023] DataWorkspace 数据缺失独立告警卡.
 *
 * 与 [[SlaDashboardCard]] (US-061) / DataHealthDashboard 并列嵌在 DataWorkspace
 * "数据健康" tab. 三张卡职责互不重叠:
 *   - SlaDashboardCard: 按 category 看 SLA 达成率 (晚了几天)
 *   - DataMissingAlertsCard: 列出 "压根没数据 / 链路挂 / 状态未知" 的具体源
 *     (本卡)
 *   - DataHealthDashboard: 全量源卡片 + 一键补抓按钮 (操作入口)
 *
 * 视图模型来自 healthResponse — 不引第二个 endpoint, 与既有 cards 共享同一
 * snapshot. 告警的 `category` 字段固定为 'data', 与 US-077 RiskAlert
 * 三大 category (position/market/individual) 平级 + 独立.
 *
 * Pure helper [[buildDataMissingAlertsViewModel]] 落在 dataWorkspaceTabHelpers.ts,
 * 单测在 backend/tests/services/data-workspace-tab-helpers.test.ts.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Card, Empty, List, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import {
  CheckCircleOutlined,
  ExclamationCircleOutlined,
  WarningOutlined,
  DatabaseOutlined,
} from '@ant-design/icons';
import { DataHealthStatusResponse, getDataHealthStatus } from '../../services/dataHealthService';
import {
  DATA_MISSING_ALERT_CATEGORY,
  DATA_MISSING_SEVERITY_COLOR,
  DATA_MISSING_SEVERITY_LABEL,
  buildDataMissingAlertsViewModel,
} from '../../pages/workspace/dataWorkspaceTabHelpers';

const { Text } = Typography;

interface DataMissingAlertsCardProps {
  /** 上层若已拉过 healthResponse, 直接传入避免重复请求. */
  healthData?: DataHealthStatusResponse | null;
}

/** 严重度 → antd Tag color name. */
const SEVERITY_TAG_COLOR: Record<'critical' | 'warning' | 'info', 'red' | 'orange' | 'default'> = {
  critical: 'red',
  warning: 'orange',
  info: 'default',
};

const DataMissingAlertsCard: React.FC<DataMissingAlertsCardProps> = ({ healthData }) => {
  // 若 caller 没传, 自己拉一次 (与 SlaDashboardCard 同模式)
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
  const vm = useMemo(() => buildDataMissingAlertsViewModel(effectiveData), [effectiveData]);

  if (selfLoading && !effectiveData) {
    return (
      <Card style={{ marginBottom: 16 }} data-testid="data-missing-alerts-card">
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin tip="数据缺失告警加载中..." />
        </div>
      </Card>
    );
  }

  const tagColor =
    vm.critical > 0 ? 'red' : vm.warning > 0 ? 'orange' : vm.info > 0 ? 'default' : 'green';
  const titleIconColor =
    vm.critical > 0
      ? DATA_MISSING_SEVERITY_COLOR.critical
      : vm.warning > 0
      ? DATA_MISSING_SEVERITY_COLOR.warning
      : '#16a34a';

  return (
    <Card
      title={
        <Space>
          <DatabaseOutlined style={{ color: titleIconColor }} />
          <Text strong>数据缺失告警</Text>
          <Tag color={tagColor}>
            {vm.total === 0
              ? '无缺失'
              : `${vm.total} 条 (严重 ${vm.critical} / 滞后 ${vm.warning} / 未知 ${vm.info})`}
          </Tag>
          {/* category='data' 标识 — 与 US-077 三大 category 平级 + 独立 */}
          <Tooltip title="告警 category 固定为 'data', 与持仓 / 市场 / 单股告警平级 + 独立">
            <Tag style={{ fontSize: 11 }}>category={DATA_MISSING_ALERT_CATEGORY}</Tag>
          </Tooltip>
        </Space>
      }
      extra={
        <Text type="secondary" style={{ fontSize: 12 }}>
          参考交易日 {vm.reference_trade_date ?? '—'}
        </Text>
      }
      style={{ marginBottom: 16 }}
      data-testid="data-missing-alerts-card"
    >
      {vm.total === 0 ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="所有数据源均有数据"
          description="无缺失/异常源. 注: 仅 lag ≤ 阈值, 不代表 SLA 一定达标 (查看 SLA 看板)."
        />
      ) : (
        <>
          {vm.critical > 0 ? (
            <Alert
              type="error"
              showIcon
              icon={<ExclamationCircleOutlined />}
              style={{ marginBottom: 12 }}
              message={`${vm.critical} 个数据源链路中断或异常 — 立即处理`}
              description="此类告警表示同步链路返回 error / 数据源完全无响应; 影响下游所有依赖该源的策略 / 推荐 / 回测."
            />
          ) : vm.warning > 0 ? (
            <Alert
              type="warning"
              showIcon
              icon={<WarningOutlined />}
              style={{ marginBottom: 12 }}
              message={`${vm.warning} 个数据源严重滞后 — 建议补抓`}
              description="数据落后 > 3 个交易日, 影响 T+1 信号准确性. 可在下方数据健康度看板一键触发补抓."
            />
          ) : null}
          <List
            size="small"
            dataSource={vm.alerts}
            data-testid="data-missing-alerts-list"
            renderItem={item => (
              <List.Item
                key={item.source_key}
                data-testid={`data-missing-alert-${item.source_key}`}
              >
                <Space wrap size={8} style={{ width: '100%' }}>
                  <Tag color={SEVERITY_TAG_COLOR[item.severity]}>
                    {DATA_MISSING_SEVERITY_LABEL[item.severity]}
                  </Tag>
                  <Text strong>{item.display_name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ({item.source_category} · {item.source_key})
                  </Text>
                  <Text style={{ fontSize: 13 }}>{item.reason}</Text>
                  {item.last_sync_at ? (
                    <Tooltip title="最近一次同步时间">
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        last_sync={item.last_sync_at.slice(0, 19).replace('T', ' ')}
                      </Text>
                    </Tooltip>
                  ) : null}
                </Space>
              </List.Item>
            )}
            locale={{
              emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无告警" />,
            }}
          />
        </>
      )}
    </Card>
  );
};

export default DataMissingAlertsCard;
