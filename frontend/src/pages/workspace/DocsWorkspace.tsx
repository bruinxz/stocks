/**
 * DocsWorkspace — 文档浏览 + 飞书式评论 (admin only)
 *
 * 布局: 三栏
 *   左 340px: 文件树
 *   中 flex 1: markdown 渲染 (可对 heading 加评论)
 *   右 380px: 评论面板 (thread 列表 + 输入框)
 *
 * URL: /workspace/docs?path=xxx.md
 *
 * 评论锚定策略:
 *   - 每个 <h2>/<h3>/<h4> 渲染时带 data-anchor 属性 (heading path)
 *   - hover 一个 heading 时右侧显示 💬 按钮
 *   - 点击 💬 → 右侧面板滚动到"新建评论" + 预填 anchor_key
 *   - 已有评论的 heading 会带一个数字 badge
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Tree,
  Typography,
  message,
} from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  CheckCircleOutlined,
  CommentOutlined,
  DeleteOutlined,
  FileMarkdownOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  MessageOutlined,
  ReloadOutlined,
  RobotOutlined,
  UserOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dayjs from 'dayjs';
import { DocsTreeNode, docsService } from '../../services/docsService';
import {
  CommentThread,
  CreateCommentInput,
  DocComment,
  docsCommentsService,
} from '../../services/docsCommentsService';

const { Title, Paragraph, Text } = Typography;
const { TextArea } = Input;

// ============================================================
// 评论锚定辅助
// ============================================================

/**
 * 从 heading DOM node 构造 anchor_key
 * 例如: <h2>0. 全局约束</h2>  → "H2:0. 全局约束"
 * 嵌套: <h3> 时向前找最近 h1/h2 → "H2:0. 全局约束 > H3:0.1 正确性优先"
 */
function buildHeadingAnchor(el: HTMLElement): { key: string; snippet: string } {
  const level = parseInt(el.tagName.substring(1), 10);
  const text = (el.textContent || '').trim().slice(0, 100);

  // 向上寻找更高层级 heading
  const parts: string[] = [`H${level}:${text}`];
  let cursor: Element | null = el.previousElementSibling;
  let targetLevel = level - 1;
  while (cursor && targetLevel > 0) {
    if (/^H[1-6]$/i.test(cursor.tagName)) {
      const l = parseInt(cursor.tagName.substring(1), 10);
      if (l === targetLevel) {
        parts.unshift(`H${l}:${(cursor.textContent || '').trim().slice(0, 100)}`);
        targetLevel--;
      } else if (l < targetLevel) {
        // 跳过了 (例如 h4 直接跟 h2), 更新 targetLevel
        parts.unshift(`H${l}:${(cursor.textContent || '').trim().slice(0, 100)}`);
        targetLevel = l - 1;
      }
    }
    cursor = cursor.previousElementSibling;
  }

  return { key: parts.join(' > '), snippet: text };
}

// ============================================================
// Markdown 渲染器 (加 anchor + hover 按钮)
// ============================================================

function buildMarkdownComponents(onAddComment: (key: string, snippet: string) => void) {
  const makeHeading = (level: number) => {
    const HeadingRenderer = ({ node: _node, children, ...props }: any) => {
      const text = React.Children.toArray(children).join('').toString().trim();
      const anchor = `H${level}:${text.slice(0, 100)}`;
      const antdLevel = Math.min(Math.max(level, 1), 5) as 1 | 2 | 3 | 4 | 5;

      return (
        <div
          className="doc-heading-wrapper"
          data-anchor-key={anchor}
          data-anchor-snippet={text.slice(0, 100)}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <Title level={antdLevel} style={{ flex: 1, margin: 0 }} {...props}>
            {children}
          </Title>
          <Tooltip title="对此段落添加评论">
            <Button
              className="doc-heading-comment-btn"
              type="text"
              size="small"
              icon={<CommentOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onAddComment(anchor, text.slice(0, 100));
              }}
              style={{ opacity: 0, transition: 'opacity 0.2s', flexShrink: 0 }}
            />
          </Tooltip>
        </div>
      );
    };
    HeadingRenderer.displayName = `MarkdownHeading${level}`;
    return HeadingRenderer;
  };

  return {
    h1: makeHeading(1),
    h2: makeHeading(2),
    h3: makeHeading(3),
    h4: makeHeading(4),
    p: ({ node: _node, ...props }: any) => <Paragraph {...props} />,
    code: ({ node: _node, inline, className, children, ...props }: any) => {
      return inline ? (
        <code
          style={{
            background: '#f5f5f5',
            padding: '2px 6px',
            borderRadius: 3,
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: '0.9em',
          }}
          {...props}
        >
          {children}
        </code>
      ) : (
        <pre
          style={{
            background: '#f5f5f5',
            padding: 12,
            borderRadius: 4,
            overflow: 'auto',
            fontFamily: 'Menlo, Consolas, monospace',
            fontSize: '0.9em',
          }}
        >
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
      );
    },
  };
}

