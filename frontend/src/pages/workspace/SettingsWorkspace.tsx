import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/rootReducer';
import {
  Alert,
  Button,
  Card,
  Descriptions,
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
  BellOutlined,
  EyeOutlined,
  SendOutlined,
  SaveOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import WorkspaceHero from '../../components/layout/WorkspaceHero';
import { AnimatePresence, motion } from 'framer-motion';
import {
  loadNotificationChannels,
  updateNotificationChannels,
  updateEmailConfig,
  previewDailyDigest,
  sendDailyDigestNow,
  previewWeeklyReview,
  sendWeeklyReviewNow,
  applyWeeklyReviewRecommendation,
  NotificationChannelsConfig,
  SendDigestsResult,
  DigestForUserResult,
  SendWeeklyReviewResult,
  WeeklyReviewForUserResult,
} from '../../services/settingsService';

const { Text, Paragraph } = Typography;

/**
 * 账号设置 (Settings Workspace).
 *
 * 2 个 tab：
 *  - 个人 — 当前账号资料 (只读)
 *  - 通知 — 飞书 / 邮件通道配置 + 当日日报 / 周报预览与手动推送
 *
 * 说明：微信公众号 / 阿里云短信通道后端 dispatch 未接入，UI 暂缓；US-080 推送渠道矩阵
 * 子视图因同样原因下线，通知 tab 直接呈现单一「通知设置」视图。
 */
const DEFAULT_CONFIG: NotificationChannelsConfig = {
  feishu: {
    enabled: true,
    webhook_url: '',
    daily_digest: true,
    earnings_alert: true,
    risk_alert: true,
  },
  email: { enabled: false, address: '', weekly_review: false, risk_alert: false },
  wechat: {
    enabled: false,
    openid: '',
    bind_scene_str: '',
    bound_at: '',
    daily_digest: false,
    earnings_alert: false,
    risk_alert: false,
  },
  sms: {
    enabled: false,
    phone: '',
    risk_alert: false,
  },
};

const SettingsWorkspace: React.FC = () => {
  // 设置聚焦"配置支撑"主线：只保留 个人(账号只读) + 通知(飞书 / 邮件通道)。
  // 历史上的风控 / 高级 / 用户管理 tab 及 US-080 推送渠道矩阵已下线 (2026-07-05)；
  // 用户管理的后端 CRUD 仍在 services/userService.ts (/api/users)，如需重开可直接复用。
  const isAdmin = useSelector((s: RootState) => s.auth.user?.role === 'admin');
  // 2026-07-05: 收敛为 2 个一级 tab (个人 / 通知)。风控 / 高级 / 用户管理已下线。
  const tabs: WorkspaceTab[] = useMemo(
    () => [
      { key: 'profile', label: '个人', icon: <UserOutlined /> },
      { key: 'notify', label: '通知', icon: <BellOutlined /> },
    ],
    []
  );
  // 默认 tab 仍是 profile (用户进设置最先想看的是"我是谁")
  const [activeKey, setActiveKey] = useState('profile');

  // --- 通知设置 state -----------------------------------------------------
  const [config, setConfig] = useState<NotificationChannelsConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [previewResult, setPreviewResult] = useState<DigestForUserResult | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // ---- 周报预览 / 发送 state (US-065) -----------------------------------
  const [weeklyPreviewing, setWeeklyPreviewing] = useState(false);
  const [weeklySending, setWeeklySending] = useState(false);
  const [weeklyEmailSaving, setWeeklyEmailSaving] = useState(false);
  const [weeklyPreviewResult, setWeeklyPreviewResult] = useState<WeeklyReviewForUserResult | null>(
    null
  );
  const [weeklyPreviewOpen, setWeeklyPreviewOpen] = useState(false);

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

  // 通知 tab 顶部的刷新按钮 (重新拉取通道配置)
  const headerActions =
    activeKey === 'notify' ? (
      <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
        刷新
      </Button>
    ) : null;

  // ---- 单字段更新 helpers ------------------------------------------------

  const patchConfig = useCallback((next: NotificationChannelsConfig) => {
    setConfig(next);
  }, []);

  const handleSave = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    try {
      const saved = await updateNotificationChannels({
        feishu: config.feishu,
        email: config.email,
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
      content: '将按当前配置中的 webhook URL 真实推送一条 interactive card 到飞书群（不可撤销）。',
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

  // ---- US-065 邮件 / 周报 handlers --------------------------------------

  const handleSaveEmailConfig = useCallback(async () => {
    if (!config) return;
    setWeeklyEmailSaving(true);
    try {
      const saved = await updateEmailConfig({
        enabled: config.email.enabled,
        address: config.email.address,
        weekly_review: config.email.weekly_review,
        risk_alert: config.email.risk_alert,
      });
      setConfig(saved);
      message.success('邮件通道配置已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setWeeklyEmailSaving(false);
    }
  }, [config]);

  const handleWeeklyPreview = useCallback(async () => {
    setWeeklyPreviewing(true);
    setWeeklyPreviewResult(null);
    try {
      const result: SendWeeklyReviewResult = await previewWeeklyReview();
      const own = result.per_user[0];
      if (own) {
        setWeeklyPreviewResult(own);
        setWeeklyPreviewOpen(true);
      } else {
        message.warning('未获取到预览结果（可能账号尚未启用邮件或周报开关关闭）');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '预览失败');
    } finally {
      setWeeklyPreviewing(false);
    }
  }, []);

  const handleWeeklySendNow = useCallback(async () => {
    Modal.confirm({
      title: '立即发送一封上周复盘邮件？',
      content:
        '将按当前配置中的接收邮箱真实发送一封 HTML 邮件（不可撤销）。SMTP 配置由后端环境变量提供。',
      okText: '发送',
      okButtonProps: { type: 'primary' },
      cancelText: '取消',
      onOk: async () => {
        setWeeklySending(true);
        try {
          const result = await sendWeeklyReviewNow();
          const own = result.per_user[0];
          if (own?.status === 'sent') {
            message.success('上周复盘邮件已发送');
          } else if (own?.status === 'skipped') {
            message.warning(`已跳过：${own.skip_reason || '未知原因'}`);
          } else if (own?.status === 'partial') {
            message.warning(`已发送但 SMTP 返回失败：${own.error || ''}`);
          } else if (own?.status === 'failed') {
            message.error(`发送失败：${own.error || '未知原因'}`);
          } else {
            message.info('已触发发送，但无返回详情');
          }
        } catch (err) {
          message.error(err instanceof Error ? err.message : '触发发送失败');
        } finally {
          setWeeklySending(false);
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
                每个交易日 15:30 自动推送：账户当日盈亏 + 新增 BUY/SELL 前 3 笔 + 明日 3 策略候选
                top 5。
              </Text>
              <Text type="secondary">
                飞书 webhook 创建方式：群设置 → 群机器人 → 添加机器人 → 自定义机器人 → 复制 webhook
                URL。留空则回退到环境变量
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
              onChange={v => patchConfig({ ...cfg, feishu: { ...cfg.feishu, enabled: v } })}
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
                onChange={e =>
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
                    onChange={v =>
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
                    onChange={v =>
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
                    onChange={v =>
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

        <Card
          title="邮件（Email）"
          extra={
            <Switch
              checked={cfg.email.enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              onChange={v => patchConfig({ ...cfg, email: { ...cfg.email, enabled: v } })}
            />
          }
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="每周一 08:00 上周策略复盘报告"
            description={
              <Space direction="vertical" size={4}>
                <Text>
                  HTML 邮件包含：上周净值曲线（inline SVG）、各行业贡献、TOP 盈利 /
                  亏损个股、本周关注事件（业绩预告）、AI 周观点。
                </Text>
                <Text type="secondary">
                  SMTP 由后端通过环境变量 <Text code>SMTP_HOST</Text> / <Text code>SMTP_PORT</Text>{' '}
                  /<Text code>SMTP_USER</Text> / <Text code>SMTP_PASS</Text> /{' '}
                  <Text code>SMTP_FROM</Text> /<Text code>SMTP_SECURE</Text> 配置。
                </Text>
              </Space>
            }
          />
          <Form layout="vertical" disabled={!cfg.email.enabled}>
            <Form.Item
              label="接收邮箱地址"
              extra="格式 example@domain.com。可点击下方“立即发送”冒烟测试 SMTP 是否畅通。"
            >
              <Input
                placeholder="example@domain.com"
                value={cfg.email.address || ''}
                onChange={e =>
                  patchConfig({ ...cfg, email: { ...cfg.email, address: e.target.value } })
                }
                allowClear
              />
            </Form.Item>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="每周复盘报告 (周一 08:00)"
                  tooltip="每周一早 8 点自动发送上周策略复盘 HTML 邮件"
                >
                  <Switch
                    checked={cfg.email.weekly_review}
                    onChange={v =>
                      patchConfig({ ...cfg, email: { ...cfg.email, weekly_review: v } })
                    }
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="高优先级风控告警 (US-067)"
                  tooltip="HIGH 级 RiskAlert 实时邮件推送；同事件 30 min 内只发 1 次去重"
                >
                  <Switch
                    checked={cfg.email.risk_alert}
                    onChange={v => patchConfig({ ...cfg, email: { ...cfg.email, risk_alert: v } })}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Divider />
            <Space wrap>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={weeklyEmailSaving}
                onClick={() => void handleSaveEmailConfig()}
              >
                保存邮件配置
              </Button>
              <Button
                icon={<EyeOutlined />}
                loading={weeklyPreviewing}
                onClick={() => void handleWeeklyPreview()}
              >
                预览上周周报（dry-run）
              </Button>
              <Button
                icon={<SendOutlined />}
                loading={weeklySending}
                onClick={handleWeeklySendNow}
                disabled={!cfg.email.enabled || !cfg.email.weekly_review || !cfg.email.address}
              >
                立即发送一封周报
              </Button>
            </Space>
          </Form>
        </Card>

        <Alert
          type="info"
          showIcon
          message="微信公众号 / 阿里云短信通道建设中"
          description="这两个通道的后端消息分发（dispatch）尚未接入，暂不在此配置；接入后会重新开放。当前可用通道为飞书机器人与邮件。"
        />
      </Space>
    );
  };

  const currentUser = useSelector((s: RootState) => s.auth.user);

  const renderProfileView = () => (
    <Card>
      <Descriptions column={1} size="small" labelStyle={{ width: 100, color: 'var(--ink-3)' }}>
        <Descriptions.Item label="用户名">{currentUser?.username ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="邮箱">{currentUser?.email ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="角色">{currentUser?.role ?? '—'}</Descriptions.Item>
      </Descriptions>
      <Alert
        style={{ marginTop: 16 }}
        type="info"
        showIcon
        message="密码修改、头像上传等编辑功能正在开发中，敬请期待。"
      />
    </Card>
  );

  // ---- 主 body render (2 个一级 tab: 个人 / 通知) ----
  let body: React.ReactNode;
  if (activeKey === 'profile') {
    body = (
      <>
        <div className="ws-tab-header">
          <h1 className="ws-tab-title">个人</h1>
          <p className="ws-tab-subtitle">当前登录账号的基本信息。</p>
        </div>
        {renderProfileView()}
      </>
    );
  } else if (activeKey === 'notify') {
    body = (
      <>
        <div className="ws-tab-header">
          <h1 className="ws-tab-title">通知</h1>
          <p className="ws-tab-subtitle">
            配置在什么时机、用什么渠道收到提醒 — 当前支持飞书机器人当日日报与邮件周报 / 风控告警。
          </p>
        </div>
        {renderNotifications()}
      </>
    );
  } else {
    body = null;
  }
  return (
    <WorkspaceLayout
      title="账号设置"
      subtitle="个人资料与通知渠道设置。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      headerActions={headerActions}
      hero={
        <WorkspaceHero
          eyebrow="Settings · 账号中心"
          title="账号与系统设置"
          subtitle="个人资料 · 通知中心 — 账号与通知渠道设置"
          variant="violet"
          metrics={[
            { label: '角色', value: isAdmin ? 'Admin' : 'User', emphasis: true },
            {
              label: '启用通道',
              value: config
                ? [config.feishu.enabled, config.email.enabled].filter(Boolean).length
                : 0,
              unit: '个',
            },
            {
              label: '日报',
              value: config?.feishu?.daily_digest ? '开' : '关',
              tone: config?.feishu?.daily_digest ? 'down' : undefined,
            },
          ]}
        />
      }
      themed
    >
      <AnimatePresence mode="wait">
        <motion.div
          key={activeKey}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          {body}
        </motion.div>
      </AnimatePresence>
      <DigestPreviewModal
        open={previewOpen}
        result={previewResult}
        onClose={() => setPreviewOpen(false)}
      />
      <WeeklyReviewPreviewModal
        open={weeklyPreviewOpen}
        result={weeklyPreviewResult}
        onClose={() => setWeeklyPreviewOpen(false)}
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
    <Modal
      title={`今日日报预览（dry-run）`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={720}
    >
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
                    color:
                      (pnl?.pnl_today ?? 0) > 0
                        ? '#dc2626'
                        : (pnl?.pnl_today ?? 0) < 0
                          ? '#16a34a'
                          : '#999',
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
                        ? '#dc2626'
                        : (pnl?.pnl_today_pct ?? 0) < 0
                          ? '#16a34a'
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
                rowKey={r => `${r.symbol}-${r.direction}-${r.amount}`}
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
                rowKey={r => `${r.symbol}-${r.direction}-${r.amount}`}
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

          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            预览不发送 webhook；点 &quot;立即推送一条日报&quot; 按钮才真实推送。Digest ID:{' '}
            <Text code>{result.digest_id}</Text>
          </Paragraph>
        </Space>
      )}
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// 上周复盘邮件预览 Modal 子组件 (US-065)
// ---------------------------------------------------------------------------

interface WeeklyReviewPreviewModalProps {
  open: boolean;
  result: WeeklyReviewForUserResult | null;
  onClose: () => void;
}

const WeeklyReviewPreviewModal: React.FC<WeeklyReviewPreviewModalProps> = ({
  open,
  result,
  onClose,
}) => {
  // Macro 串联补丁 (2026-06-21) — apply 周报建议状态.
  // 每条 recommendation 都有 index, apply 后调 POST /api/settings/weekly-review/apply
  // 让后端把建议落入 user.risk_config.weekly_review_applied[] (PM-015 + PM-027 effect tracker).
  const [appliedIndices, setAppliedIndices] = React.useState<Set<number>>(new Set());
  const [applyingIndex, setApplyingIndex] = React.useState<number | null>(null);

  React.useEffect(() => {
    // 切到不同 report 时清掉本地 applied 状态 (后端会幂等 409 防双 apply)
    setAppliedIndices(new Set());
    setApplyingIndex(null);
  }, [result?.report_id]);

  if (!result) return null;
  const payload = result.payload;
  const pnl = payload?.pnl;
  const week = result.week;

  const handleApplyRecommendation = async (index: number, text: string) => {
    if (!week.week_id) {
      message.error('week_id 缺失, 无法 apply');
      return;
    }
    setApplyingIndex(index);
    try {
      await applyWeeklyReviewRecommendation({
        week_id: week.week_id,
        recommendation_index: index,
        text,
        source: payload?.ai_opinion?.source || 'heuristic',
      });
      setAppliedIndices(prev => new Set(prev).add(index));
      message.success('建议已 apply, 已落入 risk_config.weekly_review_applied[]');
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (/已 apply/i.test(msg) || /409/.test(msg)) {
        // idempotent guard — 后端 409 表示已 apply 过, 同步本地状态防重复点击
        setAppliedIndices(prev => new Set(prev).add(index));
        message.warning(`该建议已 apply 过 (后端 409 idempotent guard)`);
      } else {
        message.error(`apply 失败: ${msg}`);
      }
    } finally {
      setApplyingIndex(null);
    }
  };

  return (
    <Modal
      title={`上周复盘邮件预览（dry-run）`}
      open={open}
      onCancel={onClose}
      footer={null}
      width={760}
    >
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
          <Card
            size="small"
            title={`周期：${week.start_date} ~ ${week.end_date}（${week.week_id}）`}
          >
            <Row gutter={16}>
              <Col span={6}>
                <Statistic
                  title="本周净值变化 (元)"
                  value={pnl?.pnl_amount ?? 0}
                  precision={2}
                  valueStyle={{
                    color:
                      (pnl?.pnl_amount ?? 0) > 0
                        ? '#dc2626'
                        : (pnl?.pnl_amount ?? 0) < 0
                          ? '#16a34a'
                          : '#999',
                  }}
                />
              </Col>
              <Col span={6}>
                <Statistic
                  title="本周净值变化 (%)"
                  value={pnl?.pnl_pct ?? 0}
                  precision={2}
                  suffix="%"
                  valueStyle={{
                    color:
                      (pnl?.pnl_pct ?? 0) > 0
                        ? '#dc2626'
                        : (pnl?.pnl_pct ?? 0) < 0
                          ? '#16a34a'
                          : '#999',
                  }}
                />
              </Col>
              <Col span={6}>
                <Statistic title="周初总资产 (元)" value={pnl?.start_value ?? 0} precision={2} />
              </Col>
              <Col span={6}>
                <Statistic title="周末总资产 (元)" value={pnl?.end_value ?? 0} precision={2} />
              </Col>
            </Row>
          </Card>

          <Card size="small" title={`各行业贡献（${payload.industry_contribution.length}）`}>
            {payload.industry_contribution.length > 0 ? (
              <Table
                size="small"
                rowKey="industry"
                pagination={false}
                dataSource={payload.industry_contribution.slice(0, 8)}
                columns={[
                  {
                    title: '行业',
                    dataIndex: 'industry',
                    render: (v: string) => (v === '__UNKNOWN__' ? '未分类' : v),
                  },
                  {
                    title: '已实现盈亏 (元)',
                    dataIndex: 'realized_pnl',
                    align: 'right',
                    render: (v: number) => v.toFixed(2),
                  },
                  { title: '成交笔数', dataIndex: 'trade_count', align: 'right', width: 100 },
                ]}
              />
            ) : (
              <Empty description="本周无已实现交易" />
            )}
          </Card>

          <Row gutter={12}>
            <Col span={12}>
              <Card size="small" title={`盈利 TOP ${payload.top_winners.length}`}>
                {payload.top_winners.length > 0 ? (
                  <Table
                    size="small"
                    rowKey="symbol"
                    pagination={false}
                    showHeader={false}
                    dataSource={payload.top_winners}
                    columns={[
                      { title: '代码', dataIndex: 'symbol', width: 90 },
                      { title: '名称', dataIndex: 'name' },
                      {
                        title: 'PnL',
                        dataIndex: 'realized_pnl',
                        align: 'right',
                        render: (v: number) => (
                          <Text style={{ color: '#dc2626' }}>+{v.toFixed(2)}</Text>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <Empty description="无盈利兑现" />
                )}
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small" title={`亏损 TOP ${payload.top_losers.length}`}>
                {payload.top_losers.length > 0 ? (
                  <Table
                    size="small"
                    rowKey="symbol"
                    pagination={false}
                    showHeader={false}
                    dataSource={payload.top_losers}
                    columns={[
                      { title: '代码', dataIndex: 'symbol', width: 90 },
                      { title: '名称', dataIndex: 'name' },
                      {
                        title: 'PnL',
                        dataIndex: 'realized_pnl',
                        align: 'right',
                        render: (v: number) => (
                          <Text style={{ color: '#16a34a' }}>{v.toFixed(2)}</Text>
                        ),
                      },
                    ]}
                  />
                ) : (
                  <Empty description="无亏损兑现" />
                )}
              </Card>
            </Col>
          </Row>

          <Card size="small" title={`本周关注事件（${payload.upcoming_events.length}）`}>
            {payload.upcoming_events.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {payload.upcoming_events.map((ev, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>
                    <Text strong>
                      {ev.symbol} {ev.name}
                    </Text>{' '}
                    · {ev.event_type === 'earnings_forecast' ? '业绩预告' : '财报披露'}
                    {ev.announce_date ? ` · ${ev.announce_date}` : ''} —{' '}
                    <Text type="secondary">{ev.detail}</Text>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty description="本周暂无重要关注事件" />
            )}
          </Card>

          <Card
            size="small"
            title={
              <Space>
                <span>🤖 AI 周观点</span>
                <Tag color={payload.ai_opinion.source === 'remote' ? 'blue' : 'default'}>
                  {payload.ai_opinion.source === 'remote' ? '远端 AI' : '本地启发式'}
                </Tag>
              </Space>
            }
          >
            <Paragraph style={{ marginBottom: 8, fontWeight: 600 }}>
              {payload.ai_opinion.headline}
            </Paragraph>
            {payload.ai_opinion.paragraphs.map((p, i) => (
              <Paragraph key={i} style={{ marginBottom: 4, color: '#475569' }}>
                {p}
              </Paragraph>
            ))}
            {payload.ai_opinion.recommendations &&
              payload.ai_opinion.recommendations.length > 0 && (
                <>
                  <Paragraph style={{ marginTop: 8, marginBottom: 4, fontWeight: 600 }}>
                    💡 操作建议
                  </Paragraph>
                  {/* Macro 串联补丁 (2026-06-21) — 每条 recommendation 加 apply 按钮.
                       已 apply 状态本地 + 后端 409 双重保护防重复. */}
                  <Space
                    direction="vertical"
                    size={6}
                    style={{ width: '100%' }}
                    data-testid="weekly-review-recommendations-list"
                  >
                    {payload.ai_opinion.recommendations.map((r, i) => {
                      const applied = appliedIndices.has(i);
                      return (
                        <Space
                          key={i}
                          align="start"
                          style={{ width: '100%', justifyContent: 'space-between' }}
                        >
                          <Text style={{ color: '#475569' }}>
                            <Text strong>{i + 1}. </Text>
                            {r}
                          </Text>
                          <Button
                            size="small"
                            type={applied ? 'default' : 'primary'}
                            disabled={applied}
                            loading={applyingIndex === i}
                            onClick={() => void handleApplyRecommendation(i, r)}
                            data-testid={`apply-weekly-review-recommendation-${i}`}
                          >
                            {applied ? '已应用' : '应用'}
                          </Button>
                        </Space>
                      );
                    })}
                  </Space>
                </>
              )}
          </Card>

          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
            预览不发送邮件；点 &quot;立即发送一封周报&quot; 按钮才真实发送。Report ID:{' '}
            <Text code>{result.report_id}</Text>
          </Paragraph>
        </Space>
      )}
    </Modal>
  );
};

export default SettingsWorkspace;
