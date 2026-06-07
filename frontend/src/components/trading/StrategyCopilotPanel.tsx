import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Avatar,
  Button,
  Drawer,
  Empty,
  FloatButton,
  Input,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message as antdMessage,
} from 'antd';
import {
  BulbOutlined,
  CopyOutlined,
  MessageOutlined,
  RobotOutlined,
  SendOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  CopilotIntent,
  COPILOT_INTENT_LABELS,
  CopilotContext,
  CopilotResponse,
  askStrategyCopilot,
  diffSuggestedParams,
  loadStrategyCopilotContext,
} from '../../services/strategyCopilotService';

const { Text, Paragraph, Title } = Typography;
const { TextArea } = Input;

/**
 * StrategyCopilotPanel — US-062 策略实验室 AI 助手
 *
 * 渲染浮在 LabWorkspace 右下角的 FloatButton + Drawer 聊天面板。
 *
 * 4 大能力对应 4 种意图：
 *   - explain_backtest：解释最近回测指标
 *   - suggest_params：建议参数改动（diff 表格 + apply 按钮）
 *   - generate_draft：生成 TypeScript 策略草案（带复制按钮）
 *   - general：通用问答兜底
 *
 * Props：
 *   - currentStrategyKey  传入用户当前选中的策略；面板打开时自动 loadContext 显示元信息
 *   - onApplySuggestedParams  父组件（LabWorkspace）接收"应用建议"事件可路由到新建回测 tab
 *
 * 复用规范（与 AIStockAnalysisModal 同款）：
 *   - 组件自管 messages / loading / sending 内部 state
 *   - 失败 / partial 仍展示 reply 让用户看到启发式答案
 *   - copy 代码 / 应用参数 用 antd message 反馈
 */

interface CopilotChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  response?: CopilotResponse;
  /** 调用失败时记录 error 文案；和 response.error (启发式 fallback) 分开。 */
  error?: string;
  pending?: boolean;
}

interface StrategyCopilotPanelProps {
  /** 当前选中的策略 key（前端 lab 主界面知道）。可空，无策略时 Copilot 仍可通用问答 */
  currentStrategyKey?: string | null;
  /** 用户点 "应用建议参数" 时上报，父组件可路由到 "新建回测" tab + 预填表单 */
  onApplySuggestedParams?: (params: Record<string, any>, strategyKey: string | null) => void;
  /** 默认是否打开 Drawer（一般不要传，让用户自己点 FloatButton） */
  defaultOpen?: boolean;
}

