import React from 'react';
import { Table, Button, Space } from 'antd';
import { EditOutlined, DeleteOutlined } from '@ant-design/icons';

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

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h2>策略管理</h2>
        <Button type="primary">新建策略</Button>
      </div>
      <Table columns={columns} dataSource={data} />
    </div>
  );
};

export default Strategy;
