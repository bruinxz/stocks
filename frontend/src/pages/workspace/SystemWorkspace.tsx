/**
 * SystemWorkspace — Batch AL (2026-06-21) — 系统介绍 + 操作手册 + 更新日志 + 架构图 + 用户反馈.
 *
 * Phase 11 (2026-06-28) — 视觉与内容重写.
 *   - 内容: systemWorkspaceContent.ts 全面对齐 Phase 1-11 现状
 *     (7 menu / 81 cron / 29 策略 / 22 因子 / 7 通知 service / id=65 主盘).
 *   - 视觉: 系统介绍 tab 顶部加 system-hero (暗色 aurora) + bento 关键统计;
 *     intro/manual/changelog/architecture 4 个静态 tab 都包 motion 入场.
 *
 * Mount: /workspace/system
 *
 * 5 个 tab:
 *   - intro        系统介绍 (hero + bento + markdown 静态)
 *   - manual       操作手册 (markdown 静态)
 *   - changelog    更新日志 (markdown 静态)
 *   - architecture 架构图 (实时 SystemTopologyMap 组件 + markdown 文字说明)
 *   - feedback     用户反馈 (动态 — 新建 / 列表 / 解决回复)
 *
 * 反馈 tab 调:
 *   GET  /api/me/feedbacks?status=&limit=
 *   POST /api/me/feedbacks (multipart/form-data 含 images)
 *
 * 没有内嵌 admin resolve UI (本 story 只承诺用户提交 + 浏览; admin 通过 swagger /
 * 后续 admin 工作区操作 resolve).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Button,
  Card,
  Empty,
  Form,
  Image,
  Input,
  message,
  Modal,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from 'antd';
import {
  BookOutlined,
  HistoryOutlined,
  InboxOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  PartitionOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dayjs from 'dayjs';
import { motion, useReducedMotion } from 'framer-motion';
import WorkspaceLayout, { WorkspaceTab } from '../../components/layout/WorkspaceLayout';
import {
  SYSTEM_ARCHITECTURE_MD,
  SYSTEM_CHANGELOG_MD,
  SYSTEM_INTRO_MD,
  SYSTEM_MANUAL_MD,
} from '../../content/systemWorkspaceContent';
import SystemTopologyMap from '../../components/data/SystemTopologyMap';
import {
  UserFeedbackRow,
  createMyFeedback,
  listMyFeedbacks,
} from '../../services/userFeedbackService';
import { API_DOMAIN_URL } from '../../services/api';

const { Title, Paragraph, Text } = Typography;

type SystemTabKey = 'intro' | 'manual' | 'changelog' | 'architecture' | 'feedback';

const MARKDOWN_COMPONENTS = {
  h1: ({ node: _node, ...props }: any) => <Title level={2} {...props} />,
  h2: ({ node: _node, ...props }: any) => <Title level={3} {...props} />,
  h3: ({ node: _node, ...props }: any) => <Title level={4} {...props} />,
  h4: ({ node: _node, ...props }: any) => <Title level={5} {...props} />,
  p: ({ node: _node, ...props }: any) => <Paragraph {...props} />,
};

const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  pending: { label: '待处理', color: 'default' },
  in_progress: { label: '处理中', color: 'default' },
  resolved: { label: '已解决', color: 'green' },
  dismissed: { label: '已忽略', color: 'red' },
};

const CLASSIFICATION_LABEL: Record<string, { label: string; color: string }> = {
  bug: { label: 'Bug', color: 'red' },
  feature_request: { label: '功能建议', color: 'blue' },
  question: { label: '使用问题', color: 'blue' },
  praise: { label: '好评', color: 'green' },
  other: { label: '其他', color: 'default' },
};

function MarkdownCard({ content }: { content: string }) {
  return (
    <Card bodyStyle={{ padding: 24 }}>
      <div className="markdown-body" data-testid="system-workspace-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS as any}>
          {content}
        </ReactMarkdown>
      </div>
    </Card>
  );
}

/**
 * Phase 11 — 系统介绍 hero (暗色 aurora) + bento 关键统计.
 * 这是 intro tab 顶部的 "封面页" — 给用户一个 30 秒看完的整体印象, 详细内容在下方
 * markdown 里继续展开.
 *
 * 数字硬编码反映"当前架构状态" (与下方 markdown 同源, 改动需同步):
 *   - 81 cron (backend/src/constants/cronRegistry.ts 计数)
 *   - 29 策略 (backend/src/quant/engine/StrategyRegistry.ts register 次数)
 *   - 22 因子 / 8 analyzer (架构常量)
 *   - 7 notification service (backend/src/services 计数)
 *   - 11 Phase (迄今完成的视觉/架构 phase 数)
 *   - 5500 A 股覆盖
 */
