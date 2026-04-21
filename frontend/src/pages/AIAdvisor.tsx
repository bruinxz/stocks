import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Input,
  Button,
  Typography,
  Space,
  Tag,
  Divider,
  Spin,
  Timeline,
  message,
  Empty,
  Row,
  Col,
} from 'antd';
import {
  RobotOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  CloseCircleOutlined,
} from '@ant-design/icons';
import api, { API_BASE_URL } from '../services/api';

const { Title, Text, Paragraph } = Typography;

interface AIEvent {
  type: string;
  message?: string;
  sender?: string;
  content?: string;
  decision?: string;
  analyst?: string;
}

const AIAdvisor: React.FC = () => {
  // 从 localStorage 恢复初始状态
  const [ticker, setTicker] = useState<string>(() => {
    return localStorage.getItem('aiAdvisor_ticker') || '';
  });
  const [analyzing, setAnalyzing] = useState<boolean>(() => {
    return localStorage.getItem('aiAdvisor_analyzing') === 'true';
  });
  const [events, setEvents] = useState<AIEvent[]>(() => {
    const savedEvents = localStorage.getItem('aiAdvisor_events');
    return savedEvents ? JSON.parse(savedEvents) : [];
  });
  const [decision, setDecision] = useState<string | null>(() => {
    return localStorage.getItem('aiAdvisor_decision') || null;
  });

  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // 状态发生变化时，保存到 localStorage
  useEffect(() => {
    localStorage.setItem('aiAdvisor_ticker', ticker);
  }, [ticker]);

  useEffect(() => {
    localStorage.setItem('aiAdvisor_analyzing', String(analyzing));
  }, [analyzing]);

  useEffect(() => {
    localStorage.setItem('aiAdvisor_events', JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    if (decision) {
      localStorage.setItem('aiAdvisor_decision', decision);
    } else {
      localStorage.removeItem('aiAdvisor_decision');
    }
  }, [decision]);

  // 如果刷新页面时状态是 analyzing，强制重置，因为 EventSource 无法跨页面保存
  useEffect(() => {
    if (analyzing) {
      setAnalyzing(false);
      localStorage.setItem('aiAdvisor_analyzing', 'false');
    }
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [events]);

  const handleAnalyze = () => {
    if (!ticker.trim()) {
      message.warning('请输入股票代码');
      return;
    }

    setEvents([]);
    setDecision(null);
    setAnalyzing(true);

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    // Connect to SSE proxy route
    const eventSource = new EventSource(`${API_BASE_URL}/ai/analyze/stream?ticker=${ticker}`);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = event => {
      try {
        const data = JSON.parse(event.data) as AIEvent;

        setEvents(prev => [...prev, data]);

        if (data.type === 'completed') {
          setDecision(data.decision || 'HOLD');
          setAnalyzing(false);
          eventSource.close();
        } else if (data.type === 'error') {
          setAnalyzing(false);
          eventSource.close();
          message.error(data.message || '分析过程中发生错误');
        }
      } catch (err) {
        console.error('Failed to parse SSE data', err);
      }
    };

    eventSource.onerror = err => {
      console.error('EventSource failed:', err);
      setAnalyzing(false);
      eventSource.close();
      message.error('与 AI 分析服务器连接中断');
    };
  };

  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  const getDecisionColor = (dec: string) => {
    if (dec.toUpperCase().includes('BUY')) return 'green';
    if (dec.toUpperCase().includes('SELL')) return 'red';
    return 'gold';
  };

  const handleClear = () => {
    setEvents([]);
    setDecision(null);
    setTicker('');
    localStorage.removeItem('aiAdvisor_events');
    localStorage.removeItem('aiAdvisor_decision');
    localStorage.removeItem('aiAdvisor_ticker');
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      setAnalyzing(false);
      localStorage.setItem('aiAdvisor_analyzing', 'false');
    }
  };

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
          <div>
            <h1 className="page-title-modern">AI 深度研报</h1>
            <p className="page-subtitle-modern">
              基于多智能体(TradingAgents)大模型框架的实时推演与决策建议
            </p>
          </div>
          {(events.length > 0 || ticker) && (
            <Button onClick={handleClear} disabled={analyzing}>
              清空历史记录
            </Button>
          )}
        </div>
      </div>

      <Card
        className="modern-card"
        bordered={false}
        style={{ minHeight: '600px', display: 'flex', flexDirection: 'column' }}
      >
        <Row justify="center" style={{ marginBottom: 32 }}>
          <Col xs={24} md={16} lg={12}>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                size="large"
                placeholder="请输入股票代码 (例如: 600519 或 000001)"
                value={ticker}
                onChange={e => setTicker(e.target.value)}
                onPressEnter={handleAnalyze}
                disabled={analyzing}
                prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
              />
              <Button
                type="primary"
                size="large"
                onClick={handleAnalyze}
                loading={analyzing}
                icon={<RobotOutlined />}
                style={{ width: 140 }}
              >
                开始推演
              </Button>
            </Space.Compact>
          </Col>
        </Row>

        {events.length > 0 && (
          <div
            style={{
              background: '#f8fafc',
              padding: '24px 32px',
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              flex: 1,
              overflowY: 'auto',
              boxShadow: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
            }}
          >
            <Title
              level={4}
              style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}
            >
              <RobotOutlined style={{ color: '#1677ff' }} />
              智能推演进程
            </Title>
            <Timeline>
              {events.map((evt, index) => {
                if (evt.type === 'system') {
                  return (
                    <Timeline.Item
                      key={index}
                      color="gray"
                      dot={<Spin indicator={<LoadingOutlined style={{ fontSize: 14 }} spin />} />}
                    >
                      <Text type="secondary">{evt.message}</Text>
                    </Timeline.Item>
                  );
                }

                if (evt.type === 'analyst_done') {
                  return (
                    <Timeline.Item key={index} color="blue">
                      <Text strong>{evt.analyst}</Text> <Text type="secondary">{evt.message}</Text>
                    </Timeline.Item>
                  );
                }

                if (evt.type === 'agent_message') {
                  return (
                    <Timeline.Item key={index} color="green">
                      <div style={{ marginBottom: 4 }}>
                        <Tag color="geekblue">{evt.sender}</Tag>
                      </div>
                      <div
                        style={{
                          background: '#fff',
                          padding: '12px 16px',
                          borderRadius: 8,
                          border: '1px solid #e2e8f0',
                          display: 'inline-block',
                          maxWidth: '90%',
                        }}
                      >
                        <Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                          {evt.content}
                        </Paragraph>
                      </div>
                    </Timeline.Item>
                  );
                }

                if (evt.type === 'completed') {
                  return (
                    <Timeline.Item
                      key={index}
                      color="green"
                      dot={<CheckCircleOutlined style={{ fontSize: 16 }} />}
                    >
                      <Text strong style={{ fontSize: 16 }}>
                        推演完成！
                      </Text>
                      <div style={{ marginTop: 8 }}>
                        <Text>AI 最终决策建议: </Text>
                        <Tag
                          color={getDecisionColor(evt.decision || '')}
                          style={{ fontSize: 16, padding: '4px 12px' }}
                        >
                          {evt.decision}
                        </Tag>
                      </div>
                    </Timeline.Item>
                  );
                }

                if (evt.type === 'error') {
                  return (
                    <Timeline.Item
                      key={index}
                      color="red"
                      dot={<CloseCircleOutlined style={{ fontSize: 16 }} />}
                    >
                      <Text type="danger">{evt.message}</Text>
                    </Timeline.Item>
                  );
                }

                return null;
              })}
            </Timeline>
            <div ref={messagesEndRef} />
          </div>
        )}

        {!analyzing && events.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Empty
              image={<RobotOutlined style={{ fontSize: 64, color: '#bfbfbf' }} />}
              description={
                <Space direction="vertical" size="small">
                  <Text type="secondary" style={{ fontSize: 16 }}>
                    输入股票代码，体验多智能体深度博弈研报
                  </Text>
                  <Text type="secondary" style={{ fontSize: 14 }}>
                    基于 TradingAgents 模型，提供全方位的决策分析
                  </Text>
                </Space>
              }
            />
          </div>
        )}
      </Card>
    </div>
  );
};

export default AIAdvisor;
