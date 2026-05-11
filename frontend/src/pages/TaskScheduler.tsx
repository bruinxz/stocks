import React, { useState, useEffect } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Switch,
  Modal,
  Form,
  Input,
  Select,
  Descriptions,
  message,
  Tooltip,
  Empty,
  Divider,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  DatabaseOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import {
  taskService,
  ScheduledTask,
  TaskExecutionLog,
  QueueJobSummary,
} from '../services/taskService';
import dayjs from 'dayjs';

const { Text, Title } = Typography;
const { Option } = Select;

const taskTypeLabels: Record<string, string> = {
  DAILY_UPDATE: '每日行情增量同步',
  SYNC_ALL_STOCKS: '全市场股票列表同步',
  SYNC_HISTORY: '股票历史行情同步',
  DATA_QUALITY_SCAN: '数据质量扫描',
  AI_DAILY_SCREENER: 'AI 每日优选评估',
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
};

const getLastRunStatusColor = (status?: string) => {
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILED') return 'error';
  return 'processing';
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

const getQueueStateColor = (state?: string) => {
  if (state === 'completed') return 'success';
  if (state === 'failed') return 'error';
  if (state === 'active') return 'processing';
  if (state === 'waiting' || state === 'delayed') return 'warning';
  return 'default';
};

const formatQueueTime = (timestamp?: number) =>
  timestamp ? dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') : '-';

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

const TaskScheduler: React.FC = () => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<TaskExecutionLog[]>([]);
  const [activeTaskName, setActiveTaskName] = useState<string>('');
  const [queueDetail, setQueueDetail] = useState<QueueJobSummary | null>(null);
  const [isQueueDetailVisible, setIsQueueDetailVisible] = useState(false);
  const [form] = Form.useForm();

  const fetchTasks = async () => {
    setLoading(true);
    try {
      const data = await taskService.getTasks();
      setTasks(data);
    } catch (error) {
      message.error('获取任务列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

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
          fetchTasks();
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
          fetchTasks();
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
      fetchTasks();
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
        fetchTasks();
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

  const columns = [
    {
      title: '任务名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '任务类型',
      dataIndex: 'type',
      key: 'type',
      render: (text: string) => (
        <Space direction="vertical" size={0}>
          <Tag color="blue">{text}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {taskTypeLabels[text] || text}
          </Text>
        </Space>
      ),
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
        <Space size="middle">
          <Button
            type="link"
            icon={<PlayCircleOutlined />}
            onClick={() => record.id && handleExecute(record.id)}
            style={{ color: '#52c41a' }}
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
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <h1 className="page-title-modern">定时任务调度</h1>
          <p className="page-subtitle-modern">
            配置并管理系统自动化任务：行情同步、多因子候选池、TradingAgents 每日优选
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          新建任务
        </Button>
      </div>

      <Card className="modern-card" variant="borderless">
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
        width={600}
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
              <Option value="AI_DAILY_SCREENER">AI 每日优选评估</Option>
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
              rows={7}
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
        width={900}
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
          <div
            style={{
              background:
                'linear-gradient(135deg, rgba(15, 23, 42, 0.04), rgba(14, 165, 233, 0.06))',
              border: '1px solid rgba(15, 23, 42, 0.08)',
              borderRadius: 18,
              padding: 16,
            }}
          >
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
                <pre
                  style={{
                    maxHeight: 260,
                    overflow: 'auto',
                    margin: 0,
                    padding: 14,
                    borderRadius: 14,
                    background: '#0f172a',
                    color: '#dbeafe',
                    border: '1px solid rgba(148, 163, 184, 0.24)',
                    fontSize: 12,
                    lineHeight: 1.6,
                  }}
                >
                  {stringifyJson(queueDetail.data)}
                </pre>
              </div>

              {queueDetail.return_value !== undefined && queueDetail.return_value !== null && (
                <div>
                  <Title level={5} style={{ marginBottom: 8 }}>
                    执行返回
                  </Title>
                  <pre
                    style={{
                      maxHeight: 220,
                      overflow: 'auto',
                      margin: 0,
                      padding: 14,
                      borderRadius: 14,
                      background: '#111827',
                      color: '#dcfce7',
                      border: '1px solid rgba(34, 197, 94, 0.24)',
                      fontSize: 12,
                      lineHeight: 1.6,
                    }}
                  >
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
