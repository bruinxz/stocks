import React, { useState, useEffect } from 'react';
import { Card, Typography, List, Tag, Button, Empty, message } from 'antd';
import { AlertOutlined, CheckOutlined } from '@ant-design/icons';
import api from '../services/api';

const { Title, Text } = Typography;

interface RiskAlert {
  id: number;
  symbol: string;
  name: string;
  level: string;
  message: string;
  isRead: boolean;
  createdAt: string;
}

const RiskAlerts: React.FC = () => {
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const response = await api.get('/risk-alerts');
      if (response.data.success) {
        setAlerts(response.data.data);
      }
    } catch (error) {
      console.error('Failed to fetch risk alerts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
  }, []);

  const handleMarkAsRead = async (id: number) => {
    try {
      const response = await api.put(`/risk-alerts/${id}/read`);
      if (response.data.success) {
        setAlerts(prev =>
          prev.map(alert => (alert.id === id ? { ...alert, isRead: true } : alert))
        );
        message.success('已标记为已读');
      }
    } catch (error) {
      message.error('操作失败');
    }
  };

  const getLevelColor = (level: string) => {
    switch (level.toUpperCase()) {
      case 'HIGH':
        return 'red';
      case 'MEDIUM':
        return 'orange';
      case 'LOW':
        return 'blue';
      default:
        return 'default';
    }
  };

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">风控告警</h1>
          <p className="page-subtitle-modern">
            实时监控自选股与模拟盘，当出现卖出信号或跌破支撑时触发告警
          </p>
        </div>
      </div>

      <Card className="modern-card" bordered={false}>
        {alerts.length > 0 ? (
          <List
            loading={loading}
            itemLayout="horizontal"
            dataSource={alerts}
            renderItem={item => (
              <List.Item
                style={{
                  opacity: item.isRead ? 0.6 : 1,
                  backgroundColor: item.isRead ? 'transparent' : '#fff1f0',
                  padding: '16px',
                  borderRadius: '8px',
                  marginBottom: '8px',
                }}
                actions={[
                  !item.isRead && (
                    <Button
                      type="link"
                      icon={<CheckOutlined />}
                      onClick={() => handleMarkAsRead(item.id)}
                    >
                      标为已读
                    </Button>
                  ),
                ]}
              >
                <List.Item.Meta
                  title={
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Text strong>
                        {item.name} ({item.symbol})
                      </Text>
                      <Tag color={getLevelColor(item.level)}>{item.level}</Tag>
                      <Text type="secondary" style={{ fontSize: '12px', marginLeft: 'auto' }}>
                        {new Date(item.createdAt).toLocaleString()}
                      </Text>
                    </div>
                  }
                  description={
                    <Text
                      style={{
                        color: item.isRead ? '#888' : '#cf1322',
                        marginTop: '8px',
                        display: 'block',
                      }}
                    >
                      {item.message}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前没有任何风控告警，市场风平浪静！"
          />
        )}
      </Card>
    </div>
  );
};

export default RiskAlerts;
