import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Box,
  Typography,
  Paper,
  TextField,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Button,
  Pagination,
  CircularProgress,
  Chip,
  IconButton,
  Tooltip,
} from '@mui/material';
import { Refresh as RefreshIcon, PlayArrow, Stop } from '@mui/icons-material';
import { logService, LogEntry } from '../services/logService';

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const getLevelColor = (lvl: string) => {
    switch (lvl.toLowerCase()) {
      case 'error': return 'error';
      case 'warn': return 'warning';
      case 'info': return 'success';
      case 'debug': return 'info';
      default: return 'default';
    }
  };

  return (
    <Box sx={{ p: 3, height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Typography variant="h4" gutterBottom>系统日志监控</Typography>
      
      {/* Top Control Panel */}
      <Paper sx={{ p: 2, mb: 2, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>日志文件</InputLabel>
          <Select
            value={logType}
            label="日志文件"
            onChange={(e) => {
              setLogType(e.target.value as 'combined' | 'error');
              setPage(1);
            }}
          >
            <MenuItem value="combined">综合日志 (combined.log)</MenuItem>
            <MenuItem value="error">错误日志 (error.log)</MenuItem>
          </Select>
        </FormControl>

        <FormControl size="small" sx={{ minWidth: 120 }}>
          <InputLabel>日志级别</InputLabel>
          <Select
            value={level}
            label="日志级别"
            onChange={(e) => {
              setLevel(e.target.value);
              setPage(1);
            }}
          >
            <MenuItem value="">全部 (All)</MenuItem>
            <MenuItem value="info">Info</MenuItem>
            <MenuItem value="warn">Warn</MenuItem>
            <MenuItem value="error">Error</MenuItem>
            <MenuItem value="debug">Debug</MenuItem>
          </Select>
        </FormControl>

        <TextField
          size="small"
          label="关键字搜索"
          variant="outlined"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={handleKeyDown}
          sx={{ flexGrow: 1 }}
        />
        
        <Button variant="contained" onClick={handleSearch}>搜索</Button>

        <Box sx={{ flexGrow: 1 }} />
        
        <Tooltip title={autoRefresh ? "停止实时刷新" : "开启实时刷新 (3秒)"}>
          <Button 
            variant={autoRefresh ? "outlined" : "contained"} 
            color={autoRefresh ? "secondary" : "primary"}
            startIcon={autoRefresh ? <Stop /> : <PlayArrow />}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? "停止 tail -f" : "实时监控"}
          </Button>
        </Tooltip>

        <Tooltip title="手动刷新">
          <IconButton onClick={() => fetchLogs(page, level, searchKeyword, logType)}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Paper>

      {/* Stats Chips */}
      <Box sx={{ mb: 2, display: 'flex', gap: 1 }}>
        <Chip label={`Total Info: ${stats.info || 0}`} color="success" size="small" variant="outlined" />
        <Chip label={`Total Warn: ${stats.warn || 0}`} color="warning" size="small" variant="outlined" />
        <Chip label={`Total Error: ${stats.error || 0}`} color="error" size="small" variant="outlined" />
      </Box>

      {/* Terminal View */}
      <Paper 
        sx={{ 
          flexGrow: 1, 
          bgcolor: '#1e1e1e', 
          color: '#d4d4d4', 
          p: 2, 
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: '0.875rem',
          borderRadius: 2,
          position: 'relative'
        }}
      >
        {loading && !autoRefresh && (
          <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, bgcolor: 'rgba(30, 30, 30, 0.7)' }}>
            <CircularProgress color="inherit" />
          </Box>
        )}
        
        {logs.length === 0 && !loading ? (
          <Typography color="gray" align="center" sx={{ mt: 4 }}>暂无匹配的日志</Typography>
        ) : (
          logs.map((log, index) => (
            <Box key={index} sx={{ mb: 0.5, display: 'flex', wordBreak: 'break-all' }}>
              {log.timestamp && (
                <Box component="span" sx={{ color: '#569cd6', mr: 2, whiteSpace: 'nowrap' }}>
                  [{log.timestamp}]
                </Box>
              )}
              {log.level !== 'unknown' && (
                <Box component="span" sx={{ 
                  color: log.level === 'error' ? '#f44336' : 
                         log.level === 'warn' ? '#ff9800' : 
                         log.level === 'info' ? '#4caf50' : '#9cdcfe',
                  mr: 2, 
                  fontWeight: 'bold',
                  whiteSpace: 'nowrap',
                  width: '50px',
                  display: 'inline-block'
                }}>
                  {log.level.toUpperCase()}
                </Box>
              )}
              <Box component="span" sx={{ 
                  color: log.level === 'error' ? '#f44336' : 
                         log.level === 'warn' ? '#ffb74d' : '#d4d4d4'
                }}>
                {log.message}
              </Box>
            </Box>
          ))
        )}
      </Paper>

      {/* Pagination */}
      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
        <Pagination 
          count={totalPages} 
          page={page} 
          onChange={(_, newPage) => {
            setAutoRefresh(false); // Stop auto-refresh when manually paginating
            setPage(newPage);
          }} 
          color="primary" 
        />
      </Box>
    </Box>
  );
};

export default SystemLogs;
