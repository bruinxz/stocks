import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BranchesOutlined,
  ExperimentOutlined,
  FundProjectionScreenOutlined,
  LineChartOutlined,
  ReloadOutlined,
  SlidersOutlined,
  TrophyOutlined,
} from '@ant-design/icons';
import AutonomousOptimizationLab from './AutonomousOptimizationLab';
import RecommendationLoopPolicies from './RecommendationLoopPolicies';
import StrategyExperimentLab from './StrategyExperimentLab';
import QuantStrategyLibrary from './QuantStrategyLibrary';
import Strategy from './Strategy';
import api from '../services/api';

const { Text, Paragraph } = Typography;

const quoteFreshnessLabel: Record<string, string> = {
  fresh: '实时新鲜',
  same_day_snapshot: '当日快照可用',
  stale: '行情滞后',
  missing: '未落盘',
  unavailable: '不可用',
  unknown: '未知',
};

const formatQuoteFreshness = (value?: string | null) =>
  quoteFreshnessLabel[String(value || 'unknown')] || String(value || '未知');

const tabPathMap: Record<string, string> = {
  overview: '/strategy-research',
  optimization: '/strategy-research/optimization',
  versions: '/strategy-research/versions',
  experiments: '/strategy-research/experiments',
  weights: '/strategy-research/weights',
  eventResults: '/strategy-research/event-results',
};

const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;

const formatPercent = (value?: number | null) => `${Number(value || 0).toFixed(2)}%`;
const metricColor = (value?: number | null) => (Number(value || 0) >= 0 ? '#b42318' : '#047857');
const clampPercent = (value?: number | null) => Math.max(0, Math.min(100, Number(value || 0)));

const strategyToneTag = (tone?: string) => {
  if (tone === 'good') return <Tag color="red">可小幅放大</Tag>;
  if (tone === 'reduce') return <Tag color="green">降权优先</Tag>;
  return <Tag color="gold">样本观察</Tag>;
};

const actionColor = (value?: string) => {
  if (['increase', 'slight_increase', 'use'].includes(String(value || ''))) return 'red';
  if (['reduce'].includes(String(value || ''))) return 'orange';
  if (['pause'].includes(String(value || ''))) return 'default';
  return 'blue';
};

