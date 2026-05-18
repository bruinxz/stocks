import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  Input,
  Table,
  Button,
  Space,
  Tag,
  Row,
  Col,
  Typography,
  Select,
  message,
  Modal,
  Form,
  Empty,
  Alert,
  Tabs,
  Spin,
} from 'antd';
import { StarOutlined, StarFilled, LineChartOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  AreaChart,
  Area,
  Tooltip as RechartsTooltip,
} from 'recharts';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import api, { addFavorite, removeFavorite } from '../services/api';

const { Text } = Typography;
const { Option } = Select;

const getPriceChangeColor = (change?: number) => {
  if (!change) return '#0f172a';
  return change > 0 ? '#ef4444' : '#10b981';
};

const getMarketLabel = (market?: string) => {
  const marketMap: Record<string, string> = {
    SH: '上海',
    SZ: '深圳',
    BJ: '北京',
  };
  return marketMap[market || ''] || market || '--';
};

interface Stock {
  id: number;
  symbol: string;
  name: string;
  market?: string;
  industry?: string;
  listing_date?: string;
  is_listed: boolean;
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
  group_id?: string;
  tags?: string;
  notes?: string;
  sort_order?: number;
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
    limit: 50,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [selectedStock, setSelectedStock] = useState<Stock | null>(null);
  const [stockHistory, setStockHistory] = useState<StockHistory[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [dateRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(1, 'year'), dayjs()]);
  const [favorites, setFavorites] = useState<FavoriteStock[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [isFavoriteModalOpen, setIsFavoriteModalOpen] = useState(false);
  const [favoriteForm] = Form.useForm();
  const [activeTab, setActiveTab] = useState('all');

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
  const fetchStockHistory = useCallback(
    async (symbol: string) => {
      if (!symbol) return;

      setHistoryLoading(true);
      try {
        const [start_date, end_date] = dateRange;
        const params = {
          start_date: start_date.format('YYYY-MM-DD'),
          end_date: end_date.format('YYYY-MM-DD'),
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
    },
    [dateRange]
  );

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
        params: { start_date: '2020-01-01', end_date: '2026-04-10' },
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
      const refreshResponse = await api.post(
        '/market/data-completeness/refresh',
        {},
        {
          params: { start_date: '2020-01-01', end_date: '2026-04-10' },
        }
      );
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
  const handleAddFavoriteCall = async (symbol: string, values?: any) => {
    try {
      const response = await addFavorite(symbol, values || {});
      if (response.data.success) {
        message.success('收藏成功');
        fetchFavorites();
        setIsFavoriteModalOpen(false);
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
  const handleRemoveFavoriteCall = async (symbol: string) => {
    try {
      const response = await removeFavorite(symbol);
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

  // 初始加载
  useEffect(() => {
    searchStocks();
    fetchFavorites();
  }, [searchStocks, fetchFavorites]);

  // 数据完整性统计是全市场聚合查询，冷缓存时可能较重；仅在用户打开对应页签时加载，
  // 避免大盘页首屏和股票搜索被后台统计请求拖慢。
  useEffect(() => {
    if (activeTab === 'stats' && !dataCompletenessStats && !statsLoading) {
      fetchDataCompletenessStats();
    }
  }, [activeTab, dataCompletenessStats, fetchDataCompletenessStats, statsLoading]);

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
      render: market => {
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
      dataIndex: 'is_listed',
      key: 'is_listed',
      width: 100,
      render: is_listed => (
        <Tag color={is_listed ? 'green' : 'red'}>{is_listed ? '上市' : '退市'}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => {
        const isFavorite = favorites.some(f => f.stock.symbol === record.symbol);

        return (
          <Space size="small">
            <Button
              type="text"
              size="small"
              onClick={e => {
                e.stopPropagation();
                setSelectedStock(record);
                fetchStockHistory(record.symbol);
              }}
            >
              查看走势
            </Button>
            <Button
              type="text"
              size="small"
              icon={isFavorite ? <StarFilled style={{ color: '#f59e0b' }} /> : <StarOutlined />}
              onClick={e => {
                e.stopPropagation();
                if (isFavorite) {
                  handleRemoveFavoriteCall(record.symbol);
                } else {
                  setIsFavoriteModalOpen(true);
                  favoriteForm.setFieldsValue({ symbol: record.symbol });
                }
              }}
            >
              {isFavorite ? '取消' : '收藏'}
            </Button>
          </Space>
        );
      },
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
          <div>
            <strong>{stock.symbol}</strong>
          </div>
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
      dataIndex: 'group_id',
      key: 'group_id',
      width: 100,
      render: group_id => group_id || '默认',
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

  const handleSearch = () => {
    setSearchParams(prev => ({ ...prev, page: 1 }));
    searchStocks();
  };

  const handlePageChange = (page: number, pageSize: number) => {
    setSearchParams(prev => ({ ...prev, page, limit: pageSize }));
  };

  const handleAddFavoriteSubmit = async () => {
    try {
      const values = await favoriteForm.validateFields();
      const symbol = favoriteForm.getFieldValue('symbol');
      const success = await handleAddFavoriteCall(symbol, values);
      if (success) {
        setIsFavoriteModalOpen(false);
        favoriteForm.resetFields();
      }
    } catch (error) {
      console.error('表单验证失败:', error);
    }
  };

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <h1 className="page-title-modern">大盘视图</h1>
        <p className="page-subtitle-modern">搜索股票、查看历史走势、管理收藏夹</p>
      </div>

      <Row gutter={[16, 16]}>
        {/* 左侧：搜索和股票列表 */}
        <Col xs={24} lg={9} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card
            className="modern-card"
            variant="borderless"
            styles={{
              body: {
                padding: '0 16px',
                display: 'flex',
                flexDirection: 'column',
                height: 'calc(100vh - 130px)',
              },
            }}
          >
            <Tabs
              defaultActiveKey="all"
              activeKey={activeTab}
              onChange={setActiveTab}
              style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
              items={[
                {
                  key: 'all',
                  label: '全部股票',
                  children: (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        height: '100%',
                        paddingBottom: 16,
                      }}
                    >
                      <div
                        style={{ width: '100%', flex: 1, display: 'flex', flexDirection: 'column' }}
                      >
                        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                          <Input.Search
                            placeholder="输入股票代码或名称"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                            onSearch={handleSearch}
                            allowClear
                            style={{ flex: 1 }}
                          />
                        </div>

                        <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
                          <Col span={8}>
                            <Select
                              placeholder="选择市场"
                              style={{ width: '100%' }}
                              allowClear
                              onChange={value =>
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
                              onChange={value =>
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
                                setSearchParams({ page: 1, limit: 50 });
                                setSearchQuery('');
                              }}
                            >
                              重置
                            </Button>
                          </Col>
                        </Row>

                        <div style={{ flex: 1, overflow: 'hidden' }}>
                          <Table
                            columns={stockColumns}
                            dataSource={stocks}
                            rowKey="id"
                            loading={loading}
                            rowClassName={record =>
                              selectedStock?.symbol === record.symbol ? 'active-row' : ''
                            }
                            onRow={record => ({
                              onClick: () => {
                                setSelectedStock(record);
                                fetchStockHistory(record.symbol);
                              },
                              style: { cursor: 'pointer' },
                            })}
                            pagination={{
                              current: searchParams.page,
                              pageSize: searchParams.limit,
                              total,
                              onChange: handlePageChange,
                              showSizeChanger: false,
                              size: 'small',
                              showTotal: total => `共 ${total} 条`,
                            }}
                            size="small"
                            scroll={{ y: 'calc(100vh - 350px)' }}
                            locale={{ emptyText: <Empty description="没有找到匹配的股票" /> }}
                          />
                        </div>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'favorites',
                  label: '我的收藏',
                  children: (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        height: '100%',
                        paddingBottom: 16,
                      }}
                    >
                      <Spin
                        spinning={favoritesLoading}
                        style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
                      >
                        {favorites.length > 0 ? (
                          <div style={{ flex: 1, overflow: 'hidden' }}>
                            <Table
                              columns={favoriteColumns}
                              dataSource={favorites}
                              rowKey="id"
                              size="small"
                              pagination={false}
                              scroll={{ y: 'calc(100vh - 280px)' }}
                              rowClassName={record =>
                                selectedStock?.symbol === record.stock.symbol ? 'active-row' : ''
                              }
                              onRow={record => ({
                                onClick: () => {
                                  setSelectedStock(record.stock);
                                  fetchStockHistory(record.stock.symbol);
                                },
                                style: { cursor: 'pointer' },
                              })}
                            />
                          </div>
                        ) : (
                          <Empty description="暂无收藏股票" />
                        )}
                      </Spin>
                    </div>
                  ),
                },
                {
                  key: 'stats',
                  label: '数据完整性',
                  children: (
                    <div style={{ paddingBottom: 24 }}>
                      <Spin spinning={statsLoading}>
                        <Space style={{ marginBottom: 16 }}>
                          <Button
                            size="small"
                            icon={<ReloadOutlined />}
                            onClick={refreshDataCompletenessStats}
                          >
                            刷新
                          </Button>
                          <Button size="small" onClick={() => navigate('/data-update')}>
                            更新监控
                          </Button>
                        </Space>
                        {dataCompletenessStats ? (
                          <div>
                            {dataCompletenessStats.summary.cached && (
                              <Alert
                                message={`缓存数据 (${
                                  dataCompletenessStats.summary.cacheTimestamp
                                    ? new Date(
                                        dataCompletenessStats.summary.cacheTimestamp
                                      ).toLocaleString()
                                    : ''
                                })`}
                                type="info"
                                showIcon
                                style={{ marginBottom: 12, fontSize: 12 }}
                              />
                            )}
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: 8,
                                marginBottom: 12,
                              }}
                            >
                              {[
                                {
                                  label: '股票总数',
                                  value: dataCompletenessStats.summary.totalStocks,
                                },
                                {
                                  label: '有数据',
                                  value: `${dataCompletenessStats.summary.stocksWithData}`,
                                },
                                {
                                  label: '平均完整性',
                                  value: `${dataCompletenessStats.metrics.avgCompleteness}%`,
                                },
                                {
                                  label: '高质量',
                                  value: `${dataCompletenessStats.metrics.highQualityStocks}只`,
                                },
                              ].map(item => (
                                <div
                                  key={item.label}
                                  style={{
                                    textAlign: 'center',
                                    padding: '8px 0',
                                    background: '#f8fafc',
                                    borderRadius: 8,
                                  }}
                                >
                                  <div
                                    style={{
                                      fontSize: 18,
                                      fontWeight: 700,
                                      color: 'var(--text-main)',
                                    }}
                                  >
                                    {item.value}
                                  </div>
                                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                                    {item.label}
                                  </div>
                                </div>
                              ))}
                            </div>
                            {dataCompletenessStats.completenessLevels.map(
                              (level: any, index: number) => (
                                <div
                                  key={index}
                                  style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    fontSize: 12,
                                    padding: '4px 0',
                                    color: 'var(--text-secondary)',
                                  }}
                                >
                                  <span>{level.label}</span>
                                  <span>
                                    {level.count} 只 ({level.percentage}%)
                                  </span>
                                </div>
                              )
                            )}
                          </div>
                        ) : (
                          <Empty description="暂无统计数据" />
                        )}
                      </Spin>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </Col>

        {/* 右侧：股票走势图 */}
        <Col
          xs={24}
          lg={15}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            height: 'calc(100vh - 130px)',
            overflowY: 'auto',
          }}
        >
          {selectedStock ? (
            <>
              {/* 顶部：当前股票摘要与指标 */}
              <Card
                className="modern-card"
                variant="borderless"
                title={`${selectedStock.name} (${selectedStock.symbol})`}
                extra={
                  <Button
                    type="text"
                    icon={
                      favorites.some(f => f.stock.symbol === selectedStock.symbol) ? (
                        <StarFilled style={{ color: '#faad14' }} />
                      ) : (
                        <StarOutlined />
                      )
                    }
                    onClick={() => {
                      if (favorites.some(f => f.stock.symbol === selectedStock.symbol)) {
                        handleRemoveFavoriteCall(selectedStock.symbol);
                      } else {
                        setIsFavoriteModalOpen(true);
                        favoriteForm.setFieldsValue({ symbol: selectedStock.symbol });
                      }
                    }}
                  >
                    {favorites.some(f => f.stock.symbol === selectedStock.symbol)
                      ? '已收藏'
                      : '加入收藏'}
                  </Button>
                }
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
                    gap: 16,
                    marginBottom: 24,
                  }}
                >
                  <div style={{ padding: '12px 16px', background: '#f8fafc', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>当前价格</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>
                      {stockHistory.length > 0
                        ? `¥${stockHistory[stockHistory.length - 1].close.toFixed(2)}`
                        : '--'}
                    </div>
                  </div>
                  <div style={{ padding: '12px 16px', background: '#f8fafc', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>涨跌幅</div>
                    <div
                      style={{
                        fontSize: 24,
                        fontWeight: 700,
                        color: getPriceChangeColor(
                          stockHistory.length > 0
                            ? stockHistory[stockHistory.length - 1].pctChg
                            : undefined
                        ),
                      }}
                    >
                      {stockHistory.length > 0
                        ? `${
                            stockHistory[stockHistory.length - 1].pctChg > 0 ? '+' : ''
                          }${stockHistory[stockHistory.length - 1].pctChg.toFixed(2)}%`
                        : '--'}
                    </div>
                  </div>
                  <div style={{ padding: '12px 16px', background: '#f8fafc', borderRadius: 8 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>成交量</div>
                    <div style={{ fontSize: 24, fontWeight: 700, color: '#0f172a' }}>
                      {stockHistory.length > 0
                        ? `${(stockHistory[stockHistory.length - 1].volume / 10000).toFixed(0)}万手`
                        : '--'}
                    </div>
                  </div>
                </div>

                <Row gutter={[16, 12]}>
                  <Col span={6}>
                    <Text type="secondary">市场：</Text>
                    <Text strong style={{ marginLeft: 8 }}>
                      {getMarketLabel(selectedStock.market)}
                    </Text>
                  </Col>
                  <Col span={6}>
                    <Text type="secondary">行业：</Text>
                    <Text strong style={{ marginLeft: 8 }}>
                      {selectedStock.industry || '--'}
                    </Text>
                  </Col>
                  <Col span={6}>
                    <Text type="secondary">上市日期：</Text>
                    <Text strong style={{ marginLeft: 8 }}>
                      {selectedStock.listing_date || '--'}
                    </Text>
                  </Col>
                  <Col span={6}>
                    <Text type="secondary">状态：</Text>
                    <Tag
                      color={selectedStock.is_listed ? 'green' : 'red'}
                      style={{ marginLeft: 8 }}
                    >
                      {selectedStock.is_listed ? '上市' : '退市'}
                    </Tag>
                  </Col>
                </Row>
              </Card>

              {/* 中部：图表区域 (使用 Tabs 切换) */}
              <Card
                className="modern-card chart-card"
                variant="borderless"
                style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
                styles={{
                  body: { flex: 1, display: 'flex', flexDirection: 'column', padding: '16px' },
                }}
              >
                <Tabs
                  defaultActiveKey="price"
                  style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
                  items={[
                    {
                      key: 'price',
                      label: '价格走势',
                      children: (
                        <div style={{ height: 400, marginTop: 16 }}>
                          {stockHistory.length > 0 ? (
                            <ResponsiveContainer width="100%" height={400}>
                              <AreaChart data={stockHistory}>
                                <defs>
                                  <linearGradient id="colorClose" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                                  </linearGradient>
                                </defs>
                                <CartesianGrid
                                  strokeDasharray="3 3"
                                  vertical={false}
                                  stroke="#f0f0f0"
                                />
                                <XAxis
                                  dataKey="date"
                                  tickFormatter={date => dayjs(date).format('MM-DD')}
                                  tick={{ fill: '#9ca3af', fontSize: 12 }}
                                  axisLine={false}
                                  tickLine={false}
                                  minTickGap={30}
                                />
                                <YAxis
                                  tickFormatter={value => `¥${value.toFixed(2)}`}
                                  domain={['auto', 'auto']}
                                  tick={{ fill: '#9ca3af', fontSize: 12 }}
                                  axisLine={false}
                                  tickLine={false}
                                />
                                <RechartsTooltip
                                  formatter={(value: number) => [`¥${value.toFixed(2)}`, '收盘价']}
                                  labelFormatter={label => dayjs(label).format('YYYY-MM-DD')}
                                  contentStyle={{
                                    borderRadius: '8px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                  }}
                                  labelStyle={{
                                    fontWeight: 'bold',
                                    color: '#1f2937',
                                    marginBottom: 8,
                                  }}
                                />
                                <Legend />
                                <Area
                                  type="monotone"
                                  dataKey="close"
                                  stroke="#3b82f6"
                                  strokeWidth={2}
                                  fillOpacity={1}
                                  fill="url(#colorClose)"
                                  name="收盘价"
                                />
                              </AreaChart>
                            </ResponsiveContainer>
                          ) : (
                            <Empty description={historyLoading ? '加载中...' : '暂无数据'} />
                          )}
                        </div>
                      ),
                    },
                    {
                      key: 'volume',
                      label: '成交量',
                      children: (
                        <div style={{ height: 400, marginTop: 16 }}>
                          {stockHistory.length > 0 ? (
                            <ResponsiveContainer width="100%" height={400}>
                              <BarChart data={stockHistory}>
                                <CartesianGrid vertical={false} stroke="#f0f0f0" />
                                <XAxis
                                  dataKey="date"
                                  tickFormatter={date => dayjs(date).format('MM-DD')}
                                  axisLine={false}
                                  tickLine={false}
                                  minTickGap={30}
                                />
                                <YAxis
                                  tickFormatter={value => {
                                    const num = Number(value);
                                    if (num >= 100000000)
                                      return `${(num / 100000000).toFixed(1)}亿`;
                                    if (num >= 10000) return `${(num / 10000).toFixed(1)}万`;
                                    return num.toString();
                                  }}
                                  axisLine={false}
                                  tickLine={false}
                                />
                                <RechartsTooltip
                                  formatter={(value: number) => [
                                    `${(value / 10000).toFixed(0)}万手`,
                                    '成交量',
                                  ]}
                                  labelFormatter={label => dayjs(label).format('YYYY-MM-DD')}
                                  contentStyle={{
                                    borderRadius: '8px',
                                    border: 'none',
                                    boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                                  }}
                                  cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                                />
                                <Legend />
                                <Bar
                                  dataKey="volume"
                                  fill="#faad14"
                                  name="成交量"
                                  radius={[4, 4, 0, 0]}
                                />
                              </BarChart>
                            </ResponsiveContainer>
                          ) : (
                            <Empty description={historyLoading ? '加载中...' : '暂无数据'} />
                          )}
                        </div>
                      ),
                    },
                  ]}
                />
              </Card>
            </>
          ) : (
            <Card
              className="modern-card"
              variant="borderless"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <Empty
                image={<LineChartOutlined style={{ fontSize: 64, color: '#bfbfbf' }} />}
                description={
                  <Space direction="vertical" size="small">
                    <Typography.Text strong style={{ fontSize: 16, color: '#374151' }}>
                      选择一只股票
                    </Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 14 }}>
                      从左侧列表中选择股票以查看走势详情
                    </Typography.Text>
                  </Space>
                }
              />
            </Card>
          )}
        </Col>
      </Row>

      {/* 收藏模态框 */}
      <Modal
        title="添加到收藏夹"
        open={isFavoriteModalOpen}
        onOk={handleAddFavoriteSubmit}
        onCancel={() => {
          setIsFavoriteModalOpen(false);
          favoriteForm.resetFields();
        }}
        okText="收藏"
        cancelText="取消"
        destroyOnHidden={false}
      >
        <Form form={favoriteForm} layout="vertical">
          <Form.Item name="symbol" label="股票代码" hidden>
            <Input />
          </Form.Item>
          <Form.Item
            name="group_id"
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
          <Form.Item name="sort_order" label="排序权重" initialValue={0}>
            <Input type="number" min={0} max={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Market;