const SYSTEM_HERO_STATS: Array<{ value: string; label: string; suffix?: string }> = [
  { value: '5,500', label: 'A 股覆盖', suffix: '+' },
  { value: '81', label: 'Cron 任务' },
  { value: '29', label: '策略' },
  { value: '22', label: '因子' },
];

const SYSTEM_BENTO: Array<{ eyebrow: string; title: string; body: string; list?: string[] }> = [
  {
    eyebrow: '主菜单',
    title: '5 通用 + 2 admin',
    body: 'Phase 9 精简后的稳态结构. 新手只看主页 + 简易版即可上手, admin 多 2 项管理入口.',
    list: ['主页', '简易版', '持仓', '实验室', '设置', '+ 数据中心 (admin)', '+ 系统介绍 (admin)'],
  },
  {
    eyebrow: '通知 / 告警',
    title: '7 service · 两层',
    body: 'Phase 10 通知 audit 完成: 个人 (drawer/SSE) + OPS 群 (card) 严格收口, 不双推.',
    list: [
      'NotificationService',
      'RealtimeAlertDispatcher',
      'SystemAdminAlertPusher',
      'FeishuBotWebhookService',
      'EmailNotificationService',
      'RiskAlertService',
      'webhookFailOpen',
    ],
  },
  {
    eyebrow: 'AI 分析引擎',
    title: '8 analyzer 并发',
    body: 'Fundamental / Technical / MoneyFlow / Sentiment / News / IndustryRegime / Risk / Announcement, 走 shadow → hard 灰度.',
  },
  {
    eyebrow: '风控',
    title: '8 闸门 fail-closed',
    body: 'Pre-trade compliance + 涨跌停 + T+1 + 行业集中度 + Drawdown + 黑天鹅 + 限售解禁, 风控不可用 = 拒单.',
  },
  {
    eyebrow: '复盘闭环',
    title: '日 / 周 / 月 / 季',
    body: 'DailyAttribution → AIDiary → ErrorPatternReport → ImprovementSuggestion → 用户 apply → 30 天效果回采.',
  },
  {
    eyebrow: '实盘',
    title: '综合策略主盘 (id=65)',
    body: '当前唯一活跃实盘. 模拟盘可多开横向对比策略组合, 30min 对账主动告警.',
  },
];

const SystemHero: React.FC = () => {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      className="system-hero"
      initial={reduceMotion ? false : { opacity: 0, y: 12 }}
      animate={reduceMotion ? undefined : { opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="system-hero-eyebrow">QuantX · A 股 Alpha 平台</div>
      <h1 className="system-hero-title">让新手也能自动化在 A 股赚钱</h1>
      <p className="system-hero-blurb">
        多策略组合 + 严格风控 + 持续迭代. 数据 / 因子 / 策略 / 风控 / 执行 / 复盘
        六层闭环, 每一笔交易都可追溯、可解释、可复盘.
      </p>
      <div className="system-hero-stats">
        {SYSTEM_HERO_STATS.map((s, i) => {
          const inner = (
            <div className="system-hero-stat">
              <div className="system-hero-stat-value">
                {s.value}
                {s.suffix ? <span className="system-hero-stat-suffix">{s.suffix}</span> : null}
              </div>
              <div className="system-hero-stat-label">{s.label}</div>
            </div>
          );
          if (reduceMotion) return <div key={s.label}>{inner}</div>;
          return (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.32,
                delay: 0.15 + i * 0.06,
                ease: [0.22, 1, 0.36, 1],
              }}
            >
              {inner}
            </motion.div>
          );
        })}
      </div>
    </motion.section>
  );
};