// ============================================================
// Tree helpers (来自原 DocsWorkspace)
// ============================================================

function convertToTreeData(node: DocsTreeNode, threadCounts?: Record<string, number>): DataNode {
  const key = node.path || node.name;
  const isFile = node.type === 'file';
  const openCount = isFile ? threadCounts?.[node.path] || 0 : 0;

  const titleNode = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 8,
        maxWidth: '100%',
        overflow: 'hidden',
        verticalAlign: 'middle',
      }}
      title={
        isFile && node.mtime
          ? `${node.name}  (${dayjs(node.mtime).format('YYYY-MM-DD HH:mm')})`
          : node.name
      }
    >
      <span
        style={{
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 200,
          display: 'inline-block',
          verticalAlign: 'baseline',
        }}
      >
        {node.name}
      </span>
      {openCount > 0 && (
        <Tag color="orange" style={{ fontSize: 10, padding: '0 4px', margin: 0, lineHeight: '16px' }}>
          {openCount}
        </Tag>
      )}
      {isFile && node.mtime && (
        <span
          style={{
            fontSize: 11,
            color: 'rgba(0,0,0,0.45)',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {dayjs(node.mtime).format('MM-DD')}
        </span>
      )}
    </span>
  );

  return {
    key,
    title: titleNode,
    icon: isFile ? <FileMarkdownOutlined /> : <FolderOutlined />,
    isLeaf: isFile,
    children: node.children?.map((c) => convertToTreeData(c, threadCounts)),
  };
}

function collectDirKeys(node: DocsTreeNode, acc: string[] = []): string[] {
  if (node.type === 'dir') {
    acc.push(node.path || node.name);
    node.children?.forEach((c) => collectDirKeys(c, acc));
  }
  return acc;
}

function collectAncestorKeys(targetPath: string): string[] {
  const parts = targetPath.split('/');
  parts.pop();
  const ancestors: string[] = ['.'];
  let cur = '';
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p;
    ancestors.push(cur);
  }
  return ancestors;
}

// ============================================================
// 评论 Thread 组件
// ============================================================

interface CommentItemProps {
  comment: DocComment;
  currentUserId: number;
  isAdmin: boolean;
  isRoot: boolean;
  onReply?: (parentId: number, threadRootId: number) => void;
  onEdit?: (id: number, content: string) => void;
  onDelete?: (id: number) => void;
  onToggleResolved?: (id: number, current: 'open' | 'resolved') => void;
}

