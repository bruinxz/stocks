import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  FireOutlined,
  InfoCircleOutlined,
  NodeIndexOutlined,
  PlusOutlined,
  PlayCircleOutlined,
  RadarChartOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  AutomationHealth,
  AutomationHealthChain,
  QueueJobSummary,
  ScheduledTask,
  TaskExecutionLog,
  taskService,
} from '../services/taskService';
import dayjs from 'dayjs';

const { Text, Title } = Typography;
const { Option } = Select;

const taskTypeLabels: Record<string, string> = {
  DAILY_UPDATE: '每日行情增量同步',
  SYNC_ALL_STOCKS: '全市场股票列表同步',
  SYNC_HISTORY: '股票历史行情同步',
  DATA_QUALITY_SCAN: '数据质量扫描',
  BENCHMARK_INDEX_SYNC: '基准指数行情同步',
  AI_DAILY_SCREENER: 'AI 每日优选评估',
  AUTO_RECOMMENDATION_LOOP: '全市场荐股闭环',
  SIGNAL_PERFORMANCE_REFRESH: '推荐绩效后验刷新',
  SIGNAL_QUALITY_DAILY_REPORT: '信号质量日报',
  PAPER_TRADING_AUTO_SYNC: '推荐信号模拟盘跟单',
  PAPER_TRADING_RISK_CHECK: '模拟盘风控退出检查',
  PAPER_TRADING_ATTRIBUTION_REPORT: '模拟盘收益归因报告',
  RECOMMENDATION_TRADE_OUTCOME_REFRESH: '推荐交易收益闭环刷新',
  PAPER_TRADING_DAILY_PLAN: '模拟盘交易计划报告',
};

const defaultParametersByType: Record<string, any> = {
  DAILY_UPDATE: {
    force_update: false,
  },
  SYNC_ALL_STOCKS: {},
  SYNC_HISTORY: {
    syncAllStocks: true,
    lookback_days: 10,
    dataSource: 'auto',
    concurrency: 2,
  },
  DATA_QUALITY_SCAN: {
    scope: 'market',
    lookback_days: 180,
    limit: 200,
  },
  AI_DAILY_SCREENER: {
    universe: 'favorites',
    style: 'balanced',
    candidate_limit: 10,
    lookback_days: 120,
  },
  AUTO_RECOMMENDATION_LOOP: {
    username: 'lym',
    universe: 'market',
    style: 'balanced',
    candidate_limit: 30,
    candidate_pool_limit: 360,
    archive_limit: 30,
    verify_signals: true,
    submit_agent_analysis: true,
    agent_max_count: 5,
    agent_min_score: 72,
    run_paper_trading: true,
    dry_run: false,
    use_profit_gate: true,
    use_entry_risk_guard: true,
    use_strategy_experiment_feedback: true,
    report_to_feishu: true,
  },
  BENCHMARK_INDEX_SYNC: {
    lookback_days: 180,
    data_source: 'tencent_only',
    concurrency: 2,
    report_to_feishu: true,
  },
  SIGNAL_PERFORMANCE_REFRESH: {
    limit: 500,
    report_to_feishu: true,
  },
  SIGNAL_QUALITY_DAILY_REPORT: {
    horizon: '5d',
    lookback_days: 30,
    min_samples: 5,
    auto_repair_missing_data: true,
    report_to_feishu: true,
  },
  PAPER_TRADING_AUTO_SYNC: {
    username: 'lym',
    refresh_recommendations: true,
    universe: 'market',
    style: 'balanced',
    candidate_limit: 30,
    use_profit_gate: true,
    dry_run: false,
    report_to_feishu: true,
  },
  PAPER_TRADING_RISK_CHECK: {
    username: 'lym',
    enable_stop_loss: true,
    enable_take_profit: true,
    enable_sell_signals: true,
    dry_run: false,
    report_to_feishu: true,
  },
  PAPER_TRADING_ATTRIBUTION_REPORT: {
    username: 'lym',
    include_open: true,
    report_to_feishu: true,
  },
  RECOMMENDATION_TRADE_OUTCOME_REFRESH: {
    username: 'lym',
    include_open: true,
    lookback_days: 180,
    limit: 2000,
    report_to_feishu: true,
  },
  PAPER_TRADING_DAILY_PLAN: {
    username: 'lym',
    include_entries: true,
    include_exits: true,
    include_monitor: true,
    report_to_feishu: true,
  },
};

