import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/rootReducer';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Col,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Segmented,
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
  NotificationOutlined,
  TeamOutlined,
  EyeOutlined,
  SendOutlined,
  SaveOutlined,
  ReloadOutlined,
  QrcodeOutlined,
  DisconnectOutlined,
  CheckCircleOutlined,
  ExperimentOutlined,
  WechatOutlined,
  MailOutlined,
  MessageOutlined,
  ThunderboltOutlined,
  SafetyOutlined,
  LeftOutlined,
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
  getWeChatBindQrCode,
  confirmWeChatBind,
  updateWeChatConfig,
  unbindWeChat,
  sendWeChatTestMessage,
  updateSmsConfig,
  sendRealtimeAlertTest,
  loadNotificationConfig,
  updateNotificationConfig,
  NotificationChannelsConfig,
  NotificationConfigMatrixView,
  NotificationEventKey,
  NotificationChannelKey,
  SendDigestsResult,
  DigestForUserResult,
  SendWeeklyReviewResult,
  WeeklyReviewForUserResult,
  WeChatBindQrCodeResult,
  WeChatTestKind,
  RealtimeAlertDispatchResult,
} from '../../services/settingsService';

const { Text, Paragraph } = Typography;

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
  // Phase 9 (2026-06-28): tab 12 → 4 (普通用户) / 5 (admin).
  // 用户原话"Tab 太多, 完全不知道怎么操作". 进一步把 Phase 3 的 12 项收成 4 个一级 tab:
  //   1. 个人  ← 旧 profile + keys (内部 Segmented "资料 / API 密钥")
  //   2. 通知  ← 旧 notifications + push-channels (内部 Segmented "通知类型 / 推送渠道")
  //   3. 风控  ← 旧 risk-parameters + strategy-kill-switch + black-swan + todo-suggestions
  //             (内部 Segmented "风控总览 / 参数中心 / kill-switch / 黑天鹅 / 待办建议")
  //   4. 高级 (admin only) ← 旧 sizing + portfolio-construction
  //                          (内部 Segmented "仓位策略 / 组合构建")
  //   5. 用户管理 (admin only) ← 旧 users
  // 注: 大部分旧 Tab 组件已按上述分组挂在新 4-5 项下 (Segmented 子视图); 但仍有 3 个 tab 是
  // placeholder 待接入 —— 个人资料(profile) / API 密钥 / 用户管理(users). 其中"用户管理"的后端
  // CRUD 现成实现见 services/userService.ts (/api/users 仍挂载), 接入时直接调用即可, 勿删该 service.
  const isAdmin = useSelector((s: RootState) => s.auth.user?.role === 'admin');
  const tabs: WorkspaceTab[] = useMemo(() => {
    const baseTabs: WorkspaceTab[] = [
      { key: 'profile', label: '个人', icon: <UserOutlined /> },
      { key: 'notify', label: '通知', icon: <BellOutlined /> },
      // { key: 'risk', label: '风控' }, // 下线 2026-07-05
    ];
    if (isAdmin) {
      baseTabs.push(
        // 高级/用户管理 tab 下线 2026-07-05
      );
    }
    return baseTabs;
  }, [isAdmin]);
  // Phase 9: 默认 tab 仍是 profile (用户进设置最先想看的是"我是谁")
  const [activeKey, setActiveKey] = useState('profile');

  // Phase 9 — 每个一级 tab 内的子视图 Segmented 状态
  const [profileSubView, setProfileSubView] = useState<'profile' | 'keys'>('profile');
  const [notifySubView, setNotifySubView] = useState<'types' | 'channels'>('types');

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

  // ---- 微信绑定 state (US-066) ------------------------------------------
  const [wechatSaving, setWeChatSaving] = useState(false);
  const [wechatBindLoading, setWeChatBindLoading] = useState(false);
  const [wechatBindOpen, setWeChatBindOpen] = useState(false);
  const [wechatBindResult, setWeChatBindResult] = useState<WeChatBindQrCodeResult | null>(null);
  /** 绑定状态：null=尚未生成 QR；'pending'=等待扫码；'bound'=已绑定；'expired'=过期 */
  const [wechatBindStatus, setWeChatBindStatus] = useState<null | 'pending' | 'bound' | 'expired'>(
    null
  );
  const [wechatUnbinding, setWeChatUnbinding] = useState(false);
  const [wechatTesting, setWeChatTesting] = useState(false);
  /** 微信 confirm 轮询 setInterval id —— 模态框关闭 / 已绑定时清掉 */
  const wechatPollRef = useRef<number | null>(null);

  // ---- US-067 SMS / 实时风控 webhook state ------------------------------
  const [smsSaving, setSmsSaving] = useState(false);
  const [realtimeAlertTesting, setRealtimeAlertTesting] = useState(false);
  const [realtimeAlertTestResult, setRealtimeAlertTestResult] =
    useState<RealtimeAlertDispatchResult | null>(null);

  // ---- US-080 推送渠道矩阵视图 state -------------------------------------
  const [pushView, setPushView] = useState<NotificationConfigMatrixView | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushSaving, setPushSaving] = useState(false);
  /** 矩阵 + 渠道字段的本地草稿；保存按钮 PUT 时一次性 diff */
  const [pushDraft, setPushDraft] = useState<NotificationConfigMatrixView | null>(null);
  const [pushFeishuTesting, setPushFeishuTesting] = useState(false);

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

  // ---- US-080 推送渠道矩阵视图 加载 -------------------------------------
  const refreshPushChannels = useCallback(async () => {
    setPushLoading(true);
    setPushError(null);
    try {
      const view = await loadNotificationConfig();
      setPushView(view);
      setPushDraft(view);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : '加载推送渠道矩阵失败');
    } finally {
      setPushLoading(false);
    }
  }, []);

  useEffect(() => {
    // lazy-load: 仅当用户切到通知 tab 的 "推送渠道" 子视图才拉
    if (activeKey !== 'notify' || notifySubView !== 'channels') return;
    if (pushView || pushLoading || pushError) return;
    void refreshPushChannels();
  }, [activeKey, notifySubView, pushView, pushLoading, pushError, refreshPushChannels]);

  // KPI 统计 — 渠道启用计数 + 日报开关状态
  const kpiSlot = useMemo(() => {
    // 推送渠道子视图用 pushView 数据；其他场景用 config (走 /notification-channels)
    const onPushChannels = activeKey === 'notify' && notifySubView === 'channels';
    const cfgForKpi: NotificationChannelsConfig | null = onPushChannels
      ? pushView?.raw || null
      : config;
    const active = cfgForKpi
      ? [
          cfgForKpi.feishu.enabled ? '飞书' : null,
          cfgForKpi.email.enabled ? '邮件' : null,
          // wechat / sms 后端 dispatch 暂未接入，不参与 KPI 计数
        ].filter(Boolean).length
      : 0;
    // 推送渠道子视图额外显示"已订阅事件数"——所有矩阵格中 enabled=true 的总数
    let subscribedCount = 0;
    if (onPushChannels && pushView) {
      for (const event of Object.values(pushView.matrix)) {
        for (const cell of Object.values(event)) {
          if (cell.applicable && cell.enabled) subscribedCount += 1;
        }
      }
    }
    return (
      <Space size={32}>
        <Statistic title="账号角色" value="—" />
        <Statistic title="启用通道" value={active} suffix="个" />
        {onPushChannels ? (
          <Statistic title="已订阅事件" value={subscribedCount} suffix="项" />
        ) : (
          <Statistic
            title="飞书日报"
            value={cfgForKpi?.feishu.daily_digest ? '开启' : '关闭'}
            valueStyle={{ color: cfgForKpi?.feishu.daily_digest ? '#16a34a' : '#999' }}
          />
        )}
      </Space>
    );
  }, [activeKey, notifySubView, config, pushView]);

  // Phase 9: headerActions 只在 notify tab 上显示刷新按钮 (按子视图切换 refresh 目标)
  const headerActions =
    activeKey === 'notify' && notifySubView === 'types' ? (
      <Button icon={<ReloadOutlined />} onClick={() => void refresh()} loading={loading}>
        刷新
      </Button>
    ) : activeKey === 'notify' && notifySubView === 'channels' ? (
      <Button
        icon={<ReloadOutlined />}
        onClick={() => void refreshPushChannels()}
        loading={pushLoading}
      >
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

  // ---- US-066 微信 handlers --------------------------------------------

  /** 停掉轮询 + 关闭模态 + 清状态 */
  const stopWeChatPolling = useCallback(() => {
    if (wechatPollRef.current !== null) {
      window.clearInterval(wechatPollRef.current);
      wechatPollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopWeChatPolling();
  }, [stopWeChatPolling]);

  const handleWeChatBindStart = useCallback(async () => {
    setWeChatBindLoading(true);
    setWeChatBindResult(null);
    setWeChatBindStatus(null);
    try {
      const qr = await getWeChatBindQrCode();
      setWeChatBindResult(qr);
      setWeChatBindStatus('pending');
      setWeChatBindOpen(true);

      // 开 3 秒轮询；最多轮询 2 分钟（40 次）就停（让用户主动关闭/重启）
      let ticks = 0;
      stopWeChatPolling();
      wechatPollRef.current = window.setInterval(async () => {
        ticks += 1;
        if (ticks > 40) {
          stopWeChatPolling();
          setWeChatBindStatus('expired');
          return;
        }
        try {
          const r = await confirmWeChatBind(qr.scene_str);
          if (r.bound) {
            stopWeChatPolling();
            setWeChatBindStatus('bound');
            message.success('微信公众号已绑定');
            void refresh();
          }
        } catch {
          // 轮询单次失败不告警；下次继续
        }
      }, 3000);
    } catch (err) {
      message.error(err instanceof Error ? err.message : '生成二维码失败');
    } finally {
      setWeChatBindLoading(false);
    }
  }, [refresh, stopWeChatPolling]);

  const handleWeChatBindClose = useCallback(() => {
    stopWeChatPolling();
    setWeChatBindOpen(false);
    setWeChatBindResult(null);
    setWeChatBindStatus(null);
  }, [stopWeChatPolling]);

  const handleWeChatSave = useCallback(async () => {
    if (!config) return;
    setWeChatSaving(true);
    try {
      const saved = await updateWeChatConfig({
        enabled: config.wechat.enabled,
        daily_digest: config.wechat.daily_digest,
        earnings_alert: config.wechat.earnings_alert,
        risk_alert: config.wechat.risk_alert,
      });
      setConfig(saved);
      message.success('微信通道配置已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setWeChatSaving(false);
    }
  }, [config]);

  const handleWeChatUnbind = useCallback(async () => {
    Modal.confirm({
      title: '解除微信公众号绑定？',
      content: '解除后将停止向微信公众号推送当日日报 / 业绩预告 / 风控告警。可随时重新扫码绑定。',
      okText: '解除绑定',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setWeChatUnbinding(true);
        try {
          const saved = await unbindWeChat();
          setConfig(saved);
          message.success('微信绑定已解除');
        } catch (err) {
          message.error(err instanceof Error ? err.message : '解除失败');
        } finally {
          setWeChatUnbinding(false);
        }
      },
    });
  }, []);

  const handleWeChatTest = useCallback(async (kind: WeChatTestKind) => {
    setWeChatTesting(true);
    try {
      const r = await sendWeChatTestMessage(kind, /* dryRun */ false);
      if (r.status === 'sent') {
        message.success(`已向微信公众号发送 ${kind} 测试消息`);
      } else if (r.status === 'skipped') {
        message.warning(`已跳过：${r.skip_reason || '未配置 / 开关关闭'}`);
      } else {
        message.error(`发送失败：${r.error || '未知原因'}`);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '发送失败');
    } finally {
      setWeChatTesting(false);
    }
  }, []);

  // ---- US-067 SMS / 实时风控 webhook handlers ---------------------------

  const handleSaveSmsConfig = useCallback(async () => {
    if (!config) return;
    setSmsSaving(true);
    try {
      const saved = await updateSmsConfig({
        enabled: config.sms.enabled,
        phone: config.sms.phone,
        risk_alert: config.sms.risk_alert,
      });
      setConfig(saved);
      message.success('SMS 通道配置已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSmsSaving(false);
    }
  }, [config]);

  /**
   * 冒烟测试一条 HIGH 级风控告警 —— 三 channel (feishu/email/sms) 全派；
   * dryRun=true 不真发也不写 dedup，让用户反复点测试不被 30 min dedup 拦。
   */
  const handleRealtimeAlertTest = useCallback(async (dryRun: boolean) => {
    setRealtimeAlertTesting(true);
    setRealtimeAlertTestResult(null);
    try {
      const result = await sendRealtimeAlertTest(dryRun);
      setRealtimeAlertTestResult(result);
      if (result.status === 'sent') {
        message.success('测试告警已派发到全部启用的通道');
      } else if (result.status === 'partial') {
        message.warning('部分通道派发失败，详见下方结果');
      } else if (result.status === 'skipped') {
        message.info(`已跳过：${result.skip_reason || '所有通道未启用或缺接收地址'}`);
      } else {
        message.error('测试告警派发失败，详见下方结果');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '测试发送失败');
    } finally {
      setRealtimeAlertTesting(false);
    }
  }, []);

  // ---- US-080 推送渠道 draft 编辑 + 保存 handlers -----------------------

  /** 矩阵格 toggle —— 只改本地 draft，提交时一次 PUT */
  const togglePushMatrix = useCallback(
    (event: NotificationEventKey, channel: NotificationChannelKey, next: boolean) => {
      setPushDraft(prev => {
        if (!prev) return prev;
        const cell = prev.matrix[event]?.[channel];
        if (!cell || !cell.applicable) return prev;
        return {
          ...prev,
          matrix: {
            ...prev.matrix,
            [event]: {
              ...prev.matrix[event],
              [channel]: { applicable: true, enabled: next },
            },
          },
        };
      });
    },
    []
  );

  /** 顶部 3 个 Card 字段编辑（webhook_url / address / channel.enabled） */
  const patchPushChannelField = useCallback(
    (channel: NotificationChannelKey, patch: Record<string, any>) => {
      setPushDraft(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          channels: {
            ...prev.channels,
            [channel]: { ...(prev.channels as any)[channel], ...patch },
          },
        };
      });
    },
    []
  );

  /**
   * 推送渠道"保存"按钮 —— diff draft vs view，把 matrix + channel 顶部字段一起
   * 打成 PUT /api/settings/notification-config 的两份 patch；返回 view 再回灌。
   */
  const handlePushSave = useCallback(async () => {
    if (!pushDraft || !pushView) return;
    setPushSaving(true);
    try {
      // 1. matrix_updates: 只发与 view 不同的 cell
      const matrixUpdates: Partial<
        Record<NotificationEventKey, Partial<Record<NotificationChannelKey, boolean>>>
      > = {};
      const events: NotificationEventKey[] = [
        'daily_digest',
        'earnings_alert',
        'risk_alert',
        'weekly_review',
        'stock_bullish_event',
      ];
      const channels: NotificationChannelKey[] = ['feishu', 'email', 'wechat', 'sms'];
      for (const ev of events) {
        for (const ch of channels) {
          const draftCell = pushDraft.matrix[ev]?.[ch];
          const viewCell = pushView.matrix[ev]?.[ch];
          if (!draftCell?.applicable) continue;
          if (draftCell.enabled !== viewCell?.enabled) {
            matrixUpdates[ev] = matrixUpdates[ev] || {};
            (matrixUpdates[ev] as any)[ch] = draftCell.enabled;
          }
        }
      }
      // 2. channels_updates: 只发顶部 Card 字段（webhook_url / address / channel.enabled / phone）
      const channelsUpdates: any = {};
      if (pushDraft.channels.feishu.enabled !== pushView.channels.feishu.enabled) {
        channelsUpdates.feishu = { enabled: pushDraft.channels.feishu.enabled };
      }
      if (pushDraft.channels.feishu.webhook_url !== pushView.channels.feishu.webhook_url) {
        channelsUpdates.feishu = {
          ...(channelsUpdates.feishu || {}),
          webhook_url: pushDraft.channels.feishu.webhook_url,
        };
      }
      if (pushDraft.channels.email.enabled !== pushView.channels.email.enabled) {
        channelsUpdates.email = { enabled: pushDraft.channels.email.enabled };
      }
      if (pushDraft.channels.email.address !== pushView.channels.email.address) {
        channelsUpdates.email = {
          ...(channelsUpdates.email || {}),
          address: pushDraft.channels.email.address,
        };
      }
      if (pushDraft.channels.wechat.enabled !== pushView.channels.wechat.enabled) {
        channelsUpdates.wechat = { enabled: pushDraft.channels.wechat.enabled };
      }
      if (pushDraft.channels.sms.enabled !== pushView.channels.sms.enabled) {
        channelsUpdates.sms = { enabled: pushDraft.channels.sms.enabled };
      }
      if (pushDraft.channels.sms.phone !== pushView.channels.sms.phone) {
        channelsUpdates.sms = {
          ...(channelsUpdates.sms || {}),
          phone: pushDraft.channels.sms.phone,
        };
      }
      const view = await updateNotificationConfig({
        matrix_updates: matrixUpdates,
        channels_updates: channelsUpdates,
      });
      setPushView(view);
      setPushDraft(view);
      // 同步刷新 notifications tab 的 config —— 共用底层存储
      setConfig(view.raw);
      message.success('推送渠道配置已保存');
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存失败');
    } finally {
      setPushSaving(false);
    }
  }, [pushDraft, pushView]);

  /**
   * 推送渠道的"飞书测试发送"按钮 —— 走与 notifications tab 同款 daily-digest
   * preview endpoint（dry-run）拿到 payload + webhook 配置反馈，让用户验证
   * webhook URL 配置正确。点击后 message 提示结果。
   */
  const handlePushFeishuTest = useCallback(async () => {
    setPushFeishuTesting(true);
    try {
      const result = await previewDailyDigest();
      const own = result.per_user[0];
      if (own?.status === 'sent') {
        message.success('飞书 webhook 测试发送成功（dry-run）');
      } else if (own?.skip_reason) {
        message.warning(`测试跳过：${own.skip_reason}`);
      } else if (own?.error) {
        message.error(`测试失败：${own.error}`);
      } else {
        message.info('测试已完成，无具体反馈');
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : '测试发送失败');
    } finally {
      setPushFeishuTesting(false);
    }
  }, []);

  /** 计算 draft vs view 是否有未保存变更 —— "保存"按钮 disabled 判定 */
  const pushHasChanges = useMemo(() => {
    if (!pushDraft || !pushView) return false;
    if (JSON.stringify(pushDraft.matrix) !== JSON.stringify(pushView.matrix)) return true;
    if (JSON.stringify(pushDraft.channels) !== JSON.stringify(pushView.channels)) return true;
    return false;
  }, [pushDraft, pushView]);

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

        <Card
          title="微信公众号（订阅消息）"
          extra={
            <Switch
              checked={cfg.wechat.enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              onChange={v => patchConfig({ ...cfg, wechat: { ...cfg.wechat, enabled: v } })}
            />
          }
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="微信公众号订阅消息推送"
            description={
              <Space direction="vertical" size={4}>
                <Text>
                  通过微信公众号订阅 3 类模板消息：当日日报、业绩预告即时提醒、高优先级风控告警。
                  <Text strong>无需打开飞书</Text>，扫码关注公众号即可收到推送。
                </Text>
                <Text type="secondary">
                  后端需配置 env：<Text code>WECHAT_OA_APPID</Text> /
                  <Text code>WECHAT_OA_APPSECRET</Text> 及 3 个模板 id（
                  <Text code>WECHAT_TEMPLATE_DAILY_DIGEST</Text> /
                  <Text code>WECHAT_TEMPLATE_EARNINGS_FORECAST</Text> /
                  <Text code>WECHAT_TEMPLATE_RISK_ALERT</Text>）。
                </Text>
              </Space>
            }
          />

          <Form layout="vertical" disabled={!cfg.wechat.enabled}>
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label="绑定状态">
                  {cfg.wechat.openid ? (
                    <Space>
                      <Tag icon={<CheckCircleOutlined />} color="success">
                        已绑定
                      </Tag>
                      <Text type="secondary" copyable={{ tooltips: ['复制 openid', '已复制'] }}>
                        {cfg.wechat.openid}
                      </Text>
                      {cfg.wechat.bound_at && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          ({cfg.wechat.bound_at.slice(0, 19).replace('T', ' ')})
                        </Text>
                      )}
                    </Space>
                  ) : (
                    <Tag color="default">未绑定 — 点击「扫码绑定」开始</Tag>
                  )}
                </Form.Item>
              </Col>
              <Col xs={24} md={12} style={{ textAlign: 'right' }}>
                <Form.Item label=" ">
                  <Space>
                    <Button
                      type={cfg.wechat.openid ? 'default' : 'primary'}
                      icon={<QrcodeOutlined />}
                      loading={wechatBindLoading}
                      onClick={() => void handleWeChatBindStart()}
                      disabled={!cfg.wechat.enabled}
                    >
                      {cfg.wechat.openid ? '重新扫码' : '扫码绑定'}
                    </Button>
                    {cfg.wechat.openid && (
                      <Button
                        danger
                        icon={<DisconnectOutlined />}
                        loading={wechatUnbinding}
                        onClick={handleWeChatUnbind}
                      >
                        解除绑定
                      </Button>
                    )}
                  </Space>
                </Form.Item>
              </Col>
            </Row>

            <Divider style={{ margin: '12px 0' }} />
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item label="当日交易日报" tooltip="盘后 15:30 推送（与飞书并发）">
                  <Switch
                    checked={cfg.wechat.daily_digest}
                    onChange={v =>
                      patchConfig({ ...cfg, wechat: { ...cfg.wechat, daily_digest: v } })
                    }
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item label="业绩预告即时提醒" tooltip="持仓股 15 分钟级 + 自选盘后汇总">
                  <Switch
                    checked={cfg.wechat.earnings_alert}
                    onChange={v =>
                      patchConfig({ ...cfg, wechat: { ...cfg.wechat, earnings_alert: v } })
                    }
                  />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item
                  label="高优先级风控告警"
                  tooltip="HIGH 级即时 / MEDIUM 聚合（US-067 同步开放）"
                >
                  <Switch
                    checked={cfg.wechat.risk_alert}
                    onChange={v =>
                      patchConfig({ ...cfg, wechat: { ...cfg.wechat, risk_alert: v } })
                    }
                  />
                </Form.Item>
              </Col>
            </Row>

            <Divider style={{ margin: '12px 0' }} />
            <Space wrap>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={wechatSaving}
                onClick={() => void handleWeChatSave()}
              >
                保存微信配置
              </Button>
              <Button
                icon={<ExperimentOutlined />}
                loading={wechatTesting}
                disabled={!cfg.wechat.enabled || !cfg.wechat.openid || !cfg.wechat.daily_digest}
                onClick={() => void handleWeChatTest('daily_digest')}
              >
                测试·当日日报
              </Button>
              <Button
                icon={<ExperimentOutlined />}
                loading={wechatTesting}
                disabled={!cfg.wechat.enabled || !cfg.wechat.openid || !cfg.wechat.earnings_alert}
                onClick={() => void handleWeChatTest('earnings_alert')}
              >
                测试·业绩预告
              </Button>
              <Button
                icon={<ExperimentOutlined />}
                loading={wechatTesting}
                disabled={!cfg.wechat.enabled || !cfg.wechat.openid || !cfg.wechat.risk_alert}
                onClick={() => void handleWeChatTest('risk_alert')}
              >
                测试·风控告警
              </Button>
            </Space>
          </Form>
        </Card>

        <Card
          title="阿里云短信（SMS·实时风控告警）"
          extra={
            <Switch
              checked={cfg.sms.enabled}
              checkedChildren="启用"
              unCheckedChildren="关闭"
              onChange={v => patchConfig({ ...cfg, sms: { ...cfg.sms, enabled: v } })}
            />
          }
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="实时风控 webhook（HIGH 级告警）"
            description={
              <Space direction="vertical" size={4}>
                <Text>
                  任何 <Text strong>HIGH 级 RiskAlert</Text> 写入即立即并行触发飞书机器人 + 邮件 +
                  阿里云短信（按通道开关）。 防风暴：同一类告警（rule_id × symbol × level）30
                  分钟内只推一次。
                </Text>
                <Text type="secondary">
                  后端需配置 env：<Text code>ALIYUN_SMS_ACCESS_KEY_ID</Text> /
                  <Text code>ALIYUN_SMS_ACCESS_KEY_SECRET</Text> /
                  <Text code>ALIYUN_SMS_SIGN_NAME</Text> /
                  <Text code>ALIYUN_SMS_TEMPLATE_RISK_ALERT</Text>； 仅支持 11 位国内手机号（+86）。
                </Text>
              </Space>
            }
          />
          <Form layout="vertical" disabled={!cfg.sms.enabled}>
            <Form.Item
              label="接收手机号"
              extra="11 位国内号（如 13800138000），后端会自动 normalize +86 / 86 前缀与分隔符。"
            >
              <Input
                placeholder="13800138000"
                value={cfg.sms.phone || ''}
                onChange={e => patchConfig({ ...cfg, sms: { ...cfg.sms, phone: e.target.value } })}
                allowClear
                maxLength={20}
              />
            </Form.Item>
            <Row gutter={16}>
              <Col span={8}>
                <Form.Item
                  label="高优先级风控告警"
                  tooltip="HIGH 级 RiskAlert 实时短信推送；与同事件 30 min dedup 共用"
                >
                  <Switch
                    checked={cfg.sms.risk_alert}
                    onChange={v => patchConfig({ ...cfg, sms: { ...cfg.sms, risk_alert: v } })}
                  />
                </Form.Item>
              </Col>
            </Row>
            <Divider />
            <Space wrap>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={smsSaving}
                onClick={() => void handleSaveSmsConfig()}
              >
                保存 SMS 配置
              </Button>
              <Button
                icon={<EyeOutlined />}
                loading={realtimeAlertTesting}
                onClick={() => void handleRealtimeAlertTest(true)}
              >
                预览测试告警（dry-run）
              </Button>
              <Button
                icon={<SendOutlined />}
                loading={realtimeAlertTesting}
                disabled={!cfg.feishu.risk_alert && !cfg.email.risk_alert && !cfg.sms.risk_alert}
                onClick={() => void handleRealtimeAlertTest(false)}
              >
                立即发送一条测试告警（三通道）
              </Button>
            </Space>
            {realtimeAlertTestResult ? (
              <Alert
                style={{ marginTop: 12 }}
                type={
                  realtimeAlertTestResult.status === 'sent'
                    ? 'success'
                    : realtimeAlertTestResult.status === 'partial'
                      ? 'warning'
                      : realtimeAlertTestResult.status === 'skipped'
                        ? 'info'
                        : 'error'
                }
                showIcon
                message={`派发结果：${realtimeAlertTestResult.status}${
                  realtimeAlertTestResult.deduped ? '（30 min 内 dedup 命中）' : ''
                }${realtimeAlertTestResult.dry_run ? ' · dry-run' : ''}`}
                description={
                  <Space direction="vertical" size={2}>
                    {realtimeAlertTestResult.skip_reason ? (
                      <Text type="secondary">
                        {`跳过原因：${realtimeAlertTestResult.skip_reason}`}
                      </Text>
                    ) : null}
                    {realtimeAlertTestResult.channels.map(ch => (
                      <Text key={ch.channel}>
                        {`· ${ch.channel}：${ch.status}${ch.message ? ' — ' + ch.message : ''}`}
                      </Text>
                    ))}
                  </Space>
                }
              />
            ) : null}
          </Form>
        </Card>
      </Space>
    );
  };

  const renderPushChannels = () => {
    if (pushLoading && !pushView) {
      return (
        <Card>
          <div style={{ textAlign: 'center', padding: 48 }}>
            <Spin tip="加载推送渠道矩阵…" />
          </div>
        </Card>
      );
    }
    if (pushError) {
      return (
        <Alert
          type="error"
          message="加载失败"
          description={pushError}
          showIcon
          action={
            <Button size="small" onClick={() => void refreshPushChannels()}>
              重试
            </Button>
          }
        />
      );
    }
    if (!pushDraft) {
      return <Empty description="暂无推送渠道配置数据" />;
    }

    const draft = pushDraft;
    /**
     * PR-D (2026-06-29): 给每个事件加 `category` 字段 — Tag 渲染 "类别" 列.
     * routine=日常 / risk=风控 / opportunity=机会 (新增).
     */
    type EventCategory = 'routine' | 'risk' | 'opportunity';
    const CATEGORY_META: Record<EventCategory, { label: string; color: string }> = {
      routine: { label: '日常', color: 'default' },
      risk: { label: '风控', color: 'red' },
      opportunity: { label: '机会', color: 'green' },
    };
    const EVENTS: Array<{
      key: NotificationEventKey;
      label: string;
      hint: string;
      category: EventCategory;
    }> = [
      { key: 'daily_digest', label: '当日交易日报', hint: '15:30 收盘后推送', category: 'routine' },
      {
        key: 'earnings_alert',
        label: '业绩预告即时提醒',
        hint: '持仓股 + 自选股',
        category: 'risk',
      },
      { key: 'risk_alert', label: '高优先级风控告警', hint: 'HIGH 级实时分发', category: 'risk' },
      {
        key: 'weekly_review',
        label: '上周复盘报告',
        hint: '周一 08:00 HTML 邮件',
        category: 'routine',
      },
      {
        key: 'stock_bullish_event',
        label: '个股利好事件',
        hint: '持仓 / 自选 / 推荐过的股票收到关键公告 / 正面新闻 / KOL 集中关注 / 关注度突增',
        category: 'opportunity',
      },
    ];
    const CHANNELS: Array<{
      key: NotificationChannelKey;
      label: string;
    }> = [
      { key: 'feishu', label: '飞书机器人' },
      { key: 'email', label: '邮件' },
      // 微信公众号 / 阿里云短信 后端 dispatch 路径未接入，暂时从矩阵 UI 隐藏
      // （绑定 / 测试入口仍保留在 '通知设置' tab，等接入后再放回来）
      // { key: 'wechat', label: '微信公众号' },
      // { key: 'sms', label: '阿里云短信' },
    ];

    return (
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="推送渠道配置（US-080）"
          description={
            <Space direction="vertical" size={4}>
              <Text>
                把消息触达拆分成 4 个独立通道（飞书 / 邮件 / 微信 / 短信）与 4 类事件（当日日报 /
                业绩预告 / 风控告警 / 上周复盘）。
                上方分块配置每个通道的连接参数，下方矩阵勾选每类事件走哪些通道。
                顶部「保存全部」按钮一次落盘所有改动。
              </Text>
              <Text type="secondary">
                单元格灰色 &quot;—&quot; 表示该通道当前架构下不支持该事件类型（如短信不支持非告警类
                富文本）。完整文档：通知设置 tab 内每个 Card 顶部 Alert。
              </Text>
            </Space>
          }
        />

        {/* 顶部 3 个 Card：飞书 webhook URL / 邮件地址 / 微信绑定状态。
            注意：AC 列了 3 个 Card，但我们已实现 4 个通道，多展示一张 SMS 卡保持完整。 */}
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={8}>
            <Card
              size="small"
              title={
                <Space>
                  <SendOutlined />
                  <span>飞书 webhook</span>
                </Space>
              }
              extra={
                <Switch
                  size="small"
                  checked={draft.channels.feishu.enabled}
                  onChange={v => patchPushChannelField('feishu', { enabled: v })}
                />
              }
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Input
                  placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxxx"
                  value={draft.channels.feishu.webhook_url}
                  onChange={e => patchPushChannelField('feishu', { webhook_url: e.target.value })}
                  disabled={!draft.channels.feishu.enabled}
                  allowClear
                />
                <Space>
                  {draft.channels.feishu.configured ? (
                    <Tag icon={<CheckCircleOutlined />} color="success">
                      已配置
                    </Tag>
                  ) : (
                    <Tag color="default">未配置 — 将退回环境变量</Tag>
                  )}
                  <Button
                    size="small"
                    icon={<ExperimentOutlined />}
                    loading={pushFeishuTesting}
                    onClick={() => void handlePushFeishuTest()}
                    disabled={!draft.channels.feishu.enabled}
                  >
                    测试发送
                  </Button>
                </Space>
              </Space>
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card
              size="small"
              title={
                <Space>
                  <MailOutlined />
                  <span>邮件接收地址</span>
                </Space>
              }
              extra={
                <Switch
                  size="small"
                  checked={draft.channels.email.enabled}
                  onChange={v => patchPushChannelField('email', { enabled: v })}
                />
              }
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Input
                  placeholder="example@domain.com"
                  value={draft.channels.email.address}
                  onChange={e => patchPushChannelField('email', { address: e.target.value })}
                  disabled={!draft.channels.email.enabled}
                  allowClear
                />
                {draft.channels.email.configured ? (
                  <Tag icon={<CheckCircleOutlined />} color="success">
                    已配置 — SMTP 走后端 env
                  </Tag>
                ) : (
                  <Tag color="default">未配置 — 周报 / 风控邮件无法投递</Tag>
                )}
              </Space>
            </Card>
          </Col>
          <Col xs={24} lg={8}>
            <Card
              size="small"
              title={
                <Space>
                  <WechatOutlined />
                  <span>微信公众号绑定</span>
                </Space>
              }
              extra={
                <Switch
                  size="small"
                  checked={draft.channels.wechat.enabled}
                  onChange={v => patchPushChannelField('wechat', { enabled: v })}
                />
              }
            >
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {draft.channels.wechat.bound ? (
                  <Space direction="vertical" size={2}>
                    <Tag icon={<CheckCircleOutlined />} color="success">
                      已绑定
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      openid: {draft.channels.wechat.openid.slice(0, 12)}…
                    </Text>
                    {draft.channels.wechat.bound_at && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        绑定于: {draft.channels.wechat.bound_at.slice(0, 19).replace('T', ' ')}
                      </Text>
                    )}
                  </Space>
                ) : (
                  <Space direction="vertical" size={4}>
                    <Tag icon={<QrcodeOutlined />} color="default">
                      未绑定
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      切到「通知设置」tab → 微信卡片 → 「扫码绑定」生成二维码。
                    </Text>
                  </Space>
                )}
                <Button
                  size="small"
                  type="link"
                  icon={<QrcodeOutlined />}
                  onClick={() => {
                    setActiveKey('notify');
                    setNotifySubView('types');
                  }}
                  style={{ paddingLeft: 0 }}
                >
                  打开扫码界面 →
                </Button>
              </Space>
            </Card>
          </Col>
        </Row>

        {/* 矩阵：事件 × 通道。 不 applicable 的格显示 — */}
        <Card
          title={
            <Space>
              <NotificationOutlined />
              <span>事件 × 渠道订阅矩阵</span>
            </Space>
          }
          extra={
            <Space>
              {pushHasChanges && <Tag color="warning">有未保存的改动</Tag>}
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={pushSaving}
                disabled={!pushHasChanges}
                onClick={() => void handlePushSave()}
              >
                保存全部
              </Button>
            </Space>
          }
        >
          <Table
            size="small"
            rowKey="key"
            dataSource={EVENTS}
            pagination={false}
            bordered
            columns={[
              {
                title: '事件类型',
                dataIndex: 'label',
                width: 240,
                fixed: 'left',
                render: (label: string, row) => (
                  <Space direction="vertical" size={2}>
                    <Space size={6}>
                      <Tag color={CATEGORY_META[row.category].color}>
                        {CATEGORY_META[row.category].label}
                      </Tag>
                      <Text strong>{label}</Text>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {row.hint}
                    </Text>
                  </Space>
                ),
              },
              ...CHANNELS.map(ch => ({
                title: (
                  <Space size={4}>
                    {ch.key === 'feishu' && <SendOutlined />}
                    {ch.key === 'email' && <MailOutlined />}
                    {ch.key === 'wechat' && <WechatOutlined />}
                    {ch.key === 'sms' && <MessageOutlined />}
                    <span>{ch.label}</span>
                  </Space>
                ),
                key: ch.key,
                align: 'center' as const,
                render: (_: unknown, row: { key: NotificationEventKey }) => {
                  const cell = draft.matrix[row.key]?.[ch.key];
                  if (!cell?.applicable) {
                    return <Text type="secondary">—</Text>;
                  }
                  const channelEnabled = draft.channels[ch.key].enabled;
                  return (
                    <Checkbox
                      checked={cell.enabled}
                      onChange={e => togglePushMatrix(row.key, ch.key, e.target.checked)}
                      disabled={!channelEnabled}
                    />
                  );
                },
              })),
            ]}
          />
          <Divider style={{ margin: '12px 0' }} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            提示：单元格灰色 &quot;—&quot; 表示该通道当前架构下不支持该事件类型。通道总开关
            关闭时（顶部 Card 右上 Switch）所有事件勾选都不会生效——保存后仍会 disabled。
            订阅事件总数与右上角 KPI 同步。
            <br />
            <Tag color="green" style={{ marginRight: 4 }}>
              机会
            </Tag>
            类事件（如个股利好）由 CriticalAnnouncementPushService 触发, 持仓
            该股票的用户会自动收到一条 inbox RiskAlert（红点 + 详情）；勾选邮件 / 飞书
            后还会推送到对应通道。
          </Text>
        </Card>
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

  const renderPlaceholder = (target: { label: string; desc: string }) => (
    <Card>
      <Alert
        type="info"
        showIcon
        message={target.label}
        description={target.desc}
      />
    </Card>
  );

  // ---- Phase 9: 主 body render (4-5 个一级 tab, 每个内部 Segmented 切子视图) ----
  let body: React.ReactNode;
  if (activeKey === 'profile') {
    // ===== Tab 1: 个人 (资料 + API 密钥) =====
    body = (
      <>
        <div className="ws-tab-header">
          <h1 className="ws-tab-title">个人</h1>
          <p className="ws-tab-subtitle">
            修改个人资料 / 密码 / 头像, 或管理你绑定的 AI 模型 API 密钥。
          </p>
        </div>
        {renderProfileView()}
      </>
    );
  } else if (activeKey === 'notify') {
    // ===== Tab 2: 通知 (通知类型 + 推送渠道) =====
    body = (
      <>
        <div className="ws-tab-header">
          <h1 className="ws-tab-title">通知</h1>
          <p className="ws-tab-subtitle">
            配置你想在什么时机、用什么渠道收到提醒 — 飞书机器人 / 邮件 / 微信公众号 / 阿里云短信。
          </p>
        </div>
        {renderNotifications()}
      </>
    );
  } else {
    body = null;
  }
  // advanced + users tabs removed 2026-07-05
  return (
    <WorkspaceLayout
      title="账号设置"
      subtitle="个人资料、API 密钥、通知、风控、用户管理等设置入口。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={setActiveKey}
      hero={
        <WorkspaceHero
          eyebrow="Settings · 账号中心"
          title="账号与系统设置"
          subtitle="个人资料 · 通知中心 · 风控参数 · 用户管理 — 一站式控制中心"
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
      <WeChatBindModal
        open={wechatBindOpen}
        result={wechatBindResult}
        status={wechatBindStatus}
        onClose={handleWeChatBindClose}
        onRetry={() => void handleWeChatBindStart()}
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

// ---------------------------------------------------------------------------
// 微信绑定 Modal (US-066)
// ---------------------------------------------------------------------------

interface WeChatBindModalProps {
  open: boolean;
  result: WeChatBindQrCodeResult | null;
  status: null | 'pending' | 'bound' | 'expired';
  onClose: () => void;
  onRetry: () => void;
}

const WeChatBindModal: React.FC<WeChatBindModalProps> = ({
  open,
  result,
  status,
  onClose,
  onRetry,
}) => {
  return (
    <Modal
      title="扫码绑定微信公众号"
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      destroyOnClose
    >
      {!result ? (
        <div style={{ textAlign: 'center', padding: 32 }}>
          <Spin tip="生成微信参数二维码…" />
        </div>
      ) : (
        <Space direction="vertical" size="middle" align="center" style={{ width: '100%' }}>
          <Alert
            type={status === 'bound' ? 'success' : status === 'expired' ? 'warning' : 'info'}
            showIcon
            style={{ width: '100%' }}
            message={
              status === 'bound'
                ? '已成功绑定！'
                : status === 'expired'
                  ? '轮询超时（2 分钟），可点击"重新生成"再试'
                  : '请用微信扫码 → 关注公众号 → 自动绑定（页面会自动刷新）'
            }
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                Scene: <Text code>{result.scene_str}</Text> | 有效期:{' '}
                {Math.round(result.expire_seconds / 86400)} 天
              </Text>
            }
          />

          {result.qrcode_image_url ? (
            <img
              src={result.qrcode_image_url}
              alt="微信公众号绑定二维码"
              style={{
                width: 240,
                height: 240,
                border: '1px solid #f0f0f0',
                borderRadius: 8,
                padding: 8,
              }}
            />
          ) : (
            <Empty description="二维码图片地址缺失" />
          )}

          {result.current_openid && status !== 'bound' && (
            <Alert
              type="warning"
              showIcon
              style={{ width: '100%' }}
              message="该账号已存在绑定"
              description={
                <Text style={{ fontSize: 12 }}>
                  当前 openid: <Text code>{result.current_openid}</Text>
                  。新扫码会覆盖旧绑定（同一 user 同一时刻只能保留一个 openid）。
                </Text>
              }
            />
          )}

          <Space>
            <Button onClick={onClose}>{status === 'bound' ? '完成' : '稍后再试'}</Button>
            {status !== 'bound' && (
              <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
                重新生成
              </Button>
            )}
          </Space>
        </Space>
      )}
    </Modal>
  );
};

export default SettingsWorkspace;
