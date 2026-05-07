import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Table,
  Button,
  Space,
  Tag,
  Row,
  Col,
  Typography,
  Divider,
  Progress,
  Alert,
  Modal,
  message,
  Tooltip,
  Switch,
  Empty,
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
  DashboardOutlined,
  DatabaseOutlined,
  ApiOutlined,
  CloudSyncOutlined,
  CodeOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import dayjs from 'dayjs';
import api from '../services/api';

const { Text } = Typography;

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
    user_id?: number;
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
  affected_stocks?: number;
  inserted_records?: number;
  error?: string;
  result?: any;
  started_at?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
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
    affected_stocks: number;
    inserted_records: number;
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

  const [loading, setLoading] = useState({
    queue: false,
    logs: false,
    stats: false,
    health: false,
  });
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(10); // 秒
  const [triggerLoading, setTriggerLoading] = useState(false);

  const handleManualTrigger = async (type: string) => {
    setTriggerLoading(true);
    try {
      const response = await api.post('/market/manual-sync', { type, force: true });
      if (response.data.success) {
        message.success(response.data.data.message || '操作成功');
        fetchAllData();
      }
    } catch (error: any) {
      message.error(error.response?.data?.error || '操作失败');
    } finally {
      setTriggerLoading(false);
    }
  };

  // 批量同步相关状态
  const [bulkSyncModalVisible, setBulkSyncModalVisible] = useState(false);
  const [bulkSyncLoading, setBulkSyncLoading] = useState(false);
  const [bulkSyncForm, setBulkSyncForm] = useState({
    symbols: [] as string[],
    marketFilters: [] as ('SH' | 'SZ' | 'BJ')[],
    syncAllStocks: false,
    start_date: '',
    end_date: '',
    dataSource: 'akshare',
    concurrency: 10,
  });
  const [stockOptions, setStockOptions] = useState<{ label: string; value: string }[]>([]);
  const [loadingStocks, setLoadingStocks] = useState(false);

  // 日志筛选状态
  const [logFilters, setLogFilters] = useState({
    types: [] as string[], // 任务类型筛选
    start_date: '', // 开始日期 YYYY-MM-DD
    end_date: '', // 结束日期 YYYY-MM-DD
  });

  // 获取所有数据
  const fetchAllData = useCallback(async () => {
    try {
      setLoading(prev => ({ ...prev, queue: true, logs: true, stats: true, health: true }));

      // 获取队列状态（带筛选参数）
      const queryParams = new URLSearchParams();
      if (logFilters.types.length > 0) {
        logFilters.types.forEach(type => queryParams.append('type', type));
      }
      if (logFilters.start_date) {
        queryParams.append('start_date', logFilters.start_date);
      }
      if (logFilters.end_date) {
        queryParams.append('end_date', logFilters.end_date);
      }

      const queryString = queryParams.toString();
      const url = queryString ? `/market/update-status?${queryString}` : '/market/update-status';

      const statusResponse = await api.get(url);
      if (statusResponse.data.success) {
        const data = statusResponse.data.data;
        if (data.queue) setQueueStatus(data.queue);
        setJobs(data.jobs || (data.job ? [data.job] : []) || []);
        if (data.locks) setLockStatus(data.locks);
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
        setSystemHealth({
          redis: healthData.services.redisLock?.status === 'healthy',
          database: healthData.services.database?.status === 'healthy',
          queue: healthData.services.dataUpdateQueue?.status === 'healthy',
          dataSource: true, // 数据源健康状态需要单独检查
        });
      }
    } catch (error: any) {
      message.error('获取数据失败: ' + error.message);
    } finally {
      setLoading(prev => ({ ...prev, queue: false, logs: false, stats: false, health: false }));
    }
  }, [logFilters]);

  // 筛选处理函数
  const taskTypeOptions = [
    { label: '每日更新', value: 'daily_update' },
    { label: '新股同步', value: 'new_stocks_sync' },
    { label: '周完整性检查', value: 'weekly_completeness_check' },
    { label: '手动同步', value: 'manual_sync' },
    { label: '批量同步', value: 'bulk_sync_custom' },
  ];

  const handleFilterChange = (key: keyof typeof logFilters, value: any) => {
    setLogFilters(prev => ({ ...prev, [key]: value }));
  };

  const handleApplyFilters = () => {
    fetchAllData();
    message.success('筛选已应用');
  };

  const handleResetFilters = () => {
    setLogFilters({
      types: [],
      start_date: '',
      end_date: '',
    });
    setTimeout(() => fetchAllData(), 100);
    message.success('筛选条件已重置');
  };

  const loadStockOptions = useCallback(async () => {
    try {
      setLoadingStocks(true);
      const response = await api.get('/market/search', {
        params: { limit: 5000 },
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

  const handleBulkSyncFormChange = (key: keyof typeof bulkSyncForm, value: any) => {
    setBulkSyncForm(prev => ({ ...prev, [key]: value }));
  };

  const handleBulkSyncSubmit = async () => {
    try {
      setBulkSyncLoading(true);

      if (
        !bulkSyncForm.syncAllStocks &&
        bulkSyncForm.symbols.length === 0 &&
        bulkSyncForm.marketFilters.length === 0
      ) {
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

      if (bulkSyncForm.start_date) {
        payload.start_date = bulkSyncForm.start_date;
      }
      if (bulkSyncForm.end_date) {
        payload.end_date = bulkSyncForm.end_date;
      }
      if (bulkSyncForm.concurrency) {
        payload.concurrency = bulkSyncForm.concurrency;
      }
      payload.dataSource = bulkSyncForm.dataSource;

      const response = await api.post('/market/bulk-sync', payload);
      if (response.data.success) {
        message.success('批量同步任务已提交');
        setBulkSyncModalVisible(false);
        setBulkSyncForm({
          symbols: [],
          marketFilters: [],
          syncAllStocks: false,
          start_date: '',
          end_date: '',
          dataSource: 'akshare',
          concurrency: 10,
        });
        fetchAllData();
      }
    } catch (error: any) {
      message.error('提交批量同步任务失败: ' + error.message);
    } finally {
      setBulkSyncLoading(false);
    }
  };

  const openBulkSyncModal = () => {
    setBulkSyncModalVisible(true);
    if (stockOptions.length === 0) {
      loadStockOptions();
    }
  };

  const handleRefresh = () => {
    fetchAllData();
    message.success('数据已刷新');
  };

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
      render: id => <Text code>{id.substring(0, 8)}...</Text>,
    },
    {
      title: '类型',
      dataIndex: ['data', 'type'],
      key: 'type',
      width: 120,
      render: type => {
        const typeMap: Record<string, { label: string; color: string }> = {
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
      render: state => {
        const stateMap: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
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
      render: timestamp => (timestamp ? dayjs(timestamp).format('YYYY-MM-DD HH:mm:ss') : '--'),
    },
    {
      title: '预计剩余',
      key: 'eta',
      width: 120,
      render: (_, record) => (
        <Text type="secondary">{calculateETA(record.progress, record.processedOn)}</Text>
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
      render: type => {
        const typeMap: Record<string, { label: string; color: string }> = {
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
      render: status => {
        const statusMap: Record<string, { label: string; color: string }> = {
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
      dataIndex: 'affected_stocks',
      key: 'affected_stocks',
      width: 100,
      render: count => count || '--',
    },
    {
      title: '插入记录',
      dataIndex: 'inserted_records',
      key: 'inserted_records',
      width: 100,
      render: count => count || '--',
    },
    {
      title: '错误信息',
      dataIndex: 'error',
      key: 'error',
      width: 200,
      ellipsis: true,
      render: error =>
        error ? (
          <Tooltip title={error}>
            <Text type="danger" style={{ cursor: 'pointer' }}>
              {error.substring(0, 30)}...
            </Text>
          </Tooltip>
        ) : (
          '--'
        ),
    },
    {
      title: '开始时间',
      dataIndex: 'started_at',
      key: 'started_at',
      width: 180,
      render: time => (time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '--'),
    },
    {
      title: '完成时间',
      dataIndex: 'completed_at',
      key: 'completed_at',
      width: 180,
      render: time => (time ? dayjs(time).format('YYYY-MM-DD HH:mm:ss') : '--'),
    },
    {
      title: '耗时',
      key: 'duration',
      width: 120,
      render: (_, record) => {
        if (!record.started_at || !record.completed_at) return '--';
        const start = dayjs(record.started_at);
        const end = dayjs(record.completed_at);
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
            if (
              result.bulkSync ||
              result.successfulSyncs !== undefined ||
              result.failedSyncs !== undefined
            ) {
              const totalStocks =
                result.totalStocks || (result.successfulSyncs || 0) + (result.failedSyncs || 0);
              const successfulSyncs = result.successfulSyncs || 0;
              const totalRecordsInserted = result.totalRecordsInserted || 0;
              return (
                <div>
                  <div>
                    股票: {successfulSyncs}/{totalStocks} 成功
                  </div>
                  <div>记录: {totalRecordsInserted} 条</div>
                </div>
              );
            }
            if (result.dailyUpdate) {
              const successCount = result.dailyUpdate.successCount || 0;
              const failCount = result.dailyUpdate.failCount || 0;
              const totalInserted = result.dailyUpdate.totalInserted || 0;
              return (
                <div>
                  <div>
                    股票: {successCount} 成功, {failCount} 失败
                  </div>
                  <div>记录: {totalInserted} 条</div>
                </div>
              );
            }
            if (result.syncedCount !== undefined) {
              return `同步股票: ${result.syncedCount}`;
            }
            if (result.missingDataCount !== undefined) {
              return (
                <div>
                  <div>检查股票: {result.totalStocks || '--'}</div>
                  <div>缺失数据: {result.missingDataCount} 只</div>
                </div>
              );
            }
            return JSON.stringify(result).substring(0, 50) + '...';
          }
          return String(result).substring(0, 50);
        } catch (e) {
          return '解析失败';
        }
      },
    },
  ];

  const renderHealthCard = () => (
    <Card className="modern-card" variant="borderless" title="系统健康">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[
          { label: 'Redis', ok: systemHealth.redis, icon: <CheckCircleOutlined /> },
          { label: '数据库', ok: systemHealth.database, icon: <DatabaseOutlined /> },
          { label: '队列', ok: systemHealth.queue, icon: <DashboardOutlined /> },
          { label: '数据源', ok: systemHealth.dataSource, icon: <ApiOutlined /> },
        ].map(item => (
          <div
            key={item.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderBottom: '1px solid #f5f5f5',
            }}
          >
            <span
              style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#666', fontSize: 13 }}
            >
              {item.icon} {item.label}
            </span>
            <Tag
              className={`modern-tag ${item.ok ? 'tag-success' : 'tag-error'}`}
              style={{ margin: 0 }}
            >
              {item.ok ? '正常' : '异常'}
            </Tag>
          </div>
        ))}
      </div>
    </Card>
  );

  const renderQueueCard = () => (
    <Card className="modern-card" variant="borderless" title="队列状态">
      <div
        style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}
      >
        {[
          { label: '等待', value: queueStatus.waiting, color: '#4f46e5' },
          { label: '进行中', value: queueStatus.active, color: '#0891b2' },
          { label: '已完成', value: queueStatus.completed, color: '#16a34a' },
          { label: '失败', value: queueStatus.failed, color: '#dc2626' },
          { label: '延迟', value: queueStatus.delayed, color: '#ea580c' },
          { label: '总计', value: queueStatus.total, color: '#1a1a1a' },
        ].map(item => (
          <div
            key={item.label}
            style={{
              textAlign: 'center',
              padding: '8px 0',
              background: '#fafafa',
              borderRadius: 6,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 700, color: item.color }}>{item.value}</div>
            <div style={{ fontSize: 11, color: '#999' }}>{item.label}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Text style={{ fontSize: 12, color: '#999', marginRight: 4 }}>锁状态：</Text>
        <Tag
          className={`modern-tag ${lockStatus.global ? 'tag-error' : 'tag-default'}`}
          style={{ margin: 0, fontSize: 11 }}
        >
          全局{lockStatus.global ? '锁定' : '空闲'}
        </Tag>
        <Tag
          className={`modern-tag ${lockStatus.daily ? 'tag-error' : 'tag-default'}`}
          style={{ margin: 0, fontSize: 11 }}
        >
          日更{lockStatus.daily ? '锁定' : '空闲'}
        </Tag>
        <Tag
          className={`modern-tag ${lockStatus.newStocks ? 'tag-error' : 'tag-default'}`}
          style={{ margin: 0, fontSize: 11 }}
        >
          新股{lockStatus.newStocks ? '锁定' : '空闲'}
        </Tag>
      </div>
    </Card>
  );

  const renderControlPanel = () => (
    <Card className="modern-card" variant="borderless" title="操作">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* 数据更新核心操作 */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Button
            size="middle"
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => handleTriggerUpdate(false)}
            style={{ borderRadius: 6 }}
          >
            更新
          </Button>
          <Button
            size="middle"
            danger
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => handleTriggerUpdate(true)}
            style={{ borderRadius: 6 }}
          >
            强制
          </Button>
        </div>

        {/* 辅助操作 */}
        <div>
          <div style={{ fontSize: 11, color: '#bbb', marginBottom: 8, fontWeight: 500 }}>
            高级工具
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Button size="small" type="dashed" onClick={() => handleManualSync('new_stocks_sync')}>
              新股同步
            </Button>
            <Button size="small" type="dashed" onClick={() => handleManualSync('daily_update')}>
              日更同步
            </Button>
            <Button
              size="small"
              type="dashed"
              onClick={() => handleManualSync('weekly_completeness_check')}
            >
              完整性检查
            </Button>
            <Button size="small" type="dashed" icon={<SyncOutlined />} onClick={openBulkSyncModal}>
              批量补数
            </Button>
            <Button size="small" type="dashed" icon={<DeleteOutlined />} onClick={handleCleanQueue}>
              清理队列
            </Button>
            <Button size="small" type="dashed" icon={<ReloadOutlined />} onClick={handleRefresh}>
              手动刷新
            </Button>
          </div>
        </div>

        {/* 自动刷新 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 12px',
            background: 'var(--bg-inset)',
            borderRadius: 6,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: '#666', fontWeight: 500 }}>自动刷新</span>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          </div>
          {autoRefresh && (
            <div style={{ display: 'flex', gap: 2 }}>
              {[5, 10, 30].map(s => (
                <Button
                  key={s}
                  size="small"
                  type={refreshInterval === s ? 'primary' : 'text'}
                  onClick={() => setRefreshInterval(s)}
                  style={{ padding: '0 6px', fontSize: 11, height: 22, borderRadius: 4 }}
                >
                  {s}s
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );

  const renderBulkSyncModal = () => {
    const marketOptions = [
      { label: '上海交易所 (SH)', value: 'SH' },
      { label: '深圳交易所 (SZ)', value: 'SZ' },
      { label: '北京交易所 (BJ)', value: 'BJ' },
    ];

    const dataSourceOptions = [{ label: 'AKShare (推荐)', value: 'akshare' }];

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
                onChange={e => handleBulkSyncFormChange('syncAllStocks', e.target.value === 'all')}
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
                    onChange={values => handleBulkSyncFormChange('marketFilters', values)}
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
                    onChange={values => handleBulkSyncFormChange('symbols', values)}
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

          <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a', margin: '24px 0 16px 0' }}>
            日期范围
          </div>

          <Row gutter={[16, 16]}>
            <Col span={12}>
              <Text strong>开始日期：</Text>
              <DatePicker
                value={bulkSyncForm.start_date ? dayjs(bulkSyncForm.start_date) : null}
                onChange={date =>
                  handleBulkSyncFormChange('start_date', date ? date.format('YYYY-MM-DD') : '')
                }
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择开始日期（留空则从2020-01-01开始）"
              />
            </Col>
            <Col span={12}>
              <Text strong>结束日期：</Text>
              <DatePicker
                value={bulkSyncForm.end_date ? dayjs(bulkSyncForm.end_date) : null}
                onChange={date =>
                  handleBulkSyncFormChange('end_date', date ? date.format('YYYY-MM-DD') : '')
                }
                style={{ width: '100%', marginTop: 8 }}
                placeholder="选择结束日期（留空则到今天）"
              />
            </Col>
          </Row>

          <div style={{ fontSize: 14, fontWeight: 600, color: '#1a1a1a', margin: '24px 0 16px 0' }}>
            同步设置
          </div>

          <Row gutter={[16, 16]}>
            <Col span={12}>
              <Text strong>数据源：</Text>
              <Radio.Group
                options={dataSourceOptions}
                value={bulkSyncForm.dataSource}
                onChange={e => handleBulkSyncFormChange('dataSource', e.target.value)}
                style={{ marginLeft: 16 }}
              />
            </Col>
            <Col span={12}>
              <Text strong>并发数量：</Text>
              <InputNumber
                min={1}
                max={50}
                value={bulkSyncForm.concurrency}
                onChange={value => handleBulkSyncFormChange('concurrency', value || 10)}
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
            style={{ marginTop: 16 }}
          />
        </Space>
      </Modal>
    );
  };

  const renderStatsCard = () => {
    if (!updateStats) return null;

    const successRateData = [
      { name: '成功', value: updateStats.successfulUpdates, color: '#52c41a' },
      { name: '失败', value: updateStats.failedUpdates, color: '#f5222d' },
      { name: '进行中', value: updateStats.inProgressUpdates, color: '#1890ff' },
    ];

    const successRate =
      updateStats.totalUpdates > 0
        ? ((updateStats.successfulUpdates / updateStats.totalUpdates) * 100).toFixed(1)
        : '0';

    return (
      <Card className="modern-card" variant="borderless" title="统计 (最近7天)">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr 1fr',
            gap: 12,
            marginBottom: 16,
          }}
        >
          {[
            { label: '总更新', value: updateStats.totalUpdates },
            { label: '成功率', value: `${successRate}%` },
            { label: '平均股票', value: updateStats.avgAffectedStocks },
            { label: '平均记录', value: updateStats.avgInsertedRecords },
          ].map(item => (
            <div
              key={item.label}
              style={{
                textAlign: 'center',
                padding: '8px 0',
                background: '#fafafa',
                borderRadius: 6,
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1a1a' }}>{item.value}</div>
              <div style={{ fontSize: 11, color: '#999' }}>{item.label}</div>
            </div>
          ))}
        </div>

        <Row gutter={[12, 12]}>
          <Col span={12}>
            <Card className="modern-card" variant="borderless" title="成功率分布" size="small">
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={successRateData}
                    cx="50%"
                    cy="50%"
                    labelLine={false}
                    label={entry => `${entry.name}: ${entry.value}`}
                    outerRadius={65}
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
            <Card className="modern-card" variant="borderless" title="更新趋势" size="small">
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={updateStats.dailyBreakdown}>
                  <CartesianGrid vertical={false} stroke="#f0f0f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                  <RechartsTooltip />
                  <Line
                    type="monotone"
                    dataKey="affected_stocks"
                    stroke="#4f46e5"
                    strokeWidth={2}
                    dot={false}
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
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h1 className="page-title-modern">数据更新与系统监控</h1>
          <p className="page-subtitle-modern">实时监控 A 股数据同步状态，确保量化回测的准确性</p>
        </div>
        <Space>
          <Button
            icon={<PlayCircleOutlined />}
            onClick={() => handleManualTrigger('health_check')}
            loading={triggerLoading}
          >
            健康检查
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined />}
            onClick={() => handleManualTrigger('daily_update')}
            loading={triggerLoading}
          >
            手动同步今日数据
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        {/* 左侧：状态概览和控制面板 */}
        <Col xs={24} md={10} lg={7}>
          {renderHealthCard()}
          <div style={{ marginTop: 12 }} />
          {renderQueueCard()}
          <div style={{ marginTop: 12 }} />
          {renderControlPanel()}
        </Col>

        {/* 右侧：详细信息和图表 */}
        <Col xs={24} md={14} lg={17}>
          {renderStatsCard()}

          <Card
            className="modern-card"
            variant="borderless"
            title="任务队列"
            style={{ marginTop: 12 }}
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
            <Table
              columns={jobColumns}
              dataSource={jobs}
              rowKey="id"
              size="small"
              pagination={false}
              loading={loading.queue}
              locale={{ emptyText: <Empty description="暂无活跃任务" /> }}
            />
          </Card>

          <Card
            className="modern-card"
            variant="borderless"
            title="更新日志"
            style={{ marginTop: 12 }}
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
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                backgroundColor: '#fafafa',
                borderRadius: 8,
              }}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                <Row gutter={[16, 16]} align="middle">
                  <Col span={24}>
                    <Text strong>任务类型筛选：</Text>
                    <Select
                      mode="multiple"
                      placeholder="选择任务类型（可多选）"
                      value={logFilters.types}
                      onChange={values => handleFilterChange('types', values)}
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
                      value={logFilters.start_date ? dayjs(logFilters.start_date) : null}
                      onChange={date =>
                        handleFilterChange('start_date', date ? date.format('YYYY-MM-DD') : '')
                      }
                      style={{ width: '100%', marginTop: 8 }}
                      placeholder="选择开始日期"
                    />
                  </Col>
                  <Col span={12}>
                    <Text strong>结束日期：</Text>
                    <DatePicker
                      value={logFilters.end_date ? dayjs(logFilters.end_date) : null}
                      onChange={date =>
                        handleFilterChange('end_date', date ? date.format('YYYY-MM-DD') : '')
                      }
                      style={{ width: '100%', marginTop: 8 }}
                      placeholder="选择结束日期"
                    />
                  </Col>
                </Row>
                <Row gutter={[16, 16]} justify="end">
                  <Col>
                    <Space>
                      <Button
                        onClick={handleResetFilters}
                        disabled={
                          !logFilters.types.length && !logFilters.start_date && !logFilters.end_date
                        }
                      >
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
              locale={{ emptyText: <Empty description="暂无更新日志" /> }}
            />
          </Card>
        </Col>
      </Row>
      {renderBulkSyncModal()}
    </div>
  );
};

export default DataUpdateStatus;
