import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Statistic,
  Typography,
  Table,
  Space,
  Tag,
  Button,
  Empty,
  Modal,
  Form,
  Select,
  InputNumber,
  Radio,
  message,
  Spin,
} from 'antd';
import {
  AccountBookOutlined,
  WalletOutlined,
  RiseOutlined,
  FallOutlined,
  PlusOutlined,
  HistoryOutlined,
} from '@ant-design/icons';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from 'recharts';
import api, { getPaperTradingSnapshots } from '../services/api';
import { marketService, Stock } from '../services/marketService';

const { Title, Text } = Typography;

interface PortfolioInfo {
  id: number;
  name: string;
  initialCapital: number;
  currentCash: number;
  totalValue: number;
  isActive: boolean;
}

interface Position {
  id: number;
  symbol: string;
  name: string;
  quantity: number;
  avgCost: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
}

interface TradeHistory {
  id: number;
  symbol: string;
  name: string;
  direction: 'BUY' | 'SELL';
  executePrice: number;
  quantity: number;
  amount: number;
  commission: number;
  realizedPnl: number | null;
  createdAt: string;
}

interface PortfolioSnapshot {
  date: string;
  totalValue: number;
  currentCash: number;
  positionValue: number;
}

const PaperTrading: React.FC = () => {
  const [portfolio, setPortfolio] = useState<PortfolioInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);

  // 交易 Modal 状态
  const [isTradeModalVisible, setIsTradeModalVisible] = useState(false);
  const [tradeForm] = Form.useForm();
  const [submittingTrade, setSubmittingTrade] = useState(false);

  // 股票搜索状态
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [fetchingStocks, setFetchingStocks] = useState(false);

  // 交易历史状态
  const [isHistoryModalVisible, setIsHistoryModalVisible] = useState(false);
  const [tradeHistory, setTradeHistory] = useState<TradeHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  // 资金曲线快照状态
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);

  const fetchPortfolio = async () => {
    setLoading(true);
    try {
      const response = await api.get('/paper-trading');
      if (response.data.success) {
        setPortfolio(response.data.data.portfolio);
        setPositions(response.data.data.positions);
      }
    } catch (error) {
      console.error('Failed to fetch paper trading data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPortfolio();
    fetchStocks(''); // 初始加载股票
    fetchSnapshots();
  }, []);

  const fetchSnapshots = async () => {
    try {
      const response = await getPaperTradingSnapshots();
      if (response.data.success) {
        setSnapshots(response.data.data);
      }
    } catch (error) {
      console.error('获取资金曲线快照失败:', error);
    }
  };

  const fetchStocks = async (query: string) => {
    setFetchingStocks(true);
    try {
      const response = await marketService.searchStocks(query, 100);
      setStocks(response.data.stocks);
    } catch (error) {
      console.error('获取股票列表失败:', error);
    } finally {
      setFetchingStocks(false);
    }
  };

  const handleSearchStock = (value: string) => {
    fetchStocks(value || '');
  };

  const showTradeModal = (symbol?: string, direction: 'BUY' | 'SELL' = 'BUY') => {
    tradeForm.resetFields();
    if (symbol) {
      tradeForm.setFieldsValue({ symbol, direction });
    } else {
      tradeForm.setFieldsValue({ direction: 'BUY' });
    }
    setIsTradeModalVisible(true);
  };

  const handleTradeSubmit = async () => {
    try {
      const values = await tradeForm.validateFields();
      setSubmittingTrade(true);
      const response = await api.post('/paper-trading/trade', values);
      if (response.data.success) {
        message.success('交易成功');
        setIsTradeModalVisible(false);
        fetchPortfolio(); // 刷新持仓
      }
    } catch (error: any) {
      message.error(error.response?.data?.message || '交易失败');
    } finally {
      setSubmittingTrade(false);
    }
  };

  const showHistoryModal = async () => {
    setIsHistoryModalVisible(true);
    setLoadingHistory(true);
    try {
      const response = await api.get('/paper-trading/history');
      if (response.data.success) {
        setTradeHistory(response.data.data);
      }
    } catch (error) {
      message.error('获取交易历史记录失败');
    } finally {
      setLoadingHistory(false);
    }
  };

  const totalReturn = portfolio
    ? ((portfolio.totalValue - portfolio.initialCapital) / portfolio.initialCapital) * 100
    : 0;
  const isPositive = totalReturn >= 0;

  const columns = [
    {
      title: '股票',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: Position) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '持有股数',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (val: number) => <Text>{val.toLocaleString()}</Text>,
    },
    {
      title: '持仓成本',
      dataIndex: 'avgCost',
      key: 'avgCost',
      render: (val: number) => (
        <Text>
          ¥ {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      ),
    },
    {
      title: '现价',
      dataIndex: 'currentPrice',
      key: 'currentPrice',
      render: (val: number) => (
        <Text>
          ¥ {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      ),
    },
    {
      title: '持仓市值',
      dataIndex: 'marketValue',
      key: 'marketValue',
      render: (val: number) => (
        <Text>
          ¥ {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </Text>
      ),
    },
    {
      title: '浮动盈亏',
      dataIndex: 'unrealizedPnl',
      key: 'unrealizedPnl',
      render: (val: number) => {
        const color = val >= 0 ? '#cf1322' : '#3f8600';
        return (
          <Text strong style={{ color }}>
            {val > 0 ? '+' : ''}
            {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: Position) => (
        <Space size="small">
          <Button type="link" onClick={() => showTradeModal(record.symbol, 'BUY')}>
            买入
          </Button>
          <Button type="link" danger onClick={() => showTradeModal(record.symbol, 'SELL')}>
            卖出
          </Button>
        </Space>
      ),
    },
  ];

  const historyColumns = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (val: string) => new Date(val).toLocaleString(),
    },
    {
      title: '股票',
      key: 'stock',
      render: (_: any, record: TradeHistory) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.name}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      render: (val: string) => (
        <Tag color={val === 'BUY' ? 'red' : 'green'}>{val === 'BUY' ? '买入' : '卖出'}</Tag>
      ),
    },
    {
      title: '成交价',
      dataIndex: 'executePrice',
      key: 'executePrice',
      render: (val: number) => `¥ ${val.toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
      render: (val: number) => val.toLocaleString(),
    },
    {
      title: '手续费',
      dataIndex: 'commission',
      key: 'commission',
      render: (val: number) => `¥ ${val.toFixed(2)}`,
    },
    {
      title: '实现盈亏',
      dataIndex: 'realizedPnl',
      key: 'realizedPnl',
      render: (val: number | null) => {
        if (val === null) return '-';
        const color = val >= 0 ? '#cf1322' : '#3f8600';
        return (
          <Text strong style={{ color }}>
            {val > 0 ? '+' : ''}
            {val.toFixed(2)}
          </Text>
        );
      },
    },
  ];

  return (
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h1 className="page-title-modern">投资组合模拟盘</h1>
          <p className="page-subtitle-modern">实时跟踪您的模拟交易与持仓盈亏</p>
        </div>
        <Space>
          <Button icon={<HistoryOutlined />} onClick={showHistoryModal}>
            交易流水
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => showTradeModal()}>
            快速交易
          </Button>
        </Space>
      </div>

      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Card className="modern-card" bordered={false} loading={loading}>
              <Statistic
                title="当前总资产"
                value={portfolio?.totalValue || 0}
                precision={2}
                prefix="¥"
                valueStyle={{ color: '#1890ff', fontWeight: 'bold' }}
              />
            </Card>
            <Card className="modern-card" bordered={false} loading={loading}>
              <Statistic
                title="可用资金"
                value={portfolio?.currentCash || 0}
                precision={2}
                prefix={<WalletOutlined />}
              />
            </Card>
            <Card className="modern-card" bordered={false} loading={loading}>
              <Statistic
                title="累计收益率"
                value={Math.abs(totalReturn)}
                precision={2}
                prefix={isPositive ? <RiseOutlined /> : <FallOutlined />}
                suffix="%"
                valueStyle={{ color: isPositive ? '#cf1322' : '#3f8600', fontWeight: 'bold' }}
              />
            </Card>
          </Space>
        </Col>

        <Col span={16}>
          <Card
            className="modern-card"
            bordered={false}
            title="资产走势"
            style={{ height: '100%' }}
          >
            <div style={{ height: 300 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={snapshots} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    tickFormatter={val => val.substring(5)} // 只显示 MM-DD
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fill: '#9ca3af', fontSize: 12 }}
                    tickFormatter={val => `¥${(val / 10000).toFixed(0)}w`}
                    domain={['auto', 'auto']}
                  />
                  <RechartsTooltip
                    formatter={(value: number) => [
                      `¥${value.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`,
                      '总资产',
                    ]}
                    labelStyle={{ color: '#6b7280' }}
                  />
                  <Area
                    type="monotone"
                    dataKey="totalValue"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorValue)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </Card>
        </Col>
      </Row>

      <Card className="modern-card" bordered={false} title="当前持仓">
        {positions.length > 0 ? (
          <Table
            columns={columns}
            dataSource={positions}
            rowKey="id"
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前模拟盘空空如也，快去 AI 每日优选看看有什么好票吧！"
          />
        )}
      </Card>

      <Modal
        title="模拟交易"
        open={isTradeModalVisible}
        onOk={handleTradeSubmit}
        onCancel={() => setIsTradeModalVisible(false)}
        confirmLoading={submittingTrade}
        destroyOnClose
      >
        <Form form={tradeForm} layout="vertical">
          <Form.Item
            label="交易方向"
            name="direction"
            rules={[{ required: true, message: '请选择交易方向' }]}
          >
            <Radio.Group>
              <Radio.Button value="BUY">买入</Radio.Button>
              <Radio.Button value="SELL">卖出</Radio.Button>
            </Radio.Group>
          </Form.Item>

          <Form.Item
            label="股票代码"
            name="symbol"
            rules={[{ required: true, message: '请选择股票' }]}
          >
            <Select
              showSearch
              placeholder="搜索并选择股票"
              optionFilterProp="children"
              onSearch={handleSearchStock}
              filterOption={false}
              notFoundContent={fetchingStocks ? <Spin size="small" /> : '未找到股票'}
            >
              {stocks.map(stock => (
                <Select.Option key={stock.symbol} value={stock.symbol}>
                  {stock.name} ({stock.symbol})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>

          <Form.Item
            label="交易数量 (股)"
            name="quantity"
            rules={[{ required: true, message: '请输入交易数量' }]}
          >
            <InputNumber
              min={100}
              step={100}
              style={{ width: '100%' }}
              placeholder="请输入交易数量，如 100"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="交易流水记录"
        open={isHistoryModalVisible}
        onCancel={() => setIsHistoryModalVisible(false)}
        footer={null}
        width={900}
      >
        <Table
          columns={historyColumns}
          dataSource={tradeHistory}
          rowKey="id"
          loading={loadingHistory}
          pagination={{ pageSize: 10 }}
          scroll={{ x: 'max-content' }}
        />
      </Modal>
    </div>
  );
};

export default PaperTrading;
