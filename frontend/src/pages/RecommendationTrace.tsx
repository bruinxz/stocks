import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Row,
  Skeleton,
  Space,
  Steps,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  FundProjectionScreenOutlined,
  NodeIndexOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  StockOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';

const { Paragraph } = Typography;

const formatMoney = (value?: number | string | null) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num === 0) return '--';
  return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatPercent = (value?: number | string | null) => `${Number(value || 0).toFixed(2)}%`;
const pnlColor = (value?: number | string | null) =>
  Number(value || 0) >= 0 ? '#b42318' : '#047857';

const sourceLabel = (value?: string) => {
  const labels: Record<string, string> = {
    quant_recommendation: '量化推荐',
    tradingagents: 'TradingAgents',
    daily_screener: 'AI每日优选',
    manual_analysis: '手动分析',
  };
  return labels[value || ''] || value || '未标注';
};

const RecommendationTrace: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<any>(null);

  const fetchTrace = async () => {
    setLoading(true);
    try {
      const response = await api.get('/paper-trading/recommendation-outcomes', {
        params: { include_open: true, limit: 2000, lookback_days: 365 },
      });
      if (response.data.success) {
        const item = (response.data.data?.outcomes || []).find(
          (row: any) => String(row.id) === String(id) || String(row.signal_id) === String(id)
        );
        setOutcome(item || null);
        if (!item) message.warning('未在最近闭环样本中找到该记录');
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '加载链路详情失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const consensus = outcome?.metadata?.consensus || outcome?.metadata?.signal_metadata || {};
  const env =
    outcome?.metadata?.market_environment || outcome?.metadata?.signal_metadata?.market_environment;
  const traceSteps = useMemo(
    () => [
      {
        title: '信号生成',
        status: 'finish' as const,
        icon: <StockOutlined />,
        description: `${outcome?.signal_date || '--'} · ${sourceLabel(outcome?.source_type)}`,
      },
      {
        title: '策略/Agent复核',
        status: outcome?.score ? ('finish' as const) : ('process' as const),
        icon: <RobotOutlined />,
        description: `评分 ${outcome?.score ?? '--'} · 共识 ${consensus.consensus_count || 1} 组`,
      },
      {
        title: '风控允许',
        status: outcome?.entry_price ? ('finish' as const) : ('wait' as const),
        icon: <SafetyCertificateOutlined />,
        description: `风险 ${outcome?.risk_level || '--'} · 仓位 ${formatPercent(
          outcome?.position_pct
        )}`,
      },
      {
        title: '模拟买入',
        status: outcome?.entry_date ? ('finish' as const) : ('wait' as const),
        icon: <FundProjectionScreenOutlined />,
        description: `${outcome?.entry_date || '--'} · ${formatMoney(outcome?.entry_price)}`,
      },
      {
        title: outcome?.trade_status === 'closed' ? '卖出闭环' : '持仓跟踪',
        status: outcome?.trade_status === 'closed' ? ('finish' as const) : ('process' as const),
        icon: <CheckCircleOutlined />,
        description:
          outcome?.trade_status === 'closed'
            ? `${outcome?.exit_date || '--'} · ${formatMoney(outcome?.exit_price)}`
            : `最新 ${formatMoney(outcome?.latest_price)} · 持有 ${outcome?.holding_days || 0} 天`,
      },
    ],
    [consensus.consensus_count, outcome]
  );

  return (
    <div className="trace-page fade-in-up">
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate(-1)}
        style={{ marginBottom: 16 }}
      >
        返回
      </Button>

      <Skeleton loading={loading} active paragraph={{ rows: 6 }}>
        {outcome ? (
          <>
            <div className="trace-hero">
              <div>
                <div className="trace-kicker">SIGNAL CAUSAL TRACE</div>
                <h1>
                  {outcome.name || outcome.symbol} <span>{outcome.symbol}</span>
                </h1>
                <Paragraph>
                  从信号生成、策略/Agent 复核、风控放行、模拟买入到卖出闭环的完整证据链。
                </Paragraph>
                <Space wrap>
                  <Tag icon={<NodeIndexOutlined />} color="geekblue">
                    {sourceLabel(outcome.source_type)}
                  </Tag>
                  <Tag color={outcome.trade_status === 'closed' ? 'purple' : 'blue'}>
                    {outcome.trade_status === 'closed' ? '已平仓' : '持仓中'}
                  </Tag>
                  <Tag color="gold">评分 {outcome.score ?? '--'}</Tag>
                </Space>
              </div>
              <div className="trace-result-card">
                <span>当前结果</span>
                <strong style={{ color: pnlColor(outcome.total_pnl) }}>
                  {formatMoney(outcome.total_pnl)}
                </strong>
                <em style={{ color: pnlColor(outcome.total_pnl_pct) }}>
                  收益 {formatPercent(outcome.total_pnl_pct)} · 超额{' '}
                  {formatPercent(outcome.excess_return_pct)}
                </em>
              </div>
            </div>

            <Card className="modern-card trace-steps-card" variant="borderless">
              <Steps items={traceSteps} />
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} xl={14}>
                <Card className="modern-card" variant="borderless" title="核心交易证据">
                  <Descriptions column={2} bordered size="small">
                    <Descriptions.Item label="信号日期">
                      {outcome.signal_date || '--'}
                    </Descriptions.Item>
                    <Descriptions.Item label="来源">
                      {sourceLabel(outcome.source_type)}
                    </Descriptions.Item>
                    <Descriptions.Item label="买入日期">
                      {outcome.entry_date || '--'}
                    </Descriptions.Item>
                    <Descriptions.Item label="买入价">
                      {formatMoney(outcome.entry_price)}
                    </Descriptions.Item>
                    <Descriptions.Item label="最新/卖出价">
                      {formatMoney(outcome.exit_price || outcome.latest_price)}
                    </Descriptions.Item>
                    <Descriptions.Item label="数量">{outcome.quantity || '--'}</Descriptions.Item>
                    <Descriptions.Item label="建议仓位">
                      {formatPercent(outcome.position_pct)}
                    </Descriptions.Item>
                    <Descriptions.Item label="退出原因">
                      {outcome.exit_reason_label || outcome.action_label || '--'}
                    </Descriptions.Item>
                    <Descriptions.Item label="基准">
                      {outcome.benchmark_name || outcome.benchmark_code || '--'}
                    </Descriptions.Item>
                    <Descriptions.Item label="基准收益">
                      {formatPercent(outcome.benchmark_return_pct)}
                    </Descriptions.Item>
                  </Descriptions>
                </Card>
              </Col>
              <Col xs={24} xl={10}>
                <Card className="modern-card" variant="borderless" title="为什么买 / 为什么卖">
                  <Space direction="vertical" size={12}>
                    <Alert
                      type="info"
                      showIcon
                      message="买入理由"
                      description={
                        consensus.recommendation_tier_label ||
                        outcome.action_label ||
                        `评分 ${outcome.score ?? '--'}，风险 ${outcome.risk_level || '--'}`
                      }
                    />
                    <Alert
                      type={outcome.trade_status === 'closed' ? 'success' : 'warning'}
                      showIcon
                      message={outcome.trade_status === 'closed' ? '卖出/闭环理由' : '当前跟踪重点'}
                      description={
                        outcome.trade_status === 'closed'
                          ? outcome.exit_reason_label || '已按模拟盘规则完成闭环'
                          : '仍在持仓，继续观察止损、止盈、卖出信号和最长持有期'
                      }
                    />
                    <div className="trace-chip-row">
                      <Tag color="cyan">
                        {env?.market_regime_label || env?.market_regime || '市场环境未知'}
                      </Tag>
                      <Tag color="purple">共识 {consensus.consensus_count || 1} 组</Tag>
                      <Tag color="orange">
                        MFE {formatPercent(outcome.max_favorable_excursion_pct)}
                      </Tag>
                      <Tag color="green">
                        MAE {formatPercent(outcome.max_adverse_excursion_pct)}
                      </Tag>
                    </div>
                  </Space>
                </Card>
              </Col>
            </Row>
          </>
        ) : (
          <Card className="modern-card" variant="borderless">
            <Empty description="未找到该推荐链路，可能记录不在当前看板查询窗口内" />
          </Card>
        )}
      </Skeleton>
    </div>
  );
};

export default RecommendationTrace;
