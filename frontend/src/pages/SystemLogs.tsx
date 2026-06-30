import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  Input,
  Select,
  Button,
  Pagination,
  Spin,
  Tag,
  Space,
  Tooltip,
  Row,
  Col,
  Empty,
} from 'antd';
import {
  SyncOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { logService, LogEntry } from '../services/logService';

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

  const fetchLogs = useCallback(
    async (
      currentPage: number,
      currentLevel: string,
      currentKeyword: string,
      currentType: 'combined' | 'error',
      showLoading = true
    ) => {
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
    },
    []
  );

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
        setPage(1);
        fetchLogs(1, level, searchKeyword, logType, false);
      }, 3000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
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

  const getLevelColor = (logLevel: string) => {
    if (logLevel === 'error') return '#ff7a7a';
    if (logLevel === 'warn') return '#f5b85b';
    if (logLevel === 'info') return '#7dd3a7';
    return '#8bd3ff';
  };

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">系统日志</h1>
          <p className="page-subtitle-modern">按级别、关键字和日志文件实时追踪系统运行状态</p>
        </div>
        <div className="page-actions-modern">
          <Tooltip title={autoRefresh ? '停止实时刷新' : '开启实时刷新 (3秒)'}>
            <Button
              type={autoRefresh ? 'default' : 'primary'}
              danger={autoRefresh}
              icon={autoRefresh ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              {autoRefresh ? '停止实时监控' : '实时监控'}
            </Button>
          </Tooltip>
          <Tooltip title="手动刷新">
            <Button
              icon={<SyncOutlined />}
              onClick={() => fetchLogs(page, level, searchKeyword, logType)}
            >
              刷新
            </Button>
          </Tooltip>
        </div>
      </div>

      <div className="stats-grid-modern" style={{ marginBottom: 16 }}>
        <Card className="stat-card stat-card-green modern-card" variant="borderless">
          <div className="metric-title">Info</div>
          <div className="metric-value">{stats.info || 0}</div>
        </Card>
        <Card className="stat-card stat-card-orange modern-card" variant="borderless">
          <div className="metric-title">Warn</div>
          <div className="metric-value">{stats.warn || 0}</div>
        </Card>
        <Card className="stat-card stat-card-red modern-card" variant="borderless">
          <div className="metric-title">Error</div>
          <div className="metric-value">{stats.error || 0}</div>
        </Card>
        <Card className="stat-card stat-card-blue modern-card" variant="borderless">
          <div className="metric-title">当前页</div>
          <div className="metric-value">{page}</div>
        </Card>
      </div>

      <Card className="modern-card" variant="borderless" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 16]} align="middle" justify="space-between">
          <Col flex="auto">
            <Space wrap size="middle">
              <Select
                value={logType}
                style={{ width: 220 }}
                onChange={val => {
                  setLogType(val as 'combined' | 'error');
                  setPage(1);
                }}
              >
                <Option value="combined">综合日志</Option>
                <Option value="error">错误日志</Option>
              </Select>

              <Select
                value={level}
                style={{ width: 132 }}
                onChange={val => {
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
                onChange={e => setKeyword(e.target.value)}
                onKeyDown={handleKeyDown}
                style={{ width: 320 }}
                prefix={<SearchOutlined style={{ color: '#8c98a5' }} />}
                allowClear
              />

              <Button type="primary" onClick={handleSearch}>
                搜索
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      <Card className="modern-card table-card-no-padding" variant="borderless">
        <div
          className="terminal-surface"
          style={{ position: 'relative', minHeight: 520, padding: 18 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 14 }}>
            <span className="terminal-title">{logType}.log</span>
            <Space size={8}>
              {level && <Tag className="modern-tag tag-info">{level.toUpperCase()}</Tag>}
              {searchKeyword && <Tag className="modern-tag tag-warning">{searchKeyword}</Tag>}
            </Space>
          </div>

          {loading && !autoRefresh && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(10, 14, 23, 0.58)',
                zIndex: 10,
                borderRadius: 18,
              }}
            >
              <Spin size="large" />
            </div>
          )}

          {logs.length === 0 && !loading ? (
            <Empty description="暂无匹配的日志" style={{ paddingTop: 120 }} />
          ) : (
            logs.map((log, index) => (
              <div key={index} className="terminal-log-line">
                {log.timestamp && <span className="terminal-timestamp">[{log.timestamp}]</span>}
                {log.level !== 'unknown' && (
                  <span className="terminal-level" style={{ color: getLevelColor(log.level) }}>
                    {log.level.toUpperCase()}
                  </span>
                )}
                <span
                  className="terminal-message"
                  style={{
                    color:
                      log.level === 'error'
                        ? '#ffb4b4'
                        : log.level === 'warn'
                          ? '#ffd18a'
                          : '#dbe7f5',
                  }}
                >
                  {log.message}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
        <Pagination
          current={page}
          total={totalPages * 100}
          pageSize={100}
          showSizeChanger={false}
          onChange={newPage => {
            setAutoRefresh(false);
            setPage(newPage);
          }}
        />
      </div>
    </div>
  );
};

export default SystemLogs;
