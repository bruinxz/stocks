import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Space,
  Spin,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  UserOutlined,
  KeyOutlined,
  BellOutlined,
  TeamOutlined,
  EyeOutlined,
  SendOutlined,
  SaveOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import {
  loadNotificationChannels,
  updateNotificationChannels,
  previewDailyDigest,
  sendDailyDigestNow,
  NotificationChannelsConfig,
  SendDigestsResult,
  DigestForUserResult,
} from '../../services/settingsService';

const { Text, Paragraph, Link } = Typography;

/**
 * 账号设置 (Settings Workspace).
 *
 * 4 个 tab：
 *  - 个人资料 (placeholder — 待后续 story 合并个人中心)
 *  - API 密钥 (placeholder)
 *  - 通知设置 — US-063 飞书 / 邮件 / 微信通道配置 + 当日日报预览/手动推送
 *  - 用户管理 (placeholder)
 */
const DEFAULT_CONFIG: NotificationChannelsConfig = {
  feishu: {
    enabled: true,
    webhook_url: '',
    daily_digest: true,
    earnings_alert: true,
    risk_alert: true,
  },
  email: { enabled: false, address: '', weekly_review: false },
  wechat: { enabled: false, openid: '', daily_digest: false },
};

const SettingsWorkspace: React.FC = () => {
  const tabs: WorkspaceTab[] = [
    { key: 'profile', label: '个人资料', icon: <UserOutlined /> },
    { key: 'keys', label: 'API 密钥', icon: <KeyOutlined /> },
    { key: 'notifications', label: '通知设置', icon: <BellOutlined /> },
    { key: 'users', label: '用户管理', icon: <TeamOutlined /> },
  ];
  const [activeKey, setActiveKey] = useState('notifications');

  // --- 通知设置 state -----------------------------------------------------
  const [config, setConfig] = useState<NotificationChannelsConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewResult, setPreviewResult] = useState<DigestForUserResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadNotificationChannels();
      setConfig(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : '加载通知通道配置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // KPI 统计 — 渠道启用计数 + 日报开关状态
  const kpiSlot = useMemo(() => {
    const active = config
      ? [
          config.feishu.enabled ? '飞书' : null,
          config.email.enabled ? '邮件' : null,
          config.wechat.enabled ? '微信' : null,
        ].filter(Boolean).length
      : 0;
    return (
      <Space size={32}>
        <Statistic title="账号角色" value="—" />
        <Statistic title="启用通道" value={active} suffix="个" />
        <Statistic
          title="飞书日报"
          value={config?.feishu.daily_digest ? '开启' : '关闭'}
          valueStyle={{ color: config?.feishu.daily_digest ? '#3f8600' : '#999' }}
        />
      </Space>
    );
  }, [config]);

  const headerActions =
    activeKey === 'notifications' ? (
      <Space>
        <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
          刷新
        </Button>
        <Tag color="processing">US-063 通知通道</Tag>
      </Space>
    ) : (
      <Tag color="processing">待迁移现有个人中心 / 用户管理页</Tag>
    );

  // ---- 单字段更新 helpers ------------------------------------------------

  const patchConfig = useCallback(
    (next: NotificationChannelsConfig) => {
      setConfig(next);
    },
    []
  );

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const saved = await updateNotificationChannels({
        feishu: config.feishu,
        email: config.email,
        wechat: config.wechat,
      });
      setConfig(saved);
      message.success('通知通道配置已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const handlePreview = useCallback(async () => {
    setPreviewing(true);
    setPreviewResult(null);
    try {
      const result: SendDigestsResult = await previewDailyDigest();
      const own = result.per_user[0];
      if (own) {
        setPreviewResult(own);
        setPreviewOpen(true);
      } else {
        message.warning('未获取到预览结果（可能账号尚未启用日报或缺少模拟盘）');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '预览失败');
    } finally {
      setPreviewing(false);
    }
  }, []);

  const handleSendNow = useCallback(async () => {
    Modal.confirm({
      title: '立即推送当日日报到飞书？',
      content:
        '将按当前配置中的 webhook URL 真实推送一条 interactive card 到飞书群（不可撤销）。',
      okText: '推送',
      okButtonProps: { type: 'primary' },
      cancelText: '取消',
      onOk: async () => {
        setSending(true);
        try {
          const result = await sendDailyDigestNow();
          const own = result.per_user[0];
          if (own?.status === 'sent') {
            message.success('飞书日报已推送');
          } else if (own?.status === 'skipped') {
            message.warning(`已跳过：${own.skip_reason || '未知原因'}`);
          } else if (own?.status === 'partial') {
            message.warning(`已发送但飞书返回失败：${own.error || ''}`);
          } else if (own?.status === 'failed') {
            message.error(`推送失败：${own.error || '未知原因'}`);
          } else {
            message.info('已触发推送，但无返回详情');
          }
        } catch (err) {
          message.error(err instanceof Error ? err.message : '触发推送失败');
        } finally {
          setSending(false);
        }
      },
    });
  }, []);

  // ---- 渲染 --------------------------------------------------------------

  const renderNotifications = () => {
    if (loading && !config) {
      return (
        <Card>
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip="加载通知通道配置…" />
          </div>
        </Card>
      );
    }
    if (loadError) {
      return (
        <Alert
          type="error"
          message="加载失败"
          description={loadError}
          showIcon
          action={
            <Button size="small" onClick={() => void refresh()}>
              重试
            </Button>
          }
        />
      );
    }
    const cfg = config || DEFAULT_CONFIG;
    return (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="飞书机器人当日交易日报"
          description={
            <Space direction="vertical" size={4}>
              <Text>
                每个交易日 15:30 自动推送：账户当日盈亏 + 新增 BUY/SELL 前 3 笔 + 明日 3 策略候选 top 5。
              </Text>
              <Text type="secondary">
                飞书 webhook 创建方式：群设置 → 群机器人 → 添加机器人 → 自定义机器人 → 复制 webhook URL。留空则回退到环境变量
                <Text code>FEISHU_RECOMMENDATION_BOT_WEBHOOK</Text> /
                <Text code>FEISHU_BOT_WEBHOOK</Text>。
              </Text>
            </Space>
          }
        />

        <Card
          title="飞书（Feishu）"
          extra={
            <Switch
              checked={cfg.feishu.enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              onChange={(v) => patchConfig({ ...cfg, feishu: { ...cfg.feishu, enabled: v } })}
            />
          }
        >
          <Form layout="vertical" disabled={!cfg.feishu.enabled}>
            <Form.Item
              label="Webhook URL"
              extra="可在飞书群设置中创建自定义机器人后复制；留空则使用服务器环境变量。"
            >
              <Input
                placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
                value={cfg.feishu.webhook_url || ''}
                onChange={(e) =>
                  patchConfig({
                    ...cfg,
                    feishu: { ...cfg.feishu, webhook_url: e.target.value },
                  })
                }
                allowClear
              />
            </Form.Item>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="当日交易日报 (15:30)" tooltip="盘后收盘 30 分钟自动推送">
                  <Switch
                    checked={cfg.feishu.daily_digest}
                    onChange={(v) =>
                      patchConfig({
                        ...cfg,
                        feishu: { ...cfg.feishu, daily_digest: v },
                      })
                    }
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="业绩预告即时提醒" tooltip="US-064 后开放">
                  <Switch
                    checked={cfg.feishu.earnings_alert}
                    onChange={(v) =>
                      patchConfig({
                        ...cfg,
                        feishu: { ...cfg.feishu, earnings_alert: v },
                      })
                    }
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="高风险告警" tooltip="US-067 后开放">
                  <Switch
                    checked={cfg.feishu.risk_alert}
                    onChange={(v) =>
                      patchConfig({
                        ...cfg,
                        feishu: { ...cfg.feishu, risk_alert: v },
                      })
                    }
                  />
                </Form.Item>
              </Col>
            </Row>
            <Divider />
            <Space>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={saving}
                onClick={() => void handleSave()}
                disabled={false}
              >
                保存配置
              </Button>
              <Button
                icon={<EyeOutlined />}
                loading={previewing}
                onClick={() => void handlePreview()}
              >
                预览今日日报（dry-run）
              </Button>
              <Button
                icon={<SendOutlined />}
                loading={sending}
                onClick={handleSendNow}
                disabled={!cfg.feishu.enabled || !cfg.feishu.daily_digest}
              >
                立即推送一条日报
              </Button>
            </Space>
          </Form>
        </Card>

        <Card title="邮件（Email）" extra={<Tag color="default">US-065 周报启用后开放</Tag>}>
          <Form layout="vertical" disabled>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item label="启用">
                  <Switch checked={cfg.email.enabled} disabled />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="接收邮箱">
                  <Input placeholder="example@domain.com" value={cfg.email.address || ''} disabled />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="每周复盘报告">
                  <Switch checked={cfg.email.weekly_review} disabled />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>

        <Card title="微信公众号" extra={<Tag color="default">US-066 启用后开放</Tag>}>
          <Form layout="vertical" disabled>
            <Row gutter={16}>
              <Col span={6}>
                <Form.Item label="启用">
                  <Switch checked={cfg.wechat.enabled} disabled />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item label="OpenID（扫码绑定后自动填写）">
                  <Input value={cfg.wechat.openid || ''} disabled />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item label="每日日报">
                  <Switch checked={cfg.wechat.daily_digest} disabled />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </Space>
    );
  };

  const renderPlaceholder = () => (
    <Card>
      <Empty
        description={`Settings Workspace · ${activeKey} 占位 — 后续聚合个人中心 / 用户管理`}
      />
    </Card>
  );

  return (
    <WorkspaceLayout
      title="账号设置"
      subtitle="个人资料、API 密钥、通知、用户管理等设置入口。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      kpiSlot={kpiSlot}
      headerActions={headerActions}
    >
      {activeKey === 'notifications' ? renderNotifications() : renderPlaceholder()}
      <DigestPreviewModal
        open={previewOpen}
        result={previewResult}
        onClose={() => setPreviewOpen(false)}
      />
    </WorkspaceLayout>
  );
};

