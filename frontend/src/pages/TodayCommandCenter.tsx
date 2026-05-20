import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  AlertOutlined,
  ArrowRightOutlined,
  CheckCircleOutlined,
  CompassOutlined,
  FundProjectionScreenOutlined,
  NodeIndexOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  RiseOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

const { Text, Paragraph } = Typography;

type Candidate = {
  key: string;
  symbol: string;
  name?: string;
  source: string;
  action: string;
  score?: number;
  confidence?: number;
  current_price?: number;
  suggested_position_pct?: number;
  reason?: string;
  risk?: string;
};

type Position = {
  symbol: string;
  name?: string;
  quantity?: number;
  current_price?: number;
  market_value?: number;
  unrealized_pnl?: number;
  unrealized_pnl_pct?: number;
  weight_pct?: number;
};

const formatMoney = (value?: number | string | null) => {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || num <= 0) return '--';
  return `¥${num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatSignedMoney = (value?: number | string | null) => {
  const num = Number(value || 0);
  const prefix = num > 0 ? '+¥' : num < 0 ? '-¥' : '¥';
  return `${prefix}${Math.abs(num).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const formatPercent = (value?: number | string | null) => `${Number(value || 0).toFixed(2)}%`;
const pnlColor = (value?: number | string | null) =>
  Number(value || 0) >= 0 ? '#b42318' : '#047857';
const clampPercent = (value?: number | string | null) =>
  Math.max(0, Math.min(100, Number(value || 0)));

const actionMeta = (action?: string) => {
  const normalized = String(action || '').toLowerCase();
  if (['buy', 'strong_buy', 'strong_recommend'].includes(normalized)) {
    return { label: '买入', color: 'volcano' };
  }
  if (['sell', 'reduce', 'exit'].includes(normalized)) {
    return { label: '卖出/减仓', color: 'green' };
  }
  if (['avoid', 'pause'].includes(normalized)) {
    return { label: '回避', color: 'default' };
  }
  return { label: '观察', color: 'gold' };
};

const buildPositionAdvice = (position: Position) => {
  const pnlPct = Number(position.unrealized_pnl_pct || 0);
  const weight = Number(position.weight_pct || 0);
  if (pnlPct <= -7)
    return { label: '优先风控', color: 'red', reason: '浮亏接近止损线，先检查卖出规则' };
  if (pnlPct >= 12) return { label: '保护利润', color: 'orange', reason: '浮盈较高，关注回撤止盈' };
  if (weight >= 12)
    return { label: '控制集中度', color: 'purple', reason: '单票仓位偏高，避免继续加仓' };
  return { label: '继续观察', color: 'blue', reason: '暂未触发强制退出条件' };
};

const TodayCommandCenter: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [commandData, setCommandData] = useState<any>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fetchCommandData = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/today/command-center', { params: { limit: 8 } });
      const data = response.data?.data;
      setCommandData(data);
      setErrors({});
      if (!silent) message.success('今日作战台已刷新');
    } catch (error: any) {
      const messageText = error.response?.data?.message || '加载今日作战台失败';
      setErrors({ command_center: messageText });
      message.error(messageText);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCommandData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const candidates = useMemo<Candidate[]>(() => commandData?.all_candidates || [], [commandData]);
  const buyCandidates =
    commandData?.buy_candidates || candidates.filter(item => item.action === 'buy');
  const watchCandidates =
    commandData?.watch_candidates || candidates.filter(item => item.action !== 'buy');
  const positions: Position[] = commandData?.positions || [];
  const sellSignals = commandData?.sell_candidates || [];
  const summary = commandData?.summary || {};
  const riskStatus = commandData?.risk_profile?.status || {};
  const readinessItems = commandData?.readiness || [];
  const latestFeishu = commandData?.latest_feishu;
  const discipline = commandData?.discipline || {};
  const cashPct = Number(summary.cash_pct || 0);
  const exposurePct = Number(summary.exposure_pct || 0);
  const conclusionTone = commandData?.conclusion?.tone || 'wait';
  const conclusionText =
    commandData?.conclusion?.headline ||
    (buyCandidates.length > 0
      ? `谨慎买入 ${buyCandidates.length} 只，观察 ${watchCandidates.length} 只，卖出/减仓 ${sellSignals.length} 只`
      : positions.length > 0
      ? `暂无强买入，持仓 ${positions.length} 只优先做风控复查`
      : `暂无持仓，等待今日量化/Agent 信号确认`);

  const candidateColumns = [
    {
      title: '动作',
      width: 98,
      render: (_: any, record: Candidate) => {
        const meta = actionMeta(record.action);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      title: '股票',
      render: (_: any, record: Candidate) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary" className="mono-text">
            {record.symbol} · {record.source}
          </Text>
        </Space>
      ),
    },
    {
      title: '当前价',
      width: 110,
      render: (_: any, record: Candidate) => formatMoney(record.current_price),
    },
    {
      title: '建议仓位',
      width: 120,
      render: (_: any, record: Candidate) =>
        `${Number(record.suggested_position_pct || 3).toFixed(1)}%`,
    },
    {
      title: '评分',
      width: 140,
      render: (_: any, record: Candidate) => (
        <Space direction="vertical" size={2} style={{ width: 104 }}>
          <Text strong>{Number(record.score || 0).toFixed(1)}</Text>
          <Progress
            percent={Math.round(Number(record.score || 0))}
            size="small"
            showInfo={false}
            strokeColor={Number(record.score || 0) >= 80 ? '#b42318' : '#c87511'}
          />
        </Space>
      ),
    },
    {
      title: '核心理由 / 风险',
      render: (_: any, record: Candidate) => (
        <Space direction="vertical" size={2}>
          <Text>{record.reason || '等待策略给出更明确理由'}</Text>
          <Text type="secondary">风险：{record.risk || '按默认仓位和止损纪律控制'}</Text>
        </Space>
      ),
    },
  ];

  const positionColumns = [
    {
      title: '持仓',
      render: (_: any, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary" className="mono-text">
            {record.symbol}
          </Text>
        </Space>
      ),
    },
    {
      title: '现价/市值',
      width: 150,
      render: (_: any, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text>{formatMoney(record.current_price)}</Text>
          <Text type="secondary">{formatMoney(record.market_value)}</Text>
        </Space>
      ),
    },
    {
      title: '仓位',
      width: 130,
      render: (_: any, record: Position) => (
        <Space direction="vertical" size={2} style={{ width: 96 }}>
          <Text>{formatPercent(record.weight_pct)}</Text>
          <Progress percent={clampPercent(record.weight_pct)} size="small" showInfo={false} />
        </Space>
      ),
    },
    {
      title: '浮盈亏',
      width: 150,
      render: (_: any, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text strong style={{ color: pnlColor(record.unrealized_pnl) }}>
            {formatSignedMoney(record.unrealized_pnl)}
          </Text>
          <Text style={{ color: pnlColor(record.unrealized_pnl_pct) }}>
            {formatPercent(record.unrealized_pnl_pct)}
          </Text>
        </Space>
      ),
    },
    {
      title: '今天处理',
      width: 150,
      render: (_: any, record: Position) => {
        const advice = buildPositionAdvice(record);
        return (
          <Space direction="vertical" size={2}>
            <Tag color={advice.color}>{advice.label}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {advice.reason}
            </Text>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="today-command-page fade-in-up">
      <div className={`today-command-hero ${conclusionTone}`}>
        <div className="today-command-orbit" />
        <div className="today-command-copy">
          <div className="today-command-kicker">TODAY COMMAND CENTER</div>
          <h1>今日作战台</h1>
          <Paragraph>
            只回答今天最关键的 5 个问题：买什么、为什么、当前价、买多少、持仓是否要卖。
            复杂图表和历史复盘全部下沉到二级页面。
          </Paragraph>
          <Space wrap>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading}
              onClick={() => fetchCommandData()}
            >
              刷新作战台
            </Button>
            <Button icon={<ThunderboltOutlined />} onClick={() => navigate('/quant/signals')}>
              查看今日机会
            </Button>
            <Button
              icon={<FundProjectionScreenOutlined />}
              onClick={() => navigate('/autonomous-trading/overview')}
            >
              进入模拟交易
            </Button>
          </Space>
        </div>
        <div className="today-command-verdict">
          <span>今日结论</span>
          <strong>{conclusionText}</strong>
          <em>
            核心原因：量化/Agent 候选 {candidates.length} 只，卖出/风控 {sellSignals.length} 只；
            现金水位 {cashPct.toFixed(1)}%，总仓位 {exposurePct.toFixed(1)}%。
          </em>
          <Alert
            showIcon
            type={cashPct < 10 || exposurePct > 85 ? 'warning' : 'success'}
            message={`风险：${
              riskStatus.label || (cashPct < 10 ? '现金偏低，禁止追高' : '按仓位纪律执行')
            }`}
          />
        </div>
      </div>

      <Row gutter={[16, 16]}>
        <Col xs={12} xl={6}>
          <Card
            className="modern-card today-metric-card"
            variant="borderless"
            loading={loading && !commandData}
          >
            <Statistic
              title="总资产"
              value={summary.total_value || 200000}
              precision={2}
              prefix="¥"
              valueStyle={{ color: 'var(--text-main)' }}
            />
            <Text style={{ color: pnlColor(summary.total_pnl) }}>
              {formatSignedMoney(summary.total_pnl)} / {formatPercent(summary.total_return_pct)}
            </Text>
          </Card>
        </Col>
        <Col xs={12} xl={6}>
          <Card
            className="modern-card today-metric-card"
            variant="borderless"
            loading={loading && !commandData}
          >
            <Statistic
              title="今日买入候选"
              value={buyCandidates.length}
              prefix={<ThunderboltOutlined />}
            />
            <Text type="secondary">观察 {watchCandidates.length} 只 · 只取高信任前排</Text>
          </Card>
        </Col>
        <Col xs={12} xl={6}>
          <Card
            className="modern-card today-metric-card"
            variant="borderless"
            loading={loading && !commandData}
          >
            <Statistic title="当前持仓" value={positions.length} prefix={<WalletOutlined />} />
            <Text type="secondary">
              现金 {cashPct.toFixed(1)}% · 仓位 {exposurePct.toFixed(1)}%
            </Text>
          </Card>
        </Col>
        <Col xs={12} xl={6}>
          <Card
            className="modern-card today-metric-card"
            variant="borderless"
            loading={loading && !commandData}
          >
            <Statistic
              title="卖出/风控信号"
              value={sellSignals.length}
              prefix={<AlertOutlined />}
            />
            <Text type="secondary">{riskStatus.label || '按默认风险纪律巡检'}</Text>
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card today-readiness-card"
        variant="borderless"
        title={
          <Space>
            <SafetyCertificateOutlined />
            <span>实盘前检查清单</span>
          </Space>
        }
        extra={
          <Button type="link" onClick={() => navigate('/tasks')}>
            查看调度任务 <ArrowRightOutlined />
          </Button>
        }
      >
        <div className="today-readiness-grid">
          {readinessItems.map((item: any) => {
            const tone = item.ok ? 'ok' : item.warn ? 'warn' : 'danger';
            return (
              <div className={`today-readiness-item ${tone}`} key={item.key}>
                <CheckCircleOutlined />
                <div>
                  <strong>{item.label}</strong>
                  <span>{item.detail}</span>
                </div>
                <Tag color={item.ok ? 'green' : item.warn ? 'gold' : 'red'}>
                  {item.ok ? '通过' : item.warn ? '注意' : '异常'}
                </Tag>
              </div>
            );
          })}
        </div>
        {latestFeishu && (
          <Alert
            showIcon
            type={latestFeishu.status === 'FAILED' ? 'warning' : 'success'}
            style={{ marginTop: 14, borderRadius: 14 }}
            message="最近荐股/飞书链路"
            description={`${latestFeishu.task_name || '荐股任务'} · ${
              latestFeishu.status || '--'
            } · ${latestFeishu.completed_at || latestFeishu.started_at || '等待任务日志'}`}
          />
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            className="modern-card today-discipline-card"
            variant="borderless"
            title={
              <Space>
                <RiseOutlined />
                <span>今日交易纪律</span>
              </Space>
            }
          >
            <div className="today-discipline-grid">
              <div className={`today-discipline-tile ${discipline.buy_allowed ? 'ok' : 'danger'}`}>
                <span>新增仓位</span>
                <strong>{discipline.buy_allowed ? '允许' : '暂停'}</strong>
                <em>{discipline.buy_reason || '等待纪律摘要'}</em>
              </div>
              <div className="today-discipline-tile">
                <span>最多新增</span>
                <strong>{discipline.suggested_new_position_count ?? 0} / {discipline.max_new_positions ?? 0} 只</strong>
                <em>建议先处理买入前排，不分散到太多标的。</em>
              </div>
              <div className="today-discipline-tile">
                <span>默认仓位</span>
                <strong>{Number(discipline.default_position_pct || 0).toFixed(1)}%</strong>
                <em>单票上限 {Number(discipline.single_position_cap_pct || 0).toFixed(1)}%</em>
              </div>
              <div className="today-discipline-tile">
                <span>现金/总仓位红线</span>
                <strong>{Number(discipline.min_cash_reserve_pct || 0).toFixed(0)}% / {Number(discipline.max_total_exposure_pct || 0).toFixed(0)}%</strong>
                <em>低于现金底线或超过总仓位上限时停止新增。</em>
              </div>
            </div>
            <Space wrap style={{ marginTop: 14 }}>
              <Tag color={discipline.buy_allowed ? 'green' : 'red'}>
                {discipline.level_label || '正常执行'}
              </Tag>
              <Tag color="blue">复查时间 {discipline.review_time || '14:35'}</Tag>
              <Tag color="gold">卖出优先 {discipline.sell_priority_count || 0} 只</Tag>
              {(discipline.forbidden_industries || []).slice(0, 2).map((item: string) => (
                <Tag color="orange" key={item}>
                  避开行业：{item}
                </Tag>
              ))}
              {(discipline.forbidden_symbols || []).slice(0, 2).map((item: string) => (
                <Tag color="red" key={item}>
                  重点风控：{item}
                </Tag>
              ))}
            </Space>
            {!!(discipline.actions || []).length && (
              <div className="today-discipline-actions">
                {(discipline.actions || []).slice(0, 4).map((item: string, index: number) => (
                  <Alert
                    key={`discipline-${index}`}
                    type={index === 0 ? 'warning' : 'info'}
                    showIcon
                    message={item}
                  />
                ))}
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card className="modern-card today-playbook-card" variant="borderless">
            <div className="today-playbook-title">
              <NodeIndexOutlined /> 今日执行清单
            </div>
            <div className="today-playbook-step">
              <CheckCircleOutlined />
              <div>
                <strong>先看纪律</strong>
                <span>{discipline.conclusion || '先确认今天允许新增几只、仓位上限是多少。'}</span>
              </div>
            </div>
            <div className="today-playbook-step">
              <RadarChartOutlined />
              <div>
                <strong>再处理候选</strong>
                <span>只处理“买入”和“优先风控”，观察项不追高、不摊薄。</span>
              </div>
            </div>
            <div className="today-playbook-step">
              <SafetyCertificateOutlined />
              <div>
                <strong>最后做复盘</strong>
                <span>所有推荐进入模拟盘后，到收益复盘中心看是否真的赚钱。</span>
              </div>
            </div>
            <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
              <Button block type="primary" onClick={() => navigate('/autonomous-trading/overview')}>
                打开模拟交易台
              </Button>
              <Button block onClick={() => navigate('/review/trades')}>
                查看收益复盘中心
              </Button>
              <Button block onClick={() => navigate('/tasks')}>
                检查开盘任务链路
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card today-decision-card"
        variant="borderless"
        title={
          <Space>
            <CompassOutlined />
            <span>今天买什么</span>
          </Space>
        }
        extra={
          <Button type="link" onClick={() => navigate('/quant/signals')}>
            进入完整机会池 <ArrowRightOutlined />
          </Button>
        }
      >
        <Skeleton loading={loading && candidates.length === 0} active>
          <Table
            columns={candidateColumns}
            dataSource={candidates}
            rowKey="key"
            pagination={false}
            scroll={{ x: 980 }}
            locale={{
              emptyText: <Empty description="暂无今日可执行候选，等待开盘任务或手动刷新" />,
            }}
          />
        </Skeleton>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={15}>
          <Card
            className="modern-card today-decision-card"
            variant="borderless"
            title={
              <Space>
                <SafetyCertificateOutlined />
                <span>当前持仓要不要卖</span>
              </Space>
            }
            extra={
              <Button type="link" onClick={() => navigate('/autonomous-trading/overview')}>
                查看交易驾驶舱 <ArrowRightOutlined />
              </Button>
            }
          >
            <Table
              columns={positionColumns}
              dataSource={positions}
              rowKey="symbol"
              loading={loading}
              pagination={false}
              scroll={{ x: 780 }}
              locale={{ emptyText: <Empty description="暂无持仓，先等待高置信推荐进入模拟盘" /> }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={9}>
          <Card className="modern-card today-decision-card" variant="borderless" title="卖出/减仓优先队列">
            <Space direction="vertical" style={{ width: '100%' }}>
              {sellSignals.length > 0 ? (
                sellSignals.slice(0, 6).map((item: any) => (
                  <div className="today-sell-row" key={item.symbol}>
                    <div>
                      <strong>{item.name || item.symbol}</strong>
                      <span>
                        {item.symbol} · 现价 {formatMoney(item.current_price)}
                      </span>
                    </div>
                    <div>
                      <Tag color={item.urgency === 'high' ? 'red' : 'orange'}>
                        {item.action_label || '卖出/减仓'}
                      </Tag>
                      <em>{item.reason}</em>
                    </div>
                  </div>
                ))
              ) : (
                <Empty description="暂无明确卖出/减仓优先项" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              )}
            </Space>
          </Card>
        </Col>
      </Row>

      {Object.keys(errors).length > 0 && (
        <Alert
          className="today-command-warning"
          type="warning"
          showIcon
          message="部分数据源暂不可用，页面已降级展示"
          description={Object.entries(errors)
            .map(([key, value]) => `${key}: ${value}`)
            .join('；')}
        />
      )}
    </div>
  );
};

export default TodayCommandCenter;
