import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Typography, Table, Space, Tag, Button, Empty } from 'antd';
import { AccountBookOutlined, WalletOutlined, RiseOutlined, FallOutlined } from '@ant-design/icons';
import api from '../services/api';

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

const PaperTrading: React.FC = () => {
  const [portfolio, setPortfolio] = useState<PortfolioInfo | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(false);

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
  }, []);

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
            {val >= 0 ? '+' : ''}
            {val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      render: () => (
        <Button size="small" type="link" disabled>
          平仓 (开发中)
        </Button>
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
          <h1 className="page-title-modern">模拟交易</h1>
          <p className="page-subtitle-modern">基于 AI 的交易建议，在这里零风险验证您的赚钱策略</p>
        </div>
      </div>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <Card className="modern-card" bordered={false} loading={loading}>
            <Statistic
              title="当前总资产"
              value={portfolio?.totalValue || 0}
              precision={2}
              prefix="¥"
              valueStyle={{ color: '#1890ff', fontWeight: 'bold' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="modern-card" bordered={false} loading={loading}>
            <Statistic
              title="可用资金"
              value={portfolio?.currentCash || 0}
              precision={2}
              prefix={<WalletOutlined />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
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
        </Col>
      </Row>

      <Card className="modern-card" bordered={false} title="当前持仓">
        {positions.length > 0 ? (
          <Table columns={columns} dataSource={positions} rowKey="id" pagination={false} />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前模拟盘空空如也，快去 AI 每日优选看看有什么好票吧！"
          />
        )}
      </Card>
    </div>
  );
};

export default PaperTrading;
