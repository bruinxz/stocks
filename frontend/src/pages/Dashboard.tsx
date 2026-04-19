import React, { useEffect, useState } from 'react';
import {
  Card,
  Row,
  Col,
  Table,
  Button,
  Tag,
  Space,
  Skeleton,
  Typography,
  Progress,
  Empty,
} from 'antd';
import {
  PlusOutlined,
  EyeOutlined,
  RocketOutlined,
  FallOutlined,
  RiseOutlined,
} from '@ant-design/icons';
import { AreaChart, Area, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { backtestService, BacktestResponse } from '../services/backtestService';
import { getMarketOverview } from '../services/api';
import { useNavigate } from 'react-router-dom';

const { Text } = Typography;

const Dashboard: React.FC = () => {
  const [stats, setStats] = useState({
    totalBacktests: 0,
    avgReturn: 0,
    avgSharpeRatio: 0,
    winRate: 0,
  });
  const [recentBacktests, setRecentBacktests] = useState<BacktestResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [marketOverview, setMarketOverview] = useState<any>(null);
  const navigate = useNavigate();

  useEffect(() => {
    loadDashboardData();
    loadMarketOverview();
  }, []);

  const loadMarketOverview = async () => {
    try {
      const response = await getMarketOverview();
      if (response.data.success) {
        setMarketOverview(response.data.data);
      }
    } catch (error) {
      console.error('加载大盘概览失败:', error);
    }
  };

  const loadDashboardData = async () => {
    setLoading(true);
    try {
      const response = await backtestService.getBacktestList(1, 10);
      const backtests = response.data.backtests || [];

      // 计算统计数据
      const completedBacktests = backtests.filter(
        (b: any) => b.status === 'completed' && b.totalReturn !== undefined
      );
      const totalCompleted = completedBacktests.length;

      let avgReturn = 0;
      let avgSharpeRatio = 0;
      let winRate = 0;

      if (totalCompleted > 0) {
        const totalReturnSum = completedBacktests.reduce(
          (sum: number, b: any) => sum + (b.totalReturn || 0),
          0
        );
        const sharpeSum = completedBacktests.reduce(
          (sum: number, b: any) => sum + (b.sharpeRatio || 0),
          0
        );
        const winningTrades = completedBacktests.filter(
          (b: any) => (b.totalReturn || 0) > 0
        ).length;

        avgReturn = (totalReturnSum / totalCompleted) * 100;
        avgSharpeRatio = sharpeSum / totalCompleted;
        winRate = (winningTrades / totalCompleted) * 100;
      }

      setStats({
        totalBacktests: response.data.pagination?.total || backtests.length,
        avgReturn,
        avgSharpeRatio,
        winRate,
      });

      // 最近回测（按创建时间排序，取前5个）
      const sorted = [...backtests]
        .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
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

      {/* 第一行：大盘概览 (走势图) */}
      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Card
            className="modern-card"
            bordered={false}
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>大盘核心指数 (近30天)</span>}
          >
            <Row gutter={[16, 16]}>
              {marketOverview?.indices?.map((index: any) => {
                const isUp = index.change >= 0;
                const color = isUp ? '#cf1322' : '#3f8600';

                return (
                  <Col xs={24} sm={12} lg={6} key={index.symbol}>
                    <Card
                      size="small"
                      bordered={false}
                      style={{ background: '#f8fafc', borderRadius: 8 }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 8,
                        }}
                      >
                        <Text strong>{index.name}</Text>
                        <Text style={{ color, fontWeight: 600 }}>
                          {isUp ? '+' : ''}
                          {index.changePercent.toFixed(2)}%
                        </Text>
                      </div>
                      <div
                        style={{
                          fontSize: 20,
                          fontWeight: 'bold',
                          marginBottom: 16,
                          color: 'var(--text-main)',
                        }}
                      >
                        {Number(index.currentPrice).toFixed(2)}
                      </div>
                      <div style={{ height: 60, width: '100%' }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={index.trend}>
                            <defs>
                              <linearGradient
                                id={`color-${index.symbol}`}
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                                <stop offset="95%" stopColor={color} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <Area
                              type="monotone"
                              dataKey="close"
                              stroke={color}
                              strokeWidth={2}
                              fill={`url(#color-${index.symbol})`}
                              isAnimationActive={false}
                            />
                            <YAxis domain={['auto', 'auto']} hide />
                            <XAxis dataKey="time" hide />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </Card>
                  </Col>
                );
              })}
            </Row>
          </Card>
        </Col>
      </Row>

      {/* 第二行：核心 KPI 与市场情绪 */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={18}>
          <Card
            className="modern-card"
            bordered={false}
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>回测数据概览</span>}
            style={{ height: '100%' }}
          >
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6}>
                <Card
                  bordered={false}
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      总回测次数
                    </div>
                    <div className="metric-value" style={{ fontSize: 24 }}>
                      {stats.totalBacktests}
                    </div>
                  </Skeleton>
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card
                  bordered={false}
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      平均收益率
                    </div>
                    <div
                      className="metric-value"
                      style={{ color: stats.avgReturn >= 0 ? '#16a34a' : '#dc2626', fontSize: 24 }}
                    >
                      {stats.avgReturn >= 0 ? '+' : ''}
                      {stats.avgReturn.toFixed(2)}%
                    </div>
                  </Skeleton>
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card
                  bordered={false}
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      平均夏普比率
                    </div>
                    <div className="metric-value" style={{ fontSize: 24 }}>
                      {stats.avgSharpeRatio.toFixed(2)}
                    </div>
                  </Skeleton>
                </Card>
              </Col>
              <Col xs={12} sm={6}>
                <Card
                  bordered={false}
                  bodyStyle={{ padding: '16px 20px', background: '#f8fafc', borderRadius: 8 }}
                >
                  <Skeleton loading={loading} active paragraph={{ rows: 1 }} title={false}>
                    <div className="metric-title" style={{ fontSize: 13 }}>
                      胜率
                    </div>
                    <div className="metric-value" style={{ fontSize: 24 }}>
                      {stats.winRate.toFixed(1)}%
                    </div>
                  </Skeleton>
                </Card>
              </Col>
            </Row>
          </Card>
        </Col>

        {/* 市场情绪面板 */}
        <Col xs={24} lg={6}>
          <Card
            className="modern-card"
            bordered={false}
            title={<span style={{ fontSize: 16, fontWeight: 600 }}>市场情绪雷达</span>}
            style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
            bodyStyle={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
            }}
          >
            {marketOverview?.sentiment ? (
              <div style={{ textAlign: 'center', margin: 'auto 0' }}>
                <Progress
                  type="dashboard"
                  percent={marketOverview.sentiment.score}
                  strokeColor={{
                    '0%': '#3f8600', // 极度恐惧
                    '50%': '#faad14', // 中性
                    '100%': '#cf1322', // 极度贪婪
                  }}
                  format={percent => (
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 32, fontWeight: 'bold' }}>{percent}</span>
                    </div>
                  )}
                  size={140}
                />
                <div style={{ marginTop: 16, fontSize: 16, fontWeight: 'bold' }}>
                  当前状态：
                  <Text
                    style={{
                      color:
                        marketOverview.sentiment.score > 70
                          ? '#cf1322'
                          : marketOverview.sentiment.score < 30
                          ? '#3f8600'
                          : '#faad14',
                      marginLeft: 8,
                    }}
                  >
                    {marketOverview.sentiment.label}
                  </Text>
                </div>
              </div>
            ) : loading ? (
              <Skeleton active />
            ) : (
              <Empty description="暂无情绪数据" />
            )}
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
              locale={{ emptyText: <Empty description="暂无最近回测记录" /> }}
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
              查看系统详情
            </Button>
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default Dashboard;