const queueStateLabels: Record<string, string> = {
  completed: '已完成',
  failed: '失败',
  active: '执行中',
  waiting: '等待中',
  delayed: '延迟中',
  paused: '已暂停',
  unknown: '未知',
};

const healthLabelMap: Record<string, string> = {
  healthy: '链路健康',
  warning: '需要关注',
  critical: '需要修复',
};

const healthColorMap: Record<string, string> = {
  healthy: 'success',
  warning: 'warning',
  critical: 'error',
};

const getLastRunStatusColor = (status?: string) => {
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILED') return 'error';
  return 'processing';
};

const getQueueStateColor = (state?: string) => {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'error';
  if (state === 'active') return 'processing';
  if (state === 'waiting' || state === 'delayed') return 'warning';
  return 'default';
};

const formatQueueTime = (timestamp?: number) =>
  timestamp ? dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') : '-';

const formatDateTime = (value?: string | null) =>
  value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '-';

const formatQueueProgress = (progress: any) => {
  if (progress === null || progress === undefined || progress === '') return '-';
  if (typeof progress === 'number') return `${progress}%`;
  if (typeof progress === 'object') return JSON.stringify(progress);
  return String(progress);
};

const stringifyJson = (value: any) => {
  if (value === null || value === undefined || value === '') return '-';
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return String(value);
  }
};

const getChainIcon = (key: string) => {
  if (key === 'market_data') return <DatabaseOutlined />;
  if (key === 'auto_recommendation_loop') return <ThunderboltOutlined />;
  if (key === 'signal_feedback') return <RadarChartOutlined />;
  if (key === 'paper_trading') return <SafetyCertificateOutlined />;
  if (key === 'trade_outcome_loop') return <NodeIndexOutlined />;
  return <ApiOutlined />;
};

