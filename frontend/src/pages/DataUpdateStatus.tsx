import React, { useState, useEffect, useCallback } from 'react';
import {
  Card,
  Table,
  Button,
  Statistic,
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
  ThunderboltOutlined,
  ToolOutlined,
  FundProjectionScreenOutlined,
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

interface DataSourceProviderHealth {
  id?: number | null;
  provider_name: string;
  provider_label: string;
  provider_type: string;
  status: 'healthy' | 'degraded' | 'unhealthy' | 'disabled' | 'unknown' | string;
  priority: number;
  is_enabled: boolean;
  supported_features: string[];
  health_score: number;
  success_count: number;
  failure_count: number;
  consecutive_failures: number;
  last_success_at?: string | null;
  last_failure_at?: string | null;
  last_latency_ms?: number | null;
  last_checked_at?: string | null;
  last_error?: string | null;
  metadata?: Record<string, any>;
}

interface DataSourceRoutingItem extends DataSourceProviderHealth {
  rank: number;
  feature: string;
  route_score: number;
  route_reason?: string;
  preference_rank?: number | null;
  is_preferred?: boolean;
}

interface DataSourceHealthResponse {
  status: string;
  summary: {
    total_providers: number;
    enabled_providers: number;
    healthy_providers: number;
    degraded_providers: number;
    unhealthy_providers: number;
    disabled_providers: number;
    avg_health_score: number;
  };
  providers: DataSourceProviderHealth[];
  routing_plans?: Record<string, DataSourceRoutingItem[]>;
  quant_readiness?: {
    score: number;
    status: string;
    summary: string;
    history_ready: boolean;
    realtime_ready: boolean;
    fundamentals_ready: boolean;
    intraday_ready: boolean;
    money_flow_ready?: boolean;
    valuation_ready?: boolean;
    agent_ready: boolean;
    primary_history_provider?: string | null;
    primary_stock_list_provider?: string | null;
    primary_stock_basic_provider?: string | null;
    primary_fundamental_provider?: string | null;
    primary_money_flow_provider?: string | null;
    primary_valuation_provider?: string | null;
    factor_landing_plan?: {
      status?: string;
      target_tables?: string[];
      next_step?: string;
    };
    realtime_providers?: string[];
    recommended_paid_source?: {
      provider_name: string;
      provider_label: string;
      priority: number;
      reason: string;
      required_env?: string[];
    };
    future_paid_sources?: Array<{
      provider_name: string;
      provider_label: string;
      use_case: string;
    }>;
    missing_configs?: string[];
    recommendations?: string[];
    capability_notes?: string[];
  };
}

interface DataQualityItem {
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  data_status?: string;
  quality_score: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor' | 'empty' | string;
  bar_count: number;
  coverage_rate: number;
  first_date?: string;
  latest_date?: string;
  issues: Record<string, number>;
  sample_issues: Array<{ date: string; type: string; detail: string }>;
  recommended_action: string;
}

interface DataQualityResponse {
  as_of: string;
  scope: string;
  lookback_days: number;
  summary: {
    scanned_stocks: number;
    avg_quality_score: number;
    low_quality_count: number;
    low_quality_rate: number;
    stale_count: number;
    issue_totals: Record<string, number>;
    grade_distribution: Record<string, number>;
  };
  repair_suggestions: {
    target_count: number;
    top_symbols: string[];
    recommended_payload?: {
      symbols: string[];
      start_date?: string;
      dataSource: string;
      concurrency: number;
    } | null;
  };
  items: DataQualityItem[];
}

interface FactorCoverageResponse {
  as_of: string;
  latest_trade_date?: string | null;
  latest_factor_date?: string | null;
  latest_landed_factor_date?: string | null;
  effective_factor_date?: string | null;
  factor_lag_days?: number | null;
  coverage_status?: 'real_ready' | 'derived_ready' | 'limited' | 'missing';
  universe_stock_count: number;
  coverage: {
    valuation: number;
    money_flow: number;
    fundamental: number;
  };
  coverage_rate: {
    valuation: number;
    money_flow: number;
    fundamental: number;
  };
  samples: Array<{
    symbol: string;
    name: string;
    industry?: string | null;
    valuation_score?: number | null;
    money_flow_score?: number | null;
    quality_score?: number | null;
    factor_date?: string | null;
  }>;
  source_breakdown?: {
    valuation?: Record<string, number>;
    money_flow?: Record<string, number>;
    fundamental?: Record<string, number>;
  };
  source_quality?: {
    total_source_records?: number;
    real_provider_records?: number;
    derived_records?: number;
    real_provider_rate?: number;
    primary_source?: string | null;
  };
  next_actions: string[];
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

  const [dataSourceHealth, setDataSourceHealth] = useState<DataSourceHealthResponse | null>(null);
  const [dataQuality, setDataQuality] = useState<DataQualityResponse | null>(null);
  const [factorCoverage, setFactorCoverage] = useState<FactorCoverageResponse | null>(null);

  const [loading, setLoading] = useState({
    queue: false,
    logs: false,
    stats: false,
    health: false,
    quality: false,
    factors: false,
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
    dataSource: 'auto',
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
      setLoading(prev => ({
        ...prev,
        queue: true,
        logs: true,
        stats: true,
        health: true,
        quality: true,
        factors: true,
      }));

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
      const [healthResponse, dataSourceHealthResponse, dataQualityResponse, factorResponse] =
        await Promise.all([
          api.get('/market/health'),
          api.get('/market/data-sources/health'),
          api.get('/market/data-quality', {
            params: { scope: 'favorites', lookback_days: 180, limit: 50 },
          }),
          api.get('/market/factors/coverage', {
            params: { scope: 'market', limit: 120 },
          }),
        ]);
      const nextSystemHealth = {
        redis: true,
        database: true,
        queue: true,
        dataSource: true,
      };

      if (healthResponse.data.success) {
        const healthData = healthResponse.data.data;
        nextSystemHealth.redis = healthData.services.redisLock?.status === 'healthy';
        nextSystemHealth.database = healthData.services.database?.status === 'healthy';
        nextSystemHealth.queue = healthData.services.dataUpdateQueue?.status === 'healthy';
        nextSystemHealth.dataSource = healthData.services.dataSource?.status !== 'unhealthy';
      }

      if (dataSourceHealthResponse.data.success) {
        const healthData = dataSourceHealthResponse.data.data as DataSourceHealthResponse;
        setDataSourceHealth(healthData);
        nextSystemHealth.dataSource = healthData.status !== 'unhealthy';
      }

      if (dataQualityResponse.data.success) {
        setDataQuality(dataQualityResponse.data.data as DataQualityResponse);
      }

      if (factorResponse.data.success) {
        setFactorCoverage(factorResponse.data.data as FactorCoverageResponse);
      }

      setSystemHealth(nextSystemHealth);
    } catch (error: any) {
      message.error('获取数据失败: ' + error.message);
    } finally {
      setLoading(prev => ({
        ...prev,
        queue: false,
        logs: false,
        stats: false,
        health: false,
        quality: false,
        factors: false,
      }));
    }
  }, [logFilters]);

  // 筛选处理函数
  const taskTypeOptions = [
    { label: '每日更新', value: 'daily_update' },
    { label: '新股同步', value: 'new_stocks_sync' },
    { label: '周完整性检查', value: 'weekly_completeness_check' },
    { label: '数据质量扫描', value: 'data_quality_scan' },
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
          dataSource: 'auto',
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

  const handleProbeDataSources = async () => {
    setLoading(prev => ({ ...prev, health: true }));
    try {
      const response = await api.get('/market/data-sources/health', {
        params: { refresh: true },
        timeout: 60000,
      });
      if (response.data.success) {
        setDataSourceHealth(response.data.data as DataSourceHealthResponse);
        message.success('数据源主动探测完成，动态路由已刷新');
      } else {
        message.warning(response.data.message || response.data.error || '数据源探测未完成');
      }
    } catch (error: any) {
      message.error('数据源主动探测失败: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(prev => ({ ...prev, health: false }));
    }
  };

  const handleSyncFactors = async () => {
    setLoading(prev => ({ ...prev, factors: true }));
    try {
      const response = await api.post('/market/factors/sync', {
        scope: 'market',
        limit: 180,
      });
      if (response.data.success) {
        message.success(response.data.message || '因子落盘完成');
        const coverageResponse = await api.get('/market/factors/coverage', {
          params: { scope: 'market', limit: 180 },
        });
        if (coverageResponse.data.success) {
          setFactorCoverage(coverageResponse.data.data as FactorCoverageResponse);
        }
      }
    } catch (error: any) {
      message.error('因子落盘失败: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(prev => ({ ...prev, factors: false }));
    }
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
          data_quality_scan: { label: '质量扫描', color: 'volcano' },
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
          data_quality_scan: { label: '质量扫描', color: 'volcano' },
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
            if (result.summary?.avg_quality_score !== undefined) {
              return (
                <div>
                  <div>扫描股票: {result.scanned || result.summary.scanned_stocks}</div>
                  <div>均分: {Number(result.summary.avg_quality_score).toFixed(1)}</div>
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

  const getProviderStatusConfig = (status: string) => {
    const statusMap: Record<string, { label: string; color: string; tagClass: string }> = {
      healthy: { label: '健康', color: '#16a34a', tagClass: 'tag-success' },
      degraded: { label: '降级', color: '#ea580c', tagClass: 'tag-warning' },
      unhealthy: { label: '异常', color: '#dc2626', tagClass: 'tag-error' },
      disabled: { label: '未启用', color: '#64748b', tagClass: 'tag-default' },
      unknown: { label: '未知', color: '#7c3aed', tagClass: 'tag-default' },
    };
    return statusMap[status] || { label: status, color: '#64748b', tagClass: 'tag-default' };
  };

  const featureLabelMap: Record<string, string> = {
    stock_list: '股票列表',
    history_k: '历史K线',
    stock_basic: '个股基础',
    index_constituents: '指数成分',
    trade_calendar: '交易日历',
    realtime_quote: '实时行情',
    intraday_bar: '日内K线',
    fundamental_factor: '财务因子',
    money_flow: '资金流',
    valuation: '估值',
    health_probe: '健康探测',
  };

  const getQualityGradeConfig = (grade: string) => {
    const gradeMap: Record<string, { label: string; color: string; tagClass: string }> = {
      excellent: { label: '优秀', color: '#16a34a', tagClass: 'tag-success' },
      good: { label: '良好', color: '#22c55e', tagClass: 'tag-success' },
      fair: { label: '一般', color: '#ea580c', tagClass: 'tag-warning' },
      poor: { label: '较差', color: '#dc2626', tagClass: 'tag-error' },
      empty: { label: '无数据', color: '#64748b', tagClass: 'tag-default' },
    };
    return gradeMap[grade] || { label: grade, color: '#64748b', tagClass: 'tag-default' };
  };

  const issueLabelMap: Record<string, string> = {
    ohlc_anomaly: 'OHLC异常',
    extreme_return: '异常涨跌',
    duplicate_day: '重复日',
    missing_business_day: '缺口',
    stale_days: '滞后',
    zero_volume: '零成交',
  };

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

  const renderDataSourceCard = () => {
    const providers = dataSourceHealth?.providers || [];
    const activeProviders = providers.filter(provider => provider.is_enabled);
    const historyPlan = dataSourceHealth?.routing_plans?.history_k || [];
    const stockBasicPlan = dataSourceHealth?.routing_plans?.stock_basic || [];
    const stockListPlan = dataSourceHealth?.routing_plans?.stock_list || [];
    const factorPlan = [
      ...(dataSourceHealth?.routing_plans?.fundamental_factor || []),
      ...(dataSourceHealth?.routing_plans?.money_flow || []),
      ...(dataSourceHealth?.routing_plans?.valuation || []),
    ];
    const quantReadiness = dataSourceHealth?.quant_readiness;
    const bestProvider = (historyPlan.find(provider => provider.is_enabled) ||
      [...activeProviders].sort(
        (a, b) => Number(b.health_score || 0) - Number(a.health_score || 0)
      )[0]) as (DataSourceRoutingItem & DataSourceProviderHealth) | undefined;
    const summary = dataSourceHealth?.summary;

    const sourceColumns: ColumnsType<DataSourceProviderHealth> = [
      {
        title: '数据源',
        dataIndex: 'provider_label',
        key: 'provider_label',
        width: 130,
        render: (_, record) => (
          <div>
            <div style={{ fontWeight: 700, color: '#111827' }}>{record.provider_label}</div>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {record.provider_name} · P{record.priority}
            </Text>
            <div style={{ marginTop: 4 }}>
              <Tag color={record.metadata?.commercial_tier === 'free' ? 'green' : 'blue'}>
                {record.metadata?.commercial_tier === 'free'
                  ? '免费'
                  : record.metadata?.commercial_tier === 'internal_service'
                  ? '内部服务'
                  : '付费增强'}
              </Tag>
            </div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 92,
        render: status => {
          const config = getProviderStatusConfig(status);
          return <Tag className={`modern-tag ${config.tagClass}`}>{config.label}</Tag>;
        },
      },
      {
        title: '健康分',
        dataIndex: 'health_score',
        key: 'health_score',
        width: 130,
        render: score => (
          <Progress
            percent={Math.round(Number(score || 0))}
            size="small"
            strokeColor={
              Number(score || 0) >= 75
                ? '#16a34a'
                : Number(score || 0) >= 45
                ? '#ea580c'
                : '#dc2626'
            }
          />
        ),
      },
      {
        title: '能力',
        dataIndex: 'supported_features',
        key: 'supported_features',
        ellipsis: true,
        render: features => (
          <Space size={[4, 4]} wrap>
            {(features || []).slice(0, 3).map((feature: string) => (
              <Tag key={feature} style={{ margin: 0, fontSize: 11 }}>
                {featureLabelMap[feature] || feature}
              </Tag>
            ))}
            {(features || []).length > 3 && (
              <Tag style={{ margin: 0, fontSize: 11 }}>+{features.length - 3}</Tag>
            )}
          </Space>
        ),
      },
      {
        title: '量化用途',
        key: 'quant_role',
        width: 240,
        render: (_, record) => (
          <Space direction="vertical" size={2}>
            <Text strong style={{ fontSize: 12 }}>
              {record.metadata?.quant_role || '--'}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.metadata?.recommendation || record.metadata?.quant_usage_notes || '--'}
            </Text>
          </Space>
        ),
      },
      {
        title: '最近检查',
        dataIndex: 'last_checked_at',
        key: 'last_checked_at',
        width: 150,
        render: time => (time ? dayjs(time).format('MM-DD HH:mm:ss') : '--'),
      },
      {
        title: '错误',
        dataIndex: 'last_error',
        key: 'last_error',
        width: 180,
        ellipsis: true,
        render: error =>
          error ? (
            <Tooltip title={error}>
              <Text type="danger" style={{ fontSize: 12 }}>
                {String(error).substring(0, 24)}...
              </Text>
            </Tooltip>
          ) : (
            <Text type="secondary">--</Text>
          ),
      },
    ];

    const routeColumns: ColumnsType<DataSourceRoutingItem> = [
      {
        title: '能力',
        dataIndex: 'feature',
        key: 'feature',
        width: 100,
        render: feature => <Tag>{featureLabelMap[feature] || feature}</Tag>,
      },
      {
        title: '顺位',
        dataIndex: 'rank',
        key: 'rank',
        width: 70,
        render: rank => <Tag color={rank === 1 ? 'blue' : 'default'}>#{rank}</Tag>,
      },
      {
        title: '数据源',
        dataIndex: 'provider_label',
        key: 'provider_label',
        width: 140,
        render: (_, record) => (
          <div>
            <Text strong>{record.provider_label}</Text>
            <div>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {record.provider_name}
              </Text>
            </div>
          </div>
        ),
      },
      {
        title: '状态 / 路由分',
        key: 'score',
        width: 150,
        render: (_, record) => {
          const config = getProviderStatusConfig(record.status);
          return (
            <Space direction="vertical" size={2}>
              <Tag className={`modern-tag ${config.tagClass}`}>{config.label}</Tag>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {Number(record.route_score || 0).toFixed(1)}
              </Text>
            </Space>
          );
        },
      },
      {
        title: '原因',
        dataIndex: 'route_reason',
        key: 'route_reason',
        render: reason => (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {reason || '--'}
          </Text>
        ),
      },
    ];

    return (
      <Card
        className="modern-card"
        variant="borderless"
        title="数据源韧性"
        style={{ marginTop: 12 }}
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={handleProbeDataSources}
            loading={loading.health}
          >
            主动探测
          </Button>
        }
      >
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Statistic
              title="综合状态"
              value={getProviderStatusConfig(dataSourceHealth?.status || 'unknown').label}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="启用源"
              value={summary?.enabled_providers || 0}
              suffix={`/ ${summary?.total_providers || 0}`}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="平均健康分" value={summary?.avg_health_score || 0} precision={1} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="K线首选源"
              value={bestProvider?.provider_label || '--'}
              suffix={
                bestProvider?.route_score ? ` / ${Number(bestProvider.route_score).toFixed(0)}` : ''
              }
            />
          </Col>
        </Row>

        <Alert
          type={dataSourceHealth?.status === 'healthy' ? 'success' : 'warning'}
          showIcon
          icon={<ThunderboltOutlined />}
          message="智能择源与自动 fallback 已启用"
          description="系统会根据健康分、近期失败、延迟和显式偏好动态调整股票列表、历史K线、基础资料的调用顺位；异常源只会降级为兜底，不会阻断同步任务。"
          style={{ marginBottom: 12 }}
        />

        {quantReadiness && (
          <Card className="data-source-readiness" variant="borderless" style={{ marginBottom: 12 }}>
            <Row gutter={[16, 12]} align="middle">
              <Col xs={24} md={7}>
                <div className="data-source-readiness-score">
                  <span>量化数据可用度</span>
                  <strong>{Number(quantReadiness.score || 0).toFixed(0)}</strong>
                  <Progress
                    percent={Math.round(Number(quantReadiness.score || 0))}
                    showInfo={false}
                    strokeColor={
                      Number(quantReadiness.score || 0) >= 82
                        ? '#0f8f6b'
                        : Number(quantReadiness.score || 0) >= 62
                        ? '#2764b8'
                        : '#d97706'
                    }
                  />
                </div>
              </Col>
              <Col xs={24} md={17}>
                <Text strong>{quantReadiness.summary}</Text>
                <div className="data-source-readiness-tags">
                  {[
                    ['历史K线', quantReadiness.history_ready],
                    ['实时行情', quantReadiness.realtime_ready],
                    ['财务因子', quantReadiness.fundamentals_ready],
                    ['资金流', quantReadiness.money_flow_ready],
                    ['估值', quantReadiness.valuation_ready],
                    ['日内数据', quantReadiness.intraday_ready],
                    ['Agent研判', quantReadiness.agent_ready],
                  ].map(([label, ok]) => (
                    <Tag
                      key={String(label)}
                      className={`modern-tag ${ok ? 'tag-success' : 'tag-warning'}`}
                    >
                      {label} {ok ? '可用' : '待补齐'}
                    </Tag>
                  ))}
                </div>
                <div className="data-source-readiness-notes">
                  {quantReadiness.primary_history_provider && (
                    <Text type="secondary">
                      历史K线首选：{quantReadiness.primary_history_provider}
                    </Text>
                  )}
                  {quantReadiness.recommended_paid_source && (
                    <Text type="secondary">
                      推荐增强：{quantReadiness.recommended_paid_source.provider_label}，
                      {quantReadiness.recommended_paid_source.reason}
                    </Text>
                  )}
                  {quantReadiness.factor_landing_plan?.next_step && (
                    <Text type="secondary">
                      因子落盘：{quantReadiness.factor_landing_plan.next_step}
                    </Text>
                  )}
                </div>
              </Col>
            </Row>
            {!!quantReadiness.recommendations?.length && (
              <Alert
                type="info"
                showIcon
                style={{ marginTop: 12 }}
                message="下一步数据源建议"
                description={
                  <Space direction="vertical" size={2}>
                    {quantReadiness.recommendations.slice(0, 3).map(item => (
                      <Text key={item} type="secondary">
                        · {item}
                      </Text>
                    ))}
                    {!!quantReadiness.missing_configs?.length && (
                      <Text type="secondary">
                        缺少配置：{quantReadiness.missing_configs.join('、')}
                      </Text>
                    )}
                  </Space>
                }
              />
            )}
          </Card>
        )}

        {historyPlan.length > 0 && (
          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} lg={8}>
              <Card size="small" variant="borderless" style={{ background: '#f8fafc' }}>
                <Statistic
                  title="历史K线优先链路"
                  value={historyPlan
                    .slice(0, 3)
                    .map(item => item.provider_label)
                    .join(' → ')}
                  valueStyle={{ fontSize: 14, fontWeight: 700 }}
                />
              </Card>
            </Col>
            <Col xs={24} lg={8}>
              <Card size="small" variant="borderless" style={{ background: '#f8fafc' }}>
                <Statistic
                  title="股票列表链路"
                  value={stockListPlan
                    .slice(0, 3)
                    .map(item => item.provider_label)
                    .join(' → ')}
                  valueStyle={{ fontSize: 14, fontWeight: 700 }}
                />
              </Card>
            </Col>
            <Col xs={24} lg={8}>
              <Card size="small" variant="borderless" style={{ background: '#f8fafc' }}>
                <Statistic
                  title="基础资料链路"
                  value={stockBasicPlan
                    .slice(0, 3)
                    .map(item => item.provider_label)
                    .join(' → ')}
                  valueStyle={{ fontSize: 14, fontWeight: 700 }}
                />
              </Card>
            </Col>
          </Row>
        )}

        <Table
          style={{ marginBottom: 12 }}
          title={() => <Text strong>历史K线动态路由计划</Text>}
          columns={routeColumns}
          dataSource={[...historyPlan, ...factorPlan]}
          rowKey={record => `${record.feature}-${record.provider_name}`}
          size="small"
          pagination={false}
          loading={loading.health}
          scroll={{ x: 720 }}
          locale={{ emptyText: <Empty description="暂无动态路由计划" /> }}
        />

        <Table
          title={() => <Text strong>数据源健康明细</Text>}
          columns={sourceColumns}
          dataSource={providers}
          rowKey="provider_name"
          size="small"
          pagination={false}
          loading={loading.health}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="暂无数据源健康记录" /> }}
        />
      </Card>
    );
  };

  const renderDataQualityCard = () => {
    const summary = dataQuality?.summary;
    const repairPayload = dataQuality?.repair_suggestions?.recommended_payload;
    const issueTotals = summary?.issue_totals || {};

    const qualityColumns: ColumnsType<DataQualityItem> = [
      {
        title: '标的',
        key: 'stock',
        width: 160,
        render: (_, record) => (
          <div>
            <Text strong>{record.name}</Text>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {record.symbol} · {record.industry || record.market || '未分类'}
              </Text>
            </div>
          </div>
        ),
      },
      {
        title: '质量分',
        dataIndex: 'quality_score',
        key: 'quality_score',
        width: 150,
        render: (score, record) => {
          const config = getQualityGradeConfig(record.grade);
          return (
            <Space direction="vertical" size={2} style={{ width: 120 }}>
              <Space>
                <Text strong style={{ color: config.color }}>
                  {Number(score || 0).toFixed(1)}
                </Text>
                <Tag className={`modern-tag ${config.tagClass}`}>{config.label}</Tag>
              </Space>
              <Progress
                percent={Math.round(Number(score || 0))}
                size="small"
                showInfo={false}
                strokeColor={config.color}
              />
            </Space>
          );
        },
      },
      {
        title: '覆盖 / 最新',
        key: 'coverage',
        width: 140,
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Text>{Number(record.coverage_rate || 0).toFixed(1)}%</Text>
            <Text type="secondary">{record.latest_date || '--'}</Text>
          </Space>
        ),
      },
      {
        title: '问题',
        key: 'issues',
        render: (_, record) => (
          <Space size={[4, 4]} wrap>
            {Object.entries(record.issues || {})
              .filter(([, value]) => Number(value || 0) > 0)
              .slice(0, 4)
              .map(([key, value]) => (
                <Tag
                  key={key}
                  color={key === 'stale_days' ? 'orange' : 'red'}
                  style={{ margin: 0 }}
                >
                  {issueLabelMap[key] || key} {value}
                </Tag>
              ))}
            {Object.values(record.issues || {}).every(value => Number(value || 0) === 0) && (
              <Tag color="green" style={{ margin: 0 }}>
                暂无异常
              </Tag>
            )}
          </Space>
        ),
      },
      {
        title: '修复建议',
        dataIndex: 'recommended_action',
        key: 'recommended_action',
        ellipsis: true,
        render: text => (
          <Tooltip title={text}>
            <Text>{text}</Text>
          </Tooltip>
        ),
      },
    ];

    const triggerQualityScan = () => handleManualSync('data_quality_scan');

    const repairTopQualityIssues = async () => {
      if (!repairPayload?.symbols?.length) {
        message.info('当前没有需要批量补数的低质量标的');
        return;
      }

      try {
        const response = await api.post('/market/bulk-sync', {
          symbols: repairPayload.symbols,
          start_date: repairPayload.start_date,
          dataSource: repairPayload.dataSource || 'auto',
          concurrency: repairPayload.concurrency || 2,
        });
        if (response.data.success) {
          message.success(`已提交 ${repairPayload.symbols.length} 只低质量标的补数任务`);
          fetchAllData();
        }
      } catch (error: any) {
        message.error(error.response?.data?.error || '提交补数任务失败');
      }
    };

    return (
      <Card
        className="modern-card"
        variant="borderless"
        title="数据质量画像"
        style={{ marginTop: 12 }}
        extra={
          <Space>
            <Button size="small" icon={<ToolOutlined />} onClick={triggerQualityScan}>
              后台扫描
            </Button>
            <Button size="small" onClick={repairTopQualityIssues} disabled={!repairPayload}>
              修复Top缺口
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={handleRefresh}
              loading={loading.quality}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Statistic title="扫描标的" value={summary?.scanned_stocks || 0} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="平均质量分" value={summary?.avg_quality_score || 0} precision={1} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="低质量占比"
              value={summary?.low_quality_rate || 0}
              precision={1}
              suffix="%"
              valueStyle={{
                color: Number(summary?.low_quality_rate || 0) > 30 ? '#dc2626' : '#16a34a',
              }}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="滞后标的" value={summary?.stale_count || 0} />
          </Col>
        </Row>

        <Alert
          type={Number(summary?.low_quality_count || 0) > 0 ? 'warning' : 'success'}
          showIcon
          message="质量口径"
          description={`按近 ${
            dataQuality?.lookback_days || 180
          } 天K线覆盖率、OHLC逻辑、异常涨跌幅、重复交易日、交易日缺口和最新日期滞后综合评分。累计问题：OHLC ${
            issueTotals.ohlc_anomaly || 0
          }，异常涨跌 ${issueTotals.extreme_return || 0}，缺口 ${
            issueTotals.missing_business_day || 0
          }，滞后 ${issueTotals.stale_days || 0}。`}
          style={{ marginBottom: 12 }}
        />

        <Table
          columns={qualityColumns}
          dataSource={dataQuality?.items || []}
          rowKey="symbol"
          size="small"
          loading={loading.quality}
          pagination={{ pageSize: 5, showSizeChanger: false }}
          scroll={{ x: 900 }}
          locale={{ emptyText: <Empty description="暂无数据质量画像" /> }}
        />
      </Card>
    );
  };

  const renderFactorCoverageCard = () => {
    const coverage = factorCoverage;
    const factorRows = [
      {
        key: 'valuation',
        label: '估值分位',
        description: 'PE/PB/市值与历史分位，辅助过滤估值极端标的',
        count: coverage?.coverage?.valuation || 0,
        rate: coverage?.coverage_rate?.valuation || 0,
      },
      {
        key: 'money_flow',
        label: '量价资金流',
        description: '量比、换手、5/20日动量，先用免费日线衍生，后续接真实资金流',
        count: coverage?.coverage?.money_flow || 0,
        rate: coverage?.coverage_rate?.money_flow || 0,
      },
      {
        key: 'fundamental',
        label: '质量因子',
        description: 'ROE/成长/负债等真实财务待 Tushare 增强，当前使用本地质量代理分',
        count: coverage?.coverage?.fundamental || 0,
        rate: coverage?.coverage_rate?.fundamental || 0,
      },
    ];
    const sourceBreakdown = coverage?.source_breakdown || {};
    const sourceRows = [
      { key: 'valuation', label: '估值', data: sourceBreakdown.valuation || {} },
      { key: 'money_flow', label: '资金流', data: sourceBreakdown.money_flow || {} },
      { key: 'fundamental', label: '质量', data: sourceBreakdown.fundamental || {} },
    ];

    const sampleColumns: ColumnsType<FactorCoverageResponse['samples'][number]> = [
      {
        title: '标的',
        key: 'stock',
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Text strong>{record.name || record.symbol}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {record.symbol} · {record.industry || '未分类'}
            </Text>
          </Space>
        ),
      },
      {
        title: '估值',
        dataIndex: 'valuation_score',
        key: 'valuation_score',
        width: 90,
        render: value => <Text strong>{Number(value || 0).toFixed(1)}</Text>,
      },
      {
        title: '资金流',
        dataIndex: 'money_flow_score',
        key: 'money_flow_score',
        width: 90,
        render: value => (
          <Text strong>{value === null ? '--' : Number(value || 0).toFixed(1)}</Text>
        ),
      },
      {
        title: '质量',
        dataIndex: 'quality_score',
        key: 'quality_score',
        width: 90,
        render: value => (
          <Text strong>{value === null ? '--' : Number(value || 0).toFixed(1)}</Text>
        ),
      },
      {
        title: '日期',
        dataIndex: 'factor_date',
        key: 'factor_date',
        width: 110,
      },
    ];

    return (
      <Card
        className="modern-card"
        variant="borderless"
        title="量化因子落盘"
        style={{ marginTop: 12 }}
        extra={
          <Button
            size="small"
            icon={<FundProjectionScreenOutlined />}
            onClick={handleSyncFactors}
            loading={loading.factors}
          >
            同步因子
          </Button>
        }
      >
        <Alert
          showIcon
          type="info"
          message="因子层已独立建模，已支持 Tushare 增强通道 + 本地派生兜底"
          description="默认 provider=auto：若 TUSHARE_ENABLED=true 且配置 token，会优先尝试 daily_basic / moneyflow / fina_indicator；失败或未配置时继续使用 local_derived 免费因子，策略读取层无需改动。"
          style={{ marginBottom: 12 }}
        />
        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          {factorRows.map(item => (
            <Col xs={24} md={8} key={item.key}>
              <Card size="small" variant="borderless" style={{ background: '#f8fafc' }}>
                <Statistic
                  title={item.label}
                  value={Number(item.rate || 0)}
                  precision={1}
                  suffix="%"
                />
                <Progress
                  percent={Math.round(Number(item.rate || 0))}
                  size="small"
                  showInfo={false}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {item.count}/{coverage?.universe_stock_count || 0} · {item.description}
                </Text>
              </Card>
            </Col>
          ))}
        </Row>
        <Space direction="vertical" size={4} style={{ width: '100%', marginBottom: 12 }}>
          <Text type="secondary">
            最新交易日：{coverage?.latest_trade_date || '--'} · 因子日：
            {coverage?.latest_factor_date ||
              coverage?.effective_factor_date ||
              coverage?.latest_landed_factor_date ||
              '--'}{' '}
            · 滞后：
            {coverage?.factor_lag_days ?? '--'} 天 · 样本池：{coverage?.universe_stock_count || 0}{' '}
            只
          </Text>
          <Space wrap size={6}>
            <Tag color={coverage?.coverage_status === 'real_ready' ? 'green' : 'gold'}>
              {coverage?.coverage_status === 'real_ready'
                ? '真实源就绪'
                : coverage?.coverage_status === 'derived_ready'
                ? '派生因子就绪'
                : coverage?.coverage_status === 'limited'
                ? '覆盖不足'
                : '等待落盘'}
            </Tag>
            <Tag>
              真实源占比：
              {Number(coverage?.source_quality?.real_provider_rate || 0).toFixed(1)}%
            </Tag>
            <Tag>主来源：{coverage?.source_quality?.primary_source || '--'}</Tag>
            {sourceRows.map(row => (
              <Tag key={row.key}>
                {row.label}来源：
                {Object.keys(row.data).length
                  ? Object.entries(row.data)
                      .map(([source, count]) => `${source} ${count}`)
                      .join(' / ')
                  : '--'}
              </Tag>
            ))}
          </Space>
          {(coverage?.next_actions || []).slice(0, 3).map(item => (
            <Text key={item} type="secondary">
              · {item}
            </Text>
          ))}
        </Space>
        <Table
          columns={sampleColumns}
          dataSource={coverage?.samples || []}
          rowKey="symbol"
          size="small"
          loading={loading.factors}
          pagination={false}
          locale={{ emptyText: <Empty description="暂无因子样本，点击同步因子生成" /> }}
        />
      </Card>
    );
  };

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
            <Button
              size="small"
              type="dashed"
              onClick={() => handleManualSync('data_quality_scan')}
            >
              质量扫描
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

    const dataSourceOptions = [
      { label: '自动 fallback (推荐)', value: 'auto' },
      { label: 'Tushare Pro', value: 'tushare' },
      { label: 'Baostock', value: 'baostock' },
      { label: 'AKShare', value: 'akshare' },
      { label: '东方财富', value: 'eastmoney' },
      { label: '新浪财经', value: 'sina' },
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
                style={{ marginLeft: 16, display: 'flex', flexDirection: 'column', gap: 8 }}
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
          {renderDataSourceCard()}
          {renderFactorCoverageCard()}
          {renderDataQualityCard()}

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
