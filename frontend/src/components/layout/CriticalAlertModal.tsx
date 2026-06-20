/**
 * US-074 [FE-035] CriticalAlertModal — 强制弹窗组件.
 *
 * 行为:
 *   - 通过 [[useAlertsRealtime]] 的 onAlert 钩子收到任何 alert.new;
 *   - 调 [[isCriticalAlert]] 判定是否值得强制弹窗 (drawdown / black_swan / kill_switch
 *     / position_limit / per_stock_stop_loss / reconciliation / restricted_share_unlock
 *     / SYSTEM: 前缀);
 *   - 命中即排进队列 (CRITICAL_MODAL_MAX_QUEUE=5), Modal 锁屏 (maskClosable=false /
 *     keyboard=false / closable=false) 强制用户点 "我已知悉" 按钮;
 *   - 点击后调 markSingleRiskAlertRead(alert_id) 通知 backend, 失败 fail-OPEN 仅 toast;
 *     无论 backend 成功失败都把 id 写入 session ack 缓存防止反复弹.
 *   - sessionStorage 跨 reload 持久化 (logout 时 [[sessionCleanup]] 会清), 防"刷新页面
 *     就再次弹同一条"假阳性.
 *
 * 设计要点 (与 [[alertsBellHelpers]] / [[criticalAlertModalHelpers]] 同款"前端 pure helper 范式"):
 *   - 纯 view, 决策表全在 helper; component 只 wire-up state + render.
 *   - 不依赖 Bell / Panel / TodayWorkspace — 全局 mount 在 App.tsx token 守护下.
 *   - 与 Bell 共享 useAlertsRealtime 但用独立 onAlert hook (Bell 不传 onAlert,
 *     本组件传 onAlert; 同一 hook 多个 instance 各持自己的 WS connection,
 *     backend MAX_CLIENTS_PER_USER=8 兜住).
 *
 * 浏览器手动 smoke:
 *   1. 登录后保留页面打开;
 *   2. backend 注入 fake RiskAlert.create({ level:'HIGH', rule_id:'drawdown_breaker', ... });
 *   3. 前端期望 < 1s 弹出锁屏 modal, 标题 "⚠ 严重风控告警", 副标题含 stock+ruleLabel;
 *   4. 点 "我已知悉" → modal 关 + Bell unread_count -1 + 同 alert 再推不再弹.
 */

import React, { useCallback, useState } from 'react';
import { Modal, Tag, Typography, message } from 'antd';
import { ExclamationCircleOutlined } from '@ant-design/icons';

import { useAlertsRealtime } from '../../services/alertsRealtimeClient';
import type { AlertsRealtimeMessage } from '../../services/alertsRealtimeClient';
import { markSingleRiskAlertRead } from '../../services/riskAlertService';
import {
  CRITICAL_MODAL_OK_TEXT,
  CRITICAL_MODAL_TITLE,
  CriticalAlertViewModel,
  buildCriticalAlertViewModel,
  enqueueCriticalAlert,
  isCriticalAlert,
  loadAckedAlertIds,
  popCriticalAlert,
  recordAckedAlertId,
} from '../../pages/workspace/criticalAlertModalHelpers';

const { Paragraph, Text } = Typography;

const CriticalAlertModal: React.FC = () => {
  const [queue, setQueue] = useState<CriticalAlertViewModel[]>([]);
  const [ackedSet, setAckedSet] = useState<Set<number>>(() => loadAckedAlertIds());
  const [acking, setAcking] = useState<boolean>(false);

  const handleIncomingAlert = useCallback(
    (msg: AlertsRealtimeMessage) => {
      if (!isCriticalAlert(msg)) return;
      const vm = buildCriticalAlertViewModel(msg);
      if (!vm) return;
      setQueue(prev => enqueueCriticalAlert(prev, vm, ackedSet));
    },
    [ackedSet]
  );

  // 复用 Bell 的 useAlertsRealtime, 注入 onAlert 钩子.
  // unreadCount/mode 本组件不消费, 但 hook 必须挂载才能接收消息.
  useAlertsRealtime({ onAlert: handleIncomingAlert });

  const current = queue[0] || null;

  const handleAck = useCallback(async () => {
    if (!current || acking) return;
    setAcking(true);
    // 不管 backend 成败都先在本地记 ack — 防"网络断 → 用户点了仍反复弹".
    const nextAcked = recordAckedAlertId(current.alert_id);
    setAckedSet(nextAcked);
    try {
      await markSingleRiskAlertRead(current.alert_id);
    } catch (e: any) {
      message.warning(`告警已记本地确认, 但同步 backend 失败: ${e?.message || e}`);
    } finally {
      setAcking(false);
      setQueue(prev => {
        const [, rest] = popCriticalAlert(prev);
        return rest;
      });
    }
  }, [current, acking]);

  // 失活时不渲染 Modal — antd Modal 加 open={false} 也行, 但完全不挂载更轻量.
  if (!current) return null;

  const queueRemaining = queue.length - 1;

  return (
    <Modal
      open={!!current}
      title={
        <span>
          <ExclamationCircleOutlined style={{ color: '#c94b4b', marginRight: 8 }} />
          {CRITICAL_MODAL_TITLE}
        </span>
      }
      // 强制 ack 三件套: 不让用户绕开
      closable={false}
      maskClosable={false}
      keyboard={false}
      okText={CRITICAL_MODAL_OK_TEXT}
      onOk={handleAck}
      confirmLoading={acking}
      cancelButtonProps={{ style: { display: 'none' } }}
      // 视觉强化: 红边 + 居中, 与 antd Modal.confirm danger 风格对齐
      okButtonProps={{ danger: true, 'data-testid': 'critical-alert-modal-ack' } as any}
      width={520}
      centered
      data-testid="critical-alert-modal"
    >
      <div data-testid="critical-alert-modal-content">
        <Paragraph style={{ marginBottom: 8 }}>
          <Tag color="red" data-testid="critical-alert-modal-level">
            {current.level || 'HIGH'}
          </Tag>
          <Tag color="orange" data-testid="critical-alert-modal-rule">
            {current.ruleLabel}
          </Tag>
          <Text strong>{current.headline}</Text>
        </Paragraph>
        <Paragraph
          style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}
          data-testid="critical-alert-modal-message"
        >
          {current.message || '(无详细信息)'}
        </Paragraph>
        {queueRemaining > 0 ? (
          <Paragraph
            type="secondary"
            style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}
            data-testid="critical-alert-modal-queue-remaining"
          >
            还有 {queueRemaining} 条严重告警待确认 — 点击「我已知悉」逐条处理.
          </Paragraph>
        ) : null}
      </div>
    </Modal>
  );
};

export default CriticalAlertModal;