const CommentItem: React.FC<CommentItemProps> = ({
  comment,
  currentUserId,
  isAdmin,
  isRoot,
  onReply,
  onEdit,
  onDelete,
  onToggleResolved,
}) => {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(comment.content);
  const canEdit = comment.user_id === currentUserId || isAdmin;
  const authorName = comment.user?.display_name || comment.user?.username || `user#${comment.user_id}`;
  const isAI = comment.author_kind === 'ai';

  return (
    <div style={{ padding: '8px 0', borderTop: isRoot ? 'none' : '1px dashed #f0f0f0' }}>
      <Space size={8} align="start" style={{ width: '100%' }}>
        <Avatar
          size={26}
          icon={isAI ? <RobotOutlined /> : <UserOutlined />}
          style={{ background: isAI ? '#722ed1' : '#1677ff', flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ marginBottom: 4 }}>
            <Text strong style={{ fontSize: 13 }}>
              {authorName}
            </Text>
            {isAI && <Tag color="purple" style={{ marginLeft: 6 }}>AI</Tag>}
            <Text type="secondary" style={{ marginLeft: 8, fontSize: 11 }}>
              {dayjs(comment.created_at).format('MM-DD HH:mm')}
            </Text>
            {isRoot && comment.status === 'resolved' && (
              <Tag color="green" style={{ marginLeft: 6 }}>已解决</Tag>
            )}
          </div>
          {editing ? (
            <div>
              <TextArea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                autoSize={{ minRows: 2, maxRows: 6 }}
                style={{ marginBottom: 8 }}
              />
              <Space size={6}>
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    if (onEdit) onEdit(comment.id, editText);
                    setEditing(false);
                  }}
                >
                  保存
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setEditText(comment.content);
                    setEditing(false);
                  }}
                >
                  取消
                </Button>
              </Space>
            </div>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6 }}>
              {comment.content}
            </div>
          )}
          {!editing && (
            <Space size={4} style={{ marginTop: 6 }}>
              {onReply && (
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 4px', fontSize: 12 }}
                  onClick={() => onReply(comment.id, comment.thread_root_id)}
                >
                  回复
                </Button>
              )}
              {canEdit && (
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 4px', fontSize: 12 }}
                  onClick={() => setEditing(true)}
                >
                  编辑
                </Button>
              )}
              {isRoot && onToggleResolved && (
                <Button
                  size="small"
                  type="link"
                  style={{ padding: '0 4px', fontSize: 12 }}
                  onClick={() => onToggleResolved(comment.id, comment.status)}
                >
                  {comment.status === 'resolved' ? '取消解决' : '标记解决'}
                </Button>
              )}
              {canEdit && onDelete && (
                <Popconfirm
                  title={isRoot ? '删除整个 thread?' : '删除这条回复?'}
                  onConfirm={() => onDelete(comment.id)}
                >
                  <Button
                    size="small"
                    type="link"
                    danger
                    style={{ padding: '0 4px', fontSize: 12 }}
                  >
                    删除
                  </Button>
                </Popconfirm>
              )}
            </Space>
          )}
        </div>
      </Space>
    </div>
  );
};

// ============================================================
// DocsWorkspace 主组件
// ============================================================

