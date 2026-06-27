/**
 * US-063 [FE-024] DataWorkspace 一键补抓按钮.
 *
 * 嵌在 DataWorkspace 'health' tab, 与 SlaDashboardCard / DataMissingAlertsCard
 * 并列 (推荐放最前, 让 ops 一眼能动手). 既有 [[DataHealthDashboard]] 每张卡
 * 自带 "手动触发同步" 按钮; 本卡的价值是 *批量入口* — 一次性串行触发所有
 * 需要补抓的 daily 源, 避免逐张点 + 漏点.
 *
 * 视图模型来自 [[buildBulkBackfillPlan]] (helper 在 dataWorkspaceTabHelpers.ts),
 * 单测在 backend/tests/services/data-workspace-tab-helpers.test.ts. UI 流程:
 *
 *   1. 卡片 header 显示当前 plan: "需补抓 N 个 (链路异常 X / 严重滞后 Y / ...)"
 *   2. 主按钮 "一键补抓 N 个数据源" — total=0 时 disabled + Tooltip 说明原因
 *   3. 点击 → Modal.confirm 列出全部目标 + reason, 用户确认后串行触发
 *   4. 串行 (而非并发) 触发 — 后端 sync 是同步 HTTP 调外网, 并发会被 rate
 *      limit / 触发 anti-bot. 每个调用 await + 把结果 push 到 results 数组
 *   5. 全部完成后 Modal.success/error 显示 BulkBackfillSummary
 *   6. 期间 disable 按钮 + 显示 Progress 条 (current/total)
 *
 * 与 SlaDashboardCard / DataMissingAlertsCard 共用 healthData prop 模式: caller
 * 传入避免双拉; 不传时自己 fetch 一次.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  List,
  Modal,
  Progress,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CloudSyncOutlined,
  ExclamationCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  DataHealthStatusResponse,
  getDataHealthStatus,
  triggerDataSync,
} from '../../services/dataHealthService';
import {
  BulkBackfillResult,
  buildBulkBackfillPlan,
  summarizeBulkBackfillResults,
} from '../../pages/workspace/dataWorkspaceTabHelpers';

const { Text, Paragraph } = Typography;

interface BulkBackfillButtonProps {
  /** 上层已拉过 healthResponse 时传入, 避免双拉. */
  healthData?: DataHealthStatusResponse | null;
  /** 一次批量补抓全部完成 (含失败) 后回调, 让上层主动 refresh healthData. */
  onBackfillDone?: () => void;
}

/** reason → antd Tag color. */
const REASON_TAG_COLOR: Record<string, 'red' | 'orange' | 'default' | 'blue'> = {
  sync_error: 'red',
  severe_lag: 'orange',
  no_record: 'default',
  mild_lag: 'blue',
};
const REASON_LABEL: Record<string, string> = {
  sync_error: '链路异常',
  severe_lag: '严重滞后',
  no_record: '零记录',
  mild_lag: '轻微滞后',
};

