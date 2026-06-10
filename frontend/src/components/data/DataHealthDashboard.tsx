import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Modal,
  Row,
  Space,
  Spin,
  Statistic,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CloudSyncOutlined,
  CopyOutlined,
  ExclamationCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  DataHealthLevel,
  DataSourceHealthCard,
  DataSourceCategory,
  getDataHealthStatus,
  triggerDataSync,
} from '../../services/dataHealthService';

const { Text, Paragraph } = Typography;

/**
 * US-079 数据健康度看板组件。
 *
 * - 顶部 KPI strip：reference_trade_date + 4 级 level 计数（红 / 黄 / 绿 / 未知）
 * - 卡片网格：每个数据源一张卡，含 lag 徽章 / 最新数据日期 / 上次同步 / 记录数
 *   + 手动触发同步按钮
 * - 同步触发后弹 Modal 显示结果，并刷新整张表
 *
 * 嵌入位置：DataWorkspace.tsx 的 "数据健康" tab。
 */

const LEVEL_META: Record<
  DataHealthLevel,
  {
    color: string;
    label: string;
    icon: React.ReactNode;
    antColor: 'success' | 'warning' | 'error' | 'default';
  }
> = {
  green: {
    color: '#52c41a',
    label: '健康',
    icon: <CheckCircleOutlined />,
    antColor: 'success',
  },
  yellow: {
    color: '#faad14',
    label: '轻微滞后',
    icon: <WarningOutlined />,
    antColor: 'warning',
  },
  red: {
    color: '#f5222d',
    label: '严重滞后',
    icon: <ExclamationCircleOutlined />,
    antColor: 'error',
  },
  unknown: {
    color: '#bfbfbf',
    label: '未知',
    icon: <QuestionCircleOutlined />,
    antColor: 'default',
  },
};

const CATEGORY_LABEL: Record<DataSourceCategory, string> = {
  daily: '日级行情',
  periodic: '周期披露',
  event: '事件流',
};

