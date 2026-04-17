import React, { useEffect, useState } from 'react';
import { Tabs, Table, Button, Space, Tag, Card } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { PlusOutlined } from '@ant-design/icons';
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

  const columns: ColumnsType<BacktestResponse> = [
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
        const statusConfig: Record<
          string,
          { color: string; text: string; bg: string; border: string }
        > = {
          pending: { color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe', text: '等待中' },
          running: { color: '#f59e0b', bg: '#fffbeb', border: '#fde68a', text: '运行中' },
          completed: { color: '#10b981', bg: '#ecfdf5', border: '#a7f3d0', text: '已完成' },
          failed: { color: '#ef4444', bg: '#fef2f2', border: '#fecaca', text: '失败' },
        };
        const config = statusConfig[status] || {
          color: '#6b7280',
          bg: '#f9fafb',
          border: '#e5e7eb',
          text: status,
        };
        return (
          <Tag
            style={{ color: config.color, background: config.bg, borderColor: config.border }}
            className="modern-tag"
          >
            {config.text}
          </Tag>
        );
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
      align: 'right',
      render: (capital: number) => `¥${capital.toLocaleString()}`,
    },
    {
      title: '总收益率',
      dataIndex: 'totalReturn',
      key: 'totalReturn',
      align: 'right',
      render: (returnRate: number | undefined) => {
        if (returnRate === undefined) return '-';
        const color = returnRate >= 0 ? '#10b981' : '#ef4444';
        return <span style={{ color, fontWeight: 500 }}>{(returnRate * 100).toFixed(2)}%</span>;
      },
    },
    {
      title: '夏普比率',
      dataIndex: 'sharpeRatio',
      key: 'sharpeRatio',
      align: 'right',
      render: (sharpe: number | undefined) =>
        sharpe ? <span style={{ fontWeight: 500 }}>{sharpe.toFixed(2)}</span> : '-',
    },
    {
      title: '最大回撤',
      dataIndex: 'maxDrawdown',
      key: 'maxDrawdown',
      align: 'right',
      render: (drawdown: number | undefined) => {
        if (drawdown === undefined) return '-';
        return (
          <span style={{ color: '#ef4444', fontWeight: 500 }}>{(drawdown * 100).toFixed(2)}%</span>
        );
      },
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      align: 'right',
      render: (date: string) => (
        <span style={{ color: '#8c8c8c' }}>{new Date(date).toLocaleDateString()}</span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      align: 'center',
      render: (_: any, record: BacktestResponse) => (
        <Space size={0}>
          {record.status === 'completed' && (
            <Button type="link" size="small" onClick={() => handleViewResults(record.id)}>
              查看结果
            </Button>
          )}
          <Button type="text" danger size="small" onClick={() => handleDelete(record.id)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const renderEmptyState = () => (
    <div style={{ padding: '60px 0', textAlign: 'center' }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
        暂无回测记录
      </h3>
      <p
        style={{
          color: '#9ca3af',
          fontSize: 14,
          marginBottom: 24,
          maxWidth: 400,
          margin: '0 auto 24px',
        }}
      >
        通过回测历史数据，您可以验证量化策略的有效性并优化参数。点击下方按钮开始您的第一次回测。
      </p>
      <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateBacktest}>
        创建新回测
      </Button>
    </div>
  );

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">回测管理</h1>
          <p className="page-subtitle-modern">创建、管理和分析回测任务</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateBacktest}>
          新建回测
        </Button>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab}>
        <TabPane tab="回测列表" key="1">
          <Table
            className="modern-card"
            columns={columns}
            dataSource={backtests}
            rowKey="id"
            loading={loading}
            locale={{ emptyText: renderEmptyState() }}
            pagination={{
              pageSize: 10,
              showTotal: total => `共 ${total} 条记录`,
            }}
            scroll={{ x: 'max-content' }}
            style={{ borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}
          />
        </TabPane>

        <TabPane tab="新建回测" key="2">
          <BacktestForm onSuccess={handleBacktestCreated} />
        </TabPane>

        <TabPane tab="结果分析" key="3">
          {selectedBacktestId ? (
            <BacktestResults backtestId={selectedBacktestId} />
          ) : (
            <Card className="modern-card" bordered={false}>
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