const TaskScheduler: React.FC = () => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [health, setHealth] = useState<AutomationHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [healthLoading, setHealthLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<TaskExecutionLog[]>([]);
  const [activeTaskName, setActiveTaskName] = useState<string>('');
  const [queueDetail, setQueueDetail] = useState<QueueJobSummary | null>(null);
  const [isQueueDetailVisible, setIsQueueDetailVisible] = useState(false);
  const [form] = Form.useForm();

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await taskService.getTasks();
      setTasks(data);
    } catch (error) {
      message.error('获取任务列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    setHealthLoading(true);
    try {
      const data = await taskService.getAutomationHealth();
      setHealth(data);
    } catch (error) {
      message.error('获取自动化健康状态失败');
    } finally {
      setHealthLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    await Promise.all([fetchTasks(), fetchHealth()]);
  }, [fetchHealth, fetchTasks]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const healthTone = health?.status || 'warning';
  const latestLoop = health?.latest_loop;
  const topSkipReasons = latestLoop?.paper_trading?.skip_reason_summary?.top_reasons || [];

  const taskStats = useMemo(() => {
    const active = tasks.filter(item => item.is_active).length;
    const failed = tasks.filter(item => item.last_run_status === 'FAILED').length;
    const running = tasks.filter(item => item.last_run_status === 'RUNNING').length;
    return { active, failed, running };
  }, [tasks]);

  const handleAdd = () => {
    setEditingTask(null);
    form.resetFields();
    form.setFieldsValue({
      is_active: true,
      type: 'DAILY_UPDATE',
      cron_expression: '10 17 * * 1-5',
      parameters: JSON.stringify(defaultParametersByType.DAILY_UPDATE, null, 2),
    });
    setIsModalVisible(true);
  };

  const handleEdit = (record: ScheduledTask) => {
    setEditingTask(record);
    form.setFieldsValue({
      ...record,
      parameters: record.parameters ? JSON.stringify(record.parameters, null, 2) : '',
    });
    setIsModalVisible(true);
  };

  const handleDelete = (id: number) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这个定时任务吗？',
      onOk: async () => {
        try {
          await taskService.deleteTask(id);
          message.success('删除成功');
          refreshAll();
        } catch (error) {
          message.error('删除失败');
        }
      },
    });
  };

  const handleExecute = (id: number) => {
    Modal.confirm({
      title: '确认立即执行',
      content: '确定要忽略定时配置，立刻在后台触发一次该任务吗？',
      onOk: async () => {
        try {
          await taskService.executeTask(id);
          message.success('任务已在后台触发执行');
          refreshAll();
        } catch (error) {
          message.error('触发执行失败');
        }
      },
    });
  };

  const handleToggleActive = async (id: number, checked: boolean) => {
    try {
      await taskService.updateTask(id, { is_active: checked });
      message.success(checked ? '任务已启用' : '任务已禁用');
      refreshAll();
    } catch (error) {
      message.error('状态更新失败');
    }
  };

  const handleModalOk = () => {
    form.validateFields().then(async (values: any) => {
      try {
        let parameters = null;
        if (values.parameters) {
          try {
            parameters = JSON.parse(values.parameters);
          } catch (e) {
            message.error('参数必须是有效的 JSON 格式');
            return;
          }
        }

        const data = { ...values, parameters };

        if (editingTask && editingTask.id) {
          await taskService.updateTask(editingTask.id, data);
          message.success('更新成功');
        } else {
          await taskService.createTask(data);
          message.success('创建成功');
        }

        setIsModalVisible(false);
        refreshAll();
      } catch (error) {
        message.error('操作失败');
      }
    });
  };

  const handleViewLogs = async (record: ScheduledTask) => {
    setActiveTaskName(record.name);
    setIsLogModalVisible(true);
    setLogLoading(true);
    setCurrentLogs([]);
    try {
      if (!record.id) return;
      const logs = await taskService.getTaskLogs(record.id);
      setCurrentLogs(logs);
    } catch (error: any) {
      const detail =
        error?.response?.data?.details || error?.response?.data?.message || error?.message || '';
      message.error(`获取日志失败${detail ? `：${detail}` : ''}`);
    } finally {
      setLogLoading(false);
    }
  };

  const renderHealthChain = (chain: AutomationHealthChain) => (
    <div className={`automation-chain-card automation-chain-card--${chain.status}`} key={chain.key}>
      <div className="automation-chain-card__head">
        <span className="automation-chain-card__icon">{getChainIcon(chain.key)}</span>
        <div>
          <div className="automation-chain-card__title">{chain.title}</div>
          <Text type="secondary">{chain.subtitle}</Text>
        </div>
        <Tag color={healthColorMap[chain.status]}>{healthLabelMap[chain.status]}</Tag>
      </div>

      <div className="automation-chain-card__meta">
        <span>
          启用 {chain.active_count}/{chain.task_count}
        </span>
        <span>问题 {chain.issues.length}</span>
      </div>

      <Timeline
        className="automation-chain-timeline"
        items={chain.tasks.map(task => {
          const isMissing = task.type === 'MISSING';
          const statusColor = isMissing
            ? 'red'
            : task.last_run_status === 'FAILED'
            ? 'red'
            : task.last_run_status === 'RUNNING'
            ? 'blue'
            : task.is_active
            ? 'green'
            : 'gray';
          return {
            color: statusColor,
            children: (
              <div className="automation-chain-task">
                <Space size={6} wrap>
                  <Text strong>{task.name}</Text>
                  {!isMissing && (
                    <Tag color={task.is_active ? 'green' : 'default'}>
                      {task.is_active ? 'ON' : 'OFF'}
                    </Tag>
                  )}
                  {task.last_run_status && (
                    <Tag color={getLastRunStatusColor(task.last_run_status)}>
                      {task.last_run_status}
                    </Tag>
                  )}
                </Space>
                <div className="automation-chain-task__sub">
                  {task.cron_expression ? <Text code>{task.cron_expression}</Text> : '-'} · 最近{' '}
                  {formatDateTime(task.last_run_at || task.last_log_started_at)}
                </div>
              </div>
            ),
          };
        })}
      />

      {chain.issues.length > 0 && (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {chain.issues.slice(0, 3).map((issue, index) => (
            <Alert
              key={`${issue.code}-${index}`}
              type={issue.level === 'critical' ? 'error' : 'warning'}
              message={issue.message}
              showIcon
            />
          ))}
        </Space>
      )}
    </div>
  );

  const columns = [
    {
      title: '任务名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: ScheduledTask) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {taskTypeLabels[record.type] || record.type}
          </Text>
        </Space>
      ),
    },
    {
      title: '任务类型',
      dataIndex: 'type',
      key: 'type',
      render: (text: string) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: 'Cron 表达式',
      dataIndex: 'cron_expression',
      key: 'cron_expression',
      render: (text: string) => <Text code>{text}</Text>,
    },
    {
      title: '状态',
      key: 'is_active',
      render: (_: any, record: ScheduledTask) => (
        <Switch
          checked={record.is_active}
          onChange={checked => record.id && handleToggleActive(record.id, checked)}
        />
      ),
    },
    {
      title: '上次运行',
      key: 'lastRun',
      render: (_: any, record: ScheduledTask) => (
        <Space direction="vertical" size={0}>
          {record.last_run_at ? new Date(record.last_run_at).toLocaleString() : '-'}
          {record.last_run_status && (
            <Tag color={getLastRunStatusColor(record.last_run_status)}>
              {record.last_run_status}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ScheduledTask) => (
        <Space size="small" wrap>
          <Button
            type="link"
            icon={<PlayCircleOutlined />}
            onClick={() => record.id && handleExecute(record.id)}
            style={{ color: '#008f6b' }}
          >
            执行
          </Button>
          <Button type="link" onClick={() => handleViewLogs(record)}>
            历史记录
          </Button>
          <Button type="link" icon={<EditOutlined />} onClick={() => handleEdit(record)}>
            编辑
          </Button>
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => record.id && handleDelete(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="task-ops-page fade-in-up">
      <div className={`task-ops-hero task-ops-hero--${healthTone}`}>
        <div className="task-ops-hero__content">
          <Tag
            color={healthColorMap[healthTone]}
            icon={healthTone === 'healthy' ? <CheckCircleOutlined /> : <WarningOutlined />}
          >
            {healthLabelMap[healthTone] || '健康检查'}
          </Tag>
          <h1>自动荐股作战室</h1>
          <p>
            这里监控从行情同步、全市场扫描、Agent
            复核、模拟盘交易到收益反哺的整条链路。目标不是盲目多交易，而是让每一次推荐都有样本、有复盘、有风控。
          </p>
          <Space wrap>
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              loading={loading || healthLoading}
              onClick={refreshAll}
            >
              刷新链路状态
            </Button>
            <Button icon={<PlusOutlined />} onClick={handleAdd}>
              新建任务
            </Button>
          </Space>
        </div>
        <div className="task-ops-hero__panel">
          <div className="task-ops-orbit">
            <span />
            <span />
            <span />
            <ThunderboltOutlined />
          </div>
          <div className="task-ops-hero__stamp">
            <Text type="secondary">最近健康扫描</Text>
            <strong>{health?.generated_at || '-'}</strong>
          </div>
        </div>
      </div>

      <Row gutter={[16, 16]} className="task-ops-metrics">
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="关键任务启用"
              value={taskStats.active}
              suffix={`/ ${tasks.length || 0}`}
              prefix={<ClockCircleOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="严重问题"
              value={health?.summary.critical_issues || 0}
              prefix={<CloseCircleOutlined />}
              valueStyle={{
                color: (health?.summary.critical_issues || 0) > 0 ? '#d14343' : '#008f6b',
              }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="队列等待/延迟"
              value={health?.summary.queue_waiting || 0}
              prefix={<DatabaseOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card task-ops-metric" variant="borderless">
            <Statistic
              title="最近闭环交易/跳过"
              value={health?.summary.latest_loop_trade_action || '-'}
              prefix={<FireOutlined />}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={16}>
          <Card
            className="modern-card task-ops-section"
            variant="borderless"
            title="自动化链路健康图"
            extra={<Tag color={healthColorMap[healthTone]}>{healthLabelMap[healthTone]}</Tag>}
            loading={healthLoading && !health}
          >
            <div className="automation-chain-grid">
              {(health?.chains || []).map(renderHealthChain)}
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card className="modern-card task-ops-section" variant="borderless" title="下一步建议">
              <Space direction="vertical" size={10} style={{ width: '100%' }}>
                {(health?.next_actions || ['正在加载链路建议...']).map((item, index) => (
                  <div className="task-ops-action" key={index}>
                    <span>{index + 1}</span>
                    <Text>{item}</Text>
                  </div>
                ))}
              </Space>
            </Card>

            <Card
              className="modern-card task-ops-section"
              variant="borderless"
              title="最近荐股闭环"
            >
              {latestLoop ? (
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Descriptions column={1} size="small">
                    <Descriptions.Item label="运行ID">
                      <Text code copyable>
                        {latestLoop.loop_run_id || '-'}
                      </Text>
                    </Descriptions.Item>
                    <Descriptions.Item label="时间">
                      {formatDateTime(latestLoop.generated_at)}
                    </Descriptions.Item>
                    <Descriptions.Item label="风格/评分">
                      {latestLoop.effective_style || '-'} / ≥{latestLoop.effective_min_score || '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="共识排序">
                      <Tag color={latestLoop.consensus?.ranked ? 'purple' : 'default'}>
                        {latestLoop.consensus?.ranked ? '已启用' : '未启用'} ·{' '}
                        {latestLoop.consensus?.overlap_count || 0} 个共识
                      </Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="模拟盘">
                      成交 {latestLoop.paper_trading?.executed || 0} / 计划{' '}
                      {latestLoop.paper_trading?.planned || 0} / 跳过{' '}
                      {latestLoop.paper_trading?.skipped || 0}
                    </Descriptions.Item>
                  </Descriptions>

                  {topSkipReasons.length > 0 && (
                    <div className="task-ops-skip-box">
                      <Text strong>主要阻断原因</Text>
                      {topSkipReasons.slice(0, 4).map((item: any, index: number) => (
                        <div className="task-ops-skip-row" key={`${item.reason}-${index}`}>
                          <Text ellipsis={{ tooltip: item.reason }}>{item.reason}</Text>
                          <Tag color="orange">×{item.count}</Tag>
                        </div>
                      ))}
                    </div>
                  )}
                </Space>
              ) : (
                <Empty description="暂无闭环快照" />
              )}
            </Card>
          </Space>
        </Col>
      </Row>

      <Card className="modern-card task-ops-table" variant="borderless" title="任务编排清单">
        <Table
          columns={columns}
          dataSource={tasks}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 960 }}
          locale={{ emptyText: <Empty description="暂无定时任务，请点击右上角新建任务" /> }}
        />
      </Card>

      <Modal
        title={editingTask ? '编辑定时任务' : '新建定时任务'}
        open={isModalVisible}
        onOk={handleModalOk}
        onCancel={() => setIsModalVisible(false)}
        width={640}
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            is_active: true,
            parameters:
              '{\n  "universe": "favorites",\n  "style": "balanced",\n  "candidate_limit": 10,\n  "lookback_days": 120\n}',
          }}
        >
          <Form.Item
            name="name"
            label="任务名称"
            rules={[{ required: true, message: '请输入任务名称' }]}
          >
            <Input placeholder="如：每日全量股票数据同步" />
          </Form.Item>

          <Form.Item
            name="type"
            label="任务类型"
            rules={[{ required: true, message: '请选择任务类型' }]}
          >
            <Select
              placeholder="选择要执行的任务类型"
              onChange={(type: string) => {
                if (defaultParametersByType[type]) {
                  form.setFieldValue(
                    'parameters',
                    JSON.stringify(defaultParametersByType[type], null, 2)
                  );
                }
              }}
            >
              <Option value="DAILY_UPDATE">每日行情增量同步</Option>
              <Option value="SYNC_ALL_STOCKS">全市场股票列表同步</Option>
              <Option value="SYNC_HISTORY">股票历史行情同步</Option>
              <Option value="DATA_QUALITY_SCAN">数据质量扫描</Option>
              <Option value="BENCHMARK_INDEX_SYNC">基准指数行情同步</Option>
              <Option value="AI_DAILY_SCREENER">AI 每日优选评估</Option>
              <Option value="AUTO_RECOMMENDATION_LOOP">全市场荐股闭环</Option>
              <Option value="SIGNAL_PERFORMANCE_REFRESH">推荐绩效后验刷新</Option>
              <Option value="SIGNAL_QUALITY_DAILY_REPORT">信号质量日报</Option>
              <Option value="PAPER_TRADING_AUTO_SYNC">推荐信号模拟盘跟单</Option>
              <Option value="PAPER_TRADING_RISK_CHECK">模拟盘风控退出检查</Option>
              <Option value="PAPER_TRADING_ATTRIBUTION_REPORT">模拟盘收益归因报告</Option>
              <Option value="RECOMMENDATION_TRADE_OUTCOME_REFRESH">推荐交易收益闭环刷新</Option>
              <Option value="PAPER_TRADING_DAILY_PLAN">模拟盘交易计划报告</Option>
            </Select>
          </Form.Item>

          <Form.Item
            name="cron_expression"
            label={
              <Space>
                Cron 表达式
                <Tooltip title="分 时 日 月 周。例如每天凌晨1点: 0 1 * * *">
                  <InfoCircleOutlined />
                </Tooltip>
              </Space>
            }
            rules={[{ required: true, message: '请输入 Cron 表达式' }]}
          >
            <Input placeholder="如：0 1 * * * (每天凌晨1点)" />
          </Form.Item>

          <Form.Item name="parameters" label="任务参数 (JSON 格式)">
            <Input.TextArea
              rows={8}
              onFocus={() => {
                const type = form.getFieldValue('type');
                const current = form.getFieldValue('parameters');
                if (!current && defaultParametersByType[type]) {
                  form.setFieldValue(
                    'parameters',
                    JSON.stringify(defaultParametersByType[type], null, 2)
                  );
                }
              }}
              placeholder={
                '{\n  "syncAllStocks": true,\n  "lookback_days": 10,\n  "dataSource": "auto",\n  "concurrency": 2\n}'
              }
            />
          </Form.Item>

          <Form.Item name="is_active" label="启用状态" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={`[${activeTaskName}] - 历史执行记录`}
        open={isLogModalVisible}
        onCancel={() => setIsLogModalVisible(false)}
        footer={null}
        width={960}
      >
        <Table
          dataSource={currentLogs}
          rowKey="id"
          loading={logLoading}
          pagination={{ pageSize: 10 }}
          size="small"
          scroll={{ x: 1080 }}
          columns={[
            {
              title: '状态',
              dataIndex: 'status',
              key: 'status',
              render: (status: string) => {
                const color =
                  status === 'COMPLETED' ? 'green' : status === 'FAILED' ? 'red' : 'blue';
                return <Tag color={color}>{status}</Tag>;
              },
            },
            {
              title: '开始时间',
              dataIndex: 'started_at',
              key: 'started_at',
              render: (text: string) => dayjs(text).format('MM-DD HH:mm:ss'),
            },
            {
              title: '结束时间',
              dataIndex: 'completed_at',
              key: 'completed_at',
              render: (text: string) => (text ? dayjs(text).format('MM-DD HH:mm:ss') : '-'),
            },
            {
              title: '进度 (完成/失败/总计)',
              key: 'progress',
              render: (_: any, record: TaskExecutionLog) => (
                <Text>
                  {record.completed_items} / <Text type="danger">{record.failed_items}</Text> /{' '}
                  {record.total_items}
                </Text>
              ),
            },
            {
              title: '队列任务',
              key: 'queue_jobs',
              width: 260,
              render: (_: any, record: TaskExecutionLog) => {
                const jobs = record.queue_jobs || [];
                if (!jobs.length) {
                  return record.queue_error ? (
                    <Text type="warning" ellipsis={{ tooltip: record.queue_error }}>
                      队列详情暂不可用
                    </Text>
                  ) : (
                    <Text type="secondary">暂无关联</Text>
                  );
                }

                return (
                  <Space direction="vertical" size={6}>
                    {jobs.map(job => (
                      <Space key={`${job.queue_name}-${job.id}`} size={6} wrap>
                        <Tag
                          color={getQueueStateColor(job.state)}
                          icon={<DatabaseOutlined />}
                          style={{ marginRight: 0 }}
                        >
                          {job.queue_name} · {queueStateLabels[job.state] || job.state}
                        </Tag>
                        <Button
                          type="link"
                          size="small"
                          icon={<EyeOutlined />}
                          onClick={() => {
                            setQueueDetail(job);
                            setIsQueueDetailVisible(true);
                          }}
                          style={{ paddingInline: 0 }}
                        >
                          详情
                        </Button>
                      </Space>
                    ))}
                  </Space>
                );
              },
            },
            {
              title: '异常信息',
              dataIndex: 'error_message',
              key: 'error_message',
              render: (text: string) =>
                text ? (
                  <Text type="danger" ellipsis={{ tooltip: text }} style={{ maxWidth: 200 }}>
                    {text}
                  </Text>
                ) : (
                  '-'
                ),
            },
          ]}
        />
      </Modal>

      <Modal
        title={
          <Space>
            <DatabaseOutlined />
            队列任务详情
          </Space>
        }
        open={isQueueDetailVisible}
        onCancel={() => setIsQueueDetailVisible(false)}
        footer={null}
        width={780}
      >
        {queueDetail && (
          <div className="queue-detail-panel">
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Space wrap>
                <Tag color="geekblue">{queueDetail.queue_name}</Tag>
                <Tag color={getQueueStateColor(queueDetail.state)}>
                  {queueStateLabels[queueDetail.state] || queueDetail.state}
                </Tag>
                <Text code copyable>
                  {String(queueDetail.id)}
                </Text>
              </Space>

              <Descriptions bordered size="small" column={1}>
                <Descriptions.Item label="任务名称">{queueDetail.name || '-'}</Descriptions.Item>
                <Descriptions.Item label="状态">
                  <Tag color={getQueueStateColor(queueDetail.state)}>
                    {queueStateLabels[queueDetail.state] || queueDetail.state}
                  </Tag>
                </Descriptions.Item>
                <Descriptions.Item label="进度">
                  {formatQueueProgress(queueDetail.progress)}
                </Descriptions.Item>
                <Descriptions.Item label="尝试次数">
                  {queueDetail.attempts_made ?? '-'}
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {formatQueueTime(queueDetail.timestamp)}
                </Descriptions.Item>
                <Descriptions.Item label="开始处理">
                  {formatQueueTime(queueDetail.processed_on)}
                </Descriptions.Item>
                <Descriptions.Item label="结束时间">
                  {formatQueueTime(queueDetail.finished_on)}
                </Descriptions.Item>
                <Descriptions.Item label="失败原因">
                  {queueDetail.failed_reason || '-'}
                </Descriptions.Item>
              </Descriptions>

              <Divider style={{ margin: '4px 0' }} />

              <div>
                <Title level={5} style={{ marginBottom: 8 }}>
                  投递数据
                </Title>
                <pre className="task-ops-codeblock">{stringifyJson(queueDetail.data)}</pre>
              </div>

              {queueDetail.return_value !== undefined && queueDetail.return_value !== null && (
                <div>
                  <Title level={5} style={{ marginBottom: 8 }}>
                    执行返回
                  </Title>
                  <pre className="task-ops-codeblock task-ops-codeblock--green">
                    {stringifyJson(queueDetail.return_value)}
                  </pre>
                </div>
              )}
            </Space>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default TaskScheduler;