// ---------------------------------------------------------------------------
// 预览 Modal 子组件
// ---------------------------------------------------------------------------

interface DigestPreviewModalProps {
  open: boolean;
  result: DigestForUserResult | null;
  onClose: () => void;
}

const DigestPreviewModal: React.FC<DigestPreviewModalProps> = ({ open, result, onClose }) => {
  if (!result) return null;
  const payload = result.payload;
  const pnl = payload?.pnl;

  return (
    <Modal title={`今日日报预览（dry-run）`} open={open} onCancel={onClose} footer={null} width={720}>
      {result.status !== 'sent' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={result.skip_reason || result.error || '未生成 payload'}
        />
      )}
      {payload && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Card size="small">
            <Row gutter={16}>
              <Col span={6}>
                <Statistic
                  title="当日盈亏 (元)"
                  value={pnl?.pnl_today ?? 0}
                  precision={2}
                  valueStyle={{
                    color: (pnl?.pnl_today ?? 0) > 0 ? '#cf1322' : (pnl?.pnl_today ?? 0) < 0 ? '#3f8600' : '#999',
                  }}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="当日盈亏 (%)"
                  value={pnl?.pnl_today_pct ?? 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{
                    color:
                      (pnl?.pnl_today_pct ?? 0) > 0
                        ? '#cf1322'
                        : (pnl?.pnl_today_pct ?? 0) < 0
                        ? '#3f8600'
                        : '#999',
                  }}
                />
              </Col>
              <Col span={6}>
                <Statistic title="总资产 (元)" value={pnl?.total_value ?? 0} precision={2} />
              </Col>
              <Col span={6}>
                <Statistic title="持仓市值 (元)" value={pnl?.position_value ?? 0} precision={2} />
              </Col>
            </Row>
          </Card>

          <Card size="small" title={`今日新增买入 ${payload.trades_today_buy_count} 笔`}>
            {payload.trades_today_buy.length > 0 ? (
              <Table
                size="small"
                rowKey={(r) => `${r.symbol}-${r.direction}-${r.amount}`}
                pagination={false}
                dataSource={payload.trades_today_buy}
                columns={[
                  { title: '代码', dataIndex: 'symbol', width: 100 },
                  { title: '名称', dataIndex: 'name', width: 120 },
                  { title: '数量', dataIndex: 'quantity', width: 80 },
                  {
                    title: '成交价',
                    dataIndex: 'execute_price',
                    width: 100,
                    render: (v: number) => v.toFixed(2),
                  },
                  {
                    title: '成交额',
                    dataIndex: 'amount',
                    render: (v: number) => v.toFixed(2),
                  },
                ]}
              />
            ) : (
              <Empty description="今日暂无新增买入" />
            )}
          </Card>

          <Card size="small" title={`今日新增卖出 ${payload.trades_today_sell_count} 笔`}>
            {payload.trades_today_sell.length > 0 ? (
              <Table
                size="small"
                rowKey={(r) => `${r.symbol}-${r.direction}-${r.amount}`}
                pagination={false}
                dataSource={payload.trades_today_sell}
                columns={[
                  { title: '代码', dataIndex: 'symbol', width: 100 },
                  { title: '名称', dataIndex: 'name', width: 120 },
                  { title: '数量', dataIndex: 'quantity', width: 80 },
                  {
                    title: '成交价',
                    dataIndex: 'execute_price',
                    width: 100,
                    render: (v: number) => v.toFixed(2),
                  },
                  {
                    title: '成交额',
                    dataIndex: 'amount',
                    width: 120,
                    render: (v: number) => v.toFixed(2),
                  },
                  {
                    title: '实现盈亏',
                    dataIndex: 'realized_pnl',
                    render: (v: number | null | undefined) =>
                      v === null || v === undefined ? '—' : v.toFixed(2),
                  },
                ]}
              />
            ) : (
              <Empty description="今日暂无新增卖出" />
            )}
          </Card>

          <Card size="small" title={`明日候选（3 策略 × Top 5）`}>
            {payload.candidates_tomorrow.length > 0 ? (
              <Table
                size="small"
                rowKey={(r, i) => `${r.strategy}-${r.symbol}-${i}`}
                pagination={false}
                dataSource={payload.candidates_tomorrow}
                columns={[
                  {
                    title: '策略',
                    dataIndex: 'strategy',
                    width: 120,
                    render: (v: string) =>
                      v === 'multi_factor' ? (
                        <Tag color="blue">多因子</Tag>
                      ) : v === 'dragon_head' ? (
                        <Tag color="red">龙头</Tag>
                      ) : v === 'earnings_surprise' ? (
                        <Tag color="orange">业绩</Tag>
                      ) : (
                        <Tag>{v}</Tag>
                      ),
                  },
                  { title: '代码', dataIndex: 'symbol', width: 100 },
                  {
                    title: '名称',
                    dataIndex: 'name',
                    width: 120,
                    render: (v?: string | null) => v || '—',
                  },
                  {
                    title: '分数',
                    dataIndex: 'score',
                    width: 100,
                    render: (v?: number | null) =>
                      v === null || v === undefined ? '—' : Number(v).toFixed(2),
                  },
                  {
                    title: '理由',
                    dataIndex: 'reason',
                    render: (v?: string | null) => v || '—',
                  },
                ]}
              />
            ) : (
              <Empty description="明日策略暂无候选" />
            )}
          </Card>

          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            预览不发送 webhook；点 &quot;立即推送一条日报&quot; 按钮才真实推送。Digest ID: <Text code>{result.digest_id}</Text>
          </Paragraph>
        </Space>
      )}
    </Modal>
  );
};

export default SettingsWorkspace;