const StrategyResearchOverview: React.FC = () => {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [lifecycleRefreshing, setLifecycleRefreshing] = useState(false);
  const [lifecycleResult, setLifecycleResult] = useState<any>(null);
  const [data, setData] = useState<any>(null);
  const [preflight, setPreflight] = useState<any>(null);

  const fetchCenter = async (silent = false) => {
    setLoading(true);
    try {
      const [response, preflightResponse] = await Promise.all([
        api.get('/strategy-research/center', {
          params: { lookback_days: 180, limit: 2000 },
        }),
        api.get('/strategy-research/opening-preflight', {
          params: { factor_limit: 180 },
        }),
      ]);
      setData(response.data?.data);
      if (preflightResponse.data?.success) setPreflight(preflightResponse.data.data);
      if (!silent) message.success('策略研究中心已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取策略研究中心失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchCenter(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = data?.summary || {};
  const conclusion = data?.conclusion || {};
  const strategyRows = data?.strategy_rows || [];
  const championCandidates = data?.champion_candidates || [];
  const weakCandidates = data?.weak_candidates || [];
  const nextActions = data?.next_actions || [];
  const activeScanParams = data?.active_scan_params || {};
  const activeScanSelections = activeScanParams?.selections || [];
  const activeScanDiagnostics = activeScanParams?.diagnostics_by_strategy || {};
  const freshness = preflight?.checks?.data_freshness || {};
  const freshnessChecks = freshness?.checks || {};
  const preflightStatus = preflight?.status;
  const factorProvider = preflight?.checks?.factor_provider || {};
  const lifecycle = data?.param_dashboard?.lifecycle || {};
  const effectiveLifecycle = lifecycleResult?.lifecycle || lifecycle;
  const effectiveLifecycleSummary = effectiveLifecycle?.summary || {};
  const refreshLifecycle = async (dryRun = true) => {
    setLifecycleRefreshing(true);
    try {
      const response = await api.post('/quant/param-lifecycle/refresh', {
        dry_run: dryRun,
        limit: 5000,
      });
      if (response.data?.success) {
        setLifecycleResult(response.data.data);
        message.success(dryRun ? '参数生命周期预览已生成' : '参数生命周期调整已应用');
        if (!dryRun) await fetchCenter(true);
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '刷新参数生命周期失败');
    } finally {
      setLifecycleRefreshing(false);
    }
  };

  const strategyColumns = [
    {
      title: '策略',
      fixed: 'left' as const,
      width: 220,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Space wrap size={4}>
            <Text strong>{record.name || record.strategy_key}</Text>
            {!record.enabled && <Tag>停用</Tag>}
          </Space>
          <Text type="secondary" className="mono-text">
            {record.strategy_key} · {record.category_label}
          </Text>
        </Space>
      ),
    },
    {
      title: '权重动作',
      width: 130,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={actionColor(record.weight_action)}>{record.weight_action_label}</Tag>
          <Text type="secondary">{Number(record.weight || 1).toFixed(2)}x</Text>
        </Space>
      ),
    },
    {
      title: '质量分',
      width: 150,
      render: (_: any, record: any) => (
        <Progress
          percent={clampPercent(record.quality_score)}
          size="small"
          strokeColor={record.quality_score >= 70 ? '#b7791f' : '#2764b8'}
        />
      ),
    },
    {
      title: '预算',
      width: 130,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Text strong>{formatPercent(record.allocation_pct)}</Text>
          <Text type="secondary">{formatMoney(record.capital_amount)}</Text>
        </Space>
      ),
    },
    {
      title: '实验/参数',
      width: 180,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Text style={{ color: metricColor(record.best_excess_return_pct) }}>
            实验超额 {formatPercent(record.best_excess_return_pct)}
          </Text>
          <Text type="secondary">
            参数 {record.param_action_label} · 信心{' '}
            {Number(record.param_confidence || 0).toFixed(0)}
          </Text>
        </Space>
      ),
    },
    {
      title: '版本冠军',
      width: 180,
      render: (_: any, record: any) => (
        <Space direction="vertical" size={2}>
          <Text>{record.champion_version_key || '--'}</Text>
          <Text type="secondary">
            超额 {formatPercent(record.champion_avg_excess_return_pct)} · 样本{' '}
            {record.champion_completed_count || 0}
          </Text>
        </Space>
      ),
    },
    {
      title: '原因',
      dataIndex: 'reason',
      ellipsis: true,
    },
  ];

  return (
    <div className="strategy-overview-page fade-in-up">
      <div className="strategy-overview-hero">
        <div>
          <div className="strategy-overview-kicker">Strategy Research Command</div>
          <h1>策略研究总览</h1>
          <Paragraph>
            将策略库、收益权重、参数版本、策略实验和模拟盘闭环优化收敛到一页，直接回答：哪些策略该放大、哪些策略该降权、下一轮荐股该怎么跑。
          </Paragraph>
          <Space wrap>
            {strategyToneTag(conclusion.tone)}
            <Tag>
              启用 {summary.enabled_count || 0}/{summary.strategy_count || 0}
            </Tag>
            <Tag>参数冠军 {summary.param_champion_count || 0}</Tag>
            <Tag>闭环样本 {summary.closed_count || 0}</Tag>
          </Space>
        </div>
        <div className="strategy-overview-verdict">
          <span>策略结论</span>
          <strong>{conclusion.headline || '等待策略样本生成'}</strong>
          <em>{conclusion.reason || '暂无策略研究结论，请先运行量化跑分和模拟盘闭环。'}</em>
          {conclusion.next_action && <em>下一步：{conclusion.next_action}</em>}
        </div>
      </div>

      <Card className="modern-card strategy-toolbar-card" variant="borderless">
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => fetchCenter(false)} loading={loading}>
            刷新总览
          </Button>
          <Button type="primary" onClick={() => navigate('/strategy-research/weights')}>
            策略库与权重 <SlidersOutlined />
          </Button>
          <Button onClick={() => navigate('/strategy-research/versions')}>
            参数版本 <BranchesOutlined />
          </Button>
          <Button onClick={() => navigate('/strategy-research/experiments')}>
            策略实验 <ExperimentOutlined />
          </Button>
          <Button
            icon={<BranchesOutlined />}
            loading={lifecycleRefreshing}
            onClick={() => refreshLifecycle(true)}
          >
            预览生命周期
          </Button>
          <Button
            type="primary"
            ghost
            loading={lifecycleRefreshing}
            onClick={() => refreshLifecycle(false)}
          >
            应用参数调整
          </Button>
          <Text type="secondary">最后生成：{data?.generated_at || '--'}</Text>
        </Space>
      </Card>

      <Alert
        className="strategy-preflight-alert"
        showIcon
        type={preflightStatus === 'ready' ? 'success' : preflightStatus === 'risk' ? 'error' : 'warning'}
        message={preflight?.summary?.conclusion || '开盘前链路自检未生成'}
        description={
          <Space wrap size={6}>
            <Tag color={preflight?.checks?.quant_task?.ok ? 'green' : 'red'}>
              日扫任务 {preflight?.checks?.quant_task?.ok ? '已启用' : '异常'}
            </Tag>
            <Tag color={preflight?.checks?.factor_coverage?.ok ? 'green' : 'gold'}>
              因子覆盖{' '}
              {Number(preflight?.checks?.factor_coverage?.min_coverage_rate || 0).toFixed(1)}%
            </Tag>
            <Tag color={preflight?.checks?.active_scan_params?.ok ? 'green' : 'gold'}>
              参数版本 {preflight?.checks?.active_scan_params?.summary?.adopted_strategy_count || 0}
            </Tag>
            <Tag color={preflight?.checks?.realtime_quote?.ok ? 'green' : 'gold'}>
              行情 {formatQuoteFreshness(preflight?.checks?.realtime_quote?.freshness_status)}
            </Tag>
            <Tag color={preflight?.checks?.feishu?.ok ? 'green' : 'orange'}>
              飞书 {preflight?.checks?.feishu?.ok ? '可用' : '待检查'}
            </Tag>
            <Tag
              color={
                freshness?.status === 'ok' ? 'green' : freshness?.status === 'risk' ? 'red' : 'gold'
              }
            >
              闭环 {freshness?.summary?.risk_count || 0}/{freshness?.summary?.warn_count || 0}
            </Tag>
          </Space>
        }
        style={{ marginBottom: 18 }}
      />

      <Card
        className="modern-card strategy-freshness-card"
        variant="borderless"
        title="开盘数据闭环检查"
      >
        <div className="strategy-freshness-grid">
          {[
            ['实时行情', freshnessChecks.realtime_quotes],
            ['量化信号', freshnessChecks.quant_signals],
            ['推荐归档', freshnessChecks.archived_quant_recommendations],
            ['Agent融合', freshnessChecks.agent_fusion_audits],
            ['参数A/B', freshnessChecks.param_validations],
            ['模拟盘收益', freshnessChecks.paper_trade_outcomes],
          ].map(([label, item]: any) => (
            <div className={`strategy-freshness-item ${item?.status || 'unknown'}`} key={label}>
              <span>{label}</span>
              <strong>
                {item?.status === 'ok' ? '正常' : item?.status === 'risk' ? '风险' : '观察'}
              </strong>
              <em>{item?.conclusion || '等待检查结果'}</em>
            </div>
          ))}
        </div>
      </Card>

      <Row gutter={[18, 18]}>
        <Col xs={12} lg={6}>
          <Card className="modern-card strategy-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="启用策略"
              value={summary.enabled_count || 0}
              suffix={`/ ${summary.strategy_count || 0}`}
              prefix={<SlidersOutlined />}
            />
            <Text type="secondary">{summary.category_count || 0} 个策略类别</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="modern-card strategy-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="加权/降权"
              value={summary.boosted_count || 0}
              suffix={`/ ${summary.reduced_count || 0}`}
              prefix={<TrophyOutlined />}
            />
            <Text type="secondary">预算覆盖 {formatPercent(summary.total_allocation_pct)}</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="modern-card strategy-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="参数验证"
              value={summary.param_completed_count || 0}
              suffix={`/ ${summary.param_pending_count || 0}`}
              prefix={<BranchesOutlined />}
            />
            <Text type="secondary">版本 {summary.param_version_count || 0}</Text>
          </Card>
        </Col>
        <Col xs={12} lg={6}>
          <Card className="modern-card strategy-stat-card" variant="borderless" loading={loading}>
            <Statistic
              title="下一轮评分"
              value={summary.next_min_score || 72}
              prefix={<FundProjectionScreenOutlined />}
            />
            <Text type="secondary">
              {summary.next_style_label || '均衡'} · 仓位{' '}
              {formatPercent(summary.next_default_position_pct)}
            </Text>
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} lg={8}>
          <Card
            className="modern-card strategy-segment-card"
            variant="borderless"
            title="可晋级/放大片段"
          >
            {championCandidates.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {championCandidates.slice(0, 6).map((item: any) => (
                  <div
                    className="strategy-segment-row good"
                    key={`champion-${item.source}-${item.key}`}
                  >
                    <div>
                      <strong>{item.label}</strong>
                      <span>
                        {item.source} · {item.metric}
                      </span>
                    </div>
                    <em>{Number(item.score || 0).toFixed(1)}</em>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可晋级片段" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            className="modern-card strategy-segment-card"
            variant="borderless"
            title="待降权/冷却片段"
          >
            {weakCandidates.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {weakCandidates.slice(0, 6).map((item: any) => (
                  <div
                    className="strategy-segment-row weak"
                    key={`weak-${item.source}-${item.key}`}
                  >
                    <div>
                      <strong>{item.label}</strong>
                      <span>
                        {item.source} · {item.metric}
                      </span>
                    </div>
                    <em>{Number(item.score || 0).toFixed(1)}</em>
                  </div>
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无降权片段" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            className="modern-card strategy-segment-card"
            variant="borderless"
            title="下一步动作"
          >
            {nextActions.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }}>
                {nextActions.slice(0, 6).map((item: string, index: number) => (
                  <Alert
                    key={`strategy-action-${index}`}
                    type={index === 0 ? 'info' : 'success'}
                    showIcon
                    message={item}
                  />
                ))}
              </Space>
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无动作建议" />
            )}
          </Card>
        </Col>
      </Row>

      <Row gutter={[18, 18]}>
        <Col xs={24} lg={12}>
          <Card
            className="modern-card strategy-segment-card"
            variant="borderless"
            title="参数生命周期状态"
          >
            <div className="strategy-lifecycle-grid">
              <div className="strategy-lifecycle-tile promote">
                <span>待晋级</span>
                <strong>{effectiveLifecycleSummary?.promotion_count || 0}</strong>
                <em>{effectiveLifecycleSummary?.conclusion || '等待生命周期结论'}</em>
              </div>
              <div className="strategy-lifecycle-tile observe">
                <span>观察中</span>
                <strong>{effectiveLifecycleSummary?.observation_count || 0}</strong>
                <em>全局指标达标但环境或交易护栏仍需继续验证。</em>
              </div>
              <div className="strategy-lifecycle-tile degrade">
                <span>待降级</span>
                <strong>{effectiveLifecycleSummary?.degradation_count || 0}</strong>
                <em>近期表现转弱或环境桶失衡，建议先降权。</em>
              </div>
              <div className="strategy-lifecycle-tile rollback">
                <span>待回滚</span>
                <strong>{effectiveLifecycleSummary?.rollback_count || 0}</strong>
                <em>实验盘收益或均超额跌破回滚护栏。</em>
              </div>
            </div>
            {lifecycleResult && (
              <Alert
                className="strategy-lifecycle-result"
                showIcon
                type={lifecycleResult.dry_run ? 'info' : 'success'}
                message={
                  lifecycleResult.dry_run
                    ? '这是生命周期预览，尚未改动生产参数'
                    : `已应用 ${lifecycleResult.applied || 0} 条参数状态调整`
                }
                description={
                  lifecycleResult.dry_run
                    ? '确认晋级/降级/回滚数量符合预期后，可点击“应用参数调整”。'
                    : (lifecycleResult.updated || [])
                        .slice(0, 3)
                        .map((item: any) => `${item.strategy_key}: ${item.to_status}`)
                        .join('；') || '状态机已执行，无需额外操作。'
                }
              />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            className="modern-card strategy-segment-card"
            variant="borderless"
            title="真实因子源状态"
          >
            <Alert
              showIcon
              type={factorProvider?.ok ? 'success' : factorProvider?.enabled ? 'warning' : 'info'}
              message={factorProvider?.conclusion || '真实因子源烟测未生成'}
              description={
                <Space wrap size={6}>
                  <Tag color={factorProvider?.ok ? 'green' : 'gold'}>
                    Provider {factorProvider?.provider || '--'}
                  </Tag>
                  <Tag color={factorProvider?.checks?.daily_basic ? 'green' : 'default'}>
                    daily_basic
                  </Tag>
                  <Tag color={factorProvider?.checks?.moneyflow ? 'green' : 'default'}>
                    moneyflow
                  </Tag>
                  <Tag color={factorProvider?.checks?.fina_indicator ? 'green' : 'default'}>
                    fina_indicator
                  </Tag>
                </Space>
              }
              style={{ marginBottom: 12 }}
            />
            <Space direction="vertical" style={{ width: '100%' }}>
              <Text type="secondary">
                优先使用真实因子增强多因子/低波质量/量价策略；若真实源未就绪，系统会自动回退到
                local_derived，保证开盘链路不断。
              </Text>
              {(factorProvider?.errors || []).slice(0, 3).map((item: string, index: number) => (
                <Alert key={`factor-provider-${index}`} type="warning" showIcon message={item} />
              ))}
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        className="modern-card strategy-active-param-card"
        variant="borderless"
        title="下一次开盘扫描将采用的参数版本"
      >
        <Alert
          showIcon
          type="info"
          message={activeScanParams?.summary?.conclusion || '等待参数版本选择结果'}
          description="优先级：手工覆盖 > champion > active_candidate（网格/实验）> 默认参数。这里展示的是量化日扫实际会读取的参数版本，便于确认网格冠军是否已进入闭环。"
          style={{ marginBottom: 12 }}
        />
        {activeScanSelections.length > 0 ? (
          <div className="strategy-active-param-grid">
            {activeScanSelections.slice(0, 9).map((item: any) => (
              <div className="strategy-active-param-item" key={item.version_key}>
                <span>{item.strategy_name || item.strategy_key}</span>
                <strong>{item.version_key}</strong>
                <em>
                  {item.version_type} · {item.status} · 分 {Number(item.rank_score || 0).toFixed(1)}
                </em>
                <em>
                  候选 {activeScanDiagnostics[item.strategy_key]?.candidate_count || 0} 个 ·{' '}
                  {activeScanDiagnostics[item.strategy_key]?.candidates?.[1]?.reason ||
                    '暂无备选诊断'}
                </em>
              </div>
            ))}
          </div>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无参数版本选择结果" />
        )}
      </Card>

      <Card className="modern-card table-card-no-padding" variant="borderless" title="策略矩阵">
        <Table
          rowKey="strategy_key"
          columns={strategyColumns}
          dataSource={strategyRows}
          loading={loading}
          scroll={{ x: 1180 }}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: <Empty description="暂无策略数据" /> }}
        />
      </Card>
    </div>
  );
};

const StrategyResearchCenter: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const activeKey = useMemo(() => {
    if (location.pathname === '/strategy-research') return 'overview';
    if (location.pathname.includes('/strategy-research/versions')) return 'versions';
    if (location.pathname.includes('/strategy-research/experiments')) return 'experiments';
    if (location.pathname.includes('/strategy-research/weights')) return 'weights';
    if (location.pathname.includes('/strategy-research/event-results')) return 'eventResults';
    return 'optimization';
  }, [location.pathname]);

  return (
    <div className="strategy-research-center-page">
      <Tabs
        activeKey={activeKey}
        onChange={key => navigate(tabPathMap[key] || '/strategy-research/optimization')}
        className="strategy-research-tabs"
        items={[
          {
            key: 'overview',
            label: (
              <span>
                <TrophyOutlined /> 研究总览
              </span>
            ),
            children: <StrategyResearchOverview />,
          },
          {
            key: 'optimization',
            label: (
              <span>
                <FundProjectionScreenOutlined /> 优化建议
              </span>
            ),
            children: <AutonomousOptimizationLab />,
          },
          {
            key: 'versions',
            label: (
              <span>
                <BranchesOutlined /> 参数版本
              </span>
            ),
            children: <RecommendationLoopPolicies />,
          },
          {
            key: 'experiments',
            label: (
              <span>
                <ExperimentOutlined /> 策略实验
              </span>
            ),
            children: <StrategyExperimentLab />,
          },
          {
            key: 'weights',
            label: (
              <span>
                <SlidersOutlined /> 策略权重
              </span>
            ),
            children: <QuantStrategyLibrary />,
          },
          {
            key: 'eventResults',
            label: (
              <span>
                <LineChartOutlined /> 事件策略榜
              </span>
            ),
            children: <Strategy />,
          },
        ]}
      />
    </div>
  );
};

export default StrategyResearchCenter;
