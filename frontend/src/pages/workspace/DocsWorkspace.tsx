/**
 * DocsWorkspace — 文档浏览工作区 (admin only)
 *
 * 特点:
 *   - 运行时读 docs/ 目录, 支持热更新 (改 md 文件 → 服务器 git pull → 立即生效)
 *   - 左侧文件树 (antd Tree, 支持展开/折叠, 按修改时间显示状态)
 *   - 右侧 markdown 渲染 (react-markdown + remark-gfm)
 *   - 顶部显示当前文件 mtime + 手动刷新按钮
 *
 * Mount: /workspace/docs
 * API: GET /api/docs/tree, GET /api/docs/file?path=...
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Space, Spin, Tag, Tree, Typography, message } from 'antd';
import type { DataNode } from 'antd/es/tree';
import {
  FileMarkdownOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dayjs from 'dayjs';
import { DocsTreeNode, docsService } from '../../services/docsService';

const { Title, Paragraph, Text } = Typography;

const MARKDOWN_COMPONENTS = {
  h1: ({ node: _node, ...props }: any) => <Title level={2} {...props} />,
  h2: ({ node: _node, ...props }: any) => <Title level={3} {...props} />,
  h3: ({ node: _node, ...props }: any) => <Title level={4} {...props} />,
  h4: ({ node: _node, ...props }: any) => <Title level={5} {...props} />,
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

/**
 * 将后端目录树转成 antd Tree 的 DataNode 格式
 */
function convertToTreeData(node: DocsTreeNode, parentKey = ''): DataNode {
  const key = node.path || node.name;
  const isFile = node.type === 'file';

  return {
    key,
    title: (
      <Space size={4}>
        <span>{node.name}</span>
        {isFile && node.mtime && (
          <Text type="secondary" style={{ fontSize: 11 }}>
            {dayjs(node.mtime).format('MM-DD HH:mm')}
          </Text>
        )}
      </Space>
    ),
    icon: isFile ? <FileMarkdownOutlined /> : <FolderOutlined />,
    isLeaf: isFile,
    children: node.children?.map((c) => convertToTreeData(c, key)),
  };
}

/**
 * 收集所有目录节点的 key (用于默认展开)
 */
function collectDirKeys(node: DocsTreeNode, acc: string[] = []): string[] {
  if (node.type === 'dir') {
    acc.push(node.path || node.name);
    node.children?.forEach((c) => collectDirKeys(c, acc));
  }
  return acc;
}

const DocsWorkspace: React.FC = () => {
  const [tree, setTree] = useState<DocsTreeNode | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>('');
  const [fileMtime, setFileMtime] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);

  const loadTree = useCallback(async () => {
    setTreeLoading(true);
    try {
      const res = await docsService.getTree();
      if (res.success && res.data) {
        setTree(res.data);
        // 默认展开所有目录
        setExpandedKeys(collectDirKeys(res.data));
      } else {
        message.error('加载文档树失败');
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '加载文档树失败');
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (path: string) => {
    setFileLoading(true);
    try {
      const res = await docsService.getFile(path);
      if (res.success && res.data) {
        setFileContent(res.data.content);
        setFileMtime(res.data.mtime);
        setSelectedPath(path);
      } else {
        message.error('加载文档失败');
      }
    } catch (err: any) {
      message.error(err?.response?.data?.message || '加载文档失败');
    } finally {
      setFileLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  const treeData = useMemo(() => (tree ? [convertToTreeData(tree)] : []), [tree]);

  const handleSelect = (keys: React.Key[], info: any) => {
    if (!info?.node) return;
    if (info.node.isLeaf) {
      const path = keys[0] as string;
      loadFile(path);
    }
  };

  const handleRefresh = () => {
    loadTree();
    if (selectedPath) {
      loadFile(selectedPath);
    }
  };

  const fileMtimeStr = fileMtime ? dayjs(fileMtime).format('YYYY-MM-DD HH:mm:ss') : '';

  return (
    <div style={{ padding: 24, minHeight: '100vh', background: '#f5f5f5' }}>
      <Card
        title={
          <Space>
            <FolderOpenOutlined />
            <span>文档浏览</span>
            <Tag color="blue">Admin</Tag>
            <Tag color="green">运行时读取 · 支持热更新</Tag>
          </Space>
        }
        extra={
          <Button icon={<ReloadOutlined />} onClick={handleRefresh} loading={treeLoading}>
            刷新
          </Button>
        }
        bodyStyle={{ padding: 0 }}
      >
        <div style={{ display: 'flex', minHeight: 600 }}>
          {/* 左: 文件树 */}
          <div
            style={{
              width: 320,
              borderRight: '1px solid #f0f0f0',
              padding: 16,
              maxHeight: '80vh',
              overflowY: 'auto',
              background: '#fafafa',
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

          {/* 右: 内容渲染 */}
          <div style={{ flex: 1, padding: 24, maxHeight: '80vh', overflowY: 'auto' }}>
            {!selectedPath ? (
              <Empty
                description={
                  <div>
                    <Paragraph>请从左侧选择一个 markdown 文档</Paragraph>
                    <Text type="secondary">
                      提示: 后端会实时读取 docs/ 目录, 修改文档后刷新即可看到最新内容
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
                <div className="markdown-body" data-testid="docs-workspace-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS as any}>
                    {fileContent}
                  </ReactMarkdown>
                </div>
              </Spin>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};

export default DocsWorkspace;