const DataHealthDashboard: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<DataSourceHealthCard[]>([]);
  const [referenceTradeDate, setReferenceTradeDate] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<DataHealthLevel, number>>({
    green: 0,
    yellow: 0,
    red: 0,
    unknown: 0,
  });
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [syncingKey, setSyncingKey] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const data = await getDataHealthStatus();
      setCards(data.cards);
      setReferenceTradeDate(data.reference_trade_date);
      setSummary(data.summary);
      setGeneratedAt(data.generated_at);
    } catch (err: any) {
      setError(err?.message ?? '获取数据健康状态失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    // 每 60s 静默刷新（不显示 loading）— 让后台 sync 完成后用户能自动看到状态变化
    const tm = setInterval(() => {
      void load(true);
    }, 60_000);
    return () => clearInterval(tm);
  }, [load]);

  const handleSync = useCallback(
    async (source: string, displayName: string) => {
      setSyncingKey(source);
      try {
        const result = await triggerDataSync(source);
        if (result.success) {
          Modal.success({
            title: `${displayName} 同步完成`,
            content: (
              <div>
                <Paragraph style={{ marginBottom: 8 }}>
                  数据源：<Text strong>{source}</Text>
                </Paragraph>
                <Paragraph style={{ marginBottom: 8 }}>
                  目标日期：<Text strong>{result.date}</Text>
                </Paragraph>
                <Paragraph style={{ marginBottom: 4 }}>详细结果：</Paragraph>
                <pre
                  style={{
                    background: '#f6f8fa',
                    padding: 8,
                    borderRadius: 4,
                    fontSize: 12,
                    maxHeight: 200,
                    overflow: 'auto',
                  }}
                >
                  {JSON.stringify(result.result ?? {}, null, 2)}
                </pre>
              </div>
            ),
          });
          // 同步成功后刷新看板
          await load(true);
        } else {
          Modal.error({
            title: `${displayName} 同步失败`,
            content: result.error ?? '未知错误，请联系运维。',
          });
        }
      } catch (err: any) {
        message.error(err?.message ?? '触发同步失败');
      } finally {
        setSyncingKey(null);
      }
    },
    [load]
  );

  const summaryAlert = useMemo(() => {
    if (summary.red > 0) {
      return (
        <Alert
          type="error"
          showIcon
          message={`检测到 ${summary.red} 个数据源严重滞后（红色），请优先处理`}
          description={`参考交易日 ${
            referenceTradeDate ?? '—'
          }。数据停滞 > 3 个交易日，策略信号可能失真。`}
          style={{ marginBottom: 16 }}
        />
      );
    }
    if (summary.yellow > 0) {
      return (
        <Alert
          type="warning"
          showIcon
          message={`${summary.yellow} 个数据源轻微滞后（黄色），建议尽快补数`}
          description={`参考交易日 ${
            referenceTradeDate ?? '—'
          }。数据滞后 1-3 个交易日，量化运行尚可。`}
          style={{ marginBottom: 16 }}
        />
      );
    }
    if (summary.unknown > 0) {
      return (
        <Alert
          type="info"
          showIcon
          message={`${summary.unknown} 个数据源状态未知`}
          description="可能因数据库连接异常或首次部署未同步任何数据。"
          style={{ marginBottom: 16 }}
        />
      );
    }
    if (cards.length > 0 && summary.green === cards.length) {
      return (
        <Alert
          type="success"
          showIcon
          message="所有数据源均健康"
          description={`参考交易日 ${referenceTradeDate ?? '—'}。`}
          style={{ marginBottom: 16 }}
        />
      );
    }
    return null;
  }, [summary, cards.length, referenceTradeDate]);

  if (loading) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Spin tip="正在加载数据源健康状态..." size="large" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <Alert
          type="error"
          showIcon
          message="数据健康状态加载失败"
          description={error}
          action={
            <Button size="small" onClick={() => void load(false)}>
              重试
            </Button>
          }
        />
      </Card>
    );
  }

  if (cards.length === 0) {
    return (
      <Card>
        <Empty description="尚未注册任何数据源" />
      </Card>
    );
  }

  return (
    <div>
      {/* 顶部汇总 KPI */}
      <Card style={{ marginBottom: 16 }} bodyStyle={{ padding: '16px 24px' }}>
        <Row gutter={[16, 16]} align="middle" justify="space-between">
          <Col>
            <Space size={32}>
              <Statistic
                title="参考交易日"
                value={referenceTradeDate ?? '—'}
                valueStyle={{ fontSize: 18 }}
              />
              <Statistic
                title="健康"
                value={summary.green}
                suffix="个"
                valueStyle={{ color: LEVEL_META.green.color, fontSize: 22 }}
              />
              <Statistic
                title="轻微滞后"
                value={summary.yellow}
                suffix="个"
                valueStyle={{ color: LEVEL_META.yellow.color, fontSize: 22 }}
              />
              <Statistic
                title="严重滞后"
                value={summary.red}
                suffix="个"
                valueStyle={{ color: LEVEL_META.red.color, fontSize: 22 }}
              />
              <Statistic
                title="未知"
                value={summary.unknown}
                suffix="个"
                valueStyle={{ color: LEVEL_META.unknown.color, fontSize: 22 }}
              />
            </Space>
          </Col>
          <Col>
            <Space>
              {generatedAt && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  数据时间：{dayjs(generatedAt).format('YYYY-MM-DD HH:mm:ss')}
                </Text>
              )}
              <Button
                icon={<ReloadOutlined />}
                onClick={() => void load(true)}
                loading={refreshing}
              >
                刷新
              </Button>
            </Space>
          </Col>
        </Row>
      </Card>

      {summaryAlert}

      {/* 卡片网格 */}
      <Row gutter={[16, 16]}>
        {cards.map(card => (
          <Col xs={24} sm={12} lg={8} xxl={6} key={card.key}>
            <DataHealthCard
              card={card}
              syncing={syncingKey === card.sync_source}
              syncDisabled={Boolean(syncingKey)}
              onSync={() => handleSync(card.sync_source, card.display_name)}
            />
          </Col>
        ))}
      </Row>
    </div>
  );
};

interface DataHealthCardProps {
  card: DataSourceHealthCard;
  syncing: boolean;
  syncDisabled: boolean;
  onSync: () => void;
}

const DAILY_SYNC_KEYS = new Set([
  'northbound',
  'dragon_tiger',
  'limit_up',
  'industry_flow',
  'snowball_hot',
]);

