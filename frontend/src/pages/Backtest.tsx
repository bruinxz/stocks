import React, { useEffect, useState } from 'react';
import { Tabs, Table, Button, Space, Tag, Progress, Card, Row, Col, Statistic } from 'antd';
import { PlusOutlined, EyeOutlined, DeleteOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { backtestService, BacktestResponse } from '../services/backtestService';
import BacktestForm from '../components/backtest/BacktestForm';
import BacktestResults from '../components/backtest/BacktestResults';

const { TabPane } = Tabs;

const Backtest: React.FC = () => {
  const [backtests, setBacktests] = useState<BacktestResponse[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedBacktestId, setSelectedBacktestId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('1');

  useEffect(() => {
    loadBacktests();
  }, []);

  const loadBacktests = async () => {
    setLoading(true);
    try {
      const response = await backtestService.getBacktests(1, 10);
      setBacktests(response.data);
    } catch (error) {
      console.error('加载回测列表失败:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm('确定要删除这个回测吗？')) {
      await backtestService.deleteBacktest(id);
      loadBacktests();
    }
  };

  const handleViewResults = (id: string) => {
    setSelectedBacktestId(id);
    setActiveTab('3');
  };

  const handleCreateBacktest = () => {
    setActiveTab('2');
  };

  const handleBacktestCreated = () => {
    setActiveTab('1');
    loadBacktests();
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
      title: '股票代码',
      dataIndex: 'symbol',
      key: 'symbol',
    },
    {
      title: '策略类型',
      dataIndex: 'strategyType',
      key: 'strategyType',
      render: (type: string) => {
        const strategyNames: Record<string, string> = {
          moving_average_crossover: '均线交叉',
          rsi: 'RSI',
          macd: 'MACD',
          bollinger_bands: '布林带',
        };
        return strategyNames[type] || type;
      },
    },
    {
      title: '初始资金',
      dataIndex: 'initialCapital',
      key: 'initialCapital',
      render: (capital: number) => `¥${capital.toLocaleString()}`,
    },
    {
      title: '总收益率',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      render: (returnRate: number | undefined) => {
        if (returnRate === undefined) return '-';
        const color = returnRate >= 0 ? 'green' : 'red';
        return <span style={{ color, fontWeight: 'bold' }}>{(returnRate * 100).toFixed(2)}%</span>;
      },
    },
    {
      title: '夏普比率',
      dataIndex: 'sharpeRatio',
      key: 'sharpeRatio',
      render: (sharpe: number | undefined) => (sharpe ? sharpe.toFixed(2) : '-'),
    },
    {
      title: '最大回撤',
      dataIndex: 'maxDrawdown',
      key: 'maxDrawdown',
      render: (drawdown: number | undefined) => {
        if (drawdown === undefined) return '-';
        return <span style={{ color: 'red' }}>{(drawdown * 100).toFixed(2)}%</span>;
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (date: string) => new Date(date).toLocaleDateString(),
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: BacktestResponse) => (
        <Space size="small">
          {record.status === 'completed' && (
            <Button type="link" icon={<EyeOutlined />} onClick={() => handleViewResults(record.id)}>
              查看结果
            </Button>
          )}
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <h2>回测管理</h2>

      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <TabPane tab="回测列表" key="1">
          <Card
            title="回测列表"
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateBacktest}>
                新建回测
              </Button>
            }
          >
            <Table
              columns={columns}
              dataSource={backtests}
              rowKey="id"
              loading={loading}
              pagination={{
                pageSize: 10,
                showTotal: total => `共 ${total} 条记录`,
              }}
            />
          </Card>
        </TabPane>

        <TabPane tab="新建回测" key="2">
          <BacktestForm onSuccess={handleBacktestCreated} />
        </TabPane>

        <TabPane tab="结果分析" key="3">
          {selectedBacktestId ? (
            <BacktestResults backtestId={selectedBacktestId} />
          ) : (
            <Card>
              <p>请从回测列表中选择一个回测来查看结果</p>
              <Button type="primary" onClick={() => setActiveTab('1')}>
                返回回测列表
              </Button>
            </Card>
          )}
        </TabPane>
      </Tabs>
    </div>
  );
};

export default Backtest;
