import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Empty, Space, Spin, Table, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { labService, OptimizationRunSummary } from '../../services/labService';

const OptimizationRunsTab: React.FC = () => {
  const [runs, setRuns] = useState<OptimizationRunSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await labService.listOptimizationRuns({ limit: 50 });
      setRuns(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  if (error)
    return (
      <Alert
        type="error"
        showIcon
        message="加载失败"
        description={error}
        action={<Button size="small" onClick={load}>重试</Button>}
      />
    );
  if (runs.length === 0) return <Empty description="暂无寻优记录" />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div style={{ textAlign: 'right' }}>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
          刷新
        </Button>
      </div>
      <Table
        size="small"
        rowKey="id"
        dataSource={runs}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 60 },
          { title: '策略', dataIndex: 'strategy_key', ellipsis: true },
          { title: '方法', dataIndex: 'optimizer_type', width: 100 },
          {
            title: '状态',
            dataIndex: 'status',
            width: 90,
            render: (v: string) => {
              const color =
                v === 'COMPLETED' ? 'green' : v === 'FAILED' ? 'red' : 'processing';
              return <Tag color={color}>{v}</Tag>;
            },
          },
          {
            title: 'DSR',
            dataIndex: 'dsr',
            width: 80,
            render: (v?: number) => (v != null ? v.toFixed(3) : '—'),
          },
          {
            title: 'PBO',
            dataIndex: 'pbo',
            width: 80,
            render: (v?: number) => (v != null ? (v * 100).toFixed(1) + '%' : '—'),
          },
          {
            title: 'Verdict',
            dataIndex: 'verdict',
            width: 90,
            render: (v?: string) => {
              if (!v) return '—';
              const color = v === 'PASS' ? 'green' : v === 'FAIL' ? 'red' : 'default';
              return <Tag color={color}>{v}</Tag>;
            },
          },
          { title: '创建时间', dataIndex: 'created_at', ellipsis: true },
        ]}
      />
    </Space>
  );
};

export default OptimizationRunsTab;
