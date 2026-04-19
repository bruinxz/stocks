import React, { useState, useEffect } from 'react';
import {
  Card,
  Typography,
  List,
  Tag,
  Button,
  Empty,
  message,
  Row,
  Col,
  Form,
  InputNumber,
  Switch,
  Divider,
} from 'antd';
import { AlertOutlined, CheckOutlined, SettingOutlined, SaveOutlined } from '@ant-design/icons';
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
  const [configForm] = Form.useForm();
  const [savingConfig, setSavingConfig] = useState(false);

  const fetchAlerts = async () => {
    setLoading(true);
    try {
      const response = await api.get('/risk-alerts');
      if (response.data.success) {
        setAlerts(response.data.data.alerts || []);
        configForm.setFieldsValue(response.data.data.riskConfig);
      }
    } catch (error) {
      console.error('Failed to fetch risk alerts');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveConfig = async (values: any) => {
    setSavingConfig(true);
    try {
      const response = await api.put('/risk-alerts/config', values);
      if (response.data.success) {
        message.success('风控配置保存成功');
      }
    } catch (error) {
      message.error('保存失败');
    } finally {
      setSavingConfig(false);
    }
  };

  useEffect(() => {
    fetchAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleMarkAllAsRead = async () => {
    try {
      const response = await api.put('/risk-alerts/read-all');
      if (response.data.success) {
        setAlerts(prev => prev.map(alert => ({ ...alert, isRead: true })));
        message.success('所有告警已标记为已读');
      }
    } catch (error) {
      message.error('一键标记已读失败');
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
        {alerts.some(a => !a.isRead) && (
          <Button type="primary" onClick={handleMarkAllAsRead}>
            一键已读
          </Button>
        )}
      </div>

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={16}>
          <Card className="modern-card" bordered={false} title="未读告警">
            <List
              loading={loading}
              itemLayout="horizontal"
              dataSource={alerts}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="当前没有任何风控告警，市场风平浪静！"
                  />
                ),
              }}
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
          </Card>
        </Col>

        <Col xs={24} lg={8}>
          <Card
            className="modern-card"
            bordered={false}
            title={
              <>
                <SettingOutlined /> 风控阈值配置
              </>
            }
          >
            <Form form={configForm} layout="vertical" onFinish={handleSaveConfig}>
              <Form.Item
                label="默认止损线 (%)"
                name="stopLossPercent"
                tooltip="持仓股票跌幅达到此数值时触发高危告警"
              >
                <InputNumber min={1} max={50} style={{ width: '100%' }} />
              </Form.Item>

              <Form.Item
                label="默认止盈线 (%)"
                name="takeProfitPercent"
                tooltip="持仓股票涨幅达到此数值时触发提醒"
              >
                <InputNumber min={1} max={200} style={{ width: '100%' }} />
              </Form.Item>

              <Divider style={{ margin: '12px 0' }} />

              <Form.Item label="成交量异常告警" name="enableVolumeAlert" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Form.Item label="技术面破位告警" name="enableTechnicalAlert" valuePropName="checked">
                <Switch />
              </Form.Item>

              <Button
                type="primary"
                htmlType="submit"
                icon={<SaveOutlined />}
                loading={savingConfig}
                block
              >
                保存配置
              </Button>
            </Form>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default RiskAlerts;
