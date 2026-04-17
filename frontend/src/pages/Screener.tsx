import React, { useState, useEffect } from 'react';
import { Card, Typography, Table, Tag, Button, Space, message, Modal, Descriptions } from 'antd';
import { RocketOutlined, EyeOutlined, SyncOutlined } from '@ant-design/icons';
import api from '../services/api';
import { Link } from 'react-router-dom';

const { Title, Text, Paragraph } = Typography;

interface ScreenerRecord {
  id: number;
  date: string;
  symbol: string;
  name: string;
  decision: string;
  rationale: string;
  score: number;
  scores: any;
}

const Screener: React.FC = () => {
  const [data, setData] = useState<ScreenerRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const [selectedRecord, setSelectedRecord] = useState<ScreenerRecord | null>(null);

  const fetchScreenerData = async () => {
    setLoading(true);
    try {
      const response = await api.get('/ai/screener');
      if (response.data.success) {
        setData(response.data.data);
      }
    } catch (error) {
      message.error('获取 AI 每日优选数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchScreenerData();
  }, []);

  const getDecisionColor = (dec: string) => {
    if (dec.toUpperCase().includes('STRONG_BUY')) return 'magenta';
    if (dec.toUpperCase().includes('BUY')) return 'green';
    if (dec.toUpperCase().includes('SELL')) return 'red';
    return 'gold';
  };

  const columns = [
    {
      title: '股票名称',
      dataIndex: 'name',
      key: 'name',
      render: (text: string, record: ScreenerRecord) => (
        <Space direction="vertical" size={0}>
          <Text strong>{text}</Text>
          <Text type="secondary">{record.symbol}</Text>
        </Space>
      ),
    },
    {
      title: 'AI 综合评分',
      dataIndex: 'score',
      key: 'score',
      render: (score: number) => {
        const color = score >= 80 ? '#f5222d' : score >= 60 ? '#faad14' : '#52c41a';
        return (
          <Text strong style={{ color, fontSize: 18 }}>
            {score || '-'}
          </Text>
        );
      },
      sorter: (a: ScreenerRecord, b: ScreenerRecord) => a.score - b.score,
      defaultSortOrder: 'descend' as const,
    },
    {
      title: '投资建议',
      dataIndex: 'decision',
      key: 'decision',
      render: (text: string) => (
        <Tag color={getDecisionColor(text)} style={{ padding: '4px 12px', fontSize: 14 }}>
          {text}
        </Tag>
      ),
    },
    {
      title: '核心理由',
      dataIndex: 'rationale',
      key: 'rationale',
      render: (text: string) => (
        <Paragraph ellipsis={{ rows: 2, expandable: false }} style={{ margin: 0, maxWidth: 400 }}>
          {text}
        </Paragraph>
      ),
    },
    {
      title: '评估日期',
      dataIndex: 'date',
      key: 'date',
    },
    {
      title: '操作',
      key: 'action',
      render: (_: any, record: ScreenerRecord) => (
        <Space size="middle">
          <Button
            type="primary"
            ghost
            size="small"
            icon={<EyeOutlined />}
            onClick={() => {
              setSelectedRecord(record);
              setDetailVisible(true);
            }}
          >
            查看详情
          </Button>
          <Link to={`/ai-advisor?ticker=${record.symbol}`}>
            <Button size="small" type="dashed">
              深度研报
            </Button>
          </Link>
        </Space>
      ),
    },
  ];

  return (
    <div className="fade-in-up">
      <div
        className="page-header-modern"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}
      >
        <div>
          <h1 className="page-title-modern">AI 每日优选</h1>
          <p className="page-subtitle-modern">
            结合技术面海选与多智能体深度研报，每天自动生成 A 股强推榜单
          </p>
        </div>
        <Button icon={<SyncOutlined />} onClick={fetchScreenerData} loading={loading}>
          刷新榜单
        </Button>
      </div>

      <Card className="modern-card" bordered={false}>
        <Table
          columns={columns}
          dataSource={data}
          rowKey="id"
          loading={loading}
          pagination={{ pageSize: 10 }}
        />
      </Card>

      <Modal
        title={
          <Space>
            <Text strong style={{ fontSize: 18 }}>
              {selectedRecord?.name}
            </Text>
            <Text type="secondary">({selectedRecord?.symbol})</Text>
            <Tag color={getDecisionColor(selectedRecord?.decision || '')}>
              {selectedRecord?.decision}
            </Tag>
          </Space>
        }
        open={detailVisible}
        onCancel={() => setDetailVisible(false)}
        footer={[
          <Button key="close" onClick={() => setDetailVisible(false)}>
            关闭
          </Button>,
          <Link key="deep" to={`/ai-advisor?ticker=${selectedRecord?.symbol}`}>
            <Button type="primary" style={{ marginLeft: 8 }}>
              重新进行实时深度推演
            </Button>
          </Link>,
        ]}
        width={700}
      >
        <div style={{ marginTop: 24 }}>
          <Descriptions bordered column={1} size="small">
            <Descriptions.Item label="评估日期">{selectedRecord?.date}</Descriptions.Item>
            <Descriptions.Item label="综合得分">
              <Text strong style={{ color: '#f5222d', fontSize: 18 }}>
                {selectedRecord?.score}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="核心看点">
              <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {selectedRecord?.rationale}
              </Paragraph>
            </Descriptions.Item>
          </Descriptions>
        </div>
      </Modal>
    </div>
  );
};

export default Screener;
