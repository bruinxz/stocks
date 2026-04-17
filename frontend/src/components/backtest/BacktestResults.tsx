import React, { useEffect, useState } from 'react';
import { Card, Table, Tabs, Tag, Descriptions, Button } from 'antd';
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
import {
  ArrowUpOutlined,
  ArrowDownOutlined,
  DollarOutlined,
  RiseOutlined,
  FallOutlined,
  ArrowLeftOutlined,
} from '@ant-design/icons';
import { backtestService } from '../../services/backtestService';

const { TabPane } = Tabs;

interface BacktestResultsProps {
  backtestId: string;
  onBack?: () => void;
}

interface MetricData {
  name: string;
  value: number;
  formattedValue: string;
  icon: React.ReactNode;
  color: string;
  cardClass: string;
  iconClass: string;
}

const BacktestResults: React.FC<BacktestResultsProps> = ({ backtestId, onBack }) => {
  const [results, setResults] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [backtestInfo, setBacktestInfo] = useState<any>(null);

  useEffect(() => {
    loadResults();
    loadBacktestInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backtestId]); // eslint-disable-next-line react-hooks/exhaustive-deps

  const loadResults = async () => {
    setLoading(true);
    try {
      const data = await backtestService.getBacktestResults(backtestId);
      setResults(data.data);
    } catch (error) {
      console.error('加载回测结果失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadBacktestInfo = async () => {
    try {
      const info = await backtestService.getBacktestById(backtestId);
      setBacktestInfo(info);
    } catch (error) {
      console.error('加载回测信息失败:', error);
    }
  };

  if (loading) {
    return <Card className="modern-card" bordered={false} loading={true}></Card>;
  }

  if (!results) {
    return (
      <Card className="modern-card" bordered={false}>
        无法加载回测结果
      </Card>
    );
  }

  const { metrics, equityCurve, trades, dailyReturns } = results;

  // 格式化指标数据
  const metricCards: MetricData[] = [
    {
      name: '总收益率',
      value: metrics.totalReturn,
      formattedValue: `${(metrics.totalReturn * 100).toFixed(2)}%`,
      icon: metrics.totalReturn >= 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />,
      color: metrics.totalReturn >= 0 ? '#3f8600' : '#cf1322',
      cardClass: metrics.totalReturn >= 0 ? 'stat-card stat-card-green' : 'stat-card stat-card-red',
      iconClass: metrics.totalReturn >= 0 ? 'icon-green' : 'icon-red',
    },
    {
      name: '年化收益率',
      value: metrics.annualizedReturn,
      formattedValue: `${(metrics.annualizedReturn * 100).toFixed(2)}%`,
      icon: <RiseOutlined />,
      color: metrics.annualizedReturn >= 0 ? '#3f8600' : '#cf1322',
      cardClass: 'stat-card stat-card-blue',
      iconClass: metrics.annualizedReturn >= 0 ? 'icon-green' : 'icon-red',
    },
    {
      name: '夏普比率',
      value: metrics.sharpeRatio,
      formattedValue: metrics.sharpeRatio.toFixed(2),
      icon: <DollarOutlined />,
      color:
        metrics.sharpeRatio >= 1 ? '#3f8600' : metrics.sharpeRatio >= 0.5 ? '#faad14' : '#cf1322',
      cardClass:
        metrics.sharpeRatio >= 1 ? 'stat-card stat-card-purple' : 'stat-card stat-card-orange',
      iconClass:
        metrics.sharpeRatio >= 1
          ? 'icon-green'
          : metrics.sharpeRatio >= 0.5
          ? 'icon-orange'
          : 'icon-red',
    },
    {
      name: '最大回撤',
      value: metrics.maxDrawdown,
      formattedValue: `${(metrics.maxDrawdown * 100).toFixed(2)}%`,
      icon: <FallOutlined />,
      color: '#cf1322',
      cardClass: 'stat-card stat-card-red',
      iconClass: 'icon-red',
    },
    {
      name: '胜率',
      value: metrics.winRate,
      formattedValue: `${(metrics.winRate * 100).toFixed(1)}%`,
      icon: <ArrowUpOutlined />,
      color: metrics.winRate >= 0.6 ? '#3f8600' : metrics.winRate >= 0.5 ? '#faad14' : '#cf1322',
      cardClass: metrics.winRate >= 0.6 ? 'stat-card stat-card-cyan' : 'stat-card stat-card-orange',
      iconClass:
        metrics.winRate >= 0.6 ? 'icon-green' : metrics.winRate >= 0.5 ? 'icon-orange' : 'icon-red',
    },
    {
      name: '盈亏比',
      value: metrics.profitLossRatio,
      formattedValue: metrics.profitLossRatio.toFixed(2),
      icon: <DollarOutlined />,
      color:
        metrics.profitLossRatio >= 1.5
          ? '#3f8600'
          : metrics.profitLossRatio >= 1
          ? '#faad14'
          : '#cf1322',
      cardClass:
        metrics.profitLossRatio >= 1.5 ? 'stat-card stat-card-green' : 'stat-card stat-card-orange',
      iconClass:
        metrics.profitLossRatio >= 1.5
          ? 'icon-green'
          : metrics.profitLossRatio >= 1
          ? 'icon-orange'
          : 'icon-red',
    },
  ];

  // 交易表格列定义
  const tradeColumns = [
    {
      title: '交易ID',
      dataIndex: 'id',
      key: 'id',
    },
    {
      title: '方向',
      dataIndex: 'direction',
      key: 'direction',
      render: (direction: string) => (
        <Tag color={direction === 'buy' ? 'green' : 'red'}>
          {direction === 'buy' ? '买入' : '卖出'}
        </Tag>
      ),
    },
    {
      title: '入场价格',
      dataIndex: 'entryPrice',
      key: 'entryPrice',
      render: (price: number) => `¥${price.toFixed(2)}`,
    },
    {
      title: '出场价格',
      dataIndex: 'exitPrice',
      key: 'exitPrice',
      render: (price: number) => `¥${price.toFixed(2)}`,
    },
    {
      title: '数量',
      dataIndex: 'quantity',
      key: 'quantity',
    },
    {
      title: '盈亏',
      dataIndex: 'profit',
      key: 'profit',
      render: (profit: number) => (
        <span style={{ color: profit >= 0 ? '#3f8600' : '#cf1322', fontWeight: 'bold' }}>
          ¥{profit.toFixed(2)}
        </span>
      ),
    },
    {
      title: '入场日期',
      dataIndex: 'entryDate',
      key: 'entryDate',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: '出场日期',
      dataIndex: 'exitDate',
      key: 'exitDate',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
  ];

  // 准备图表数据
  const equityData = equityCurve.map((point: any, index: number) => ({
    date: new Date(point.date).toLocaleDateString(),
    value: Math.round(point.value),
    day: index + 1,
  }));

  const returnsData = dailyReturns.map((ret: number, index: number) => ({
    day: index + 1,
    return: ret * 100,
  }));

  return (
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          background: 'var(--bg-base)',
          paddingBottom: 16,
          paddingTop: 16,
          marginBottom: 24,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {onBack && (
            <Button
              type="text"
              icon={<ArrowLeftOutlined />}
              onClick={onBack}
              style={{ padding: 0 }}
            />
          )}
          <div>
            <h1 className="page-title-modern" style={{ margin: 0 }}>
              回测结果
            </h1>
            <p className="page-subtitle-modern" style={{ margin: 0 }}>
              {backtestInfo
                ? `${backtestInfo.name} (${backtestInfo.symbol})`
                : '查看详细指标与收益曲线'}
            </p>
          </div>
        </div>
      </div>
      {/* 关键指标卡片 */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          marginBottom: 24,
        }}
      >
        {metricCards.map((metric, index) => (
          <div
            key={index}
            style={{
              padding: '16px',
              background: 'var(--bg-card)',
              borderRadius: 'var(--border-radius-lg)',
              border: '1px solid var(--border-color)',
            }}
          >
            <div
              style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 }}
            >
              {metric.name}
            </div>
            <div
              style={{
                fontSize: 24,
                fontWeight: 700,
                color: metric.color || 'var(--text-main)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {metric.formattedValue}
            </div>
          </div>
        ))}
      </div>

      <Tabs defaultActiveKey="1">
        <TabPane tab="资金曲线" key="1">
          <Card className="modern-card chart-card" bordered={false}>
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={equityData}>
                <CartesianGrid vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={value => `¥${value.toLocaleString()}`}
                  tick={{ fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={value => [`¥${Number(value).toLocaleString()}`, '资金']}
                  labelFormatter={label => `日期: ${label}`}
                />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#1890ff"
                  strokeWidth={2}
                  dot={false}
                  name="资金曲线"
                />
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </TabPane>

        <TabPane tab="交易记录" key="2">
          <Card className="modern-card" bordered={false}>
            <Table
              columns={tradeColumns}
              dataSource={trades}
              rowKey="id"
              pagination={{ pageSize: 10 }}
              summary={() => (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0} colSpan={5}>
                      <strong>总计</strong>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={5}>
                      <strong style={{ color: metrics.totalReturn >= 0 ? '#3f8600' : '#cf1322' }}>
                        ¥
                        {trades
                          .reduce((sum: number, trade: any) => sum + trade.profit, 0)
                          .toFixed(2)}
                      </strong>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={6} colSpan={2}>
                      <strong>总交易数: {metrics.totalTrades}</strong>
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                </Table.Summary>
              )}
            />
          </Card>
        </TabPane>

        <TabPane tab="每日收益" key="3">
          <Card className="modern-card chart-card" bordered={false}>
            <ResponsiveContainer width="100%" height={400}>
              <BarChart data={returnsData}>
                <CartesianGrid vertical={false} stroke="#f0f0f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis
                  tickFormatter={value => `${value.toFixed(2)}%`}
                  tick={{ fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip formatter={value => [`${Number(value).toFixed(2)}%`, '日收益率']} />
                <Legend />
                <Bar dataKey="return" fill="#52c41a" name="日收益率" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </TabPane>

        <TabPane tab="详细指标" key="4">
          <Card className="modern-card" bordered={false}>
            <Descriptions title="回测详细指标" bordered column={2}>
              <Descriptions.Item label="初始资金">
                ¥{metrics.initialCapital.toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="最终资金">
                ¥{metrics.finalCapital.toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="总收益率">
                {(metrics.totalReturn * 100).toFixed(2)}%
              </Descriptions.Item>
              <Descriptions.Item label="年化收益率">
                {(metrics.annualizedReturn * 100).toFixed(2)}%
              </Descriptions.Item>
              <Descriptions.Item label="夏普比率">
                {metrics.sharpeRatio.toFixed(2)}
              </Descriptions.Item>
              <Descriptions.Item label="索提诺比率">
                {metrics.sortinoRatio.toFixed(2)}
              </Descriptions.Item>
              <Descriptions.Item label="最大回撤">
                {(metrics.maxDrawdown * 100).toFixed(2)}%
              </Descriptions.Item>
              <Descriptions.Item label="胜率">
                {(metrics.winRate * 100).toFixed(1)}%
              </Descriptions.Item>
              <Descriptions.Item label="盈亏比">
                {metrics.profitLossRatio.toFixed(2)}
              </Descriptions.Item>
              <Descriptions.Item label="总交易数">{metrics.totalTrades}</Descriptions.Item>
              <Descriptions.Item label="盈利交易数">{metrics.profitTrades}</Descriptions.Item>
              <Descriptions.Item label="亏损交易数">{metrics.lossTrades}</Descriptions.Item>
              <Descriptions.Item label="平均持仓天数">
                {metrics.averageHoldingDays.toFixed(1)}天
              </Descriptions.Item>
              <Descriptions.Item label="平均盈利">
                ¥{metrics.averageProfit.toFixed(2)}
              </Descriptions.Item>
              <Descriptions.Item label="平均亏损">
                ¥{metrics.averageLoss.toFixed(2)}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </TabPane>

        <TabPane tab="回测参数" key="5">
          {backtestInfo && (
            <Card className="modern-card" bordered={false}>
              <Descriptions title="回测基本信息" bordered>
                <Descriptions.Item label="回测名称">{backtestInfo.name}</Descriptions.Item>
                <Descriptions.Item label="股票代码">{backtestInfo.symbol}</Descriptions.Item>
                <Descriptions.Item label="策略类型">
                  {backtestInfo.strategyType === 'moving_average_crossover'
                    ? '均线交叉'
                    : backtestInfo.strategyType === 'rsi'
                    ? 'RSI策略'
                    : backtestInfo.strategyType === 'macd'
                    ? 'MACD策略'
                    : backtestInfo.strategyType === 'bollinger_bands'
                    ? '布林带策略'
                    : backtestInfo.strategyType}
                </Descriptions.Item>
                <Descriptions.Item label="初始资金">
                  ¥{backtestInfo.initialCapital.toLocaleString()}
                </Descriptions.Item>
                <Descriptions.Item label="开始日期">{backtestInfo.startDate}</Descriptions.Item>
                <Descriptions.Item label="结束日期">{backtestInfo.endDate}</Descriptions.Item>
              </Descriptions>
            </Card>
          )}
        </TabPane>
      </Tabs>
    </div>
  );
};

export default BacktestResults;