/** 各数据源对应的 CLI 命令 — 用于按钮 disabled 时提示运维命令 */
const CLI_COMMANDS: Record<string, string> = {
  northbound: 'npm run sync:northbound -- --date=YYYY-MM-DD',
  dragon_tiger: 'npm run sync:dragon-tiger -- --date=YYYY-MM-DD',
  limit_up: 'npm run sync:limit-up -- --date=YYYY-MM-DD',
  industry_flow: 'npm run sync:industry-flow -- --date=YYYY-MM-DD',
  snowball_hot: 'npm run sync:snowball-keywords',
  earnings_forecast: 'npm run sync:earnings-forecast -- --report-period=YYYY-MM-DD',
  financial_report: 'npm run sync:financial-report -- --stock=600519',
  dividend_history: 'npm run sync:dividend-history -- --stock=600519',
  analyst_forecast: 'npm run sync:analyst-forecast -- --stock=600519',
  shareholder_count: 'npm run sync:shareholder-count -- --stock=600519',
  shareholder_trade: 'npm run sync:shareholder-trade',
  restricted_share: 'npm run sync:restricted-share',
  margin_trading: 'npm run sync:margin-trading -- --date=YYYY-MM-DD',
  etf_flow: 'npm run sync:etf-flow -- --date=YYYY-MM-DD',
  announcements: 'npm run sync:announcements -- --date=YYYY-MM-DD',
  qa_topics: 'npm run sync:qa-topics -- --stock=600519',
  index_components: 'npm run sync:index-components -- --index=000300 --date=YYYY-MM-DD',
  market_sentiment: 'npm run sync:market-sentiment',
  kol_opinions: 'npm run sync:kol-opinions',
  stock_sentiment: 'npm run sync:stock-sentiment',
};

const DataHealthCard: React.FC<DataHealthCardProps> = ({ card, syncing, syncDisabled, onSync }) => {
  const meta = LEVEL_META[card.level];
  const canManualSync = DAILY_SYNC_KEYS.has(card.sync_source);
  const lagText =
    card.lag_trading_days === null
      ? '—'
      : card.category === 'daily'
      ? `${card.lag_trading_days} 个交易日`
      : `${card.lag_trading_days} 天`;
  const lastSyncText = card.last_sync_at
    ? dayjs(card.last_sync_at).format('YYYY-MM-DD HH:mm')
    : '从未同步';

  return (
    <Card
      bodyStyle={{ padding: 16 }}
      title={
        <Space size={8}>
          <Badge color={meta.color} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{card.display_name}</span>
        </Space>
      }
      extra={
        <Tag color={meta.antColor} style={{ marginRight: 0 }}>
          {meta.icon} {meta.label}
        </Tag>
      }
    >
      <Tooltip title={card.description}>
        <Paragraph
          type="secondary"
          ellipsis={{ rows: 2 }}
          style={{ marginBottom: 12, fontSize: 12, minHeight: 36 }}
        >
          {card.description}
        </Paragraph>
      </Tooltip>

      <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
        <Col span={12}>
          <Statistic
            title="最新数据日期"
            value={card.latest_data_date ?? '—'}
            valueStyle={{ fontSize: 14 }}
          />
        </Col>
        <Col span={12}>
          <Statistic
            title="落后"
            value={lagText}
            valueStyle={{
              fontSize: 14,
              color: meta.color,
            }}
          />
        </Col>
        <Col span={12}>
          <Statistic
            title="记录条数"
            value={card.record_count.toLocaleString('zh-CN')}
            valueStyle={{ fontSize: 14 }}
          />
        </Col>
        <Col span={12}>
          <Statistic title="上次同步" value={lastSyncText} valueStyle={{ fontSize: 12 }} />
        </Col>
      </Row>

      <Space size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
        <Tag color="processing" style={{ marginRight: 0 }}>
          {CATEGORY_LABEL[card.category]}
        </Tag>
        {canManualSync ? (
          <Button
            type="primary"
            size="small"
            icon={<CloudSyncOutlined />}
            loading={syncing}
            disabled={syncDisabled && !syncing}
            onClick={onSync}
          >
            {syncing ? '同步中...' : '手动触发同步'}
          </Button>
        ) : (
          <Tooltip
            title={
              <div style={{ maxWidth: 360 }}>
                <div style={{ marginBottom: 6 }}>本数据源需在服务器上执行 CLI：</div>
                <code
                  style={{
                    fontSize: 11,
                    background: 'rgba(255,255,255,0.15)',
                    padding: '4px 6px',
                    borderRadius: 3,
                    display: 'block',
                    userSelect: 'all',
                    cursor: 'text',
                  }}
                >
                  {CLI_COMMANDS[card.sync_source] || `npm run sync:${card.sync_source}`}
                </code>
                <div style={{ marginTop: 6, fontSize: 10, opacity: 0.7 }}>
                  在 /opt/stocks/current/backend 目录执行
                </div>
              </div>
            }
          >
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                const cmd = CLI_COMMANDS[card.sync_source] || `npm run sync:${card.sync_source}`;
                navigator.clipboard?.writeText(cmd).catch(() => {
                  /* silent: 浏览器不支持或权限拒绝时静默退出 */
                });
              }}
            >
              复制 CLI
            </Button>
          </Tooltip>
        )}
      </Space>

      {card.error && (
        <Alert
          type="error"
          showIcon
          message="数据源查询异常"
          description={card.error}
          style={{ marginTop: 12 }}
        />
      )}
    </Card>
  );
};

export default DataHealthDashboard;
