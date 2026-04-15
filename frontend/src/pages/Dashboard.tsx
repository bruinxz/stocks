import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Statistic, Table, Button, Tag, Space } from 'antd';
import { ArrowUpOutlined, ArrowDownOutlined, PlusOutlined, EyeOutlined } from '@ant-design/icons';
import { backtestService, BacktestResponse } from '../services/backtestService';
import { useNavigate } from 'react-router-dom';

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState({
    totalBacktests: 0,
    avgReturn: 0,
    avgSharpeRatio: 0,
    winRate: 0,
  });
  const [recentBacktests, setRecentBacktests] = useState<BacktestResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    loadDashboardData();
  }, []);

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      const response = await backtestService.getBacktests(1, 10);
      const backtests = response.data;

      // 计算统计数据
      const completedBacktests = backtests.filter(
        b => b.status === 'completed' && b.totalReturn !== undefined
      );
      const totalCompleted = completedBacktests.length;

      let avgReturn = 0;
      let avgSharpeRatio = 0;
      let winRate = 0;

      if (totalCompleted > 0) {
        const totalReturnSum = completedBacktests.reduce((sum, b) => sum + (b.totalReturn || 0), 0);
        const sharpeSum = completedBacktests.reduce((sum, b) => sum + (b.sharpeRatio || 0), 0);
        const winningTrades = completedBacktests.filter(b => (b.totalReturn || 0) > 0).length;

        avgReturn = (totalReturnSum / totalCompleted) * 100;
        avgSharpeRatio = sharpeSum / totalCompleted;
        winRate = (winningTrades / totalCompleted) * 100;
      }

      setStats({
        totalBacktests: response.total,
        avgReturn,
        avgSharpeRatio,
        winRate,
      });

      // 最近回测（按创建时间排序，取前5个）
      const sorted = [...backtests]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5);
      setRecentBacktests(sorted);
    } catch (error) {
      console.error('加载仪表板数据失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (status: BacktestResponse['status']) => {
        const statusConfig: Record<string, { color: string; text: string }> = {
          pending: { color: 'blue', text: '等待中' },
          running: { color: 'orange', text: '运行中' },
          completed: { color: 'green', text: '已完成' },
          failed: { color: 'red', text: '失败' },
        };
        const config = statusConfig[status] || { color: 'default', text: status };
        return <Tag color={config.color}>{config.text}</Tag>;
      },
    },
    {
      title: '收益率',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      render: (returnRate: number | undefined) => {
        if (returnRate === undefined) return '-';
        const color = returnRate >= 0 ? 'green' : 'red';
        return <span style={{ color, fontWeight: 'bold' }}>{(returnRate * 100).toFixed(2)}%</span>;
      },
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: BacktestResponse) => (
        <Space size="small">
          {record.status === 'completed' && (
            <Button
              type="link"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => navigate(`/backtest/${record.id}`)}
            >
              查看
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <h2>仪表板</h2>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic
              title="总回测次数"
              value={stats.totalBacktests}
              valueStyle={{ color: '#3f8600' }}
              prefix={<ArrowUpOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="平均收益率"
              value={stats.avgReturn}
              precision={2}
              suffix="%"
              valueStyle={{ color: stats.avgReturn >= 0 ? '#3f8600' : '#cf1322' }}
              prefix={stats.avgReturn >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="平均夏普比率"
              value={stats.avgSharpeRatio}
              precision={2}
              valueStyle={{ color: stats.avgSharpeRatio >= 1 ? '#3f8600' : '#cf1322' }}
              prefix={stats.avgSharpeRatio >= 1 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}
            />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic
              title="胜率"
              value={stats.winRate}
              precision={1}
              suffix="%"
              valueStyle={{ color: '#3f8600' }}
              prefix={<ArrowUpOutlined />}
            />
          </Card>
        </Col>
      </Row>
      <Row gutter={16} style={{ marginTop: '20px' }}>
        <Col span={12}>
          <Card
            title="最近回测"
            extra={
              <Button type="link" onClick={() => navigate('/backtest')}>
                查看全部
              </Button>
            }
          >
            <Table
              columns={columns}
              dataSource={recentBacktests}
              rowKey="id"
              loading={loading}
              pagination={false}
              size="small"
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card title="快速操作">
            <Space direction="vertical" style={{ width: '100%' }}>
              <Button
                type="primary"
                block
                icon={<PlusOutlined />}
                onClick={() => navigate('/backtest')}
              >
                新建回测
              </Button>
              <Button block onClick={() => navigate('/strategy')}>
                策略管理
              </Button>
              <Button block onClick={() => navigate('/backtest')}>
                查看历史回测
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
