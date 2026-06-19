/**
 * SettingsWorkspace.TodoSuggestionsTab — US-068 [FE-029]
 *
 * **待办建议 (todo suggestions) tab** — 聚合 3 类 "操盘手该看一下" 事项到同一面板:
 *
 *   1. **黑天鹅 (black-swan)** — 来自 `GET /api/risk-alerts?limit=50` 未读 HIGH/CRITICAL
 *      告警 (BlackSwanWatchdog / RiskGuard fail-CLOSED). 系统刚抓到的黑天鹅, 最先看.
 *   2. **偏差 (deviation)** — 来自 `GET /api/tasks/automation-health` 的 issues 与
 *      chains[].issues (cron 卡死 / queue 积压 / 任务失败 / schema 不健康). 链路实际
 *      运行偏离了事先约定.
 *   3. **改进 (improvement)** — 同 endpoint 的 `risk_limit_suggestion` (可应用的阈值
 *      候选补丁) + `next_actions[]` (人写的下一步建议). 系统在告诉你"调一下这里会更好".
 *
 * 设计模式 (沿用 PortfolioConstructionTab / RiskParametersCenterTab 同款 "draft/view"
 * 思想的轻量版 — 本 tab 只读 + 推动用户去其它 tab 操作, 没有自己的 save 路径):
 *   - Promise.allSettled 并行拉两路 endpoint, 单路失败仅本 section Alert 降级,
 *     不阻塞另一路 (与 RiskParametersCenterTab fail-OPEN 同思想);
 *   - 所有"业务排序 / 截断 / dedup / 聚合"逻辑全在 todoSuggestionsHelpers.ts pure
 *     function, 本组件只负责 fetch + render + navigate (与 [[todayPlanHelpers]] /
 *     [[todaySellHelpers]] / [[shadowRunHelpers]] 同款 "UI 提示 + backend 独立执行" 二元结构);
 *   - 没有 save 按钮 — 用户操作直接跳到对应 tab (黑天鹅 → 警报 panel / 偏差 → 任务设置 /
 *     改进 → /api/tasks/...).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  AlertOutlined,
  BulbOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import api from '../../services/api';
import {
  buildTodoSuggestionsViewModel,
  TODO_CATEGORY_COLOR,
  TODO_CATEGORY_LABEL,
  TODO_PRIORITY_COLOR,
  TODO_PRIORITY_LABEL,
  type AutomationHealthInput,
  type RiskAlertInput,
  type TodoCategory,
  type TodoItem,
  type TodoSuggestionsViewModel,
} from './todoSuggestionsHelpers';

const { Paragraph, Text } = Typography;

/** category → icon (UI 友好) */
const CATEGORY_ICON: Record<TodoCategory, React.ReactNode> = {
  'black-swan': <AlertOutlined />,
  deviation: <WarningOutlined />,
  improvement: <BulbOutlined />,
};

