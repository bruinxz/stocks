/**
 * AlertsBell (US-070 [FE-031]) — 顶 nav bar 全局浮动告警铃铛.
 *
 * 用法: 放在 App.tsx Header 里, 任何已登录用户全屏显示.
 *
 * 行为:
 *   - **US-073 [FE-034]** 实时模式: 默认 WebSocket /ws/alerts 推送, 失败自动退 30s polling.
 *     - WebSocket 收到 alert.new → 立刻 fetch /api/risk-alerts/list?limit=1 取 unread_count.
 *     - WebSocket 断 → 1s/2s/4s/8s/16s/32s backoff 重连, 同时 30s polling 兜底.
 *     - 重连失败 6 次 → 永久 polling, mode='polling'.
 *   - 未读 = 0 → 显示空心 Bell, 无 Badge.
 *   - 1 ≤ 未读 < CRITICAL_UNREAD_THRESHOLD → 蓝色 Badge + 数字.
 *   - 未读 ≥ CRITICAL_UNREAD_THRESHOLD → 红色 Badge + 数字 (status='error').
 *   - 未读 ≥ 100 → 显示 "99+".
 *   - hover → Tooltip 文案见 buildBellTooltip() + mode 后缀 (ws/polling).
 *   - click → navigate('/workspace/today?tab=risk_center') 落到风控中心 tab.
 *
 * 错误兜底 (fail-OPEN):
 *   - useAlertsRealtime 内部全 try/catch — 任何 fetch 失败保留上一次 unread count
 *     (不清零, 防"网络抖动一秒红 Badge 跳没了" 假阴性). 与 backend
 *     dispatcher fail-OPEN 思想一致 — Bell 不可用不应阻塞用户使用其它 workspace.
 *   - 未登录 (无 token) → 不渲染本组件 (caller 已经在 App.tsx 用 `token &&` 守).
 *
 * 与后续 stories 解耦:
 *   - US-071 AlertsPanel filter — 与本组件无关 (那是 sub-tab 内细节).
 *   - US-072 AlertItem snooze — 同上.
 *   - US-074 CriticalAlertModal — 独立组件, 不在本组件内. 共用 unread_count 但
 *     展示形态不同.
 *
 * 单测策略:
 *   - 本 .tsx 不直接单测 (跨 monorepo 起 React/jsdom 太重, 与 [[strategyKillSwitchHelpers]]
 *     同款"逻辑全在 helper, JSX 仅 render" 范式);
 *   - alertsBellHelpers.ts + alertsRealtimeClient.ts 全单测; META-GUARD 守本 .tsx 调到了关键 export.
 */

import React, { useCallback } from 'react';
import { Badge, Tooltip } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import {
  buildAlertsBellHref,
  buildBellTooltip,
  classifyAlertsBellSeverity,
  formatBadgeText,
  MAX_BADGE_COUNT,
} from '../../pages/workspace/alertsBellHelpers';
import { useAlertsRealtime } from '../../services/alertsRealtimeClient';

export interface AlertsBellProps {
  /**
   * @deprecated US-073 之后 polling 间隔由 useAlertsRealtime 内部固化 30s;
   * 此 prop 保留向后兼容但实际无效. 调试可用 enableWebSocket=false 强制 polling.
   */
  pollIntervalMs?: number;
  /**
   * 关闭 WebSocket — 强制走 30s polling. 用于回归测试 / 故障演练.
   */
  enableWebSocket?: boolean;
}

const AlertsBell: React.FC<AlertsBellProps> = ({ enableWebSocket = true }) => {
  const navigate = useNavigate();
  const { unreadCount, mode } = useAlertsRealtime({ enableWebSocket });
  const errored = mode === 'error';

  const handleClick = useCallback(() => {
    navigate(buildAlertsBellHref());
  }, [navigate]);

  const severity = classifyAlertsBellSeverity(unreadCount);
  const badgeText = formatBadgeText(unreadCount);
  // mode 后缀让用户感知 ws vs polling — 调试 / 看 connection 健康度时有用
  const modeSuffix =
    mode === 'ws'
      ? ' (实时)'
      : mode === 'polling'
      ? ' (轮询)'
      : mode === 'error'
      ? ' (拉取失败)'
      : '';
  const tooltipText = errored
    ? '拉取告警失败 — 网络异常, 已保留上次未读数; 点击仍可跳转风控中心'
    : `${buildBellTooltip(unreadCount)}${modeSuffix}`;

  // antd Badge: color='red' 让 critical Badge 显红 (与项目主题 colorError 同色);
  // normal 让 antd 默认蓝色 (颜色省略). 0 → showBadge=false 不显示 Badge, Bell 看起来"干净".
  const showBadge = severity !== 'none';
  const badgeColor = severity === 'critical' ? '#c94b4b' : '#1f3a5f';

  return (
    <Tooltip title={tooltipText} placement="bottomRight">
      <span
        role="button"
        tabIndex={0}
        data-testid="alerts-bell"
        data-severity={severity}
        data-unread={String(unreadCount)}
        data-mode={mode}
        onClick={handleClick}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleClick();
          }
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          padding: '4px 8px',
          borderRadius: 8,
          color: errored ? '#c94b4b' : undefined,
          // 让 hover 有视觉反馈, 与 header-user-dropdown 同思想.
          transition: 'background-color 0.18s ease',
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLSpanElement).style.backgroundColor = 'rgba(0,0,0,0.04)';
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLSpanElement).style.backgroundColor = 'transparent';
        }}
      >
        {showBadge ? (
          <Badge
            count={badgeText}
            color={badgeColor}
            overflowCount={MAX_BADGE_COUNT}
            offset={[0, 0]}
            data-testid="alerts-bell-badge"
          >
            <BellOutlined style={{ fontSize: 18 }} />
          </Badge>
        ) : (
          <BellOutlined style={{ fontSize: 18 }} />
        )}
      </span>
    </Tooltip>
  );
};

export default AlertsBell;
