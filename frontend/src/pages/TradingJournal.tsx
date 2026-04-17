import React, { useState, useEffect } from 'react';
import { Card, Typography, List, Space, Tag, Empty, Divider, Skeleton } from 'antd';
import { BookOutlined, CalendarOutlined, LineChartOutlined, BulbOutlined } from '@ant-design/icons';
import api from '../services/api';

const { Title, Text, Paragraph } = Typography;

interface Journal {
  id: number;
  date: string;
  marketSummary: string;
  portfolioAnalysis: string;
  actionPlan: string;
  createdAt: string;
}

const TradingJournal: React.FC = () => {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchJournals = async () => {
    setLoading(true);
    try {
      const response = await api.get('/journals');
      if (response.data.success) {
        setJournals(response.data.data);
      }
    } catch (error) {
      console.error('Failed to fetch trading journals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJournals();
  }, []);

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">交易日记</h1>
          <p className="page-subtitle-modern">
            每日收盘后，由大模型为您量身定制的专属大盘分析与持仓表现复盘
          </p>
        </div>
      </div>

      <Card className="modern-card" bordered={false}>
        {loading ? (
          <Skeleton active paragraph={{ rows: 6 }} />
        ) : journals.length > 0 ? (
          <List
            itemLayout="vertical"
            size="large"
            dataSource={journals}
            renderItem={item => (
              <List.Item
                key={item.id}
                style={{
                  padding: '24px',
                  background: '#f8fafc',
                  borderRadius: '12px',
                  marginBottom: '24px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px' }}>
                  <CalendarOutlined
                    style={{ fontSize: '20px', color: '#4f46e5', marginRight: '8px' }}
                  />
                  <Title level={4} style={{ margin: 0 }}>
                    {item.date} 复盘报告
                  </Title>
                </div>

                <Divider style={{ margin: '12px 0' }} />

                <div style={{ marginBottom: '16px' }}>
                  <Space style={{ marginBottom: '8px' }}>
                    <LineChartOutlined style={{ color: '#1890ff' }} />
                    <Text strong>大盘总结</Text>
                  </Space>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', color: '#555' }}>
                    {item.marketSummary}
                  </Paragraph>
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <Space style={{ marginBottom: '8px' }}>
                    <Tag color="cyan">持仓分析</Tag>
                  </Space>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', color: '#555' }}>
                    {item.portfolioAnalysis}
                  </Paragraph>
                </div>

                {item.actionPlan && (
                  <div style={{ background: '#e6f7ff', padding: '16px', borderRadius: '8px' }}>
                    <Space style={{ marginBottom: '8px' }}>
                      <BulbOutlined style={{ color: '#faad14' }} />
                      <Text strong>明日操作建议</Text>
                    </Space>
                    <Paragraph
                      style={{
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        color: '#1890ff',
                        fontWeight: 500,
                      }}
                    >
                      {item.actionPlan}
                    </Paragraph>
                  </div>
                )}
              </List.Item>
            )}
          />
        ) : (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="当前还没有生成过 AI 复盘日记，等待收盘后的魔法吧！"
          />
        )}
      </Card>
    </div>
  );
};

export default TradingJournal;
