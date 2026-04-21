import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Typography,
  Input,
  Select,
  Button,
  Pagination,
  Spin,
  Tag,
  Space,
  Tooltip,
  Row,
  Col
} from 'antd';
import {
  SyncOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  SearchOutlined
} from '@ant-design/icons';
import { logService, LogEntry } from '../services/logService';

const { Title, Text } = Typography;
const { Option } = Select;

const SystemLogs: React.FC = () => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState<boolean>(false);
  
  // Pagination & Filters
  const [page, setPage] = useState<number>(1);
  const [totalPages, setTotalPages] = useState<number>(1);
  const [level, setLevel] = useState<string>('');
  const [keyword, setKeyword] = useState<string>('');
  const [searchKeyword, setSearchKeyword] = useState<string>('');
  const [logType, setLogType] = useState<'combined' | 'error'>('combined');
  
  // Auto Refresh
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const fetchLogs = useCallback(async (currentPage: number, currentLevel: string, currentKeyword: string, currentType: 'combined' | 'error', showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const response = await logService.getLogs({
        page: currentPage,
        limit: 100,
        level: currentLevel || undefined,
        keyword: currentKeyword || undefined,
        type: currentType,
      });
      if (response.success) {
        setLogs(response.data.logs);
        setTotalPages(response.data.pagination.totalPages);
      }
    } catch (error) {
      console.error('Failed to fetch logs', error);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const response = await logService.getLogStats();
      if (response.success) {
        setStats(response.data);
      }
    } catch (error) {
      console.error('Failed to fetch stats', error);
    }
  }, []);

  useEffect(() => {
    fetchLogs(page, level, searchKeyword, logType);
    fetchStats();
  }, [page, level, searchKeyword, logType, fetchLogs, fetchStats]);

  // Auto refresh logic
  useEffect(() => {
    if (autoRefresh) {
      timerRef.current = setInterval(() => {
        // If auto-refreshing, force page 1 and don't show loading spinner
        setPage(1);
        fetchLogs(1, level, searchKeyword, logType, false);
      }, 3000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [autoRefresh, level, searchKeyword, logType, fetchLogs]);

  const handleSearch = () => {
    setPage(1);
    setSearchKeyword(keyword);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  return (
    <div style={{ padding: '24px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Title level={4} style={{ marginBottom: '24px' }}>系统日志监控</Title>
      
      {/* Top Control Panel */}
      <Card bordered={false} style={{ marginBottom: '16px' }} bodyStyle={{ padding: '16px 24px' }}>
        <Row gutter={[16, 16]} align="middle" justify="space-between">
          <Col flex="auto">
            <Space wrap size="middle">
              <Select
                value={logType}
                style={{ width: 220 }}
                onChange={(val) => {
                  setLogType(val as 'combined' | 'error');
                  setPage(1);
                }}
              >
                <Option value="combined">综合日志 (combined.log)</Option>
                <Option value="error">错误日志 (error.log)</Option>
              </Select>

              <Select
                value={level}
                style={{ width: 120 }}
                onChange={(val) => {
                  setLevel(val);
                  setPage(1);
                }}
              >
                <Option value="">全部级别</Option>
                <Option value="info">Info</Option>
                <Option value="warn">Warn</Option>
                <Option value="error">Error</Option>
                <Option value="debug">Debug</Option>
              </Select>

              <Input
                placeholder="关键字搜索..."
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onKeyDown={handleKeyDown}
                style={{ width: 300 }}
                prefix={<SearchOutlined style={{ color: '#bfbfbf' }}/>}
                allowClear
              />
              
              <Button type="primary" onClick={handleSearch}>搜索</Button>
            </Space>
          </Col>
          <Col>
            <Space size="middle">
              <Tooltip title={autoRefresh ? "停止实时刷新" : "开启实时刷新 (3秒)"}>
                <Button 
                  type={autoRefresh ? "default" : "primary"} 
                  danger={autoRefresh}
                  icon={autoRefresh ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                  onClick={() => setAutoRefresh(!autoRefresh)}
                >
                  {autoRefresh ? "停止 tail -f" : "实时监控"}
                </Button>
              </Tooltip>

              <Tooltip title="手动刷新">
                <Button 
                  icon={<SyncOutlined />} 
                  onClick={() => fetchLogs(page, level, searchKeyword, logType)}
                />
              </Tooltip>
            </Space>
          </Col>
        </Row>
      </Card>

      {/* Stats Chips */}
      <div style={{ marginBottom: '16px' }}>
        <Space size="small">
          <Tag color="success">Total Info: {stats.info || 0}</Tag>
          <Tag color="warning">Total Warn: {stats.warn || 0}</Tag>
          <Tag color="error">Total Error: {stats.error || 0}</Tag>
        </Space>
      </div>

      {/* Terminal View */}
      <div 
        style={{ 
          flexGrow: 1, 
          backgroundColor: '#1e1e1e', 
          color: '#d4d4d4', 
          padding: '16px', 
          overflowY: 'auto',
          fontFamily: '"Fira Code", Consolas, Monaco, "Courier New", monospace',
          fontSize: '14px',
          lineHeight: '1.6',
          borderRadius: '8px',
          position: 'relative',
          minHeight: '400px',
          boxShadow: 'inset 0 0 10px rgba(0,0,0,0.5)'
        }}
      >
        {loading && !autoRefresh && (
          <div style={{ 
            display: 'flex', 
            justifyContent: 'center', 
            alignItems: 'center', 
            height: '100%', 
            position: 'absolute', 
            top: 0, left: 0, right: 0, bottom: 0, 
            backgroundColor: 'rgba(30, 30, 30, 0.7)',
            zIndex: 10
          }}>
            <Spin size="large" />
          </div>
        )}
        
        {logs.length === 0 && !loading ? (
          <div style={{ textAlign: 'center', color: '#666', marginTop: '40px' }}>
            暂无匹配的日志
          </div>
        ) : (
          logs.map((log, index) => (
            <div key={index} style={{ marginBottom: '4px', display: 'flex', wordBreak: 'break-all' }}>
              {log.timestamp && (
                <span style={{ color: '#569cd6', marginRight: '16px', whiteSpace: 'nowrap' }}>
                  [{log.timestamp}]
                </span>
              )}
              {log.level !== 'unknown' && (
                <span style={{ 
                  color: log.level === 'error' ? '#f44336' : 
                         log.level === 'warn' ? '#ff9800' : 
                         log.level === 'info' ? '#4caf50' : '#9cdcfe',
                  marginRight: '16px', 
                  fontWeight: 'bold',
                  whiteSpace: 'nowrap',
                  width: '50px',
                  display: 'inline-block'
                }}>
                  {log.level.toUpperCase()}
                </span>
              )}
              <span style={{ 
                  color: log.level === 'error' ? '#f44336' : 
                         log.level === 'warn' ? '#ffb74d' : '#d4d4d4'
                }}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '24px' }}>
        <Pagination 
          current={page} 
          total={totalPages * 100} // AntD Pagination uses total items, assuming 100 per page limit
          pageSize={100}
          showSizeChanger={false}
          onChange={(newPage) => {
            setAutoRefresh(false); // Stop auto-refresh when manually paginating
            setPage(newPage);
          }} 
        />
      </div>
    </div>
  );
};

export default SystemLogs;
