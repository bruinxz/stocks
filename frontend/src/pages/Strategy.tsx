import React, { useState, useEffect } from 'react';
import { Card, Table, Button, Space, Tag, Typography, Row, Col, Statistic, Empty } from 'antd';
import { RocketOutlined, BarChartOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { backtestService, BacktestResponse } from '../services/backtestService';
import dayjs from 'dayjs';

const { Text } = Typography;

const Strategy: React.FC = () => {
  const [backtests, setBacktests] = useState<BacktestResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const navigate = useNavigate();

  const fetchBacktests = async () => {
    setLoading(true);
    try {
      // 获取回测列表
      const response = await backtestService.getBacktestList(1, 100);
      setBacktests(response.data.backtests);

      // 获取回测统计
      const statsResponse = await backtestService.getBacktestStats();
      setStats(statsResponse.data);
    } catch (error) {
      console.error('Failed to fetch backtests:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBacktests();
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await backtestService.deleteBacktest(id);
      fetchBacktests();
    } catch (error) {
      console.error('Failed to delete backtest:', error);
    }
  };

  const getStrategyTypeName = (type: string) => {
    const map: Record<string, string> = {
      moving_average_crossover: '均线交叉',
      rsi: 'RSI指标',
      macd: 'MACD指标',
      bollinger_bands: '布林带',
    };
    return map[type] || type;
  };

  const columns = [
    {
      title: '策略名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: any) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {getStrategyTypeName(record.strategy_config?.strategyType)}
          </Text>
        </Space>
      ),
    },
    {
      title: '测试标的',
      key: 'symbols',
      render: (_: any, record: any) => {
        const symbols = record.strategy_config?.symbols || [];
        return symbols.map((s: string) => <Tag key={s}>{s}</Tag>);
      },
    },
    {
      title: '测试周期',
      key: 'period',
      render: (_: any, record: any) => (
        <Text style={{ fontSize: 12 }}>
          {dayjs(record.start_date).format('YYYY-MM-DD')} ~{' '}
          {dayjs(record.end_date).format('YYYY-MM-DD')}
        </Text>
      ),
    },
    {
      title: '总收益率',
      dataIndex: 'total_return',
      key: 'total_return',
      render: (val: number) => {
        const color = val >= 0 ? '#cf1322' : '#3f8600';
        return (
          <Text strong style={{ color }}>
            {val > 0 ? '+' : ''}
            {(val * 100).toFixed(2)}%
          </Text>
        );
      },
      sorter: (a: any, b: any) => (a.total_return || 0) - (b.total_return || 0),
    },
    {
      title: '年化收益',
      dataIndex: 'annualized_return',
      key: 'annualized_return',
      render: (val: number) => {
        const color = val >= 0 ? '#cf1322' : '#3f8600';
        return (
          <Text style={{ color }}>
            {val > 0 ? '+' : ''}
            {(val * 100).toFixed(2)}%
          </Text>
        );
      },
      sorter: (a: any, b: any) => (a.annualized_return || 0) - (b.annualized_return || 0),
    },
    {
      title: '最大回撤',
      dataIndex: 'max_drawdown',
      key: 'max_drawdown',
      render: (val: number) => <Text style={{ color: '#3f8600' }}>{(val * 100).toFixed(2)}%</Text>,
      sorter: (a: any, b: any) => (a.max_drawdown || 0) - (b.max_drawdown || 0),
    },
    {
      title: '夏普比率',
      dataIndex: 'sharpe_ratio',
      key: 'sharpe_ratio',
      render: (val: number) => <Text>{val.toFixed(2)}</Text>,
      sorter: (a: any, b: any) => (a.sharpe_ratio || 0) - (b.sharpe_ratio || 0),
    },
    {
      title: '胜率',
      dataIndex: 'win_rate',
      key: 'win_rate',
      render: (val: number) => <Text>{(val * 100).toFixed(2)}%</Text>,
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: any) => (
        <Space size="small">
          <Button type="link" onClick={() => navigate(`/backtest/${record.id}`)}>
            查看报告
          </Button>
          <Button type="link" danger onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
      >
        <div>
          <h1 className="page-title-modern">策略大厅</h1>
          <p className="page-subtitle-modern">
            管理并对比您的所有量化回测策略表现，发现最优盈利模型
          </p>
        </div>
        <Button type="primary" icon={<RocketOutlined />} onClick={() => navigate('/backtest')}>
          新建回测
        </Button>
      </div>

      <Row gutter={[24, 24]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={8}>
          <Card className="modern-card" variant="borderless" loading={loading}>
            <Statistic
              title="已运行回测总数"
              value={stats?.totalBacktests || 0}
              prefix={<BarChartOutlined style={{ color: '#1890ff' }} />}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="modern-card" variant="borderless" loading={loading}>
            <Statistic
              title="平均总收益率"
              value={stats?.avgReturn ? (stats.avgReturn * 100).toFixed(2) : 0}
              suffix="%"
              valueStyle={{ color: stats?.avgReturn >= 0 ? '#cf1322' : '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="modern-card" variant="borderless" loading={loading}>
            <Statistic
              title="成功运行"
              value={stats?.completedBacktests || 0}
              prefix={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
            />
          </Card>
        </Col>
      </Row>

      <Card className="modern-card" variant="borderless" title="策略收益排行榜">
        <Table
          columns={columns}
          dataSource={backtests}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 15 }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: <Empty description="暂无策略回测记录，点击右上角新建回测" /> }}
        />
      </Card>
    </div>
  );
};

export default Strategy;
