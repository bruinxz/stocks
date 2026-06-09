import React, { useCallback, useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Tag, Space, Spin, Alert, Button, Descriptions, Empty } from 'antd';
import { ReloadOutlined, HeartOutlined, DatabaseOutlined, ApiOutlined, CloudOutlined } from '@ant-design/icons';
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
  source: string;
  latest_date: string | null;
  rows_today: number;
  status: 'green' | 'yellow' | 'red';
  lag_days: number | null;
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
      // /health/detail 是无认证的，可以直接 fetch（绕开 api wrapper）
      const detailResp = await fetch(
        `${(api.defaults.baseURL || '').replace(/\/api$/, '')}/health/detail`
      );
      const detail = await detailResp.json();
      setHealth(detail);

      // 数据源健康
      const dh = await api.get('/data/health-status');
      const arr = (dh.data?.data?.records || dh.data?.data || []) as any[];
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
            <HeartOutlined style={{ color: '#cf1322' }} />
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
          <Descriptions
            size="small"
            column={2}
            style={{ marginTop: 16 }}
            bordered
          >
            {Object.entries(health)
              .filter(([k]) => !['db', 'redis', 'tradingAgents', 'akshare', 'feishu', 'uptime_seconds'].includes(k))
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
            {dataHealth.map((d) => (
              <Col xs={12} sm={8} md={6} key={d.source}>
                <Card
                  size="small"
                  title={d.source}
                  extra={
                    d.status === 'green' ? <Tag color="green">正常</Tag> :
                    d.status === 'yellow' ? <Tag color="orange">滞后</Tag> :
                    <Tag color="red">异常</Tag>
                  }
                >
                  <Statistic title="最新日期" value={d.latest_date || '—'} valueStyle={{ fontSize: 14 }} />
                  <div style={{ marginTop: 8 }}>
                    <Space>
                      <span>滞后</span>
                      <Tag color={d.lag_days && d.lag_days > 3 ? 'red' : 'blue'}>
                        {d.lag_days != null ? `${d.lag_days} 天` : '—'}
                      </Tag>
                    </Space>
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
