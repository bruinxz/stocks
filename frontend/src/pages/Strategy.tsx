import React from 'react';
import { Table, Button, Space, Tag } from 'antd';
import { EditOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons';

const Strategy: React.FC = () => {
  const columns = [
    {
      title: '策略名称',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: '策略类型',
      dataIndex: 'type',
      key: 'type',
      render: (text: string) => <Tag color="blue">{text}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
    },
    {
      title: '操作',
      key: 'action',
      render: () => (
        <Space size="small">
          <Button icon={<EditOutlined />} size="small">
            编辑
          </Button>
          <Button icon={<DeleteOutlined />} size="small" danger>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const data = [
    {
      key: '1',
      name: '移动平均线交叉策略',
      type: '技术指标',
      createdAt: '2023-06-01',
    },
    {
      key: '2',
      name: 'RSI超买超卖策略',
      type: '技术指标',
      createdAt: '2023-06-02',
    },
    {
      key: '3',
      name: '布林带突破策略',
      type: '技术指标',
      createdAt: '2023-06-03',
    },
  ];

  const renderEmptyState = () => (
    <div style={{ padding: '60px 0', textAlign: 'center' }}>
      <h3 style={{ fontSize: 16, fontWeight: 600, color: '#374151', marginBottom: 8 }}>暂无策略</h3>
      <p
        style={{
          color: '#9ca3af',
          fontSize: 14,
          marginBottom: 24,
          maxWidth: 400,
          margin: '0 auto 24px',
        }}
      >
        策略是回测系统的核心。您可以基于均线、RSI、MACD等指标创建您的交易策略。
      </p>
      <Button type="primary" icon={<PlusOutlined />}>
        创建策略
      </Button>
    </div>
  );

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">策略中心</h1>
          <p className="page-subtitle-modern">管理和配置您的量化交易策略</p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} style={{ borderRadius: 6 }}>
          新建策略
        </Button>
      </div>

      <Table
        className="modern-card"
        columns={columns}
        dataSource={data}
        rowKey="id"
        locale={{ emptyText: renderEmptyState() }}
        scroll={{ x: 'max-content' }}
        style={{ borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}
      />
    </div>
  );
};

export default Strategy;