const TodoSuggestionsTab: React.FC = () => {
  const [view, setView] = useState<TodoSuggestionsViewModel | null>(null);
  const [loading, setLoading] = useState(false);
  /** 分路 error — 任一路 fail 只本 section 标 error, 另一路照常加载 */
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setAlertsError(null);
    setHealthError(null);

    let alerts: RiskAlertInput[] | null = null;
    let health: AutomationHealthInput | null = null;

    // Promise.allSettled — 单路失败不阻塞另一路 (与 RiskParametersCenterTab loadAll 同款)
    const results = await Promise.allSettled([
      api.get('/risk-alerts', { params: { limit: 50 } }),
      api.get('/tasks/automation-health'),
    ]);

    const alertsRes = results[0];
    if (alertsRes.status === 'fulfilled') {
      // 后端 getAlerts 返 { data: { alerts: [...], risk_config } } 或直接 { data: [...] }, 两种 shape 都兜
      const payload = alertsRes.value?.data?.data;
      if (Array.isArray(payload)) {
        alerts = payload as RiskAlertInput[];
      } else if (payload && Array.isArray(payload.alerts)) {
        alerts = payload.alerts as RiskAlertInput[];
      } else {
        alerts = [];
      }
    } else {
      const err = alertsRes.reason;
      const msg = err?.response?.data?.message || err?.message || String(err);
      setAlertsError(`加载黑天鹅告警失败: ${msg}`);
    }

    const healthRes = results[1];
    if (healthRes.status === 'fulfilled') {
      health = (healthRes.value?.data?.data || null) as AutomationHealthInput | null;
    } else {
      const err = healthRes.reason;
      const msg = err?.response?.data?.message || err?.message || String(err);
      setHealthError(`加载偏差/改进建议失败: ${msg}`);
    }

    setView(buildTodoSuggestionsViewModel({ alerts, health }));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Table 列定义 — 用 useMemo 防 React render path 重渲染 */
  const columns = useMemo(
    () => [
      {
        title: '类别',
        dataIndex: 'category',
        key: 'category',
        width: 110,
        render: (cat: TodoCategory) => (
          <Tag color={TODO_CATEGORY_COLOR[cat]} icon={CATEGORY_ICON[cat]}>
            {TODO_CATEGORY_LABEL[cat]}
          </Tag>
        ),
      },
      {
        title: '优先级',
        dataIndex: 'priority',
        key: 'priority',
        width: 90,
        render: (p: TodoItem['priority']) => (
          <Tag color={TODO_PRIORITY_COLOR[p]}>{TODO_PRIORITY_LABEL[p]}</Tag>
        ),
      },
      {
        title: '标题',
        dataIndex: 'title',
        key: 'title',
        render: (t: string, row: TodoItem) => (
          <Space direction="vertical" size={0}>
            <Text strong>{t}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.detail}
            </Text>
          </Space>
        ),
      },
      {
        title: '建议动作',
        dataIndex: 'action_hint',
        key: 'action_hint',
        width: 200,
        render: (h: string, row: TodoItem) => (
          <Tooltip title={`来源: ${row.source}`}>
            <Text>{h}</Text>
          </Tooltip>
        ),
      },
      {
        title: '时间',
        dataIndex: 'occurred_at',
        key: 'occurred_at',
        width: 160,
        render: (v?: string) =>
          v ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {v}
            </Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Text>
          ),
      },
    ],
    []
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type={view?.has_critical ? 'error' : 'info'}
        showIcon
        message="待办建议"
        description={
          <div>
            <Paragraph style={{ marginBottom: 4 }}>
              聚合 <strong>黑天鹅</strong> (系统刚抓到的高危告警) / <strong>偏差</strong> (链路 cron
              / queue / schema 问题) / <strong>改进</strong> (风险阈值候选补丁 + 下一步建议)
              三类待办到同一面板, 优先级 critical→low 排序, 同优先级内黑天鹅最先看。
            </Paragraph>
            <Paragraph style={{ marginBottom: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              本 tab 仅 <strong>聚合提示</strong>, 不直接执行任何动作 — 点{' 「查看告警」 '}跳警报
              panel, 点{' 「刷新链路」 '}跳任务设置, 点{' 「应用建议」 '}跳风险阈值 apply route。
            </Paragraph>
          </div>
        }
      />

      {/* 顶部 KPI 行 — 一眼看出每类各几条 */}
      <Card size="small" variant="borderless" className="modern-card">
        <Row gutter={[16, 16]}>
          <Col xs={12} md={4}>
            <Statistic title="待办总数" value={view?.total ?? 0} suffix="项" />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="严重 (critical)"
              value={view?.by_priority.critical ?? 0}
              suffix="项"
              valueStyle={{
                color: view?.by_priority.critical ? '#cf1322' : undefined,
              }}
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="高 (high)"
              value={view?.by_priority.high ?? 0}
              suffix="项"
              valueStyle={{ color: view?.by_priority.high ? '#fa541c' : undefined }}
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="黑天鹅"
              value={view?.by_category.black_swan ?? 0}
              suffix="项"
              prefix={<AlertOutlined />}
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="偏差"
              value={view?.by_category.deviation ?? 0}
              suffix="项"
              prefix={<WarningOutlined />}
            />
          </Col>
          <Col xs={12} md={4}>
            <Statistic
              title="改进"
              value={view?.by_category.improvement ?? 0}
              suffix="项"
              prefix={<BulbOutlined />}
            />
          </Col>
        </Row>
      </Card>

      {/* 分路 error — 两路独立显示, 一路失败另一路照常 */}
      {alertsError && <Alert type="warning" showIcon message={alertsError} />}
      {healthError && <Alert type="warning" showIcon message={healthError} />}

      {/* Table — 待办列表, 默认按 priority + category + 时间倒序 */}
      <Card
        size="small"
        variant="borderless"
        className="modern-card"
        title={
          <Space>
            <ThunderboltOutlined />
            <span style={{ fontWeight: 600 }}>待办列表 ({view?.total ?? 0} 项)</span>
          </Space>
        }
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={loading}
            onClick={() => void refresh()}
          >
            刷新
          </Button>
        }
      >
        {view && view.items.length > 0 ? (
          <Table<TodoItem>
            size="small"
            rowKey="id"
            columns={columns as any}
            dataSource={view.items}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            data-testid="todo-suggestions-table"
          />
        ) : (
          <Empty
            description={
              loading
                ? '加载中...'
                : view
                ? '当前无待办 — 链路健康 / 无黑天鹅 / 无改进建议'
                : '尚未加载数据'
            }
          />
        )}
      </Card>
    </Space>
  );
};

export default TodoSuggestionsTab;