const SystemBento: React.FC = () => {
  const reduceMotion = useReducedMotion();
  return (
    <div className="system-bento">
      {SYSTEM_BENTO.map((card, i) => {
        const inner = (
          <article className="system-bento-card">
            <div className="system-bento-card-eyebrow">{card.eyebrow}</div>
            <h3 className="system-bento-card-title">{card.title}</h3>
            <p className="system-bento-card-body">{card.body}</p>
            {card.list && card.list.length > 0 ? (
              <ul className="system-bento-card-list">
                {card.list.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
          </article>
        );
        if (reduceMotion) return <div key={card.title}>{inner}</div>;
        return (
          <motion.div
            key={card.title}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{
              duration: 0.32,
              delay: Math.min(i * 0.05, 0.3),
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            {inner}
          </motion.div>
        );
      })}
    </div>
  );
};

/**
 * Markdown tab with framer-motion entry — 用于 manual / changelog / architecture 三个
 * tab, 切换时有 fade-up 入场. intro tab 不走这个 (intro 有自己的 hero + bento).
 */
function MotionMarkdownCard({ content }: { content: string }) {
  const reduceMotion = useReducedMotion();
  const card = <MarkdownCard content={content} />;
  if (reduceMotion) return card;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      {card}
    </motion.div>
  );
}

function buildImageSrc(url: string): string {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${API_DOMAIN_URL}${url}`;
}

function FeedbackTab() {
  const [list, setList] = useState<UserFeedbackRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [imageFiles, setImageFiles] = useState<File[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listMyFeedbacks({ limit: 50 });
      setList(items);
    } catch (err: any) {
      message.error(`反馈列表加载失败: ${err?.message || err}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleOpenCreate = () => {
    form.resetFields();
    setImageFiles([]);
    setModalOpen(true);
  };

  const handleSubmit = async () => {
    let values: { title: string; description: string };
    try {
      values = await form.validateFields();
    } catch {
      return;
    }
    setSubmitting(true);
    try {
      await createMyFeedback({
        title: values.title,
        description: values.description,
        images: imageFiles,
      });
      message.success('反馈已提交，30 分钟内 AI 会自动分类');
      setModalOpen(false);
      await refresh();
    } catch (err: any) {
      message.error(`提交失败: ${err?.response?.data?.message || err?.message || err}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        size="small"
        bodyStyle={{ padding: '12px 16px' }}
        title={
          <Space>
            <MessageOutlined />
            <Text strong>用户反馈</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              文字 + 图片均可；30 min 内 AI 自动分类，解决后下方绿底回复
            </Text>
          </Space>
        }
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
              刷新
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreate}>
              新建反馈
            </Button>
          </Space>
        }
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : list.length === 0 ? (
          <Empty description="还没有提交过反馈" />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {list.map(row => {
              const statusInfo = STATUS_LABEL[row.status] || {
                label: row.status,
                color: 'default',
              };
              const classInfo = row.ai_classification
                ? CLASSIFICATION_LABEL[row.ai_classification]
                : null;
              const isResolved = row.status === 'resolved';
              return (
                <Card
                  key={row.id}
                  size="small"
                  data-testid={`user-feedback-row-${row.id}`}
                  bodyStyle={{ padding: 12 }}
                >
                  <Space direction="vertical" size={6} style={{ width: '100%' }}>
                    <Space wrap>
                      <Text strong style={{ fontSize: 14 }}>
                        {row.title}
                      </Text>
                      <Tag color={statusInfo.color}>{statusInfo.label}</Tag>
                      {classInfo && <Tag color={classInfo.color}>AI: {classInfo.label}</Tag>}
                      {row.ai_priority !== null && (
                        <Tag color={(row.ai_priority || 0) >= 4 ? 'volcano' : 'default'}>
                          优先级 {row.ai_priority}
                        </Tag>
                      )}
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {dayjs(row.created_at).format('YYYY-MM-DD HH:mm')}
                      </Text>
                    </Space>
                    <Paragraph style={{ marginBottom: 0, whiteSpace: 'pre-wrap' }}>
                      {row.description}
                    </Paragraph>
                    {row.image_urls && row.image_urls.length > 0 && (
                      <Image.PreviewGroup>
                        <Space wrap>
                          {row.image_urls.map(url => (
                            <Image
                              key={url}
                              src={buildImageSrc(url)}
                              width={96}
                              height={96}
                              style={{ objectFit: 'cover', borderRadius: 8 }}
                            />
                          ))}
                        </Space>
                      </Image.PreviewGroup>
                    )}
                    {isResolved && row.resolution_note && (
                      <Card
                        size="small"
                        bodyStyle={{ padding: 12 }}
                        style={{
                          background: '#f6ffed',
                          borderColor: '#b7eb8f',
                          marginTop: 8,
                        }}
                      >
                        <Space direction="vertical" size={4} style={{ width: '100%' }}>
                          <Text strong style={{ color: '#16a34a' }}>
                            系统回复
                          </Text>
                          <Paragraph
                            style={{
                              marginBottom: 0,
                              whiteSpace: 'pre-wrap',
                              color: '#3f6600',
                            }}
                          >
                            {row.resolution_note}
                          </Paragraph>
                          <Space size={12} wrap>
                            {row.resolved_at && (
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                解决于 {dayjs(row.resolved_at).format('YYYY-MM-DD HH:mm')}
                              </Text>
                            )}
                            {row.resolution_commit_hash && (
                              <Tag color="green">
                                commit {row.resolution_commit_hash.slice(0, 7)}
                              </Tag>
                            )}
                            {row.resolution_pr_number !== null &&
                              row.resolution_pr_number !== undefined && (
                                <Tag color="green">PR #{row.resolution_pr_number}</Tag>
                              )}
                          </Space>
                        </Space>
                      </Card>
                    )}
                  </Space>
                </Card>
              );
            })}
          </Space>
        )}
      </Card>

      <Modal
        open={modalOpen}
        title="新建用户反馈"
        onCancel={() => setModalOpen(false)}
        onOk={handleSubmit}
        confirmLoading={submitting}
        okText="提交"
        cancelText="取消"
        width={640}
        destroyOnClose
      >
        <Form layout="vertical" form={form}>
          <Form.Item
            name="title"
            label="标题"
            rules={[
              { required: true, message: '请填写标题' },
              { max: 200, message: '标题不能超过 200 字' },
            ]}
          >
            <Input placeholder="例如：登录页一直闪 / 希望增加策略 XX" />
          </Form.Item>
          <Form.Item
            name="description"
            label="详细描述"
            rules={[{ required: true, message: '请填写描述' }]}
          >
            <Input.TextArea
              placeholder="详细说说你遇到的问题或建议..."
              rows={5}
              maxLength={5000}
              showCount
            />
          </Form.Item>
          <Form.Item label="附件图片（最多 3 张，每张 ≤ 1.5 MB；总大小 ≤ 5 MB）">
            <Upload.Dragger
              multiple
              accept="image/jpeg,image/png,image/gif,image/webp"
              beforeUpload={file => {
                // 单张 ≤ 1.5 MB (nginx client_max_body_size 5 MB, 留 buffer 给 multipart overhead)
                const MAX_BYTES = 1.5 * 1024 * 1024;
                if (file.size > MAX_BYTES) {
                  message.warning(
                    `图片 ${file.name} 超过 1.5 MB (${(file.size / 1024 / 1024).toFixed(2)} MB)，请压缩后再上传`
                  );
                  return Upload.LIST_IGNORE;
                }
                setImageFiles(prev => {
                  if (prev.length >= 3) {
                    message.warning('最多 3 张，请删除一张再添加');
                    return prev;
                  }
                  return [...prev, file];
                });
                return false;
              }}
              onRemove={file => {
                setImageFiles(prev =>
                  prev.filter(f => f.name !== file.name || f.size !== file.size)
                );
              }}
              fileList={imageFiles.map((f, idx) => ({
                uid: `${f.name}-${f.size}-${idx}`,
                name: f.name,
                status: 'done' as const,
              }))}
            >
              <p className="ant-upload-drag-icon">
                <InboxOutlined />
              </p>
              <p className="ant-upload-text">点击或拖拽图片到此处</p>
              <p className="ant-upload-hint">
                支持 JPEG / PNG / GIF / WEBP；最多 3 张 × 1.5 MB（nginx 限制 5 MB）
              </p>
            </Upload.Dragger>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

const SystemWorkspace: React.FC = () => {
  const [activeKey, setActiveKey] = useState<SystemTabKey>('intro');

  const tabs: WorkspaceTab[] = useMemo(
    () => [
      { key: 'intro', label: '系统介绍', icon: <InfoCircleOutlined /> },
      { key: 'manual', label: '操作手册', icon: <BookOutlined /> },
      { key: 'changelog', label: '更新日志', icon: <HistoryOutlined /> },
      { key: 'architecture', label: '架构图', icon: <PartitionOutlined /> },
      { key: 'feedback', label: '用户反馈', icon: <MessageOutlined /> },
    ],
    []
  );

  const renderTab = () => {
    switch (activeKey) {
      case 'intro':
        return (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <SystemHero />
            <SystemBento />
            <MotionMarkdownCard content={SYSTEM_INTRO_MD} />
          </Space>
        );
      case 'manual':
        return <MotionMarkdownCard content={SYSTEM_MANUAL_MD} />;
      case 'changelog':
        return <MotionMarkdownCard content={SYSTEM_CHANGELOG_MD} />;
      case 'architecture':
        // Batch AQ (2026-06-21) — 把实时拓扑组件 <SystemTopologyMap /> 从 DataWorkspace
        // 迁过来 (用户原话: 架构图应该挂在 "系统介绍" 而不是 "数据中心"), 下方保留
        // SYSTEM_ARCHITECTURE_MD 作为文字说明 (节点 ID / 数据流向解释).
        return (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <SystemTopologyMap />
            <MotionMarkdownCard content={SYSTEM_ARCHITECTURE_MD} />
          </Space>
        );
      case 'feedback':
        return <FeedbackTab />;
      default:
        return <Empty description="未知 tab" />;
    }
  };

  return (
    <WorkspaceLayout
      title="系统介绍"
      subtitle="系统如何实现交易闭环、操作手册、更新日志、架构图、用户反馈。"
      tabs={tabs}
      activeKey={activeKey}
      onTabChange={k => setActiveKey(k as SystemTabKey)}
    >
      {/* Phase 16 — sc-datav 借鉴: admin 区 grid 背景 (与 DataWorkspace 同款). */}
      <div className="workspace-grid-bg" style={{ padding: '8px 0', minHeight: '100%' }}>
        {renderTab()}
      </div>
    </WorkspaceLayout>
  );
};

export default SystemWorkspace;
