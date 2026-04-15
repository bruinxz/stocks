import React, { useState, useEffect, useCallback } from 'react';
import {
  Layout,
  Card,
  Table,
  Button,
  Space,
  Tag,
  Row,
  Col,
  Typography,
  Divider,
  Statistic,
  Progress,
  Alert,
  Modal,
  message,
  Tooltip,
  Switch,
  Empty,
  Timeline,
  Badge,
  Radio,
  Checkbox,
  Select,
  DatePicker,
  InputNumber,
} from 'antd';
import {
  SyncOutlined,
  ReloadOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  BarChartOutlined,
  LineChartOutlined,
  DashboardOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import dayjs from 'dayjs';
import api from '../services/api';

const { Title, Text, Paragraph } = Typography;

interface QueueStatus {
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  total: number;
}

interface JobInfo {
  id: string;
  data: {
    type: string;
    date: string;
    forceUpdate?: boolean;
    userId?: number;
  };
  state: string;
  progress: number;
  failedReason?: string;
  finishedOn?: number;
  processedOn?: number;
  timestamp?: number;
}

interface UpdateLog {
  id: number;
  type: string;
  status: string;
  date: string;
  affectedStocks?: number;
  insertedRecords?: number;
  error?: string;
  result?: any;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface UpdateStats {
  totalUpdates: number;
  successfulUpdates: number;
  failedUpdates: number;
  inProgressUpdates: number;
  avgAffectedStocks: number;
  avgInsertedRecords: number;
  dailyBreakdown: Array<{
    date: string;
    affectedStocks: number;
    insertedRecords: number;
    status: string;
  }>;
}

interface LockStatus {
  global: boolean;
  daily: boolean;
  newStocks: boolean;
}

interface SystemHealth {
  redis: boolean;
  database: boolean;
  queue: boolean;
  dataSource: boolean;
}

const DataUpdateStatus: React.FC = () => {
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({
    waiting: 0,
    active: 0,
    completed: 0,
    failed: 0,
    delayed: 0,
    total: 0,
  });
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [updateLogs, setUpdateLogs] = useState<UpdateLog[]>([]);
  const [updateStats, setUpdateStats] = useState<UpdateStats | null>(null);
  const [lockStatus, setLockStatus] = useState<LockStatus>({
    global: false,
    daily: false,
    newStocks: false,
  });
  const [systemHealth, setSystemHealth] = useState<SystemHealth>({
    redis: true,
    database: true,
    queue: true,
    dataSource: true,
  });
  const [systemHealthDetails, setSystemHealthDetails] = useState<any>(null);
  const [loading, setLoading] = useState({
    queue: false,
    logs: false,
    stats: false,
    health: false,
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(10); // 秒

  // 批量同步相关状态
  const [bulkSyncModalVisible, setBulkSyncModalVisible] = useState(false);
  const [bulkSyncLoading, setBulkSyncLoading] = useState(false);
  const [bulkSyncForm, setBulkSyncForm] = useState({
    symbols: [] as string[],
    marketFilters: [] as ('SH' | 'SZ' | 'BJ')[],
    syncAllStocks: false,
    startDate: '',
    endDate: '',
    dataSource: 'akshare' as 'akshare',
    concurrency: 10,
  });
  const [stockOptions, setStockOptions] = useState<{ label: string; value: string }[]>([]);
  const [loadingStocks, setLoadingStocks] = useState(false);

  // 日志筛选状态
  const [logFilters, setLogFilters] = useState({
    types: [] as string[], // 任务类型筛选
    startDate: '', // 开始日期 YYYY-MM-DD
    endDate: '', // 结束日期 YYYY-MM-DD
  });

  // 获取所有数据
  const fetchAllData = useCallback(async () => {
    try {
      setLoading(prev => ({ ...prev, queue: true, logs: true, stats: true, health: true }));

      // 获取队列状态（带筛选参数）
      const queryParams = new URLSearchParams();
      if (logFilters.types.length > 0) {
        // 如果选择了多个类型，可以传递多个type参数，或者用逗号分隔
        // 这里后端支持多个type参数，所以可以传递多个
        logFilters.types.forEach(type => queryParams.append('type', type));
      }
      if (logFilters.startDate) {
        queryParams.append('startDate', logFilters.startDate);
      }
      if (logFilters.endDate) {
        queryParams.append('endDate', logFilters.endDate);
      }

      const queryString = queryParams.toString();
      const url = queryString ? `/market/update-status?${queryString}` : '/market/update-status';

      const statusResponse = await api.get(url);
      if (statusResponse.data.success) {
        const data = statusResponse.data.data;
        setQueueStatus(data.queue);
        // 优先使用jobs数组，如果不存在则使用job字段
        setJobs(data.jobs || (data.job ? [data.job] : []) || []);
        setLockStatus(data.locks);
        setUpdateLogs(data.logs || []);
      }

      // 获取统计信息
      const statsResponse = await api.get('/market/update-stats?days=7');
      if (statsResponse.data.success) {
        setUpdateStats(statsResponse.data.data.stats);
      }

      // 获取系统健康状态
      const healthResponse = await api.get('/market/health');
      if (healthResponse.data.success) {
        const healthData = healthResponse.data.data;
        // 将后端健康数据转换为前端格式
        setSystemHealth({
          redis: healthData.services.redisLock?.status === 'healthy',
          database: healthData.services.database?.status === 'healthy',
          queue: healthData.services.dataUpdateQueue?.status === 'healthy',
          dataSource: true, // 数据源健康状态需要单独检查
        });
        setSystemHealthDetails(healthData);
      }

    } catch (error: any) {
      message.error('获取数据失败: ' + error.message);
    } finally {
      setLoading(prev => ({ ...prev, queue: false, logs: false, stats: false, health: false }));
    }
  }, [logFilters]); // 添加依赖，当筛选条件变化时重新创建函数

  // 筛选处理函数
  // 任务类型选项
  const taskTypeOptions = [
    { label: '每日更新', value: 'daily_update' },
    { label: '新股同步', value: 'new_stocks_sync' },
    { label: '周完整性检查', value: 'weekly_completeness_check' },
    { label: '手动同步', value: 'manual_sync' },
    { label: '批量同步', value: 'bulk_sync_custom' },
  ];

  // 筛选条件变更
  const handleFilterChange = (key: keyof typeof logFilters, value: any) => {
    setLogFilters(prev => ({ ...prev, [key]: value }));
  };

  // 应用筛选
  const handleApplyFilters = () => {
    fetchAllData();
    message.success('筛选已应用');
  };

  // 重置筛选
  const handleResetFilters = () => {
    setLogFilters({
      types: [],
      startDate: '',
      endDate: '',
    });
    // 重置后立即刷新数据
    setTimeout(() => fetchAllData(), 100);
    message.success('筛选条件已重置');
  };

  // 加载股票选项
  const loadStockOptions = useCallback(async () => {
    try {
      setLoadingStocks(true);
      const response = await api.get('/market/search', {
        params: { limit: 5000 } // 获取所有股票
      });
      if (response.data.success) {
        const stocks = response.data.data.stocks || [];
        const options = stocks.map((stock: any) => ({
          label: `${stock.symbol} ${stock.name}`,
          value: stock.symbol,
        }));
        setStockOptions(options);
      }
    } catch (error: any) {
      message.error('加载股票列表失败: ' + error.message);
    } finally {
      setLoadingStocks(false);
    }
  }, []);

  // 批量同步表单变更
  const handleBulkSyncFormChange = (key: keyof typeof bulkSyncForm, value: any) => {
    setBulkSyncForm(prev => ({ ...prev, [key]: value }));
  };

  // 提交批量同步任务
  const handleBulkSyncSubmit = async () => {
    try {
      setBulkSyncLoading(true);

      // 验证表单
      if (!bulkSyncForm.syncAllStocks &&
          bulkSyncForm.symbols.length === 0 &&
          bulkSyncForm.marketFilters.length === 0) {
        message.error('请选择要同步的股票范围');
        return;
      }

      const payload: any = {};
      if (bulkSyncForm.syncAllStocks) {
        payload.syncAllStocks = true;
      } else if (bulkSyncForm.symbols.length > 0) {
        payload.symbols = bulkSyncForm.symbols;
      } else if (bulkSyncForm.marketFilters.length > 0) {
        payload.marketFilters = bulkSyncForm.marketFilters;
      }

      if (bulkSyncForm.startDate) {
        payload.startDate = bulkSyncForm.startDate;
      }
      if (bulkSyncForm.endDate) {
        payload.endDate = bulkSyncForm.endDate;
      }
      if (bulkSyncForm.concurrency) {
        payload.concurrency = bulkSyncForm.concurrency;
      }
      payload.dataSource = bulkSyncForm.dataSource;

      const response = await api.post('/market/bulk-sync', payload);
      if (response.data.success) {
        message.success('批量同步任务已提交');
        setBulkSyncModalVisible(false);
        // 重置表单
        setBulkSyncForm({
          symbols: [],
          marketFilters: [],
          syncAllStocks: false,
          startDate: '',
          endDate: '',
          dataSource: 'akshare',
          concurrency: 10,
        });
        // 刷新数据
        fetchAllData();
      }
    } catch (error: any) {
      message.error('提交批量同步任务失败: ' + error.message);
    } finally {
      setBulkSyncLoading(false);
    }
  };

  // 打开批量同步模态框
  const openBulkSyncModal = () => {
    setBulkSyncModalVisible(true);
    // 如果股票选项为空，则加载
    if (stockOptions.length === 0) {
      loadStockOptions();
    }
  };

  // 手动刷新
  const handleRefresh = () => {
    fetchAllData();
    message.success('数据已刷新');
  };

  // 触发数据更新
  const handleTriggerUpdate = async (force = false) => {
    try {
      const url = force ? '/market/update-data?force=true' : '/market/update-data';
      const response = await api.post(url);
      if (response.data.success) {
        message.success(response.data.data.message);
        fetchAllData();
      }
    } catch (error: any) {
      message.error('触发更新失败: ' + error.message);
    }
  };

  // 手动同步
  const handleManualSync = async (type: string) => {
    try {
      const response = await api.post('/market/manual-sync', { type });
      if (response.data.success) {
        message.success('手动同步任务已排队');
        fetchAllData();
      }
    } catch (error: any) {
      message.error('手动同步失败: ' + error.message);
    }
  };

  // 清理队列
  const handleCleanQueue = async () => {
    Modal.confirm({
      title: '确认清理队列',
      content: '这将清理所有已完成和失败的任务，是否继续？',
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        try {
          const response = await api.post('/market/clean-queue');
          if (response.data.success) {
            message.success('队列已清理');
            fetchAllData();
          }
        } catch (error: any) {
          message.error('清理队列失败: ' + error.message);
        }
      },
    });
  };

  // 取消任务
  const handleCancelJob = async (jobId: string) => {
    Modal.confirm({
      title: '确认取消任务',
      content: `确定要取消任务 ${jobId} 吗？`,
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        try {
          const response = await api.post(`/market/queue/${jobId}/cancel`);
          if (response.data.success) {
            message.success('任务已取消');
            fetchAllData();
          } else {
            message.error(response.data.error || '取消任务失败');
          }
        } catch (error: any) {
          message.error('取消任务失败: ' + error.message);
        }
      },
    });
  };

  // 重试失败任务
  const handleRetryJob = async (jobId: string) => {
    Modal.confirm({
      title: '确认重试任务',
      content: `确定要重试任务 ${jobId} 吗？`,
      okText: '确认',
      cancelText: '取消',
      onOk: async () => {
        try {
          const response = await api.post(`/market/queue/${jobId}/retry`);
          if (response.data.success) {
            message.success('任务已重新排队');
            fetchAllData();
          } else {
            message.error(response.data.error || '重试任务失败');
          }
        } catch (error: any) {
          message.error('重试任务失败: ' + error.message);
        }
      },
    });
  };

  // 自动刷新
  useEffect(() => {
    fetchAllData();

    let intervalId: NodeJS.Timeout;
    if (autoRefresh) {
      intervalId = setInterval(fetchAllData, refreshInterval * 1000);
    }

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [fetchAllData, autoRefresh, refreshInterval]);

  // 任务表格列定义
  // 计算预计剩余时间
  const calculateETA = (progress: number, processedOn?: number): string => {
    if (!processedOn || progress <= 0 || progress >= 100) {
      return '--';
    }
    const elapsedMs = Date.now() - processedOn;
    const totalEstimatedMs = elapsedMs / (progress / 100);
    const remainingMs = totalEstimatedMs - elapsedMs;

    if (remainingMs < 60000) {
      return `${Math.ceil(remainingMs / 1000)}秒`;
    } else if (remainingMs < 3600000) {
      return `${Math.ceil(remainingMs / 60000)}分钟`;
    } else {
      const hours = Math.floor(remainingMs / 3600000);
      const minutes = Math.ceil((remainingMs % 3600000) / 60000);
      return `${hours}小时${minutes}分钟`;
    }
  };

  const jobColumns: ColumnsType<JobInfo> = [
    {
      title: '任务ID',
      dataIndex: 'id',
      key: 'id',
      width: 150,
      render: (id) => <Text code>{id.substring(0, 8)}...</Text>,
    },
    {
      title: '类型',
      dataIndex: ['data', 'type'],
      key: 'type',
      width: 120,
      render: (type) => {
        const typeMap: Record<string, { label: string, color: string }> = {
          daily_update: { label: '每日更新', color: 'blue' },
          new_stocks_sync: { label: '新股同步', color: 'green' },
          weekly_completeness_check: { label: '完整性检查', color: 'orange' },
          manual_sync: { label: '手动同步', color: 'purple' },
          bulk_sync_custom: { label: '批量同步', color: 'cyan' },
        };
        const config = typeMap[type] || { label: type, color: 'default' };
        return <Tag color={config.color}>{config.label}</Tag>;
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      key: 'state',
      width: 100,
      render: (state) => {
        const stateMap: Record<string, { label: string, color: string, icon: React.ReactNode }> = {
          waiting: { label: '等待中', color: 'default', icon: <SyncOutlined spin /> },
          active: { label: '进行中', color: 'processing', icon: <SyncOutlined spin /> },
          completed: { label: '已完成', color: 'success', icon: <CheckCircleOutlined /> },
          failed: { label: '失败', color: 'error', icon: <CloseCircleOutlined /> },
          delayed: { label: '延迟', color: 'warning', icon: <ExclamationCircleOutlined /> },
        };
        const config = stateMap[state] || { label: state, color: 'default', icon: null };
        return (
          <Tag icon={config.icon} color={config.color}>
            {config.label}
          </Tag>
        );
      },
    },
    {
      title: '进度',
      dataIndex: 'progress',
      key: 'progress',
      width: 120,
      render: (progress, record) => (
        <Progress
          percent={progress}
          size="small"
          status={record.state === 'failed' ? 'exception' : 'normal'}
        />
      ),
    },
    {
      title: '操作时间',
      dataIndex: 'processedOn',
      key: 'processedOn',
      width: 180,
      render: (timestamp) => (
        timestamp ? dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') : '--'
      ),
    },
    {
      title: '预计剩余',
      key: 'eta',
      width: 120,
      render: (_, record) => (
        <Text type="secondary">
          {calculateETA(record.progress, record.processedOn)}
        </Text>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 150,
      render: (_, record) => (
        <Space size="small">
          {record.state === 'active' && (
            <Button
              size="small"
              danger
              icon={<PauseCircleOutlined />}
              onClick={() => handleCancelJob(record.id)}
            >
              取消
            </Button>
          )}
          {record.state === 'failed' && (
            <Button
              size="small"
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => handleRetryJob(record.id)}
            >
              重试
            </Button>
          )}
        </Space>
      ),
    },
  ];

  // 更新日志表格列定义
  const logColumns: ColumnsType<UpdateLog> = [
    {
      title: '日期',
      dataIndex: 'date',
      key: 'date',
      width: 100,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 120,
      render: (type) => {
        const typeMap: Record<string, { label: string, color: string }> = {
          daily_update: { label: '每日更新', color: 'blue' },
          new_stocks_sync: { label: '新股同步', color: 'green' },
          weekly_completeness_check: { label: '完整性检查', color: 'orange' },
          manual_sync: { label: '手动同步', color: 'purple' },
          bulk_sync_custom: { label: '批量同步', color: 'cyan' },
        };
        const config = typeMap[type] || { label: type, color: 'default' };
        return <Tag color={config.color}>{config.label}</Tag>;
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status) => {
        const statusMap: Record<string, { label: string, color: string }> = {
          pending: { label: '待处理', color: 'default' },
          in_progress: { label: '进行中', color: 'processing' },
          completed: { label: '已完成', color: 'success' },
          failed: { label: '失败', color: 'error' },
        };
        const config = statusMap[status] || { label: status, color: 'default' };
        return <Tag color={config.color}>{config.label}</Tag>;
      },
    },
    {
      title: '影响股票',
      dataIndex: 'affectedStocks',
      key: 'affectedStocks',
      width: 100,
      render: (count) => count || '--',
    },
    {
      title: '插入记录',
      dataIndex: 'insertedRecords',
      key: 'insertedRecords',
      width: 100,
      render: (count) => count || '--',
    },
    {
      title: '错误信息',
      dataIndex: 'error',
      key: 'error',
      width: 200,
      ellipsis: true,
      render: (error) => (
        error ? (
          <Tooltip title={error}>
            <Text type="danger" style={{ cursor: 'pointer' }}>
              {error.substring(0, 30)}...
            </Text>
          </Tooltip>
        ) : '--'
      ),
    },
    {
      title: '开始时间',
      dataIndex: 'startedAt',
      key: 'startedAt',
      width: 180,
      render: (time) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '--',
    },
    {
      title: '完成时间',
      dataIndex: 'completedAt',
      key: 'completedAt',
      width: 180,
      render: (time) => time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '--',
    },
    {
      title: '耗时',
      key: 'duration',
      width: 120,
      render: (_, record) => {
        if (!record.startedAt || !record.completedAt) return '--';
        const start = dayjs(record.startedAt);
        const end = dayjs(record.completedAt);
        const durationMs = end.diff(start);
        const seconds = Math.floor(durationMs / 1000);
        if (seconds < 60) {
          return `${seconds}秒`;
        } else if (seconds < 3600) {
          const minutes = Math.floor(seconds / 60);
          const remainingSeconds = seconds % 60;
          return `${minutes}分${remainingSeconds}秒`;
        } else {
          const hours = Math.floor(seconds / 3600);
          const minutes = Math.floor((seconds % 3600) / 60);
          return `${hours}小时${minutes}分`;
        }
      },
    },
    {
      title: '结果摘要',
      key: 'resultSummary',
      width: 200,
      render: (_, record) => {
        if (!record.result) return '--';
        try {
          const result = record.result;
          if (typeof result === 'object') {
            // 批量同步任务结果（包括manual_sync和bulk_sync_custom）
            if (result.bulkSync || result.successfulSyncs !== undefined || result.failedSyncs !== undefined) {
              const totalStocks = result.totalStocks || (result.successfulSyncs || 0) + (result.failedSyncs || 0);
              const successfulSyncs = result.successfulSyncs || 0;
              const failedSyncs = result.failedSyncs || 0;
              const totalRecordsInserted = result.totalRecordsInserted || 0;
              return (
                <div>
                  <div>股票: {successfulSyncs}/{totalStocks} 成功</div>
                  <div>记录: {totalRecordsInserted} 条</div>
                </div>
              );
            }
            // 每日更新结果
            if (result.dailyUpdate) {
              const successCount = result.dailyUpdate.successCount || 0;
              const failCount = result.dailyUpdate.failCount || 0;
              const totalInserted = result.dailyUpdate.totalInserted || 0;
              return (
                <div>
                  <div>股票: {successCount} 成功, {failCount} 失败</div>
                  <div>记录: {totalInserted} 条</div>
                </div>
              );
            }
            // 新股同步结果
            if (result.syncedCount !== undefined) {
              return `同步股票: ${result.syncedCount}`;
            }
            // 周完整性检查结果
            if (result.missingDataCount !== undefined) {
              return (
                <div>
                  <div>检查股票: {result.totalStocks || '--'}</div>
                  <div>缺失数据: {result.missingDataCount} 只</div>
                </div>
              );
            }
            // 其他结果
            return JSON.stringify(result).substring(0, 50) + '...';
          }
          return String(result).substring(0, 50);
        } catch (e) {
          return '解析失败';
        }
      },
    },
  ];

  // 系统健康状态卡片
  const renderHealthCard = () => (
    <Card title="系统健康状态" size="small">
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="Redis"
              value={systemHealth.redis ? '正常' : '异常'}
              valueStyle={{ color: systemHealth.redis ? '#3f8600' : '#cf1322' }}
              prefix={systemHealth.redis ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="数据库"
              value={systemHealth.database ? '正常' : '异常'}
              valueStyle={{ color: systemHealth.database ? '#3f8600' : '#cf1322' }}
              prefix={systemHealth.database ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="队列系统"
              value={systemHealth.queue ? '正常' : '异常'}
              valueStyle={{ color: systemHealth.queue ? '#3f8600' : '#cf1322' }}
              prefix={systemHealth.queue ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic
              title="数据源"
              value={systemHealth.dataSource ? '正常' : '异常'}
              valueStyle={{ color: systemHealth.dataSource ? '#3f8600' : '#cf1322' }}
              prefix={systemHealth.dataSource ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
            />
          </Card>
        </Col>
      </Row>
    </Card>
  );

  // 队列状态卡片
  const renderQueueCard = () => (
    <Card title="队列状态概览" size="small">
      <Row gutter={[16, 16]}>
        <Col span={4}>
          <Card size="small">
            <Statistic title="等待中" value={queueStatus.waiting} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="进行中"
              value={queueStatus.active}
              valueStyle={{ color: queueStatus.active > 0 ? '#1890ff' : undefined }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="已完成" value={queueStatus.completed} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic
              title="失败"
              value={queueStatus.failed}
              valueStyle={{ color: queueStatus.failed > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="延迟" value={queueStatus.delayed} />
          </Card>
        </Col>
        <Col span={4}>
          <Card size="small">
            <Statistic title="总计" value={queueStatus.total} />
          </Card>
        </Col>
      </Row>
      <Divider />
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Text strong>分布式锁状态：</Text>
          <Space style={{ marginLeft: 16 }}>
            <Tag color={lockStatus.global ? 'red' : 'green'}>
              全局锁：{lockStatus.global ? '已锁定' : '未锁定'}
            </Tag>
            <Tag color={lockStatus.daily ? 'red' : 'green'}>
              日锁：{lockStatus.daily ? '已锁定' : '未锁定'}
            </Tag>
            <Tag color={lockStatus.newStocks ? 'red' : 'green'}>
              新股锁：{lockStatus.newStocks ? '已锁定' : '未锁定'}
            </Tag>
          </Space>
        </Col>
      </Row>
    </Card>
  );

  // 控制面板卡片
  const renderControlPanel = () => (
    <Card title="控制面板" size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Row gutter={[8, 8]}>
          <Col>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => handleTriggerUpdate(false)}
            >
              触发数据更新
            </Button>
          </Col>
          <Col>
            <Button
              type="primary"
              danger
              icon={<PlayCircleOutlined />}
              onClick={() => handleTriggerUpdate(true)}
            >
              强制更新
            </Button>
          </Col>
          <Col>
            <Button
              icon={<SyncOutlined />}
              onClick={handleRefresh}
            >
              刷新数据
            </Button>
          </Col>
          <Col>
            <Button
              icon={<DeleteOutlined />}
              onClick={handleCleanQueue}
            >
              清理队列
            </Button>
          </Col>
          <Col>
            <Button
              type="primary"
              icon={<SyncOutlined />}
              onClick={openBulkSyncModal}
            >
              批量同步
            </Button>
          </Col>
        </Row>

        <Row gutter={[8, 8]}>
          <Col>
            <Text strong>手动同步：</Text>
          </Col>
          <Col>
            <Button
              size="small"
              onClick={() => handleManualSync('new_stocks_sync')}
            >
              新股同步
            </Button>
          </Col>
          <Col>
            <Button
              size="small"
              onClick={() => handleManualSync('weekly_completeness_check')}
            >
              完整性检查
            </Button>
          </Col>
          <Col>
            <Button
              size="small"
              onClick={() => handleManualSync('daily_update')}
            >
              每日更新
            </Button>
          </Col>
        </Row>

        <Row gutter={[8, 8]} align="middle">
          <Col>
            <Text strong>自动刷新：</Text>
          </Col>
          <Col>
            <Switch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              checkedChildren="开"
              unCheckedChildren="关"
            />
          </Col>
          <Col>
            <Text>间隔：</Text>
          </Col>
          <Col>
            <Space>
              {[5, 10, 30, 60].map(seconds => (
                <Button
                  key={seconds}
                  size="small"
                  type={refreshInterval === seconds ? 'primary' : 'default'}
                  onClick={() => setRefreshInterval(seconds)}
                >
                  {seconds}秒
                </Button>
              ))}
            </Space>
          </Col>
        </Row>
      </Space>
    </Card>
  );

  // 批量同步模态框
  const renderBulkSyncModal = () => {
    const marketOptions = [
      { label: '上海交易所 (SH)', value: 'SH' },
      { label: '深圳交易所 (SZ)', value: 'SZ' },
      { label: '北京交易所 (BJ)', value: 'BJ' },
    ];

    const dataSourceOptions = [
      { label: 'AKShare (推荐)', value: 'akshare' },
    ];

    return (
      <Modal
        title="批量数据同步"
        open={bulkSyncModalVisible}
        onOk={handleBulkSyncSubmit}
        onCancel={() => setBulkSyncModalVisible(false)}
        confirmLoading={bulkSyncLoading}
        width={800}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            message="批量同步说明"
            description="选择要同步的股票范围、日期范围和数据源，系统将在后台异步执行同步任务。"
            type="info"
            showIcon
          />

          <Divider orientation="left">股票范围</Divider>

          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Radio.Group
                value={bulkSyncForm.syncAllStocks ? 'all' : 'custom'}
                onChange={(e) => handleBulkSyncFormChange('syncAllStocks', e.target.value === 'all')}
              >
                <Space direction="vertical">
                  <Radio value="all">同步所有股票（当前数据库中的所有股票）</Radio>
                  <Radio value="custom">自定义选择</Radio>
                </Space>
              </Radio.Group>
            </Col>
          </Row>

          {!bulkSyncForm.syncAllStocks && (
            <>
              <Row gutter={[16, 16]}>
                <Col span={24}>
                  <Text strong>按市场筛选：</Text>
                  <Checkbox.Group
                    options={marketOptions}
                    value={bulkSyncForm.marketFilters}
                    onChange={(values) => handleBulkSyncFormChange('marketFilters', values)}
                    style={{ marginLeft: 16 }}
                  />
                </Col>
              </Row>

              <Row gutter={[16, 16]}>
                <Col span={24}>
                  <Text strong>指定股票代码（可多选）：</Text>
                  <Select
                    mode="multiple"
                    placeholder="选择股票代码"
                    value={bulkSyncForm.symbols}
                    onChange={(values) => handleBulkSyncFormChange('symbols', values)}
                    style={{ width: '100%', marginTop: 8 }}
                    loading={loadingStocks}
                    options={stockOptions}
                    filterOption={(input, option) =>
                      (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                    showSearch
                    allowClear
                  />
                  <Text type="secondary" style={{ marginTop: 4, display: 'block' }}>
                    注意：如果指定了股票代码，将忽略市场筛选。
                  </Text>
                </Col>
              </Row>
            </>
          )}

          <Divider orientation="left">日期范围</Divider>

          <Row gutter={[16, 16]}>
            <Col span={12}>
              <Text strong>开始日期：</Text>
              <DatePicker
                value={bulkSyncForm.startDate ? dayjs(bulkSyncForm.startDate) : null}
                onChange={(date) => handleBulkSyncFormChange('startDate', date ? date.format('YYYY-MM-DD') : '')}
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择开始日期（留空则从2020-01-01开始）"
              />
            </Col>
            <Col span={12}>
              <Text strong>结束日期：</Text>
              <DatePicker
                value={bulkSyncForm.endDate ? dayjs(bulkSyncForm.endDate) : null}
                onChange={(date) => handleBulkSyncFormChange('endDate', date ? date.format('YYYY-MM-DD') : '')}
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择结束日期（留空则到今天）"
              />
            </Col>
          </Row>

          <Divider orientation="left">同步设置</Divider>

          <Row gutter={[16, 16]}>
            <Col span={12}>
              <Text strong>数据源：</Text>
              <Radio.Group
                options={dataSourceOptions}
                value={bulkSyncForm.dataSource}
                onChange={(e) => handleBulkSyncFormChange('dataSource', e.target.value)}
                style={{ marginLeft: 16 }}
              />
            </Col>
            <Col span={12}>
              <Text strong>并发数量：</Text>
              <InputNumber
                min={1}
                max={50}
                value={bulkSyncForm.concurrency}
                onChange={(value) => handleBulkSyncFormChange('concurrency', value || 10)}
                style={{ width: '100%', marginTop: 8 }}
                addonAfter="个/批次"
                placeholder="同时处理的股票数量"
              />
              <Text type="secondary" style={{ marginTop: 4, display: 'block' }}>
                建议值：10-20。过高可能导致数据源限制。
              </Text>
            </Col>
          </Row>

          <Alert
            message="注意事项"
            description="批量同步任务将在后台执行，可能需要较长时间。您可以在任务队列中查看进度。"
            type="warning"
            showIcon
          />
        </Space>
      </Modal>
    );
  };

  // 统计信息卡片
  const renderStatsCard = () => {
    if (!updateStats) return null;

    // 成功率图表数据
    const successRateData = [
      { name: '成功', value: updateStats.successfulUpdates, color: '#52c41a' },
      { name: '失败', value: updateStats.failedUpdates, color: '#f5222d' },
      { name: '进行中', value: updateStats.inProgressUpdates, color: '#1890ff' },
    ];

    return (
      <Card title="统计信息 (最近7天)" size="small">
        <Row gutter={[16, 16]}>
          <Col span={6}>
            <Card size="small">
              <Statistic title="总更新次数" value={updateStats.totalUpdates} />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="成功率"
                value={updateStats.totalUpdates > 0 ?
                  ((updateStats.successfulUpdates / updateStats.totalUpdates) * 100).toFixed(1) : 0}
                suffix="%"
                valueStyle={{ color: '#3f8600' }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="平均影响股票"
                value={updateStats.avgAffectedStocks}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card size="small">
              <Statistic
                title="平均插入记录"
                value={updateStats.avgInsertedRecords}
              />
            </Card>
          </Col>
        </Row>

        <Divider />

        <Row gutter={[16, 16]}>
          <Col span={12}>
            <Card size="small" title="成功率分布">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie
                    data={successRateData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={(entry) => `${entry.name}: ${entry.value}`}
                    outerRadius={80}
                    fill="#8884d8"
                    dataKey="value"
                  >
                    {successRateData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <RechartsTooltip />
                </PieChart>
              </ResponsiveContainer>
            </Card>
          </Col>
          <Col span={12}>
            <Card size="small" title="每日更新趋势">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={updateStats.dailyBreakdown}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis />
                  <RechartsTooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="affectedStocks"
                    stroke="#1890ff"
                    name="影响股票"
                  />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </Col>
        </Row>
      </Card>
    );
  };

  return (
    <Layout>
      <Title level={2}>数据更新监控</Title>
      <Paragraph>
        监控股票数据更新状态、队列情况、系统健康状态，并提供控制功能。
        <Text type="secondary" style={{ marginLeft: 8 }}>
          最后更新: {dayjs().format('YYYY-MM-DD HH:mm:ss')}
        </Text>
      </Paragraph>

      <Alert
        message="系统提示"
        description="数据更新系统使用Bull队列进行异步处理，Redis分布式锁防止并发冲突，增量更新减少数据源请求。"
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />

      <Row gutter={[16, 16]}>
        {/* 左侧：状态概览和控制面板 */}
        <Col xs={24} lg={8}>
          {renderHealthCard()}
          <div style={{ marginTop: 16 }} />
          {renderQueueCard()}
          <div style={{ marginTop: 16 }} />
          {renderControlPanel()}
        </Col>

        {/* 右侧：详细信息和图表 */}
        <Col xs={24} lg={16}>
          {renderStatsCard()}

          <Card
            title="任务队列"
            size="small"
            style={{ marginTop: 16 }}
            extra={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleRefresh}
                loading={loading.queue}
              >
                刷新
              </Button>
            }
          >
            {jobs.length > 0 ? (
              <Table
                columns={jobColumns}
                dataSource={jobs}
                rowKey="id"
                size="small"
                pagination={false}
                loading={loading.queue}
              />
            ) : (
              <Empty description="暂无活跃任务" />
            )}
          </Card>

          <Card
            title="更新日志"
            size="small"
            style={{ marginTop: 16 }}
            extra={
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={handleRefresh}
                loading={loading.logs}
              >
                刷新
              </Button>
            }
          >
            {/* 筛选器面板 */}
            <div style={{ marginBottom: 16, padding: 12, backgroundColor: '#fafafa', borderRadius: 4 }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                <Row gutter={[16, 16]} align="middle">
                  <Col span={24}>
                    <Text strong>任务类型筛选：</Text>
                    <Select
                      mode="multiple"
                      placeholder="选择任务类型（可多选）"
                      value={logFilters.types}
                      onChange={(values) => handleFilterChange('types', values)}
                      style={{ width: '100%', marginTop: 8 }}
                      options={taskTypeOptions}
                      allowClear
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 16]} align="middle">
                  <Col span={12}>
                    <Text strong>开始日期：</Text>
                    <DatePicker
                      value={logFilters.startDate ? dayjs(logFilters.startDate) : null}
                      onChange={(date) => handleFilterChange('startDate', date ? date.format('YYYY-MM-DD') : '')}
                      style={{ width: '100%', marginTop: 8 }}
                      placeholder="选择开始日期"
                    />
                  </Col>
                  <Col span={12}>
                    <Text strong>结束日期：</Text>
                    <DatePicker
                      value={logFilters.endDate ? dayjs(logFilters.endDate) : null}
                      onChange={(date) => handleFilterChange('endDate', date ? date.format('YYYY-MM-DD') : '')}
                      style={{ width: '100%', marginTop: 8 }}
                      placeholder="选择结束日期"
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 16]} justify="end">
                  <Col>
                    <Space>
                      <Button onClick={handleResetFilters} disabled={!logFilters.types.length && !logFilters.startDate && !logFilters.endDate}>
                        重置筛选
                      </Button>
                      <Button type="primary" onClick={handleApplyFilters}>
                        应用筛选
                      </Button>
                    </Space>
                  </Col>
                </Row>
              </Space>
            </div>

            <Table
              columns={logColumns}
              dataSource={updateLogs}
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10, showSizeChanger: true }}
              loading={loading.logs}
              scroll={{ y: 400 }}
            />
          </Card>
        </Col>
      </Row>
      {renderBulkSyncModal()}
    </Layout>
  );
};

export default DataUpdateStatus;