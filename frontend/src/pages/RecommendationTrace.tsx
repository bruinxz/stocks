import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Progress,
  Row,
  Skeleton,
  Space,
  Steps,
  Tag,
  Typography,
  message,
  Statistic,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  FundProjectionScreenOutlined,
  LinkOutlined,
  NodeIndexOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  StockOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import api from '../services/api';
import TradePolicyExplainPanel from '../components/trading/TradePolicyExplainPanel';

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

const compactTime = (value?: string | Date | null) => {
  if (!value) return '--';
  return String(value).slice(0, 19).replace('T', ' ');
};

const RecommendationTrace: React.FC = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [trace, setTrace] = useState<any>(null);

  const fetchTrace = async () => {
    setLoading(true);
    try {
      const response = await api.get(`/signals/${id}/trace`);
      if (response.data.success) {
        setTrace(response.data.data || null);
      }
    } catch (error: any) {
      try {
        const traceResponse = await api.get(`/paper-trading/recommendation-outcomes/${id}/trace`);
        if (traceResponse.data.success) {
          setTrace(traceResponse.data.data || null);
          return;
        }
        const response = await api.get('/paper-trading/recommendation-outcomes', {
          params: { include_open: true, limit: 2000, lookback_days: 365 },
        });
        if (response.data.success) {
          const item = (response.data.data?.outcomes || []).find(
            (row: any) => String(row.id) === String(id) || String(row.signal_id) === String(id)
          );
          setTrace(item ? { outcome: item, steps: [], conclusion: '' } : null);
          if (!item) message.warning('未在最近闭环样本中找到该记录');
        }
      } catch (fallbackError: any) {
        message.error(error.response?.data?.message || '加载链路详情失败');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrace();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const outcome = trace?.outcome;
  const policyExplain = trace?.policy_explain || outcome?.policy_explain;
  const summary = trace?.summary || {};
  const keyEvidence = Array.isArray(trace?.key_evidence) ? trace.key_evidence : [];
  const decisionContext = trace?.decision_context || {};
  const consensus = outcome?.metadata?.consensus || outcome?.metadata?.signal_metadata || {};
  const env =
    outcome?.metadata?.market_environment || outcome?.metadata?.signal_metadata?.market_environment;
  const traceSteps = useMemo(() => {
    if (Array.isArray(trace?.steps) && trace.steps.length > 0) {
      return trace.steps.map((step: any) => ({
        title: step.title,
        status:
          step.status === 'finish' || step.status === 'process' || step.status === 'wait'
            ? step.status
            : 'wait',
        icon:
          step.key === 'signal' ? (
            <StockOutlined />
          ) : step.key === 'quant' || step.key === 'agent' ? (
            <RobotOutlined />
          ) : step.key === 'risk' ? (
            <SafetyCertificateOutlined />
          ) : step.key === 'entry' ? (
            <FundProjectionScreenOutlined />
          ) : (
            <CheckCircleOutlined />
          ),
        description: step.at
          ? `${compactTime(step.at).slice(0, 10)} · ${
              step.key === 'quant'
                ? `${(step.evidence || []).length} 条量化证据`
                : step.key === 'agent'
                ? `${(step.evidence || []).length} 条融合证据`
                : step.key === 'risk'
                ? `仓位 ${formatPercent(step.evidence?.position_pct)}`
                : step.key === 'entry'
                ? formatMoney(outcome?.entry_price)
                : step.key === 'exit'
                ? outcome?.trade_status === 'closed'
                  ? formatMoney(outcome?.exit_price)
                  : formatMoney(outcome?.latest_price)
                : sourceLabel(outcome?.source_type)
            }`
          : '等待证据',
      }));
    }

    return [
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
    ];
  }, [consensus.consensus_count, outcome, trace?.steps]);

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
                  {summary.conclusion ||
                    '从信号生成、策略/Agent 复核、风控放行、模拟买入到卖出闭环的完整证据链。'}
                </Paragraph>
                <Space wrap>
                  <Tag icon={<NodeIndexOutlined />} color="geekblue">
                    {sourceLabel(outcome.source_type)}
                  </Tag>
                  <Tag color={outcome.trade_status === 'closed' ? 'purple' : 'blue'}>
                    {outcome.trade_status === 'closed' ? '已平仓' : '持仓中'}
                  </Tag>
                  <Tag color="gold">评分 {summary.score ?? outcome.score ?? '--'}</Tag>
                  <Tag color="cyan">
                    信号价 {formatMoney(summary.current_price || outcome.entry_price)}
                  </Tag>
                  {summary.trace_id && <Tag color="default">{summary.trace_id}</Tag>}
                </Space>
              </div>
              <div className="trace-result-card">
                <span>当前结果</span>
                <strong style={{ color: pnlColor(outcome.total_pnl) }}>
                  {formatMoney(summary.total_pnl ?? outcome.total_pnl)}
                </strong>
                <em style={{ color: pnlColor(outcome.total_pnl_pct) }}>
                  收益 {formatPercent(summary.total_pnl_pct ?? outcome.total_pnl_pct)} · 超额{' '}
                  {formatPercent(summary.excess_return_pct ?? outcome.excess_return_pct)}
                </em>
                {summary.trace_url && (
                  <Button
                    size="small"
                    icon={<LinkOutlined />}
                    onClick={() => navigator.clipboard?.writeText(summary.trace_url)}
                  >
                    复制链路
                  </Button>
                )}
              </div>
            </div>

            <Card className="modern-card trace-verdict-card" variant="borderless">
              <Row gutter={[16, 16]} align="middle">
                <Col xs={24} lg={10}>
                  <div className="trace-verdict-title">
                    <TrophyOutlined />
                    <div>
                      <span>KEY VERDICT</span>
                      <strong>{summary.conclusion || trace?.conclusion || '链路结论生成中'}</strong>
                    </div>
                  </div>
                </Col>
                <Col xs={12} sm={6} lg={3}>
                  <Statistic
                    title="信号/买入价"
                    value={formatMoney(summary.entry_price || outcome.entry_price)}
                  />
                </Col>
                <Col xs={12} sm={6} lg={3}>
                  <Statistic
                    title="当前/卖出价"
                    value={formatMoney(
                      summary.exit_price ||
                        summary.latest_price ||
                        outcome.exit_price ||
                        outcome.latest_price
                    )}
                  />
                </Col>
                <Col xs={12} sm={6} lg={4}>
                  <Statistic
                    title="收益率"
                    value={Number(summary.total_pnl_pct ?? outcome.total_pnl_pct ?? 0)}
                    precision={2}
                    suffix="%"
                    valueStyle={{ color: pnlColor(summary.total_pnl_pct ?? outcome.total_pnl_pct) }}
                  />
                </Col>
                <Col xs={12} sm={6} lg={4}>
                  <Statistic
                    title="超额收益"
                    value={Number(summary.excess_return_pct ?? outcome.excess_return_pct ?? 0)}
                    precision={2}
                    suffix="%"
                    valueStyle={{
                      color: pnlColor(summary.excess_return_pct ?? outcome.excess_return_pct),
                    }}
                  />
                </Col>
              </Row>
            </Card>

            <Card className="modern-card trace-steps-card" variant="borderless">
              <Steps items={traceSteps} />
              {trace?.conclusion && (
                <Alert
                  showIcon
                  type="info"
                  style={{ marginTop: 16, borderRadius: 14 }}
                  message="链路结论"
                  description={trace.conclusion}
                />
              )}
            </Card>

            <TradePolicyExplainPanel
              policy={policyExplain}
              outcome={outcome}
              title="这笔推荐为什么被允许买入"
            />

            <Row gutter={[16, 16]}>
              <Col xs={24} xl={14}>
                <Card
                  className="modern-card trace-evidence-card"
                  variant="borderless"
                  title="关键证据，不看长报告也能判断"
                >
                  <div className="trace-evidence-grid">
                    {keyEvidence.length ? (
                      keyEvidence.map((item: any, index: number) => (
                        <div
                          className={`trace-evidence-item ${item.weight || 'medium'}`}
                          key={`${item.type || 'evidence'}-${index}`}
                        >
                          <span>{item.label}</span>
                          <strong>{item.value}</strong>
                          {item.detail && <em>{item.detail}</em>}
                        </div>
                      ))
                    ) : (
                      <Empty description="暂无关键证据摘要" />
                    )}
                  </div>
                </Card>
              </Col>
              <Col xs={24} xl={10}>
                <Card
                  className="modern-card trace-risk-card"
                  variant="borderless"
                  title="风控与链路完整度"
                >
                  <Space direction="vertical" size={14} style={{ width: '100%' }}>
                    <Alert
                      showIcon
                      type={summary.trade_status === 'closed' ? 'success' : 'warning'}
                      message={summary.current_risk || '暂无风控摘要'}
                      description={summary.sell_or_hold_reason || '继续观察持仓变化'}
                    />
                    <div className="trace-health-row">
                      <span>量化证据</span>
                      <Progress
                        percent={Math.min(
                          100,
                          (decisionContext.evidence_counts?.quant_signals || 0) * 25
                        )}
                        showInfo={false}
                      />
                      <strong>{decisionContext.evidence_counts?.quant_signals || 0} 条</strong>
                    </div>
                    <div className="trace-health-row">
                      <span>融合审计</span>
                      <Progress
                        percent={Math.min(
                          100,
                          (decisionContext.evidence_counts?.fusion_audits || 0) * 34
                        )}
                        showInfo={false}
                        strokeColor="#0fa6a6"
                      />
                      <strong>{decisionContext.evidence_counts?.fusion_audits || 0} 条</strong>
                    </div>
                    <div className="trace-chip-row">
                      <Tag color="blue">
                        {decisionContext.strategy?.strategy_label ||
                          summary.strategy_label ||
                          '参数未知'}
                      </Tag>
                      <Tag color="cyan">
                        {decisionContext.market_environment?.market_regime_label ||
                          summary.market_regime_label ||
                          '环境未知'}
                      </Tag>
                      <Tag color="gold">{summary.agent_session_label || '场次未知'}</Tag>
                    </div>
                  </Space>
                </Card>
              </Col>
            </Row>

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
                        summary.buy_reason ||
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
                          ? summary.sell_or_hold_reason ||
                            outcome.exit_reason_label ||
                            '已按模拟盘规则完成闭环'
                          : summary.sell_or_hold_reason ||
                            '仍在持仓，继续观察止损、止盈、卖出信号和最长持有期'
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

            <Row gutter={[16, 16]}>
              <Col xs={24} xl={12}>
                <Card className="modern-card" variant="borderless" title="量化 / Agent 证据">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {(trace?.quant_signals || []).slice(0, 4).map((item: any) => (
                      <Alert
                        key={`quant-${item.id}`}
                        type="info"
                        showIcon
                        message={`${item.strategy_key} · ${item.signal} · ${Number(
                          item.score || 0
                        ).toFixed(1)}分`}
                        description={item.reason || '暂无量化理由'}
                      />
                    ))}
                    {(trace?.fusion_audits || []).slice(0, 3).map((item: any) => (
                      <Alert
                        key={`fusion-${item.id}`}
                        type="success"
                        showIcon
                        message={`融合复核 · 最终 ${item.final_decision || '--'} · ${Number(
                          item.final_score || 0
                        ).toFixed(1)}分`}
                        description={item.rationale || '暂无融合理由'}
                      />
                    ))}
                    {!trace?.quant_signals?.length && !trace?.fusion_audits?.length && (
                      <Empty description="暂无可关联的量化/Agent 证据，可能来自早期历史信号" />
                    )}
                  </Space>
                </Card>
              </Col>
              <Col xs={24} xl={12}>
                <Card className="modern-card" variant="borderless" title="关联任务与交易记录">
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {(trace?.task_logs || []).slice(0, 5).map((item: any) => (
                      <div className="trace-log-row" key={`task-${item.id}`}>
                        <div>
                          <strong>{item.task_name}</strong>
                          <span>{compactTime(item.started_at)}</span>
                        </div>
                        <Tag color={item.status === 'COMPLETED' ? 'green' : 'gold'}>
                          {item.status}
                        </Tag>
                      </div>
                    ))}
                    {(trace?.trades || []).map((item: any) => (
                      <div className="trace-log-row" key={`trade-${item.id}`}>
                        <div>
                          <strong>
                            {item.direction === 'BUY' ? '模拟买入' : '模拟卖出'} · {item.quantity}股
                          </strong>
                          <span>
                            {formatMoney(item.execute_price)} · {formatMoney(item.amount)}
                          </span>
                        </div>
                        <Tag color={item.direction === 'BUY' ? 'volcano' : 'green'}>
                          {item.direction}
                        </Tag>
                      </div>
                    ))}
                    {!trace?.task_logs?.length && !trace?.trades?.length && (
                      <Empty description="暂无关联任务/交易记录" />
                    )}
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
