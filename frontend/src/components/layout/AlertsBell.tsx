/**
 * AlertsBell (US-070 [FE-031]) — 顶 nav bar 全局浮动告警铃铛.
 *
 * 用法: 放在 App.tsx Header 里, 任何已登录用户全屏显示.
 *
 * 行为:
 *   - 60s 轮询 GET /api/risk-alerts/list?limit=1 → 取 unread_count
 *     (limit=1 让 response ≤ 200B, 轮询负担最小 — 我们只关心数字).
 *   - 未读 = 0 → 显示空心 Bell, 无 Badge.
 *   - 1 ≤ 未读 < CRITICAL_UNREAD_THRESHOLD → 蓝色 Badge + 数字.
 *   - 未读 ≥ CRITICAL_UNREAD_THRESHOLD → 红色 Badge + 数字 (status='error').
 *   - 未读 ≥ 100 → 显示 "99+".
 *   - hover → Tooltip 文案见 buildBellTooltip().
 *   - click → navigate('/workspace/today?tab=risk_center') 落到风控中心 tab.
 *
 * 错误兜底 (fail-OPEN):
 *   - listRiskAlerts() throw → 仅 setErrorTooltip + 保留上一次 unread count
 *     (不清零, 防"网络抖动一秒红 Badge 跳没了" 假阴性). 与 backend
 *     dispatcher fail-OPEN 思想一致 — Bell 不可用不应阻塞用户使用其它 workspace.
 *   - 未登录 (无 token) → 不渲染本组件 (caller 已经在 App.tsx 用 `token &&` 守).
 *
 * 与后续 stories 解耦:
 *   - US-071 AlertsPanel filter — 与本组件无关 (那是 sub-tab 内细节).
 *   - US-072 AlertItem snooze — 同上.
 *   - US-073 WebSocket /ws/alerts — 替换本组件轮询路径, 但 Badge 渲染/导航/tooltip
 *     全靠 alertsBellHelpers 已抽好的纯函数, US-073 只改 hook 来源不动 UI.
 *   - US-074 CriticalAlertModal — 独立组件, 不在本组件内. 共用 unread_count 但
 *     展示形态不同.
 *
 * 单测策略:
 *   - 本 .tsx 不直接单测 (跨 monorepo 起 React/jsdom 太重, 与 [[strategyKillSwitchHelpers]]
 *     同款"逻辑全在 helper, JSX 仅 render" 范式);
 *   - alertsBellHelpers.ts 全单测; META-GUARD 守本 .tsx 调到了关键 export.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Tooltip } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { listRiskAlerts } from '../../services/riskAlertService';
import {
  buildAlertsBellHref,
  buildBellTooltip,
  classifyAlertsBellSeverity,
  clampPollInterval,
  DEFAULT_POLL_INTERVAL_MS,
  formatBadgeText,
  MAX_BADGE_COUNT,
  normalizeUnreadCount,
} from '../../pages/workspace/alertsBellHelpers';

export interface AlertsBellProps {
  /**
   * Override poll interval (ms). Defaults to DEFAULT_POLL_INTERVAL_MS = 60s.
   * Clamped to [MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS] in helper.
   *
   * 用法场景: 演示模式 (5s 演示快速看 Badge 变红) / 性能调试. 生产环境保持默认.
   */
  pollIntervalMs?: number;
}

const AlertsBell: React.FC<AlertsBellProps> = ({ pollIntervalMs }) => {
  const navigate = useNavigate();
  const [unreadCount, setUnreadCount] = useState<number>(0);
  const [errored, setErrored] = useState<boolean>(false);
  // 防 unmount 后 setState — 切路由 / hot-reload 时常见 React warn 源.
  const mountedRef = useRef(true);

  const fetchUnread = useCallback(async () => {
    try {
      // limit=1 让 response body 极小, 我们只用 unread_count 字段.
      const res = await listRiskAlerts({ limit: 1, page: 1 });
      if (!mountedRef.current) return;
      setUnreadCount(normalizeUnreadCount(res?.unread_count));
      setErrored(false);
    } catch {
      // fail-OPEN: 不清零, 仅标记 errored 让 Tooltip 提示 "拉取失败".
      // 网络抖动一次不应让 Badge "假绿" 误导用户以为告警都已读了.
      if (!mountedRef.current) return;
      setErrored(true);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // 立即拉一次, 再周期轮询.
    void fetchUnread();
    const interval = clampPollInterval(pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const timer = window.setInterval(() => {
      void fetchUnread();
    }, interval);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [fetchUnread, pollIntervalMs]);

  const handleClick = useCallback(() => {
    navigate(buildAlertsBellHref());
  }, [navigate]);

  const severity = classifyAlertsBellSeverity(unreadCount);
  const badgeText = formatBadgeText(unreadCount);
  const tooltipText = errored
    ? '拉取告警失败 — 网络异常, 已保留上次未读数; 点击仍可跳转风控中心'
    : buildBellTooltip(unreadCount);

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