const DocsWorkspace: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlPath = searchParams.get('path');

  const [tree, setTree] = useState<DocsTreeNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(urlPath);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileMtime, setFileMtime] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [threadCounts, setThreadCounts] = useState<Record<string, number>>({});

  const [newAnchor, setNewAnchor] = useState<{ key: string; snippet: string } | null>(null);
  const [newContent, setNewContent] = useState('');
  const [replyTo, setReplyTo] = useState<{ parentId: number; threadRootId: number } | null>(null);
  const [posting, setPosting] = useState(false);
  const commentPanelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);

  const currentUser = useMemo(() => {
    const raw = localStorage.getItem('user');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, []);
  const currentUserId = currentUser?.id || 0;
  const isAdmin = currentUser?.role === 'admin';

  // ============ 加载 tree ============
  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const res = await docsService.getTree();
      if (res.success && res.data) {
        setTree(res.data);
        setExpandedKeys(collectDirKeys(res.data));
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '加载文档树失败');
    } finally {
      setTreeLoading(false);
    }
  }, []);

  // ============ 加载文档 ============
  const loadFile = useCallback(
    async (path: string, updateUrl = true) => {
      setFileLoading(true);
      try {
        const res = await docsService.getFile(path);
        if (res.success && res.data) {
          setFileContent(res.data.content);
          setFileMtime(res.data.mtime);
          setSelectedPath(path);
          if (updateUrl) {
            setSearchParams({ path }, { replace: false });
          }
          setExpandedKeys((prev) => {
            const ancestors = collectAncestorKeys(path);
            const merged = new Set([...prev.map(String), ...ancestors]);
            return Array.from(merged);
          });
        }
      } catch (err: any) {
        message.error(err?.response?.data?.message || '加载文档失败');
      } finally {
        setFileLoading(false);
      }
    },
    [setSearchParams]
  );

  // ============ 加载评论 ============
  const loadComments = useCallback(
    async (path: string) => {
      setCommentsLoading(true);
      try {
        const res = await docsCommentsService.list(path, showResolved);
        if (res.success && res.data) {
          setThreads(res.data.threads);
        }
      } catch (err: any) {
        // 忽略, 评论加载失败不影响文档查看
        setThreads([]);
      } finally {
        setCommentsLoading(false);
      }
    },
    [showResolved]
  );

  // ============ 加载 threadCounts (左侧树用) ============
  const loadThreadCounts = useCallback(async () => {
    try {
      const res = await docsCommentsService.stats();
      if (res.success && res.data) {
        const map: Record<string, number> = {};
        Object.entries(res.data).forEach(([path, s]) => {
          map[path] = s.open;
        });
        setThreadCounts(map);
      }
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    loadTree();
    loadThreadCounts();
  }, [loadTree, loadThreadCounts]);

  useEffect(() => {
    if (urlPath && urlPath !== selectedPath) {
      loadFile(urlPath, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPath]);

  useEffect(() => {
    if (selectedPath) {
      loadComments(selectedPath);
    } else {
      setThreads([]);
    }
  }, [selectedPath, showResolved, loadComments]);

  // ============ 点击 heading 旁的 💬 按钮 ============
  const handleAddCommentToAnchor = useCallback((key: string, snippet: string) => {
    setNewAnchor({ key, snippet });
    setReplyTo(null);
    setNewContent('');
    // 滚到右侧输入框
    setTimeout(() => {
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  }, []);

  // ============ 点击某评论"回复" ============
  const handleReply = (parentId: number, threadRootId: number) => {
    setReplyTo({ parentId, threadRootId });
    setNewAnchor(null);  // 回复不覆盖 anchor
    setNewContent('');
    setTimeout(() => {
      composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }, 100);
  };

  // ============ 提交评论 ============
  const handleSubmit = async () => {
    if (!selectedPath) {
      message.warning('请先选择一个文档');
      return;
    }
    if (!newContent.trim()) {
      message.warning('评论内容不能为空');
      return;
    }

    let payload: CreateCommentInput;

    if (replyTo) {
      // 回复某评论: anchor 沿用 thread 根评论的
      const root = threads.find((t) => t.root.id === replyTo.threadRootId)?.root;
      if (!root) {
        message.error('找不到 thread 根评论');
        return;
      }
      payload = {
        doc_path: selectedPath,
        anchor_type: root.anchor_type,
        anchor_key: root.anchor_key,
        anchor_snippet: root.anchor_snippet || undefined,
        content: newContent,
        parent_id: replyTo.parentId,
      };
    } else if (newAnchor) {
      // 对某 heading 发新评论
      payload = {
        doc_path: selectedPath,
        anchor_type: 'heading',
        anchor_key: newAnchor.key,
        anchor_snippet: newAnchor.snippet,
        content: newContent,
      };
    } else {
      // 无 anchor, 整文档级评论
      payload = {
        doc_path: selectedPath,
        anchor_type: 'doc',
        anchor_key: '__doc_level__',
        content: newContent,
      };
    }

    setPosting(true);
    try {
      const res = await docsCommentsService.create(payload);
      if (res.success) {
        message.success('已发布');
        setNewContent('');
        setNewAnchor(null);
        setReplyTo(null);
        loadComments(selectedPath);
        loadThreadCounts();
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '发布失败');
    } finally {
      setPosting(false);
    }
  };

  // ============ 编辑评论 ============
  const handleEdit = async (id: number, content: string) => {
    try {
      const res = await docsCommentsService.update(id, { content });
      if (res.success) {
        message.success('已保存');
        if (selectedPath) loadComments(selectedPath);
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '保存失败');
    }
  };

  // ============ 删除评论 ============
  const handleDelete = async (id: number) => {
    try {
      const res = await docsCommentsService.destroy(id);
      if (res.success) {
        message.success('已删除');
        if (selectedPath) loadComments(selectedPath);
        loadThreadCounts();
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '删除失败');
    }
  };

  // ============ 切换 resolved 状态 ============
  const handleToggleResolved = async (id: number, current: 'open' | 'resolved') => {
    try {
      const newStatus = current === 'open' ? 'resolved' : 'open';
      const res = await docsCommentsService.update(id, { status: newStatus });
      if (res.success) {
        message.success(newStatus === 'resolved' ? '已标记解决' : '已重新打开');
        if (selectedPath) loadComments(selectedPath);
        loadThreadCounts();
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '操作失败');
    }
  };

  const treeData = useMemo(
    () => (tree ? [convertToTreeData(tree, threadCounts)] : []),
    [tree, threadCounts]
  );

  const handleSelect = (keys: React.Key[], info: any) => {
    if (!info?.node) return;
    if (info.node.isLeaf) {
      const path = keys[0] as string;
      loadFile(path);
    }
  };

  const handleRefresh = () => {
    loadTree();
    loadThreadCounts();
    if (selectedPath) {
      loadFile(selectedPath, false);
      loadComments(selectedPath);
    }
  };

  const markdownComponents = useMemo(
    () => buildMarkdownComponents(handleAddCommentToAnchor),
    [handleAddCommentToAnchor]
  );

  const fileMtimeStr = fileMtime ? dayjs(fileMtime).format('YYYY-MM-DD HH:mm:ss') : '';

  return (
    <div style={{ padding: 24, minHeight: '100vh', background: '#f5f5f5' }}>
      <style>
        {`
          .doc-heading-wrapper:hover .doc-heading-comment-btn {
            opacity: 1 !important;
          }
        `}
      </style>
      <Card
        title={
          <Space>
            <FolderOpenOutlined />
            <span>文档浏览</span>
            <Tag color="blue">Admin</Tag>
            <Tag color="green">运行时读取 · 支持热更新</Tag>
            <Tag color="purple">飞书式评论</Tag>
          </Space>
        }
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
              loading={treeLoading}
            >
              刷新
            </Button>
          </Space>
        }
        bodyStyle={{ padding: 0 }}
      >
        <div style={{ display: 'flex', minHeight: 600 }}>
          {/* 左: 文件树 */}
          <div
            style={{
              width: 320,
              flex: '0 0 320px',
              borderRight: '1px solid #f0f0f0',
              padding: 16,
              maxHeight: '85vh',
              overflow: 'auto',
              background: '#fafafa',
              boxSizing: 'border-box',
            }}
          >
            {treeLoading ? (
              <Spin />
            ) : tree ? (
              <Tree
                showIcon
                treeData={treeData}
                expandedKeys={expandedKeys}
                onExpand={(keys) => setExpandedKeys(keys)}
                selectedKeys={selectedPath ? [selectedPath] : []}
                onSelect={handleSelect}
                blockNode
              />
            ) : (
              <Empty description="暂无文档" />
            )}
          </div>

          {/* 中: 内容 */}
          <div
            style={{
              flex: '1 1 auto',
              padding: 24,
              maxHeight: '85vh',
              overflowY: 'auto',
              minWidth: 0,
            }}
          >
            {!selectedPath ? (
              <Empty
                description={
                  <div>
                    <Paragraph>请从左侧选择一个 markdown 文档</Paragraph>
                    <Text type="secondary">
                      提示: 支持 URL 参数 <code>?path=xxx.md</code> 直接跳转
                    </Text>
                  </div>
                }
              />
            ) : (
              <Spin spinning={fileLoading}>
                <div style={{ marginBottom: 16 }}>
                  <Space>
                    <Text strong>{selectedPath}</Text>
                    {fileMtimeStr && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        最后修改: {fileMtimeStr}
                      </Text>
                    )}
                  </Space>
                </div>
                <div className="markdown-body">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents as any}
                  >
                    {fileContent}
                  </ReactMarkdown>
                </div>
              </Spin>
            )}
          </div>

          {/* 右: 评论面板 */}
          <div
            ref={commentPanelRef}
            style={{
              width: 380,
              flex: '0 0 380px',
              borderLeft: '1px solid #f0f0f0',
              padding: 16,
              maxHeight: '85vh',
              overflow: 'auto',
              background: '#fbfbfd',
              boxSizing: 'border-box',
            }}
          >
            {!selectedPath ? (
              <Empty description="选择文档后可评论" />
            ) : (
              <>
                <div style={{ marginBottom: 12 }}>
                  <Space>
                    <MessageOutlined />
                    <Text strong>评论</Text>
                    <Badge count={threads.filter((t) => t.root.status === 'open').length} />
                    <Button
                      size="small"
                      type="text"
                      icon={<CheckCircleOutlined />}
                      onClick={() => setShowResolved(!showResolved)}
                    >
                      {showResolved ? '隐藏已解决' : '显示已解决'}
                    </Button>
                  </Space>
                </div>

                <Spin spinning={commentsLoading}>
                  {threads.length === 0 ? (
                    <Empty description="暂无评论, hover 段落标题添加" />
                  ) : (
                    threads.map((t) => (
                      <Card
                        key={t.root.id}
                        size="small"
                        style={{
                          marginBottom: 12,
                          background: t.root.status === 'resolved' ? '#f6ffed' : '#fff',
                          border: `1px solid ${t.root.status === 'resolved' ? '#b7eb8f' : '#f0f0f0'}`,
                        }}
                        bodyStyle={{ padding: 12 }}
                      >
                        {/* 显示锚定预览 */}
                        {t.root.anchor_type !== 'doc' && (
                          <div
                            style={{
                              fontSize: 11,
                              color: '#8c8c8c',
                              background: '#f0f2f5',
                              padding: '4px 8px',
                              borderRadius: 4,
                              marginBottom: 8,
                              cursor: 'pointer',
                            }}
                            title="点击定位到原文"
                          >
                            📎 {t.root.anchor_snippet || t.root.anchor_key}
                          </div>
                        )}
                        {/* 根评论 */}
                        <CommentItem
                          comment={t.root}
                          currentUserId={currentUserId}
                          isAdmin={isAdmin}
                          isRoot={true}
                          onReply={handleReply}
                          onEdit={handleEdit}
                          onDelete={handleDelete}
                          onToggleResolved={handleToggleResolved}
                        />
                        {/* 回复 */}
                        {t.replies.map((r) => (
                          <div key={r.id} style={{ paddingLeft: 16 }}>
                            <CommentItem
                              comment={r}
                              currentUserId={currentUserId}
                              isAdmin={isAdmin}
                              isRoot={false}
                              onReply={handleReply}
                              onEdit={handleEdit}
                              onDelete={handleDelete}
                            />
                          </div>
                        ))}
                      </Card>
                    ))
                  )}
                </Spin>

                {/* 底部 composer */}
                <div ref={composerRef} style={{ marginTop: 12 }}>
                  <Card size="small" bodyStyle={{ padding: 12 }}>
                    {newAnchor && !replyTo && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#8c8c8c',
                          background: '#e6f4ff',
                          padding: '4px 8px',
                          borderRadius: 4,
                          marginBottom: 8,
                        }}
                      >
                        📎 对锚点评论: {newAnchor.snippet}
                        <Button
                          type="text"
                          size="small"
                          onClick={() => setNewAnchor(null)}
                          style={{ marginLeft: 8, padding: 0 }}
                        >
                          清除
                        </Button>
                      </div>
                    )}
                    {replyTo && (
                      <div
                        style={{
                          fontSize: 11,
                          color: '#8c8c8c',
                          background: '#fff7e6',
                          padding: '4px 8px',
                          borderRadius: 4,
                          marginBottom: 8,
                        }}
                      >
                        ↳ 回复评论 #{replyTo.parentId}
                        <Button
                          type="text"
                          size="small"
                          onClick={() => setReplyTo(null)}
                          style={{ marginLeft: 8, padding: 0 }}
                        >
                          取消
                        </Button>
                      </div>
                    )}
                    <TextArea
                      placeholder={
                        replyTo
                          ? '写回复...'
                          : newAnchor
                          ? '对该段落发评论...'
                          : 'hover 段落标题添加锚定评论, 或直接发整文档评论'
                      }
                      value={newContent}
                      onChange={(e) => setNewContent(e.target.value)}
                      autoSize={{ minRows: 3, maxRows: 8 }}
                    />
                    <div style={{ marginTop: 8, textAlign: 'right' }}>
                      <Button
                        type="primary"
                        size="small"
                        loading={posting}
                        disabled={!newContent.trim()}
                        onClick={handleSubmit}
                      >
                        发布
                      </Button>
                    </div>
                  </Card>
                </div>
              </>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};

export default DocsWorkspace;
