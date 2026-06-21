/**
 * SystemWorkspace — Batch AL (2026-06-21) — 系统介绍 + 操作手册 + 更新日志 + 架构图 + 用户反馈.
 *
 * Mount: /workspace/system
 *
 * 5 个 tab:
 *   - intro        系统介绍 (markdown 静态)
 *   - manual       操作手册 (markdown 静态)
 *   - changelog    更新日志 (markdown 静态)
 *   - architecture 架构图 (markdown 静态 + 跳转到 DataWorkspace 实时 SystemTopologyMap 提示)
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
  in_progress: { label: '处理中', color: 'gold' },
  resolved: { label: '已解决', color: 'green' },
  dismissed: { label: '已忽略', color: 'red' },
};

const CLASSIFICATION_LABEL: Record<string, { label: string; color: string }> = {
  bug: { label: 'Bug', color: 'red' },
  feature_request: { label: '功能建议', color: 'blue' },
  question: { label: '使用问题', color: 'cyan' },
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
                              style={{ objectFit: 'cover', borderRadius: 4 }}
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
                          <Text strong style={{ color: '#389e0d' }}>
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
        return <MarkdownCard content={SYSTEM_INTRO_MD} />;
      case 'manual':
        return <MarkdownCard content={SYSTEM_MANUAL_MD} />;
      case 'changelog':
        return <MarkdownCard content={SYSTEM_CHANGELOG_MD} />;
      case 'architecture':
        // Batch AQ (2026-06-21) — 把实时拓扑组件 <SystemTopologyMap /> 从 DataWorkspace
        // 迁过来 (用户原话: 架构图应该挂在 "系统介绍" 而不是 "数据中心"), 下方保留
        // SYSTEM_ARCHITECTURE_MD 作为文字说明 (节点 ID / 数据流向解释).
        return (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <SystemTopologyMap />
            <MarkdownCard content={SYSTEM_ARCHITECTURE_MD} />
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
      {renderTab()}
    </WorkspaceLayout>
  );
};

export default SystemWorkspace;