const BulkBackfillButton: React.FC<BulkBackfillButtonProps> = ({ healthData, onBackfillDone }) => {
  // caller 没传时自己拉一次 (与 SlaDashboardCard / DataMissingAlertsCard 同模式).
  const [selfFetched, setSelfFetched] = useState<DataHealthStatusResponse | null>(null);
  useEffect(() => {
    if (healthData) return;
    getDataHealthStatus()
      .then(d => setSelfFetched(d))
      .catch(() => setSelfFetched(null));
  }, [healthData]);
  const effectiveData = healthData ?? selfFetched;
  const plan = useMemo(() => buildBulkBackfillPlan(effectiveData), [effectiveData]);

  // 串行触发进度状态.
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string | null }>(
    {
      done: 0,
      total: 0,
      current: null,
    }
  );

  const runBulkBackfill = useCallback(async () => {
    if (plan.total === 0 || running) return;
    setRunning(true);
    setProgress({ done: 0, total: plan.total, current: plan.targets[0]?.display_name ?? null });
    const results: BulkBackfillResult[] = [];
    // 串行 — 同步链路是外网调用 + 数据库写, 并发会被 rate limit 拒.
    for (let i = 0; i < plan.targets.length; i += 1) {
      const target = plan.targets[i];
      setProgress({ done: i, total: plan.total, current: target.display_name });
      try {
        const res = await triggerDataSync(target.sync_source);
        results.push({
          sync_source: target.sync_source,
          display_name: target.display_name,
          ok: Boolean(res?.success),
          message: res?.success ? '同步完成' : res?.error ?? '后端返回 success=false',
        });
      } catch (err: any) {
        results.push({
          sync_source: target.sync_source,
          display_name: target.display_name,
          ok: false,
          message: err?.message ?? '触发失败',
        });
      }
    }
    setProgress({ done: plan.total, total: plan.total, current: null });
    setRunning(false);
    const summary = summarizeBulkBackfillResults(results);
    if (summary.all_ok) {
      Modal.success({
        title: `一键补抓完成 — 全部 ${summary.success} 个数据源同步成功`,
        content: (
          <Paragraph style={{ marginBottom: 0 }}>
            建议刷新 SLA 看板与数据缺失告警, 确认 lag 已归零.
          </Paragraph>
        ),
      });
    } else {
      Modal.error({
        title: `一键补抓部分失败 (${summary.success} 成功 / ${summary.failed} 失败)`,
        content: (
          <div>
            <Paragraph style={{ marginBottom: 8 }}>
              失败的数据源: <Text code>{summary.failed_sources.join(', ') || '—'}</Text>
            </Paragraph>
            <Paragraph style={{ marginBottom: 0, fontSize: 12 }}>
              请在下方数据健康度看板上对失败源逐个重试, 或登录服务器走运维 CLI 排查.
            </Paragraph>
          </div>
        ),
      });
    }
    // 让上层 refresh — 不直接 await 让 UI 优先呈现 Modal.
    onBackfillDone?.();
  }, [plan, running, onBackfillDone]);

  const handleClick = useCallback(() => {
    if (plan.total === 0 || running) return;
    Modal.confirm({
      title: `确认一键补抓 ${plan.total} 个数据源?`,
      icon: <ExclamationCircleOutlined />,
      width: 560,
      content: (
        <div>
          <Paragraph style={{ marginBottom: 8 }}>
            将串行触发以下数据源同步 (每个等前一个完成再下一个):
          </Paragraph>
          <List
            size="small"
            dataSource={plan.targets}
            data-testid="bulk-backfill-confirm-list"
            renderItem={item => (
              <List.Item key={item.source_key}>
                <Space size={6} wrap>
                  <Tag color={REASON_TAG_COLOR[item.reason] || 'default'}>
                    {REASON_LABEL[item.reason] || item.reason}
                  </Tag>
                  <Text strong>{item.display_name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ({item.sync_source})
                  </Text>
                  <Text style={{ fontSize: 12 }}>{item.reason_text}</Text>
                </Space>
              </List.Item>
            )}
          />
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            注: 仅触发当日数据补抓 (按服务端 today). 历史日期回填需走运维 CLI 指定 --date.
          </Paragraph>
        </div>
      ),
      okText: `开始补抓 (${plan.total} 个)`,
      cancelText: '取消',
      onOk: () => {
        void runBulkBackfill().catch(err => {
          // runBulkBackfill 自己已经 try/catch 每个 await, 这里只是兜底
          message.error(err?.message ?? '一键补抓异常');
        });
      },
    });
  }, [plan, running, runBulkBackfill]);

  const tagColor =
    plan.counts.sync_error > 0
      ? 'red'
      : plan.counts.severe_lag > 0
      ? 'orange'
      : plan.total > 0
      ? 'blue'
      : 'green';

  const progressPct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Card
      title={
        <Space>
          <ThunderboltOutlined
            style={{
              color: tagColor === 'red' ? '#dc2626' : tagColor === 'orange' ? '#faad14' : '#1890ff',
            }}
          />
          <Text strong>一键补抓</Text>
          <Tag color={tagColor}>
            {plan.total === 0
              ? '无需补抓'
              : `${plan.total} 个待补抓 (异常 ${plan.counts.sync_error} / 严重滞后 ${plan.counts.severe_lag} / 零记录 ${plan.counts.no_record} / 轻微 ${plan.counts.mild_lag})`}
          </Tag>
        </Space>
      }
      extra={
        <Tooltip
          title={
            plan.disabled_reason ?? `点击后将串行触发 ${plan.total} 个数据源补抓 (确认后才执行)`
          }
        >
          <Button
            type="primary"
            icon={<CloudSyncOutlined />}
            disabled={plan.total === 0 || running}
            loading={running}
            onClick={handleClick}
            data-testid="bulk-backfill-trigger-btn"
          >
            {running
              ? `补抓中… (${progress.done}/${progress.total})`
              : plan.total > 0
              ? `一键补抓 ${plan.total} 个`
              : '一键补抓'}
          </Button>
        </Tooltip>
      }
      style={{ marginBottom: 16 }}
      data-testid="bulk-backfill-card"
    >
      {plan.disabled_reason && plan.total === 0 ? (
        <Alert type="success" showIcon message={plan.disabled_reason} />
      ) : (
        <>
          <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
            可一键补抓 daily 源共 <Text strong>{plan.daily_sources_total}</Text> 个, 当前
            <Text strong> {plan.total} </Text>
            个需要补抓 — 按 reason 排序如下, 点击右上按钮触发批量同步.
          </Paragraph>
          <List
            size="small"
            dataSource={plan.targets}
            data-testid="bulk-backfill-targets-list"
            renderItem={item => (
              <List.Item
                key={item.source_key}
                data-testid={`bulk-backfill-target-${item.sync_source}`}
              >
                <Space size={8} wrap>
                  <Tag color={REASON_TAG_COLOR[item.reason] || 'default'}>
                    {REASON_LABEL[item.reason] || item.reason}
                  </Tag>
                  <Text strong>{item.display_name}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    ({item.sync_source} · {item.source_category})
                  </Text>
                  <Text style={{ fontSize: 12 }}>{item.reason_text}</Text>
                </Space>
              </List.Item>
            )}
          />
          {running && (
            <div style={{ marginTop: 12 }}>
              <Progress
                percent={progressPct}
                status="active"
                data-testid="bulk-backfill-progress"
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                正在同步: {progress.current ?? '—'} ({progress.done}/{progress.total})
              </Text>
            </div>
          )}
        </>
      )}
    </Card>
  );
};

export default BulkBackfillButton;
