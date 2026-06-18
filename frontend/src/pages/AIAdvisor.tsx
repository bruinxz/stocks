import React, { useState, useEffect, useRef } from 'react';
import {
  Card,
  Input,
  Button,
  Typography,
  Space,
  Tag,
  Spin,
  Timeline,
  message,
  Empty,
  Row,
  Col,
  Descriptions,
  Alert,
  Statistic,
  Divider,
} from 'antd';
import {
  RobotOutlined,
  SearchOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  CloseCircleOutlined,
  ApiOutlined,
  ReloadOutlined,
  DatabaseOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from '@ant-design/icons';
import api, { API_BASE_URL } from '../services/api';
import { useLocation } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;

interface AIEvent {
  type: string;
  message?: string;
  sender?: string;
  content?: string;
  decision?: string;
  analyst?: string;
}

interface ArchivedSignal {
  id: number;
  symbol: string;
  name?: string;
  signal_date: string;
  normalized_decision: string;
  confidence_score?: number;
  risk_level?: string;
  rationale?: string;
  current_price?: number;
  forward_returns?: any;
  metadata?: {
    structured_decision?: {
      rating?: string;
      summary?: string;
      thesis?: string;
      confidence_score?: number;
      risk_level?: string;
      action_tags?: string[];
      key_levels?: { stop_loss?: number; take_profit?: number; entry?: number };
    };
  };
}

interface TradingAgentsHealth {
  provider_label?: string;
  status: string;
  health_score?: number;
  base_url?: string;
  last_latency_ms?: number;
  last_checked_at?: string;
  last_error?: string;
  metadata?: Record<string, any>;
}

const parseDecision = (decisionStr: string) => {
  let rating = 'HOLD';
  let summary = '';
  let thesis = '';

  if (!decisionStr) return { rating, summary, thesis };

  // Try to parse structured markdown
  const ratingMatch = decisionStr.match(/### 1\. \*\*Rating\*\*:\s*([^\n]+)/i);
  if (ratingMatch) {
    rating = ratingMatch[1].trim();
  } else {
    // Fallback simple search
    if (decisionStr.toUpperCase().includes('BUY')) rating = 'BUY';
    else if (decisionStr.toUpperCase().includes('SELL')) rating = 'SELL';
  }

  const summaryMatch = decisionStr.match(
    /### 2\. \*\*Executive Summary\*\*\n([\s\S]*?)(?=### 3\.|\n\n###|$)/i
  );
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  const thesisMatch = decisionStr.match(/### 3\. \*\*Investment Thesis\*\*\n([\s\S]*)$/i);
  if (thesisMatch) {
    thesis = thesisMatch[1].trim();
  } else if (!summaryMatch && !ratingMatch) {
    // If it doesn't match the new structure at all, just dump it in thesis
    thesis = decisionStr;
  }

  return { rating, summary, thesis };
};

const AIAdvisor: React.FC = () => {
  const location = useLocation();

  // 从 URL / localStorage 恢复初始状态
  const [ticker, setTicker] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('ticker') || localStorage.getItem('aiAdvisor_ticker') || '';
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
  const [serviceHealth, setServiceHealth] = useState<TradingAgentsHealth | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [recentSignals, setRecentSignals] = useState<ArchivedSignal[]>([]);
  const [signalsLoading, setSignalsLoading] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchRecentSignals = async () => {
    setSignalsLoading(true);
    try {
      const response = await api.get('/ai/signals', {
        params: { source_type: 'tradingagents', limit: 5 },
      });
      if (response.data.success) {
        setRecentSignals(response.data.data?.signals || []);
      }
    } catch (error: any) {
      message.warning(error.response?.data?.message || '获取历史 AI 研报信号失败');
    } finally {
      setSignalsLoading(false);
    }
  };

  const fetchServiceHealth = async (refresh = false) => {
    setHealthLoading(true);
    try {
      const response = await api.get('/ai/health', { params: { refresh } });
      if (response.data.success) {
        setServiceHealth(response.data.data);
      }
    } catch (error: any) {
      message.warning(error.response?.data?.message || '获取 TradingAgents 状态失败');
    } finally {
      setHealthLoading(false);
    }
  };

  // 状态发生变化时，保存到 localStorage
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const nextTicker = params.get('ticker');
    if (nextTicker && nextTicker !== ticker) {
      setTicker(nextTicker);
    }
  }, [location.search, ticker]);

  useEffect(() => {
    localStorage.setItem('aiAdvisor_ticker', ticker);
  }, [ticker]);

  useEffect(() => {
    localStorage.setItem('aiAdvisor_analyzing', String(analyzing));
  }, [analyzing]);

  useEffect(() => {
    // Batch AA (2026-06-17, fe-1 fix): events 只持久化最近 50 条防 O(n²) +
    // localStorage 5MB 配额爆. 完整 SSE 历史可能数千条 image_url base64 + analysis
    // 文本, 每条 event 都 JSON.stringify(events) 让 setItem 频次 × payload 双重爆.
    try {
      const tail = events.slice(-50);
      localStorage.setItem('aiAdvisor_events', JSON.stringify(tail));
    } catch (err) {
      // localStorage 配额满 / private mode — 静默, 不阻塞 UI render
      console.warn('[AIAdvisor] persist events failed:', err);
    }
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
    if (localStorage.getItem('aiAdvisor_analyzing') === 'true') {
      setAnalyzing(false);
      localStorage.setItem('aiAdvisor_analyzing', 'false');
    }
  }, []);

  useEffect(() => {
    fetchServiceHealth(false);
    fetchRecentSignals();
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
          setTimeout(fetchRecentSignals, 1200);
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

  const getActionTagLabel = (tag: string) => {
    const map: Record<string, string> = {
      stop_loss: '止损',
      take_profit: '止盈',
      position_sizing: '仓位',
      avoid_entry: '避免介入',
      watchlist: '观察池',
    };
    return map[tag] || tag;
  };

  const renderForwardReturn = (signal: ArchivedSignal) => {
    const horizons = signal.forward_returns?.horizons || {};
    const completed = Object.entries<any>(horizons).find(
      ([, value]) => value.status === 'completed'
    );
    if (!completed) return <Text type="secondary">待验证</Text>;
    const [horizon, value] = completed;
    const returnPct = Number(value.return_pct || 0);
    return (
      <Tag color={returnPct >= 0 ? 'red' : 'green'}>
        {returnPct >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {horizon}{' '}
        {returnPct.toFixed(2)}%
      </Tag>
    );
  };

  const getDecisionColor = (dec: string) => {
    if (dec.toUpperCase().includes('BUY')) return 'green';
    if (dec.toUpperCase().includes('SELL')) return 'red';
    return 'gold';
  };

  const getStatusTagColor = (status?: string) => {
    if (status === 'healthy') return 'green';
    if (status === 'degraded' || status === 'unknown') return 'gold';
    return 'red';
  };

  const getHealthColor = (status?: string) => {
    if (status === 'healthy') return 'success';
    if (status === 'degraded' || status === 'unknown') return 'warning';
    return 'error';
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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            width: '100%',
          }}
        >
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
        variant="borderless"
        title={
          <Space>
            <DatabaseOutlined />
            <span>最近归档研报信号</span>
          </Space>
        }
        extra={
          <Button size="small" onClick={fetchRecentSignals} loading={signalsLoading}>
            刷新
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        {recentSignals.length > 0 ? (
          <Row gutter={[12, 12]}>
            {recentSignals.map(signal => {
              const structured = signal.metadata?.structured_decision || {};
              const actionTags = structured.action_tags || [];
              const keyLevels = structured.key_levels || {};
              return (
                <Col xs={24} md={12} xl={8} key={signal.id}>
                  <Card size="small" style={{ height: '100%', background: '#f8fafc' }}>
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Space wrap>
                        <Text strong>{signal.name || signal.symbol}</Text>
                        <Tag color={getDecisionColor(signal.normalized_decision)}>
                          {(
                            structured.rating ||
                            signal.normalized_decision ||
                            'UNKNOWN'
                          ).toUpperCase()}
                        </Tag>
                      </Space>
                      <Text type="secondary">
                        {signal.symbol} · {signal.signal_date} · 置信{' '}
                        {signal.confidence_score ?? '--'}
                      </Text>
                      <Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
                        {structured.summary || signal.rationale || '暂无结构化摘要'}
                      </Paragraph>
                      <Space wrap size={[4, 4]}>
                        {actionTags.slice(0, 4).map(tag => (
                          <Tag key={tag} color="blue">
                            {getActionTagLabel(tag)}
                          </Tag>
                        ))}
                        {keyLevels.stop_loss && <Tag color="red">止损 {keyLevels.stop_loss}</Tag>}
                        {keyLevels.take_profit && (
                          <Tag color="green">止盈 {keyLevels.take_profit}</Tag>
                        )}
                        {renderForwardReturn(signal)}
                      </Space>
                    </Space>
                  </Card>
                </Col>
              );
            })}
          </Row>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已归档 TradingAgents 信号" />
        )}
      </Card>

      <Card
        className="modern-card"
        variant="borderless"
        style={{ minHeight: '600px', display: 'flex', flexDirection: 'column' }}
      >
        <Alert
          type={getHealthColor(serviceHealth?.status) as any}
          showIcon
          icon={<ApiOutlined />}
          style={{ marginBottom: 24 }}
          message={
            <Space wrap>
              <Text strong>TradingAgents 服务</Text>
              <Tag color={getStatusTagColor(serviceHealth?.status)}>
                {(serviceHealth?.status || 'unknown').toUpperCase()}
              </Tag>
              <Text type="secondary">{serviceHealth?.base_url || '未探测'}</Text>
            </Space>
          }
          description={
            <Row gutter={[16, 8]} align="middle">
              <Col xs={12} md={6}>
                <Statistic
                  title="健康分"
                  value={serviceHealth?.health_score || 0}
                  precision={0}
                  suffix="/100"
                />
              </Col>
              <Col xs={12} md={6}>
                <Statistic
                  title="最近延迟"
                  value={serviceHealth?.last_latency_ms || 0}
                  suffix="ms"
                />
              </Col>
              <Col xs={24} md={8}>
                <Text type="secondary">
                  {serviceHealth?.last_error
                    ? `最近错误：${serviceHealth.last_error}`
                    : `能力：${
                        (serviceHealth?.metadata?.exposed_paths || []).slice(0, 3).join(' / ') ||
                        'analyze / stream / tasks'
                      }`}
                </Text>
              </Col>
              <Col xs={24} md={4} style={{ textAlign: 'right' }}>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  loading={healthLoading}
                  onClick={() => fetchServiceHealth(true)}
                >
                  重新探测
                </Button>
              </Col>
            </Row>
          }
        />

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
                  // 如果推演已经完成，就不再显示转圈了
                  const isDone = events.some(e => e.type === 'completed' || e.type === 'error');
                  return (
                    <Timeline.Item
                      key={index}
                      color={isDone ? 'blue' : 'gray'}
                      dot={
                        isDone ? (
                          <CheckCircleOutlined style={{ fontSize: 14 }} />
                        ) : (
                          <Spin indicator={<LoadingOutlined style={{ fontSize: 14 }} spin />} />
                        )
                      }
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
                  const { rating, summary, thesis } = parseDecision(evt.decision || '');

                  return (
                    <Timeline.Item
                      key={index}
                      color="green"
                      dot={<CheckCircleOutlined style={{ fontSize: 16 }} />}
                    >
                      <Text strong style={{ fontSize: 16 }}>
                        推演完成！
                      </Text>

                      <Card
                        size="small"
                        title={
                          <>
                            <RobotOutlined /> 最终决策报告
                          </>
                        }
                        style={{ marginTop: 12, borderColor: '#b7eb8f', background: '#f6ffed' }}
                        headStyle={{ background: '#e6f7ff', borderBottom: '1px solid #b7eb8f' }}
                      >
                        <Descriptions column={1} layout="vertical" size="small">
                          <Descriptions.Item label={<Text strong>投资评级 (Rating)</Text>}>
                            <Tag
                              color={getDecisionColor(rating)}
                              style={{ fontSize: 16, padding: '4px 12px', fontWeight: 'bold' }}
                            >
                              {rating.toUpperCase()}
                            </Tag>
                          </Descriptions.Item>

                          {summary && (
                            <Descriptions.Item
                              label={<Text strong>执行摘要 (Executive Summary)</Text>}
                            >
                              <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                                {summary}
                              </Paragraph>
                            </Descriptions.Item>
                          )}

                          {thesis && (
                            <Descriptions.Item
                              label={<Text strong>投资论点 (Investment Thesis)</Text>}
                            >
                              <div
                                style={{
                                  background: '#fff',
                                  padding: '12px',
                                  borderRadius: '6px',
                                  border: '1px dashed #d9d9d9',
                                }}
                              >
                                <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                                  {thesis.replace(/#### /g, '\n• ').replace(/- /g, '  - ')}
                                </Paragraph>
                              </div>
                            </Descriptions.Item>
                          )}
                        </Descriptions>
                        <Divider style={{ margin: '12px 0' }} />
                        <Text type="secondary">
                          分析完成后会自动归档为 AI 投研信号，并持续生成 1/3/5/10/20 日后验收益。
                        </Text>
                      </Card>
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
