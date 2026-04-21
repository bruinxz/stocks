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
  message,
  Tooltip,
  Empty,
} from 'antd';
import {
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { taskService, ScheduledTask } from '../services/taskService';

const { Title, Text } = Typography;
const { Option } = Select;

const TaskScheduler: React.FC = () => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
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
    form.validateFields().then(async values => {
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
          onChange={checked => handleToggleActive(record.id!, checked)}
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
            <Tag
              color={
                record.last_run_status === 'SUCCESS'
                  ? 'success'
                  : record.last_run_status === 'FAILED'
                  ? 'error'
                  : 'processing'
              }
            >
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
          <Button type="text" icon={<EditOutlined />} onClick={() => handleEdit(record)} />
          <Button
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id!)}
          />
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
          <p className="page-subtitle-modern">配置并管理系统的自动化任务，如数据拉取、定时巡检等</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleAdd}>
          新建任务
        </Button>
      </div>

      <Card className="modern-card" bordered={false}>
        <Table
          columns={columns}
          dataSource={tasks}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
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
        <Form form={form} layout="vertical" initialValues={{ is_active: true }}>
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
            <Select placeholder="选择要执行的任务类型">
              <Option value="SYNC_ALL_STOCKS">全市场股票列表同步</Option>
              <Option value="SYNC_HISTORY">股票历史行情同步</Option>
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
            <Input.TextArea rows={4} placeholder='{"symbols": ["600519", "000001"]}' />
          </Form.Item>

          <Form.Item name="is_active" label="启用状态" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default TaskScheduler;
