import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  LockOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WalletOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import api from '../services/api';

const { Text } = Typography;
const CONFIRM_TEXT = 'CONFIRM_LIVE_ORDER';

interface LiveReadiness {
  safety: {
    mode: string;
    can_submit_orders: boolean;
    can_sync_account: boolean;
    global_kill_switch: boolean;
    broker_gateway: string;
    market_data_provider: string;
    confirm_text_required: string;
    blockers: string[];
    warnings: string[];
    default_risk_limits: Record<string, any>;
  };
  broker: {
    broker_key: string;
    broker_name: string;
    readonly_supported: boolean;
    trading_supported: boolean;
    notes: string[];
  };
  market_data: {
    provider_key: string;
    provider_name: string;
    licensed_for_external_use: boolean;
    notes: string[];
  };
  market_data_health: {
    status: string;
    status_label: string;
    sample_count: number;
    missing_count: number;
    stale_count: number;
    missing_ratio_pct: number;
    max_latency_seconds: number;
    licensed_for_external_use: boolean;
    conclusion: string;
    warnings: string[];
    items: Array<{
      symbol: string;
      name?: string;
      current_price?: number;
      status: string;
      latency_seconds?: number;
      source?: string;
    }>;
  };
  market_data_provider_comparison?: {
    active_provider_key: string;
    conclusion: string;
    providers: Array<{
      provider: {
        provider_key: string;
        provider_name: string;
        licensed_for_external_use: boolean;
      };
      status: string;
      status_label: string;
      sample_count: number;
      missing_count: number;
      stale_count: number;
      missing_ratio_pct: number;
      max_latency_seconds: number;
      conclusion: string;
    }>;
  };
  phases: Array<{ key: string; label: string; status: string; detail: string }>;
  conclusion: string;
}

interface LiveOverview {
  generated_at: string;
  readiness: LiveReadiness;
  account?: any;
  latest_snapshot?: any;
  positions: any[];
  order_drafts: any[];
  summary: {
    account_bound: boolean;
    total_asset: number;
    available_cash: number;
    market_value: number;
    exposure_pct: number;
    position_count: number;
    pending_draft_count: number;
    can_submit_orders: boolean;
    market_data_status: string;
    market_data_conclusion: string;
    mode_label: string;
    conclusion: string;
  };
}

