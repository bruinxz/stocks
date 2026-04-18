import React, { useState, useEffect } from 'react';
import {
  Card,
  Typography,
  Space,
  Tag,
  Empty,
  Divider,
  Skeleton,
  Calendar,
  Row,
  Col,
  Badge,
  Button,
  message,
} from 'antd';
import {
  CalendarOutlined,
  LineChartOutlined,
  BulbOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import api from '../services/api';

const { Title, Text, Paragraph } = Typography;

interface Journal {
  id: number;
  date: string;
  marketSummary: string;
  portfolioAnalysis: string;
  actionPlan: string;
  tags?: string[];
  mood?: string;
  createdAt: string;
}

const TradingJournal: React.FC = () => {
  const [journals, setJournals] = useState<Journal[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Dayjs>(dayjs());

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

  const getJournalForDate = (date: Dayjs) => {
    const dateStr = date.format('YYYY-MM-DD');
    return journals.find(j => j.date === dateStr);
  };

  const dateCellRender = (value: Dayjs) => {
    const journal = getJournalForDate(value);
    if (journal) {
      const isPositive = journal.mood && ['开心', '兴奋', '平静'].includes(journal.mood);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Badge status={isPositive ? 'success' : 'warning'} text={journal.mood || '已复盘'} />
        </div>
      );
    }
    return null;
  };

  const selectedJournal = getJournalForDate(selectedDate);

  return (
    <div className="fade-in-up">
      <div className="page-header-modern">
        <div>
          <h1 className="page-title-modern">交易日记</h1>
          <p className="page-subtitle-modern">
            每日收盘后，由大模型为您量身定制的专属大盘分析与持仓表现复盘
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />}>
          手动添加
        </Button>
      </div>

      <Row gutter={[24, 24]}>
        <Col xs={24} lg={10}>
          <Card className="modern-card" bordered={false} title="复盘日历">
            <Calendar
              fullscreen={false}
              value={selectedDate}
              onChange={setSelectedDate}
              cellRender={dateCellRender}
            />
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            className="modern-card"
            bordered={false}
            title={`${selectedDate.format('YYYY年MM月DD日')} 日记`}
            extra={
              selectedJournal && (
                <Button type="text" icon={<EditOutlined />}>
                  编辑
                </Button>
              )
            }
          >
            {loading ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : selectedJournal ? (
              <div
                style={{
                  padding: '24px',
                  background: '#f8fafc',
                  borderRadius: '12px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '16px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    <CalendarOutlined
                      style={{ fontSize: '20px', color: '#4f46e5', marginRight: '8px' }}
                    />
                    <Title level={4} style={{ margin: 0 }}>
                      {selectedJournal.date} 复盘报告
                    </Title>
                  </div>
                  <div>
                    {selectedJournal.mood && (
                      <Tag color="processing" style={{ marginRight: 8 }}>
                        心情: {selectedJournal.mood}
                      </Tag>
                    )}
                    {selectedJournal.tags?.map((tag, idx) => (
                      <Tag key={idx} color="default">
                        {tag}
                      </Tag>
                    ))}
                  </div>
                </div>

                <Divider style={{ margin: '12px 0' }} />

                <div style={{ marginBottom: '16px' }}>
                  <Space style={{ marginBottom: '8px' }}>
                    <LineChartOutlined style={{ color: '#1890ff' }} />
                    <Text strong>大盘总结</Text>
                  </Space>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', color: '#555' }}>
                    {selectedJournal.marketSummary}
                  </Paragraph>
                </div>

                <div style={{ marginBottom: '16px' }}>
                  <Space style={{ marginBottom: '8px' }}>
                    <Tag color="cyan">持仓分析</Tag>
                  </Space>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', color: '#555' }}>
                    {selectedJournal.portfolioAnalysis}
                  </Paragraph>
                </div>

                {selectedJournal.actionPlan && (
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
                      {selectedJournal.actionPlan}
                    </Paragraph>
                  </div>
                )}
              </div>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span>
                    {selectedDate.format('YYYY-MM-DD')} 没有复盘日记
                    <br />
                    <Button type="link" onClick={() => message.info('功能开发中...')}>
                      立即记录
                    </Button>
                  </span>
                }
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
};

export default TradingJournal;
