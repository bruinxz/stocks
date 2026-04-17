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
  const [ticker, setTicker] = useState<string>('');
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [events, setEvents] = useState<AIEvent[]>([]);
  const [decision, setDecision] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">AI 深度研报</h1>
          <p className="page-subtitle-modern">
            基于多智能体(TradingAgents)大模型框架的实时推演与决策建议
          </p>
        </div>
      </div>

      <Card className="modern-card" bordered={false}>
        <Space.Compact style={{ width: '100%', marginBottom: 24 }}>
          <Input
            size="large"
            placeholder="请输入股票代码 (例如: 600519 或 000001)"
            value={ticker}
            onChange={e => setTicker(e.target.value)}
            onPressEnter={handleAnalyze}
            disabled={analyzing}
            prefix={<SearchOutlined />}
            style={{ width: 'calc(100% - 120px)' }}
          />
          <Button
            type="primary"
            size="large"
            onClick={handleAnalyze}
            loading={analyzing}
            style={{ width: 120 }}
          >
            开始推演
          </Button>
        </Space.Compact>

        {events.length > 0 && (
          <div
            style={{
              background: '#f8fafc',
              padding: 24,
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              minHeight: 400,
              maxHeight: 600,
              overflowY: 'auto',
            }}
          >
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
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#94a3b8' }}>
            <RobotOutlined style={{ fontSize: 48, marginBottom: 16, opacity: 0.5 }} />
            <div>输入股票代码，体验多智能体深度博弈研报</div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default AIAdvisor;