const buildLocalId = () => `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

const QUICK_PROMPTS: Array<{ key: CopilotIntent; label: string; prompt: string }> = [
  {
    key: 'explain_backtest',
    label: '解释回测',
    prompt: '帮我解释当前策略最近一次回测的 sharpe / 最大回撤 / 胜率，并说明这些数字代表什么。',
  },
  {
    key: 'suggest_params',
    label: '建议调参',
    prompt: '基于当前策略的最近回测表现，建议我下一步调哪些参数？给出具体建议数值。',
  },
  {
    key: 'generate_draft',
    label: '生成草案',
    prompt: '帮我写一个 A 股周线 RSI 超卖反弹策略的 TypeScript 代码草案，遵循 QuantStrategy 接口。',
  },
];

const StrategyCopilotPanel: React.FC<StrategyCopilotPanelProps> = ({
  currentStrategyKey,
  onApplySuggestedParams,
  defaultOpen = false,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<CopilotChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [context, setContext] = useState<CopilotContext | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);

  const refreshContext = useCallback(async () => {
    setContextLoading(true);
    setContextError(null);
    try {
      const ctx = await loadStrategyCopilotContext(currentStrategyKey || undefined, 5);
      setContext(ctx);
    } catch (err: any) {
      setContextError(err.message || '加载策略上下文失败');
    } finally {
      setContextLoading(false);
    }
  }, [currentStrategyKey]);

  // Drawer 打开 + currentStrategyKey 变化时刷上下文
  useEffect(() => {
    if (open) {
      refreshContext();
    }
  }, [open, refreshContext]);

  const handleQuickPrompt = useCallback((quick: (typeof QUICK_PROMPTS)[number]) => {
    setInputText(quick.prompt);
  }, []);

  const handleSend = useCallback(async () => {
    const promptText = inputText.trim();
    if (!promptText) {
      antdMessage.warning('请输入问题');
      return;
    }
    const userMsg: CopilotChatMessage = {
      id: buildLocalId(),
      role: 'user',
      content: promptText,
    };
    const placeholderId = buildLocalId();
    const placeholderMsg: CopilotChatMessage = {
      id: placeholderId,
      role: 'assistant',
      content: '正在思考...',
      pending: true,
    };
    setMessages(prev => [...prev, userMsg, placeholderMsg]);
    setInputText('');
    setSending(true);
    try {
      const response = await askStrategyCopilot({
        prompt: promptText,
        strategy_key: currentStrategyKey || undefined,
        task_label: 'lab_copilot_panel',
      });
      setMessages(prev =>
        prev.map(m =>
          m.id === placeholderId
            ? {
                id: placeholderId,
                role: 'assistant',
                content: response.reply,
                response,
                pending: false,
              }
            : m
        )
      );
      if (response.status === 'failed') {
        antdMessage.error(response.error || 'Copilot 返回失败');
      } else if (response.status === 'partial') {
        antdMessage.warning('AI 远端暂时不可达，已用启发式回答');
      }
    } catch (err: any) {
      const errMsg = err.message || 'Copilot 请求失败';
      setMessages(prev =>
        prev.map(m =>
          m.id === placeholderId
            ? {
                id: placeholderId,
                role: 'assistant',
                content: errMsg,
                error: errMsg,
                pending: false,
              }
            : m
        )
      );
      antdMessage.error(errMsg);
    } finally {
      setSending(false);
    }
  }, [inputText, currentStrategyKey]);

  const handleClearChat = useCallback(() => {
    setMessages([]);
    setInputText('');
  }, []);

  const handleCopyCode = useCallback((code: string) => {
    if (!navigator?.clipboard) {
      antdMessage.warning('当前浏览器不支持剪贴板写入');
      return;
    }
    navigator.clipboard
      .writeText(code)
      .then(() => antdMessage.success('已复制到剪贴板'))
      .catch(() => antdMessage.warning('复制失败，请手动复制'));
  }, []);

  const handleApply = useCallback(
    (response: CopilotResponse) => {
      if (!onApplySuggestedParams || Object.keys(response.suggested_params).length === 0) {
        antdMessage.info('没有可应用的参数建议');
        return;
      }
      onApplySuggestedParams(response.suggested_params, response.strategy_key);
      antdMessage.success('已把建议参数发送到 "新建回测" tab');
    },
    [onApplySuggestedParams]
  );

  const contextSummary = useMemo(() => {
    if (!context?.strategy) {
      return currentStrategyKey
        ? `策略 ${currentStrategyKey} (未在 DB 中找到元信息)`
        : '当前未选择策略 - 可用通用问答';
    }
    const s = context.strategy;
    const parts = [s.name || s.strategy_key];
    if (s.category) parts.push(s.category);
    if (s.risk_level) parts.push(`risk=${s.risk_level}`);
    return parts.join(' · ');
  }, [context, currentStrategyKey]);

  return (
    <>
      <FloatButton
        icon={<RobotOutlined />}
        type="primary"
        tooltip="策略 Copilot"
        onClick={() => setOpen(true)}
        style={{ insetInlineEnd: 32, bottom: 32 }}
      />
      <Drawer
        title={
          <Space>
            <RobotOutlined style={{ color: '#1890ff' }} />
            <span>策略 Copilot</span>
            <Tag color="blue">US-062</Tag>
          </Space>
        }
        placement="right"
        width={480}
        open={open}
        onClose={() => setOpen(false)}
        extra={
          <Button size="small" onClick={handleClearChat} disabled={messages.length === 0}>
            清空对话
          </Button>
        }
        styles={{ body: { display: 'flex', flexDirection: 'column', padding: 0 } }}
      >
        {/* 顶部 context 区 */}
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f0f0f0' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            当前上下文
          </Text>
          <div style={{ marginTop: 4 }}>
            {contextLoading ? (
              <Spin size="small" />
            ) : (
              <Text strong style={{ fontSize: 13 }}>
                {contextSummary}
              </Text>
            )}
          </div>
          {contextError && (
            <Alert
              type="warning"
              showIcon
              message={contextError}
              style={{ marginTop: 8 }}
              closable
            />
          )}
          {context && context.backtests.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                最近回测: {context.backtests.length} 次, 最新 sharpe ={' '}
                {context.backtests[0].sharpe_ratio !== null
                  ? context.backtests[0].sharpe_ratio.toFixed(2)
                  : '—'}
              </Text>
            </div>
          )}
        </div>

        {/* 快捷意图按钮 */}
        <div
          style={{ padding: '8px 16px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}
        >
          <Space wrap size={[6, 6]}>
            {QUICK_PROMPTS.map(q => (
              <Tooltip key={q.key} title={q.prompt}>
                <Tag
                  color="blue"
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => handleQuickPrompt(q)}
                  icon={<BulbOutlined />}
                >
                  {COPILOT_INTENT_LABELS[q.key]}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        </div>

        {/* 消息列表 */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '12px 16px',
            background: '#f6f8fa',
          }}
        >
          {messages.length === 0 ? (
            <Empty
              description={
                <span style={{ color: '#999' }}>
                  问我任何关于策略和回测的问题，例如：
                  <br />
                  {`"为什么这次回测 sharpe 这么低？" 或 "帮我写一个 RSI 反转策略草案"`}
                </span>
              }
              style={{ marginTop: 40 }}
            />
          ) : (
            messages.map(msg => (
              <ChatBubble
                key={msg.id}
                msg={msg}
                strategyDefaultParams={context?.strategy?.default_params || null}
                onCopyCode={handleCopyCode}
                onApply={handleApply}
              />
            ))
          )}
        </div>

        {/* 输入框 */}
        <div style={{ borderTop: '1px solid #f0f0f0', padding: 12 }}>
          <TextArea
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            placeholder="请输入问题，Cmd/Ctrl+Enter 发送"
            autoSize={{ minRows: 2, maxRows: 4 }}
            disabled={sending}
            onPressEnter={e => {
              if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />
          <div style={{ marginTop: 8, textAlign: 'right' }}>
            <Button
              type="primary"
              icon={<SendOutlined />}
              loading={sending}
              onClick={handleSend}
              disabled={!inputText.trim()}
            >
              发送
            </Button>
          </div>
        </div>
      </Drawer>
    </>
  );
};

// ---------------------------------------------------------------------------
// 子组件
// ---------------------------------------------------------------------------

const ChatBubble: React.FC<{
  msg: CopilotChatMessage;
  strategyDefaultParams: Record<string, any> | null;
  onCopyCode: (code: string) => void;
  onApply: (response: CopilotResponse) => void;
}> = ({ msg, strategyDefaultParams, onCopyCode, onApply }) => {
  const isUser = msg.role === 'user';
  const bubbleStyle: React.CSSProperties = {
    background: isUser ? '#1890ff' : '#fff',
    color: isUser ? '#fff' : '#333',
    padding: '8px 12px',
    borderRadius: 8,
    maxWidth: '85%',
    border: isUser ? 'none' : '1px solid #f0f0f0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  };

  const paramDelta = useMemo(() => {
    if (!msg.response || !msg.response.suggested_params) return [];
    return diffSuggestedParams(strategyDefaultParams, msg.response.suggested_params);
  }, [msg.response, strategyDefaultParams]);

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 12,
        gap: 8,
      }}
    >
      {!isUser && (
        <Avatar size={28} icon={<RobotOutlined />} style={{ background: '#1890ff', flexShrink: 0 }} />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '85%' }}>
        <div style={bubbleStyle}>
          {msg.pending ? (
            <Space>
              <Spin size="small" />
              <Text type="secondary">正在思考...</Text>
            </Space>
          ) : (
            msg.content
          )}
        </div>
        {/* 元信息: intent / engine / next_action */}
        {!isUser && msg.response && !msg.pending && (
          <Space size={4} style={{ marginTop: 4 }} wrap>
            <Tag color="geekblue" style={{ fontSize: 11 }}>
              {COPILOT_INTENT_LABELS[msg.response.intent] || msg.response.intent}
            </Tag>
            {msg.response.nlp_engine === 'heuristic_fallback' && (
              <Tag color="orange" style={{ fontSize: 11 }}>
                启发式兜底
              </Tag>
            )}
            {msg.response.status === 'failed' && (
              <Tag color="red" style={{ fontSize: 11 }}>
                失败
              </Tag>
            )}
          </Space>
        )}
        {/* 建议参数 diff 表 */}
        {!isUser && paramDelta.length > 0 && (
          <div style={{ marginTop: 8, background: '#fff', borderRadius: 6, padding: 8 }}>
            <Title level={5} style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>
              建议参数改动
            </Title>
            <Table
              size="small"
              dataSource={paramDelta}
              rowKey={r => r.key}
              pagination={false}
              columns={[
                { title: '参数', dataIndex: 'key', key: 'key', width: 100 },
                {
                  title: '当前',
                  dataIndex: 'before',
                  key: 'before',
                  render: v => JSON.stringify(v),
                },
                {
                  title: '建议',
                  dataIndex: 'after',
                  key: 'after',
                  render: v => <Text strong>{JSON.stringify(v)}</Text>,
                },
              ]}
            />
            <Button
              type="primary"
              size="small"
              style={{ marginTop: 8 }}
              onClick={() => onApply(msg.response!)}
            >
              应用并去新建回测
            </Button>
          </div>
        )}
        {/* 策略草案代码 */}
        {!isUser && msg.response?.strategy_draft && (
          <div style={{ marginTop: 8, background: '#fff', borderRadius: 6, padding: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Title level={5} style={{ marginTop: 0, marginBottom: 6, fontSize: 13 }}>
                策略草案 (TypeScript)
              </Title>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => onCopyCode(msg.response!.strategy_draft!)}
              >
                复制
              </Button>
            </div>
            <pre
              style={{
                background: '#f6f8fa',
                padding: 8,
                borderRadius: 4,
                fontSize: 12,
                margin: 0,
                maxHeight: 320,
                overflow: 'auto',
              }}
            >
              {msg.response.strategy_draft}
            </pre>
          </div>
        )}
        {/* error 显示 */}
        {!isUser && msg.error && !msg.pending && (
          <Alert type="error" showIcon message={msg.error} style={{ marginTop: 4 }} />
        )}
      </div>
      {isUser && (
        <Avatar size={28} icon={<UserOutlined />} style={{ background: '#52c41a', flexShrink: 0 }} />
      )}
    </div>
  );
};

export default StrategyCopilotPanel;
