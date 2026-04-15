import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Layout,
  Card,
  Input,
  Table,
  Button,
  Space,
  Tag,
  Row,
  Col,
  Typography,
  Divider,
  DatePicker,
  Select,
  message,
  Modal,
  Form,
  Empty,
  Statistic,
  Alert,
} from 'antd';
import {
  SearchOutlined,
  StarOutlined,
  StarFilled,
  LineChartOutlined,
  PlusOutlined,
  FilterOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
} from 'recharts';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api from '../services/api';

const { Title, Text, Paragraph } = Typography;
const { RangePicker } = DatePicker;
const { Option } = Select;

interface Stock {
  id: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  listingDate?: string;
  isListed: boolean;
}

interface StockHistory {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
  pctChg: number;
  adjustflag: number;
}

interface FavoriteStock {
  id: number;
  groupId?: string;
  tags?: string;
  notes?: string;
  sortOrder?: number;
  stock: Stock;
}

interface SearchParams {
  q?: string;
  page: number;
  limit: number;
  market?: string;
  industry?: string;
}

const Market: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useState<SearchParams>({
    page: 1,
    limit: 20,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [selectedStock, setSelectedStock] = useState<Stock | null>(null);
  const [stockHistory, setStockHistory] = useState<StockHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([
    dayjs().subtract(1, 'year'),
    dayjs(),
  ]);
  const [favorites, setFavorites] = useState<FavoriteStock[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [isFavoriteModalOpen, setIsFavoriteModalOpen] = useState(false);
  const [favoriteForm] = Form.useForm();

  // 数据完整性统计状态
  const [dataCompletenessStats, setDataCompletenessStats] = useState<any>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // 搜索股票
  const searchStocks = useCallback(async () => {
    setLoading(true);
    try {
      const params = {
        ...searchParams,
        q: searchQuery || undefined,
      };
      const response = await api.get('/market/search', { params });
      if (response.data.success) {
        setStocks(response.data.data.stocks);
        setTotal(response.data.data.pagination.total);
      } else {
        message.error('搜索失败：' + response.data.error);
      }
    } catch (error: any) {
      message.error('搜索失败：' + error.message);
    } finally {
      setLoading(false);
    }
  }, [searchParams, searchQuery]);

  // 获取股票历史数据
  const fetchStockHistory = useCallback(async (symbol: string) => {
    if (!symbol) return;

    setHistoryLoading(true);
    try {
      const [startDate, endDate] = dateRange;
      const params = {
        startDate: startDate.format('YYYY-MM-DD'),
        endDate: endDate.format('YYYY-MM-DD'),
        frequency: 'd',
      };
      const response = await api.get(`/market/history/${symbol}`, { params });
      if (response.data.success) {
        // 将字符串类型的数据转换为数字类型
        const historyData = response.data.data.history.map((item: any) => ({
          ...item,
          open: parseFloat(item.open) || 0,
          high: parseFloat(item.high) || 0,
          low: parseFloat(item.low) || 0,
          close: parseFloat(item.close) || 0,
          volume: parseFloat(item.volume) || 0,
          amount: parseFloat(item.amount) || 0,
          pctChg: parseFloat(item.pctChg) || 0,
          adjustflag: parseInt(item.adjustflag) || 0,
        }));
        setStockHistory(historyData);
      } else {
        message.error('获取历史数据失败：' + response.data.error);
        setStockHistory([]);
      }
    } catch (error: any) {
      message.error('获取历史数据失败：' + error.message);
      setStockHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [dateRange]);

  // 获取收藏列表
  const fetchFavorites = useCallback(async () => {
    setFavoritesLoading(true);
    try {
      const response = await api.get('/market/favorites');
      if (response.data.success) {
        setFavorites(response.data.data.favorites || []);
      } else {
        message.error('获取收藏列表失败：' + response.data.error);
      }
    } catch (error: any) {
      message.error('获取收藏列表失败：' + error.message);
    } finally {
      setFavoritesLoading(false);
    }
  }, []);

  // 获取数据完整性统计
  const fetchDataCompletenessStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const response = await api.get('/market/data-completeness', {
        params: { startDate: '2020-01-01', endDate: '2026-04-10' }
      });
      if (response.data.success) {
        setDataCompletenessStats(response.data.data);
      } else {
        message.error('获取数据完整性统计失败：' + response.data.error);
      }
    } catch (error: any) {
      message.error('获取数据完整性统计失败：' + error.message);
    } finally {
      setStatsLoading(false);
    }
  }, []);

  // 刷新数据完整性统计缓存
  const refreshDataCompletenessStats = async () => {
    try {
      // 先调用刷新缓存API，传递参数作为查询参数
      const refreshResponse = await api.post('/market/data-completeness/refresh', null, {
        params: { startDate: '2020-01-01', endDate: '2026-04-10' }
      });
      if (refreshResponse.data.success) {
        message.success('缓存已刷新，正在重新计算...');
        // 重新获取数据
        await fetchDataCompletenessStats();
      } else {
        message.error('刷新缓存失败：' + refreshResponse.data.error);
      }
    } catch (error: any) {
      message.error('刷新缓存失败：' + error.message);
    }
  };

  // 添加收藏
  const addFavorite = async (symbol: string, values?: any) => {
    try {
      const response = await api.post(`/market/favorites/${symbol}`, values || {});
      if (response.data.success) {
        message.success('收藏成功');
        fetchFavorites();
        return true;
      } else {
        message.error('收藏失败：' + response.data.error);
        return false;
      }
    } catch (error: any) {
      message.error('收藏失败：' + error.message);
      return false;
    }
  };

  // 移除收藏
  const removeFavorite = async (symbol: string) => {
    try {
      const response = await api.delete(`/market/favorites/${symbol}`);
      if (response.data.success) {
        message.success('已取消收藏');
        fetchFavorites();
        return true;
      } else {
        message.error('取消收藏失败：' + response.data.error);
        return false;
      }
    } catch (error: any) {
      message.error('取消收藏失败：' + error.message);
      return false;
    }
  };

  // 检查是否已收藏
  const checkIsFavorite = async (symbol: string): Promise<boolean> => {
    try {
      const response = await api.get(`/market/favorites/${symbol}`);
      return response.data.success && response.data.data.isFavorite;
    } catch {
      return false;
    }
  };

  // 初始加载
  useEffect(() => {
    searchStocks();
    fetchFavorites();
    fetchDataCompletenessStats();
  }, [searchStocks, fetchFavorites, fetchDataCompletenessStats]);

  // 数据更新检查（进入大盘页面时触发）
  useEffect(() => {
    const triggerDataUpdate = async () => {
      try {
        const response = await api.post('/market/update-data');
        if (response.data.success) {
          if (response.data.data.updatedToday) {
            console.log('今日数据已更新，跳过');
          } else {
            console.log('数据更新任务已开始，logId:', response.data.data.logId);
          }
        }
      } catch (error) {
        console.error('触发数据更新失败:', error);
        // 静默失败，不影响主功能
      }
    };

    triggerDataUpdate();
  }, []);

  // 自定义操作列组件
  const ActionColumn: React.FC<{ record: Stock }> = ({ record }) => {
    const [isFavorite, setIsFavorite] = useState(false);
    const [checkingFavorite, setCheckingFavorite] = useState(false);

    useEffect(() => {
      const checkFavorite = async () => {
        setCheckingFavorite(true);
        const result = await checkIsFavorite(record.symbol);
        setIsFavorite(result);
        setCheckingFavorite(false);
      };
      checkFavorite();
    }, [record.symbol, favorites]);

    const handleFavoriteClick = async () => {
      if (isFavorite) {
        await removeFavorite(record.symbol);
        setIsFavorite(false);
      } else {
        setIsFavoriteModalOpen(true);
        favoriteForm.setFieldsValue({ symbol: record.symbol });
      }
    };

    return (
      <Space size="small">
        <Button
          type="primary"
          size="small"
          icon={<LineChartOutlined />}
          onClick={() => {
            setSelectedStock(record);
            fetchStockHistory(record.symbol);
          }}
        >
          查看走势
        </Button>
        <Button
          type={isFavorite ? 'primary' : 'default'}
          size="small"
          icon={isFavorite ? <StarFilled /> : <StarOutlined />}
          loading={checkingFavorite}
          onClick={handleFavoriteClick}
          danger={isFavorite}
        >
          {isFavorite ? '已收藏' : '收藏'}
        </Button>
      </Space>
    );
  };

  // 股票表格列定义
  const stockColumns: ColumnsType<Stock> = [
    {
      title: '股票代码',
      dataIndex: 'symbol',
      key: 'symbol',
      width: 120,
    },
    {
      title: '股票名称',
      dataIndex: 'name',
      key: 'name',
      width: 120,
    },
    {
      title: '市场',
      dataIndex: 'market',
      key: 'market',
      width: 80,
      render: (market) => {
        const marketMap: Record<string, string> = {
          SH: '上海',
          SZ: '深圳',
          BJ: '北京',
        };
        return marketMap[market] || market;
      },
    },
    {
      title: '行业',
      dataIndex: 'industry',
      key: 'industry',
      width: 120,
    },
    {
      title: '上市状态',
      dataIndex: 'isListed',
      key: 'isListed',
      width: 100,
      render: (isListed) => (
        <Tag color={isListed ? 'green' : 'red'}>
          {isListed ? '上市' : '退市'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => <ActionColumn record={record} />,
    },
  ];

  // 收藏表格列定义
  const favoriteColumns: ColumnsType<FavoriteStock> = [
    {
      title: '股票',
      dataIndex: 'stock',
      key: 'stock',
      width: 150,
      render: (stock: Stock) => (
        <div>
          <div><strong>{stock.symbol}</strong></div>
          <div style={{ fontSize: '12px', color: '#666' }}>{stock.name}</div>
        </div>
      ),
    },
    {
      title: '市场',
      dataIndex: 'stock',
      key: 'market',
      width: 80,
      render: (stock: Stock) => {
        const marketMap: Record<string, string> = {
          SH: '上海',
          SZ: '深圳',
          BJ: '北京',
        };
        return marketMap[stock.market || ''] || stock.market;
      },
    },
    {
      title: '分组',
      dataIndex: 'groupId',
      key: 'groupId',
      width: 100,
      render: (groupId) => groupId || '默认',
    },
    {
      title: '备注',
      dataIndex: 'notes',
      key: 'notes',
      width: 150,
      ellipsis: true,
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, record) => (
        <Space size="small">
          <Button
            type="primary"
            size="small"
            icon={<LineChartOutlined />}
            onClick={() => {
              setSelectedStock(record.stock);
              fetchStockHistory(record.stock.symbol);
            }}
          >
            查看
          </Button>
          <Button
            type="text"
            size="small"
            danger
            onClick={async () => {
              await removeFavorite(record.stock.symbol);
            }}
          >
            移除
          </Button>
        </Space>
      ),
    },
  ];

  // 价格走势图配置使用Recharts

  // 成交量图表配置使用Recharts

  const handleSearch = () => {
    setSearchParams(prev => ({ ...prev, page: 1 }));
    searchStocks();
  };

  const handlePageChange = (page: number, pageSize: number) => {
    setSearchParams(prev => ({ ...prev, page, limit: pageSize }));
  };

  const handleDateRangeChange = (dates: any) => {
    if (dates && dates.length === 2) {
      setDateRange([dates[0], dates[1]]);
      if (selectedStock) {
        fetchStockHistory(selectedStock.symbol);
      }
    }
  };

  const handleAddFavorite = async () => {
    try {
      const values = await favoriteForm.validateFields();
      const symbol = favoriteForm.getFieldValue('symbol');
      const success = await addFavorite(symbol, values);
      if (success) {
        setIsFavoriteModalOpen(false);
        favoriteForm.resetFields();
      }
    } catch (error) {
      console.error('表单验证失败:', error);
    }
  };

  return (
    <Layout>
      <Title level={2}>大盘视图</Title>
      <Paragraph>搜索股票、查看历史走势、管理收藏夹</Paragraph>

      <Row gutter={[16, 16]}>
        {/* 左侧：搜索和股票列表 */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <SearchOutlined />
                <span>股票搜索</span>
              </Space>
            }
            extra={
              <Button
                type="primary"
                icon={<FilterOutlined />}
                onClick={() => {
                  // 可以扩展为高级筛选面板
                }}
              >
                筛选
              </Button>
            }
          >
            <Space direction="vertical" style={{ width: '100%' }}>
              <Input.Search
                placeholder="输入股票代码或名称"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onSearch={handleSearch}
                enterButton={
                  <Button type="primary" icon={<SearchOutlined />}>
                    搜索
                  </Button>
                }
                size="large"
                style={{ marginBottom: 16 }}
              />

              <Row gutter={8} style={{ marginBottom: 16 }}>
                <Col span={8}>
                  <Select
                    placeholder="选择市场"
                    style={{ width: '100%' }}
                    allowClear
                    onChange={(value) =>
                      setSearchParams(prev => ({ ...prev, market: value, page: 1 }))
                    }
                  >
                    <Option value="SH">上海</Option>
                    <Option value="SZ">深圳</Option>
                    <Option value="BJ">北京</Option>
                  </Select>
                </Col>
                <Col span={8}>
                  <Select
                    placeholder="选择行业"
                    style={{ width: '100%' }}
                    allowClear
                    onChange={(value) =>
                      setSearchParams(prev => ({ ...prev, industry: value, page: 1 }))
                    }
                  >
                    <Option value="银行">银行</Option>
                    <Option value="证券">证券</Option>
                    <Option value="保险">保险</Option>
                    <Option value="科技">科技</Option>
                    <Option value="医药">医药</Option>
                    <Option value="消费">消费</Option>
                  </Select>
                </Col>
                <Col span={8}>
                  <Button
                    style={{ width: '100%' }}
                    onClick={() => {
                      setSearchParams({ page: 1, limit: 20 });
                      setSearchQuery('');
                    }}
                  >
                    重置
                  </Button>
                </Col>
              </Row>

              <Table
                columns={stockColumns}
                dataSource={stocks}
                rowKey="id"
                loading={loading}
                pagination={{
                  current: searchParams.page,
                  pageSize: searchParams.limit,
                  total,
                  onChange: handlePageChange,
                  showSizeChanger: true,
                  showQuickJumper: true,
                  showTotal: (total) => `共 ${total} 条`,
                }}
                size="small"
                scroll={{ y: 400 }}
              />
            </Space>
          </Card>

          {/* 收藏夹 */}
          <Card
            title={
              <Space>
                <StarOutlined />
                <span>我的收藏</span>
              </Space>
            }
            style={{ marginTop: 16 }}
            loading={favoritesLoading}
          >
            {favorites.length > 0 ? (
              <Table
                columns={favoriteColumns}
                dataSource={favorites}
                rowKey="id"
                size="small"
                pagination={false}
                scroll={{ y: 300 }}
              />
            ) : (
              <Empty description="暂无收藏股票" />
            )}
          </Card>

          {/* 数据完整性统计 */}
          <Card
            title={
              <Space>
                <span>📊 数据完整性统计</span>
              </Space>
            }
            style={{ marginTop: 16 }}
            loading={statsLoading}
            extra={
              <Space>
                <Button
                  type="link"
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={refreshDataCompletenessStats}
                  loading={statsLoading}
                >
                  刷新
                </Button>
                <Button
                  type="link"
                  size="small"
                  onClick={() => {
                    // 跳转到数据更新监控页面
                    navigate('/data-update-status');
                  }}
                >
                  更新监控
                </Button>
              </Space>
            }
          >
            {dataCompletenessStats ? (
              <div>
                {/* 缓存状态提示 */}
                {dataCompletenessStats.summary.cached && (
                  <Alert
                    message="缓存数据"
                    description={`数据来源于缓存，缓存时间: ${dataCompletenessStats.summary.cacheTimestamp ? new Date(dataCompletenessStats.summary.cacheTimestamp).toLocaleString() : '未知'}`}
                    type="info"
                    showIcon
                    style={{ marginBottom: '12px' }}
                    action={
                      <Button
                        size="small"
                        type="link"
                        onClick={refreshDataCompletenessStats}
                      >
                        刷新数据
                      </Button>
                    }
                  />
                )}

                <Row gutter={[8, 8]}>
                  <Col span={12}>
                    <Card size="small" title="股票总数">
                      <Statistic
                        value={dataCompletenessStats.summary.totalStocks}
                        valueStyle={{ fontSize: '18px', fontWeight: 'bold' }}
                      />
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card size="small" title="有数据股票">
                      <Statistic
                        value={dataCompletenessStats.summary.stocksWithData}
                        valueStyle={{ fontSize: '18px', fontWeight: 'bold' }}
                        suffix={`/${dataCompletenessStats.summary.totalStocks}`}
                      />
                    </Card>
                  </Col>
                </Row>

                <Divider style={{ margin: '12px 0' }} />

                <Row gutter={[8, 8]}>
                  <Col span={24}>
                    <Card size="small" title="数据完整性分布">
                      {dataCompletenessStats.completenessLevels.map((level: any, index: number) => (
                        <div key={index} style={{ marginBottom: '4px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span>{level.label}</span>
                            <span>
                              {level.count} 只 ({level.percentage}%)
                            </span>
                          </div>
                        </div>
                      ))}
                    </Card>
                  </Col>
                </Row>

                <Divider style={{ margin: '12px 0' }} />

                <Row gutter={[8, 8]}>
                  <Col span={12}>
                    <Card size="small" title="平均完整性">
                      <Statistic
                        value={dataCompletenessStats.metrics.avgCompleteness}
                        suffix="%"
                        valueStyle={{ fontSize: '16px', fontWeight: 'bold' }}
                      />
                    </Card>
                  </Col>
                  <Col span={12}>
                    <Card size="small" title="高质量股票">
                      <Statistic
                        value={dataCompletenessStats.metrics.highQualityStocks}
                        suffix={`只 (${dataCompletenessStats.metrics.highQualityPercentage}%)`}
                        valueStyle={{ fontSize: '16px', fontWeight: 'bold' }}
                      />
                    </Card>
                  </Col>
                </Row>

                {dataCompletenessStats.dataQualityIssues.hasUndefinedSymbols && (
                  <Alert
                    message="数据质量问题"
                    description={`发现 ${dataCompletenessStats.dataQualityIssues.undefinedSymbolCount} 只股票的代码为undefined，建议执行数据更新`}
                    type="warning"
                    showIcon
                    style={{ marginTop: '12px' }}
                    action={
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => {
                          // 触发数据更新
                          api.post('/market/update-data').then(response => {
                            if (response.data.success) {
                              message.success('数据更新任务已触发');
                            }
                          });
                        }}
                      >
                        立即更新
                      </Button>
                    }
                  />
                )}
              </div>
            ) : (
              <Empty description="暂无统计数据" />
            )}
          </Card>
        </Col>

        {/* 右侧：股票走势图 */}
        <Col xs={24} lg={12}>
          <Card
            title={
              <Space>
                <LineChartOutlined />
                <span>
                  {selectedStock
                    ? `${selectedStock.name} (${selectedStock.symbol})`
                    : '股票走势'}
                </span>
              </Space>
            }
            extra={
              selectedStock && (
                <Space>
                  <RangePicker
                    value={dateRange}
                    onChange={handleDateRangeChange}
                    style={{ width: 300 }}
                  />
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setIsFavoriteModalOpen(true);
                      favoriteForm.setFieldsValue({ symbol: selectedStock.symbol });
                    }}
                  >
                    添加到收藏
                  </Button>
                </Space>
              )
            }
          >
            {selectedStock ? (
              <>
                <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
                  <Col span={8}>
                    <Card size="small" title="当前价格">
                      <Title level={3} style={{ margin: 0, color: '#1890ff' }}>
                        {stockHistory.length > 0
                          ? `¥${stockHistory[stockHistory.length - 1].close.toFixed(2)}`
                          : '--'}
                      </Title>
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small" title="涨跌幅">
                      <Title
                        level={3}
                        style={{
                          margin: 0,
                          color:
                            stockHistory.length > 0 && stockHistory[stockHistory.length - 1].pctChg > 0
                              ? '#ff4d4f'
                              : '#52c41a',
                        }}
                      >
                        {stockHistory.length > 0
                          ? `${stockHistory[stockHistory.length - 1].pctChg.toFixed(2)}%`
                          : '--'}
                      </Title>
                    </Card>
                  </Col>
                  <Col span={8}>
                    <Card size="small" title="成交量">
                      <Title level={3} style={{ margin: 0, color: '#faad14' }}>
                        {stockHistory.length > 0
                          ? `${(stockHistory[stockHistory.length - 1].volume / 10000).toFixed(0)}万手`
                          : '--'}
                      </Title>
                    </Card>
                  </Col>
                </Row>

                <Card title="价格走势" size="small" style={{ marginBottom: 16 }}>
                  {stockHistory.length > 0 ? (
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart data={stockHistory}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={(date) => dayjs(date).format('MM-DD')}
                        />
                        <YAxis
                          tickFormatter={(value) => `¥${value.toFixed(2)}`}
                          domain={['dataMin', 'dataMax']}
                        />
                        <Tooltip
                          formatter={(value: number) => [`¥${value.toFixed(2)}`, '收盘价']}
                          labelFormatter={(label) => dayjs(label).format('YYYY-MM-DD')}
                        />
                        <Legend />
                        <Line
                          type="monotone"
                          dataKey="close"
                          stroke="#1890ff"
                          strokeWidth={2}
                          dot={false}
                          name="收盘价"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <Empty description={historyLoading ? '加载中...' : '暂无数据'} />
                  )}
                </Card>

                <Card title="成交量" size="small">
                  {stockHistory.length > 0 ? (
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={stockHistory}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis
                          dataKey="date"
                          tickFormatter={(date) => dayjs(date).format('MM-DD')}
                        />
                        <YAxis
                          tickFormatter={(value) => {
                            const num = Number(value);
                            if (num >= 100000000) return `${(num / 100000000).toFixed(1)}亿`;
                            if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
                            return num.toString();
                          }}
                        />
                        <Tooltip
                          formatter={(value: number) => [`${(value / 10000).toFixed(0)}万手`, '成交量']}
                          labelFormatter={(label) => dayjs(label).format('YYYY-MM-DD')}
                        />
                        <Legend />
                        <Bar
                          dataKey="volume"
                          fill="#faad14"
                          name="成交量"
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <Empty description={historyLoading ? '加载中...' : '暂无数据'} />
                  )}
                </Card>
              </>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="请从左侧选择一只股票查看走势"
              />
            )}
          </Card>

          {/* 股票基本信息 */}
          {selectedStock && (
            <Card title="股票信息" style={{ marginTop: 16 }}>
              <Row gutter={[16, 8]}>
                <Col span={8}>
                  <Text strong>股票代码：</Text>
                  <Text>{selectedStock.symbol}</Text>
                </Col>
                <Col span={8}>
                  <Text strong>股票名称：</Text>
                  <Text>{selectedStock.name}</Text>
                </Col>
                <Col span={8}>
                  <Text strong>市场：</Text>
                  <Text>
                    {selectedStock.market === 'SH'
                      ? '上海'
                      : selectedStock.market === 'SZ'
                      ? '深圳'
                      : selectedStock.market === 'BJ'
                      ? '北京'
                      : selectedStock.market}
                  </Text>
                </Col>
                <Col span={8}>
                  <Text strong>行业：</Text>
                  <Text>{selectedStock.industry || '--'}</Text>
                </Col>
                <Col span={8}>
                  <Text strong>上市日期：</Text>
                  <Text>{selectedStock.listingDate || '--'}</Text>
                </Col>
                <Col span={8}>
                  <Text strong>上市状态：</Text>
                  <Tag color={selectedStock.isListed ? 'green' : 'red'}>
                    {selectedStock.isListed ? '上市' : '退市'}
                  </Tag>
                </Col>
              </Row>
            </Card>
          )}
        </Col>
      </Row>

      {/* 收藏模态框 */}
      <Modal
        title="添加到收藏夹"
        open={isFavoriteModalOpen}
        onOk={handleAddFavorite}
        onCancel={() => {
          setIsFavoriteModalOpen(false);
          favoriteForm.resetFields();
        }}
        okText="收藏"
        cancelText="取消"
      >
        <Form form={favoriteForm} layout="vertical">
          <Form.Item name="symbol" label="股票代码" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="groupId"
            label="分组"
            rules={[{ required: false, message: '请选择分组' }]}
          >
            <Select placeholder="选择分组">
              <Option value="default">默认</Option>
              <Option value="tech">科技股</Option>
              <Option value="finance">金融股</Option>
              <Option value="consumer">消费股</Option>
              <Option value="medicine">医药股</Option>
              <Option value="industry">工业股</Option>
            </Select>
          </Form.Item>
          <Form.Item name="tags" label="标签">
            <Input placeholder="多个标签用逗号分隔，如：蓝筹股,高股息" />
          </Form.Item>
          <Form.Item name="notes" label="备注">
            <Input.TextArea rows={3} placeholder="输入备注信息" />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序权重" initialValue={0}>
            <Input type="number" min={0} max={100} />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
};

export default Market;