const formatMoney = (value?: number | null) =>
  `¥${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
const statusColor: Record<string, string> = {
  ready: 'green',
  partial: 'gold',
  locked: 'default',
  blocked: 'red',
  restricted: 'orange',
};
const draftStatusColor: Record<string, string> = {
  pending: 'gold',
  preview: 'blue',
  blocked: 'red',
  approved: 'green',
  rejected: 'default',
  submitted: 'purple',
};
const marketHealthColor: Record<string, string> = {
  ok: 'green',
  degraded: 'gold',
  risk: 'red',
  empty: 'default',
};

const LiveTrading: React.FC = () => {
  const [overview, setOverview] = useState<LiveOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [isDraftModalOpen, setIsDraftModalOpen] = useState(false);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<any>(null);
  const [confirmText, setConfirmText] = useState('');
  const [draftForm] = Form.useForm();

  const fetchOverview = async (silent = false) => {
    setLoading(true);
    try {
      const response = await api.get('/live-trading/overview');
      setOverview(response.data.data);
      if (!silent) message.success('实盘能力状态已刷新');
    } catch (error: any) {
      message.error(error.response?.data?.message || '获取实盘总览失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOverview(true);
  }, []);

  const safety = overview?.readiness?.safety;
  const marketHealth = overview?.readiness?.market_data_health;
  const providerComparison = overview?.readiness?.market_data_provider_comparison;
  const canSubmit = Boolean(safety?.can_submit_orders);
  const blockers = safety?.blockers || [];
  const modeTag = canSubmit ? '受限可提交' : safety?.mode === 'read_only' ? '只读观察' : '安全禁用';

  const createDraft = async () => {
    try {
      const values = await draftForm.validateFields();
      setDraftLoading(true);
      const response = await api.post('/live-trading/order-drafts', values);
      message.success(response.data.message || '订单草稿已创建');
      setIsDraftModalOpen(false);
      draftForm.resetFields();
      await fetchOverview(true);
    } catch (error: any) {
      if (error?.errorFields) return;
      message.error(error.response?.data?.message || '创建订单草稿失败');
    } finally {
      setDraftLoading(false);
    }
  };

  const rejectDraft = async (draft: any) => {
    setDraftLoading(true);
    try {
      await api.post(`/live-trading/order-drafts/${draft.id}/reject`, { reason: '用户在页面拒绝' });
      message.success('已拒绝订单草稿');
      await fetchOverview(true);
    } catch (error: any) {
      message.error(error.response?.data?.message || '拒绝订单草稿失败');
    } finally {
      setDraftLoading(false);
    }
  };

  const openConfirm = (draft: any) => {
    setSelectedDraft(draft);
    setConfirmText('');
    setIsConfirmModalOpen(true);
  };

  const approveDraft = async () => {
    if (!selectedDraft) return;
    if (confirmText.trim() !== (selectedDraft.confirm_text_required || CONFIRM_TEXT)) {
      message.warning(`请输入 ${selectedDraft.confirm_text_required || CONFIRM_TEXT} 后再确认`);
      return;
    }
    setDraftLoading(true);
    try {
      await api.post(`/live-trading/order-drafts/${selectedDraft.id}/approve`, {
        confirm_text: confirmText.trim(),
      });
      message.success('订单草稿已确认');
      setIsConfirmModalOpen(false);
      await fetchOverview(true);
    } catch (error: any) {
      message.error(error.response?.data?.message || '确认被安全边界阻断');
    } finally {
      setDraftLoading(false);
    }
  };

  const syncReadonly = async () => {
    setSyncLoading(true);
    try {
      await api.post('/live-trading/accounts/sync-readonly', {});
      message.success('只读账户同步完成');
      await fetchOverview(true);
    } catch (error: any) {
      message.warning(error.response?.data?.message || '当前未启用真实券商只读同步');
    } finally {
      setSyncLoading(false);
    }
  };

  const riskChecks = useMemo(() => selectedDraft?.risk_check?.checks || [], [selectedDraft]);

  const draftColumns = [
    {
      title: '标的',
      dataIndex: 'symbol',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name || record.symbol}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '方向',
      dataIndex: 'side',
      render: (value: string) => (
        <Tag color={value === 'BUY' ? 'red' : 'green'}>{value === 'BUY' ? '买入' : '卖出'}</Tag>
      ),
    },
    {
      title: '数量/限价',
      render: (_: any, record: any) => (
        <Space direction="vertical" size={0}>
          <Text>{Number(record.quantity || 0).toLocaleString()} 股</Text>
          <Text type="secondary">¥{Number(record.limit_price || 0).toFixed(2)}</Text>
        </Space>
      ),
    },
    {
      title: '预计金额',
      dataIndex: 'estimated_amount',
      render: (value: number) => formatMoney(value),
    },
    {
      title: '状态',
      dataIndex: 'status',
      render: (value: string, record: any) => (
        <Space direction="vertical" size={2}>
          <Tag color={draftStatusColor[value] || 'default'}>{value}</Tag>
          <Text type={record.risk_check?.allowed ? 'secondary' : 'danger'}>
            {record.risk_check?.allowed ? '风控通过' : '风控阻断'}
          </Text>
        </Space>
      ),
    },
    {
      title: '行情/复核',
      render: (_: any, record: any) => {
        const quote = record.quote_snapshot || {};
        const failedChecks = record.risk_check?.failed_checks || [];
        return (
          <Space direction="vertical" size={2}>
            <Tag color={quote.is_realtime ? 'green' : quote.current_price ? 'gold' : 'default'}>
              {quote.current_price ? `¥${Number(quote.current_price).toFixed(2)}` : '无行情'}
            </Tag>
            <Text type="secondary">
              {quote.latency_seconds !== undefined
                ? `延迟 ${Math.round(Number(quote.latency_seconds || 0))} 秒`
                : '等待行情 SLA'}
            </Text>
            {failedChecks.length > 0 && (
              <Text type="danger">
                {failedChecks
                  .slice(0, 2)
                  .map((item: any) => item.label)
                  .join('、')}
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      fixed: 'right' as const,
      render: (_: any, record: any) => (
        <Space>
          <Button
            size="small"
            disabled={
              !record.risk_check?.allowed || !['pending', 'preview'].includes(record.status)
            }
            onClick={() => openConfirm(record)}
          >
            确认
          </Button>
          <Button
            size="small"
            type="link"
            disabled={['rejected', 'submitted'].includes(record.status)}
            onClick={() => rejectDraft(record)}
          >
            拒绝
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="live-trading-page page-fade-in">
      <div className="page-hero live-trading-hero">
        <div>
          <Space wrap size={8}>
            <Tag
              color={canSubmit ? 'orange' : 'green'}
              icon={canSubmit ? <WarningOutlined /> : <LockOutlined />}
            >
              {modeTag}
            </Tag>
            <Tag color="blue">实盘辅助，不默认代操</Tag>
          </Space>
          <h1>实盘交易安全边界</h1>
          <p>
            这里是接入真实行情与券商账户前的安全控制台。系统可以生成订单草稿与风控解释，
            但默认不会提交真实委托；所有真实交易必须人工确认、强风控、可审计。
          </p>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => fetchOverview(false)} loading={loading}>
            刷新状态
          </Button>
          <Button icon={<WalletOutlined />} onClick={syncReadonly} loading={syncLoading}>
            只读同步
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={() => setIsDraftModalOpen(true)}
          >
            新建订单草稿
          </Button>
        </Space>
      </div>

      <Spin spinning={loading}>
        <Alert
          className="live-trading-boundary-alert"
          type={canSubmit ? 'warning' : 'success'}
          showIcon
          message={overview?.summary?.conclusion || '实盘提交能力默认关闭'}
          description={
            blockers.length
              ? `当前阻断项：${blockers.join('；')}`
              : '即使开关启用，也必须经过订单审批、强确认和风控审计。'
          }
        />

        <Row gutter={[16, 16]}>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="总资产"
                value={overview?.summary?.total_asset || 0}
                precision={2}
                prefix="¥"
              />
              <span>{overview?.summary?.account_bound ? '已绑定只读账户' : '未绑定真实账户'}</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="可用资金"
                value={overview?.summary?.available_cash || 0}
                precision={2}
                prefix="¥"
              />
              <span>来自券商只读快照</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic
                title="总仓位"
                value={overview?.summary?.exposure_pct || 0}
                precision={2}
                suffix="%"
              />
              <span>{overview?.summary?.position_count || 0} 个真实持仓</span>
            </Card>
          </Col>
          <Col xs={24} md={6}>
            <Card className="modern-card live-stat-card" variant="borderless">
              <Statistic title="行情 SLA" value={marketHealth?.status_label || '--'} />
              <span>
                {marketHealth
                  ? `样本 ${marketHealth.sample_count} · 延迟 ${marketHealth.max_latency_seconds}s`
                  : '等待行情检查'}
              </span>
            </Card>
          </Col>
        </Row>

        <Row gutter={[16, 16]} className="live-section-row">
          <Col xs={24} lg={10}>
            <Card className="modern-card" variant="borderless" title="实盘接入阶段">
              <Timeline
                items={(overview?.readiness?.phases || []).map(item => ({
                  color:
                    item.status === 'ready' ? 'green' : item.status === 'blocked' ? 'red' : 'blue',
                  children: (
                    <div className="live-phase-item">
                      <Space>
                        <Text strong>{item.label}</Text>
                        <Tag color={statusColor[item.status] || 'default'}>{item.status}</Tag>
                      </Space>
                      <p>{item.detail}</p>
                    </div>
                  ),
                }))}
              />
            </Card>
          </Col>
          <Col xs={24} lg={14}>
            <Card className="modern-card" variant="borderless" title="券商与行情网关">
              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <div className="live-gateway-card">
                    <SafetyCertificateOutlined />
                    <strong>
                      {overview?.readiness?.broker?.broker_name || '安全占位券商网关'}
                    </strong>
                    <span>{overview?.readiness?.broker?.broker_key || 'mock_guarded'}</span>
                    <p>{overview?.readiness?.broker?.notes?.[0] || '当前不会连接真实券商。'}</p>
                  </div>
                </Col>
                <Col xs={24} md={12}>
                  <div className="live-gateway-card">
                    <AuditOutlined />
                    <Space wrap size={6}>
                      <strong>
                        {overview?.readiness?.market_data?.provider_name || '本地行情缓存'}
                      </strong>
                      <Tag color={marketHealthColor[marketHealth?.status || 'empty'] || 'default'}>
                        {marketHealth?.status_label || '待检查'}
                      </Tag>
                    </Space>
                    <span>
                      {overview?.readiness?.market_data?.provider_key || 'database_realtime_quotes'}
                    </span>
                    <p>{marketHealth?.conclusion || '商业化前需替换授权实时行情。'}</p>
                  </div>
                </Col>
              </Row>
              {marketHealth && (
                <div className="live-market-health-strip">
                  <div>
                    <span>缺失</span>
                    <strong>{marketHealth.missing_count}</strong>
                  </div>
                  <div>
                    <span>延迟</span>
                    <strong>{marketHealth.stale_count}</strong>
                  </div>
                  <div>
                    <span>缺失率</span>
                    <strong>{Number(marketHealth.missing_ratio_pct || 0).toFixed(2)}%</strong>
                  </div>
                  <div>
                    <span>授权</span>
                    <strong>
                      {marketHealth.licensed_for_external_use ? '可外用' : '内部验证'}
                    </strong>
                  </div>
                </div>
              )}
              {providerComparison && (
                <div className="live-provider-compare">
                  <div className="live-provider-compare-head">
                    <Text strong>行情源对比</Text>
                    <Text type="secondary">{providerComparison.conclusion}</Text>
                  </div>
                  {(providerComparison.providers || []).map(provider => (
                    <div
                      className={`live-provider-row ${
                        provider.provider.provider_key === providerComparison.active_provider_key
                          ? 'active'
                          : ''
                      }`}
                      key={provider.provider.provider_key}
                    >
                      <div>
                        <Text strong>{provider.provider.provider_name}</Text>
                        <span>{provider.provider.provider_key}</span>
                      </div>
                      <Tag color={marketHealthColor[provider.status] || 'default'}>
                        {provider.status_label}
                      </Tag>
                      <em>
                        样本 {provider.sample_count} · 缺失 {provider.missing_count} · 延迟{' '}
                        {provider.stale_count} · 最大 {provider.max_latency_seconds}s
                      </em>
                    </div>
                  ))}
                </div>
              )}
              <div className="live-risk-limit-grid">
                {Object.entries(safety?.default_risk_limits || {})
                  .slice(0, 8)
                  .map(([key, value]) => (
                    <div key={key}>
                      <span>{key}</span>
                      <strong>{String(value)}</strong>
                    </div>
                  ))}
              </div>
            </Card>
          </Col>
        </Row>

        <Card className="modern-card" variant="borderless" title="实盘订单草稿">
          <Table
            columns={draftColumns}
            dataSource={overview?.order_drafts || []}
            rowKey="id"
            pagination={{ pageSize: 8 }}
            scroll={{ x: 'max-content' }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="暂无订单草稿。系统生成或手动创建后，会先停在这里等待确认。"
                />
              ),
            }}
          />
        </Card>
      </Spin>

      <Modal
        title="新建实盘订单草稿"
        open={isDraftModalOpen}
        onOk={createDraft}
        onCancel={() => setIsDraftModalOpen(false)}
        confirmLoading={draftLoading}
        okText="生成草稿"
        destroyOnHidden
      >
        <Alert
          type="info"
          showIcon
          message="只创建草稿，不会下单"
          description="订单会先经过基础风控。确认提交仍会被当前安全边界阻断，直到真实券商网关与实盘开关合规启用。"
        />
        <Form
          form={draftForm}
          layout="vertical"
          className="live-draft-form"
          initialValues={{ side: 'BUY', quantity: 100 }}
        >
          <Form.Item
            label="股票代码"
            name="symbol"
            rules={[{ required: true, message: '请输入股票代码' }]}
          >
            <Input placeholder="例如 600519.SH" />
          </Form.Item>
          <Form.Item label="方向" name="side" rules={[{ required: true }]}>
            <Radio.Group>
              <Radio.Button value="BUY">买入</Radio.Button>
              <Radio.Button value="SELL">卖出</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item
                label="数量"
                name="quantity"
                rules={[{ required: true, message: '请输入数量' }]}
              >
                <InputNumber min={100} step={100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="限价"
                name="limit_price"
                rules={[{ required: true, message: '请输入限价' }]}
              >
                <InputNumber min={0.01} step={0.01} precision={2} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="理由" name="rationale">
            <Input.TextArea rows={3} placeholder="简短说明，不建议放大段分析" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="强确认实盘订单草稿"
        open={isConfirmModalOpen}
        onOk={approveDraft}
        onCancel={() => setIsConfirmModalOpen(false)}
        confirmLoading={draftLoading}
        okText="确认提交"
        okButtonProps={{
          danger: true,
          disabled: confirmText.trim() !== (selectedDraft?.confirm_text_required || CONFIRM_TEXT),
        }}
        destroyOnHidden
      >
        {selectedDraft && (
          <div className="live-confirm-modal">
            <Alert
              type={canSubmit ? 'warning' : 'error'}
              showIcon
              message={
                canSubmit
                  ? '实盘开关已启用，确认后将进入券商提交链路'
                  : '当前安全边界会阻断真实提交'
              }
              description="该弹窗用于验证强确认链路；默认环境不会真实下单。"
            />
            <div className="live-confirm-summary">
              <strong>
                {selectedDraft.side === 'BUY' ? '买入' : '卖出'}{' '}
                {selectedDraft.name || selectedDraft.symbol}
              </strong>
              <span>
                {Number(selectedDraft.quantity || 0).toLocaleString()} 股 · ¥
                {Number(selectedDraft.limit_price || 0).toFixed(2)} ·{' '}
                {formatMoney(selectedDraft.estimated_amount)}
              </span>
            </div>
            <div className="live-risk-checks">
              {riskChecks.map((item: any) => (
                <div key={item.key} className={item.passed ? 'passed' : 'failed'}>
                  {item.passed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
                  <span>{item.label}</span>
                  <em>{item.message}</em>
                </div>
              ))}
            </div>
            <Form layout="vertical">
              <Form.Item
                label={`请输入 ${selectedDraft.confirm_text_required || CONFIRM_TEXT}`}
                required
              >
                <Input
                  value={confirmText}
                  onChange={event => setConfirmText(event.target.value)}
                  placeholder={selectedDraft.confirm_text_required || CONFIRM_TEXT}
                />
              </Form.Item>
            </Form>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default LiveTrading;
