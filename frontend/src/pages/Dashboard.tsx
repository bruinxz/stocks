import React, { useEffect, useState } from 'react';
import { Card, Row, Col, Table, Button, Tag, Space, Skeleton } from 'antd';
import { PlusOutlined, EyeOutlined, RocketOutlined } from '@ant-design/icons';
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
      render: (text: string) => <span style={{ fontWeight: 500 }}>{text}</span>,
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
        if (returnRate === undefined) return <span style={{ color: '#bfbfbf' }}>--</span>;
        const color = returnRate >= 0 ? '#52c41a' : '#ff4d4f';
        return <span style={{ color, fontWeight: 600 }}>{(returnRate * 100).toFixed(2)}%</span>;
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
    <div className="fade-in-up">
      {/* 页面标题与快速操作区 */}
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <h1 className="page-title-modern">仪表盘</h1>
          <p className="page-subtitle-modern">欢迎回来，以下是您的系统概览</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/backtest')}>
            新建回测
          </Button>
          <Button icon={<RocketOutlined />} onClick={() => navigate('/portfolio')}>
            组合模拟
          </Button>
        </div>
      </div>

      {/* 核心 KPI 区 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card" bordered={false}>
            <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
              <div className="metric-title">总回测次数</div>
              <div className="metric-value">{stats.totalBacktests}</div>
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card" bordered={false}>
            <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
              <div className="metric-title">平均收益率</div>
              <div
                className="metric-value"
                style={{ color: stats.avgReturn >= 0 ? '#16a34a' : '#dc2626' }}
              >
                {stats.avgReturn >= 0 ? '+' : ''}
                {stats.avgReturn.toFixed(2)}%
              </div>
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card" bordered={false}>
            <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
              <div className="metric-title">平均夏普比率</div>
              <div className="metric-value">{stats.avgSharpeRatio.toFixed(2)}</div>
            </Skeleton>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card className="modern-card" bordered={false}>
            <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
              <div className="metric-title">胜率</div>
              <div className="metric-value">{stats.winRate.toFixed(1)}%</div>
            </Skeleton>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={16}>
          <Card
            className="modern-card"
            bordered={false}
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>最近回测</span>}
            extra={
              <Button type="link" size="small" onClick={() => navigate('/backtest')}>
                查看全部
              </Button>
            }
            bodyStyle={{ padding: '0 24px 24px 24px' }}
          >
            <Table
              columns={columns}
              dataSource={recentBacktests}
              rowKey="id"
              loading={loading}
              pagination={false}
              size="middle"
            />
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            className="modern-card"
            bordered={false}
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>系统状态</span>}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>数据同步</span>
                <Tag color="success">正常</Tag>
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>交易接口</span>
                <Tag color="success">已连接</Tag>
              </div>
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <span style={{ color: 'var(--text-secondary)' }}>AI 服务</span>
                <Tag color="processing">运行中</Tag>
              </div>
            </div>
            <Button block style={{ marginTop: 24 }} onClick={() => navigate('/data-update')}>
              查看详情
            </Button>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
