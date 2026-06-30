import React, { useCallback, useEffect, useState } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Tag,
  Space,
  Spin,
  Alert,
  Button,
  Descriptions,
  Empty,
} from 'antd';
import {
  ReloadOutlined,
  HeartOutlined,
  DatabaseOutlined,
  ApiOutlined,
  CloudOutlined,
} from '@ant-design/icons';
import api from '../services/api';

interface HealthDetail {
  db: 'ok' | 'fail' | 'unknown';
  redis: 'ok' | 'fail' | 'unknown';
  tradingAgents: 'ok' | 'fail' | 'unknown';
  akshare: 'ok' | 'fail' | 'unknown';
  feishu: 'ok' | 'fail' | 'unknown';
  uptime_seconds: number;
  [k: string]: any;
}

interface DataHealth {
  key: string;
  display_name: string;
  category?: string;
  latest_data_date: string | null;
  last_sync_at: string | null;
  record_count: number;
  lag_trading_days: number | null;
  level: 'green' | 'yellow' | 'red' | 'unknown';
  description?: string;
}

const statusTag = (s: 'ok' | 'fail' | 'unknown') => {
  if (s === 'ok') return <Tag color="green">正常</Tag>;
  if (s === 'fail') return <Tag color="red">失败</Tag>;
  return <Tag>未知</Tag>;
};

const formatUptime = (sec: number) => {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}天 ${hours}小时`;
  if (hours > 0) return `${hours}小时 ${minutes}分钟`;
  return `${minutes}分钟`;
};

const HealthMonitor: React.FC = () => {
  const [health, setHealth] = useState<HealthDetail | null>(null);
  const [dataHealth, setDataHealth] = useState<DataHealth[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // /health/detail 是无认证、不在 /api 前缀下的。axios baseURL 设的是 /api，
      // 用相对 url 会拼成 /api/health/detail (404 HTML)。手动算根 url。
      const apiBase = (api.defaults.baseURL || '').replace(/\/api\/?$/, '');
      const detailResp = await fetch(`${apiBase}/health/detail`);
      if (!detailResp.ok) throw new Error(`/health/detail HTTP ${detailResp.status}`);
      const detailText = await detailResp.text();
      let detail: HealthDetail;
      try {
        detail = JSON.parse(detailText);
      } catch (e) {
        throw new Error('/health/detail returned non-JSON (server may be misrouting)');
      }
      setHealth(detail);

      // 数据源健康
      const dh = await api.get('/data/health-status');
      const arr = (dh.data?.data?.cards || dh.data?.data?.records || dh.data?.data || []) as any[];
      setDataHealth(arr);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const tm = setInterval(() => void load(), 60_000); // 每 60 秒自动刷新
    return () => clearInterval(tm);
  }, [load]);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <HeartOutlined style={{ color: '#dc2626' }} />
            <span>系统健康总览</span>
            {health && <Tag color="blue">运行 {formatUptime(health.uptime_seconds)}</Tag>}
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
            刷新
          </Button>
        }
      >
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}
        {loading && !health ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : health ? (
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic
                  title={
                    <Space size={4}>
                      <DatabaseOutlined />
                      <span>PostgreSQL</span>
                    </Space>
                  }
                  valueRender={() => statusTag(health.db)}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic
                  title={
                    <Space size={4}>
                      <CloudOutlined />
                      <span>Redis</span>
                    </Space>
                  }
                  valueRender={() => statusTag(health.redis)}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic
                  title={
                    <Space size={4}>
                      <ApiOutlined />
                      <span>TradingAgents</span>
                    </Space>
                  }
                  valueRender={() => statusTag(health.tradingAgents)}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic
                  title={
                    <Space size={4}>
                      <ApiOutlined />
                      <span>AKShare</span>
                    </Space>
                  }
                  valueRender={() => statusTag(health.akshare)}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic
                  title={
                    <Space size={4}>
                      <ApiOutlined />
                      <span>飞书 Webhook</span>
                    </Space>
                  }
                  valueRender={() => statusTag(health.feishu)}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={4}>
              <Card size="small">
                <Statistic
                  title="正常运行时间"
                  value={formatUptime(health.uptime_seconds)}
                  valueStyle={{ fontSize: 16 }}
                />
              </Card>
            </Col>
          </Row>
        ) : (
          <Empty />
        )}

        {health && (
          <Descriptions size="small" column={2} style={{ marginTop: 16 }} bordered>
            {Object.entries(health)
              .filter(
                ([k]) =>
                  !['db', 'redis', 'tradingAgents', 'akshare', 'feishu', 'uptime_seconds'].includes(
                    k
                  )
              )
              .map(([k, v]) => (
                <Descriptions.Item key={k} label={k}>
                  {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                </Descriptions.Item>
              ))}
          </Descriptions>
        )}
      </Card>

      <Card title="数据源健康状态">
        {dataHealth.length === 0 ? (
          <Empty description="暂无数据源健康记录" />
        ) : (
          <Row gutter={[12, 12]}>
            {[...dataHealth]
              .sort((a, b) => {
                const order = { red: 0, yellow: 1, unknown: 2, green: 3 };
                return (order[a.level] ?? 9) - (order[b.level] ?? 9);
              })
              .map(d => (
                <Col xs={12} sm={8} md={6} key={d.key}>
                  <Card
                    size="small"
                    title={<span style={{ fontSize: 13 }}>{d.display_name}</span>}
                    extra={
                      d.level === 'green' ? (
                        <Tag color="green">正常</Tag>
                      ) : d.level === 'yellow' ? (
                        <Tag color="orange">滞后</Tag>
                      ) : d.level === 'red' ? (
                        <Tag color="red">严重</Tag>
                      ) : (
                        <Tag>未知</Tag>
                      )
                    }
                  >
                    <Statistic
                      title="最新数据日"
                      value={d.latest_data_date || '—'}
                      valueStyle={{ fontSize: 13 }}
                    />
                    <div style={{ marginTop: 6 }}>
                      <Space size={4}>
                        <span style={{ fontSize: 12 }}>滞后</span>
                        <Tag
                          color={
                            d.lag_trading_days != null && d.lag_trading_days > 3
                              ? 'red'
                              : d.lag_trading_days != null && d.lag_trading_days > 0
                                ? 'orange'
                                : 'blue'
                          }
                          style={{ fontSize: 11 }}
                        >
                          {d.lag_trading_days != null ? `${d.lag_trading_days} 个交易日` : '—'}
                        </Tag>
                      </Space>
                    </div>
                    <div style={{ marginTop: 4, fontSize: 11, color: '#999' }}>
                      行数：{d.record_count.toLocaleString()}
                    </div>
                  </Card>
                </Col>
              ))}
          </Row>
        )}
      </Card>
    </Space>
  );
};

export default HealthMonitor;
