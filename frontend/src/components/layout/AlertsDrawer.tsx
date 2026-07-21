import React, { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Empty, Spin, Tag, message } from 'antd';
import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  ALERT_CATEGORY_LABEL,
  ALERT_LEVEL_LABEL,
  listRiskAlerts,
  markAllRiskAlertsRead,
  markSingleRiskAlertRead,
  type RiskAlertItem,
} from '../../services/riskAlertService';

export interface AlertsDrawerProps {
  open: boolean;
  onClose: () => void;
  onUnreadChange?: () => void;
}

const formatTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));

const AlertsDrawer: React.FC<AlertsDrawerProps> = ({ open, onClose, onUnreadChange }) => {
  const [items, setItems] = useState<RiskAlertItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listRiskAlerts({ page: 1, limit: 50 });
      setItems(result.items);
      setUnread(result.unread_count);
    } catch (err) {
      setError(err instanceof Error ? err.message : '告警加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const markOne = async (id: number) => {
    try {
      await markSingleRiskAlertRead(id);
      setItems(previous =>
        previous.map(item => (item.id === id ? { ...item, is_read: true } : item))
      );
      setUnread(previous => Math.max(0, previous - 1));
      onUnreadChange?.();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '标记已读失败');
    }
  };

  const markAll = async () => {
    try {
      await markAllRiskAlertsRead();
      setItems(previous => previous.map(item => ({ ...item, is_read: true })));
      setUnread(0);
      onUnreadChange?.();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '全部标记已读失败');
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={460}
      title={
        <span>
          风控告警收件箱 <Tag color={unread ? 'red' : 'default'}>{unread} 未读</Tag>
        </span>
      }
      extra={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <Button size="small" icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
          <Button
            size="small"
            icon={<CheckOutlined />}
            disabled={!unread}
            onClick={() => void markAll()}
          >
            全部已读
          </Button>
        </span>
      }
      styles={{ body: { padding: 0, background: '#fbf5e9' } }}
      data-testid="alerts-drawer"
    >
      {loading ? (
        <div style={{ padding: 48, textAlign: 'center' }}>
          <Spin />
        </div>
      ) : null}
      {error ? <div style={{ margin: 18, color: '#a44232' }}>{error}</div> : null}
      {!loading && !error && !items.length ? (
        <Empty description="没有告警" style={{ marginTop: 80 }} />
      ) : null}
      {!loading && !error ? (
        <div>
          {items.map(item => (
            <article
              key={item.id}
              style={{
                padding: '16px 18px',
                borderBottom: '1px solid rgba(80, 58, 39, .13)',
                background: item.is_read ? 'transparent' : 'rgba(184, 96, 58, .08)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                <Tag
                  color={
                    item.level === 'HIGH' ? 'red' : item.level === 'MEDIUM' ? 'orange' : 'blue'
                  }
                >
                  {ALERT_LEVEL_LABEL[item.level] || item.level}
                </Tag>
                <Tag>{ALERT_CATEGORY_LABEL[item.category]}</Tag>
                <strong style={{ flex: 1 }}>{item.name || item.symbol}</strong>
                <small style={{ color: '#7a6a5f' }}>{formatTime(item.created_at)}</small>
              </div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 1.65, color: '#3a302b' }}>
                {item.message}
              </p>
              {!item.is_read ? (
                <Button
                  type="link"
                  size="small"
                  style={{ paddingLeft: 0 }}
                  onClick={() => void markOne(item.id)}
                >
                  标记已读
                </Button>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
    </Drawer>
  );
};

export default AlertsDrawer;
