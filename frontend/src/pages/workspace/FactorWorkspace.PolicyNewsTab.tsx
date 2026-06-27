/**
 * US-048 [FE-009] FactorWorkspace 政策要闻 Tab.
 *
 * 从 GET /api/data/market-news 拉取多源市场要闻 (cls/em/sina/baidu),
 * 在 frontend 用 [[policyNewsHelpers]] 过滤成"政策类"子集 + 自动打 6 档 topic.
 *
 * 设计选择:
 *   - **frontend 侧过滤** (不在 backend 加 policy=true 字段) — 因为政策关键字
 *     字典在前端就行, 加 backend 字段会让 migrations + sync 流程都要改, 边际
 *     收益 < 边际成本. 未来若要做"政策邮件订阅 / 飞书推送"再把字典挪到 backend.
 *   - 复用 backend /api/data/market-news endpoint (Batch AG 已落), 仅传 days=N,
 *     不传 source — 4 源全要 (cls 时效性最高, em/sina/baidu 补长尾).
 *   - **Lazy fetch + 三态短路** 与 FactorWorkspace 其它 tab (board / sentiment)
 *     同款. 切到 'policy' tab 才 fire.
 *
 * UI:
 *   - 顶部 KPI strip: 6 个 topic chip + 当前命中 / 全量条数
 *   - 主体: 按 topic 过滤的时间线 (可全选 / 单选 topic)
 *
 * 这个 tab 不做 AI 影响分析 (e.g. "降准利好哪些板块"), 只做"筛选 + 展示" —
 * 真要做影响分析见未来 US-XYZ (PolicyImpactCard) 走专门的后端推理.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  InputNumber,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import api from '../../services/api';
import {
  filterPolicyNews,
  countPolicyByTopic,
  POLICY_TOPIC_LABELS,
  POLICY_TOPIC_ORDER,
  PolicyTopic,
  PolicyNewsRow,
  MarketNewsRow,
} from './policyNewsHelpers';

const { Text } = Typography;

interface MarketNewsResponse {
  success: boolean;
  count: number;
  data: MarketNewsRow[];
  filters?: Record<string, unknown>;
}

/** topic → Tag color, 与 backend 业务语义保持视觉一致. */
const TOPIC_COLOR: Record<PolicyTopic, string> = {
  monetary: 'gold', // 央行 / 利率类 — 金色 (黄金)
  fiscal: 'orange', // 财政 — 暖色
  regulatory: 'red', // 监管处罚 — 警告色
  capital_market: 'blue', // 资本市场制度 — 蓝色 (与"市场"语义同色)
  industry: 'purple', // 行业部委政策
  macro_signal: 'green', // 宏观信号
};

/** ISO 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM-DDTHH:mm:ss.sssZ' → 'MM-DD HH:mm' */
function formatNewsTime(raw: string | null | undefined): string {
  if (!raw) return '—';
  const s = String(raw);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return `${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  const md = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (md) return `${md[2]}-${md[3]}`;
  return s.slice(0, 16);
}

function sourceColor(src: string | null | undefined): string {
  switch (src) {
    case 'cls':
      return 'orange';
    case 'em':
      return 'blue';
    case 'sina':
      return 'purple';
    case 'baidu':
      return 'cyan';
    default:
      return 'default';
  }
}

const PolicyNewsTab: React.FC = () => {
  const [rawRows, setRawRows] = useState<MarketNewsRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState<number>(3);
  const [topicFilter, setTopicFilter] = useState<PolicyTopic | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get('/data/market-news', { params: { days, limit: 200 } });
      const body = resp.data as MarketNewsResponse;
      setRawRows(Array.isArray(body?.data) ? body.data : []);
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const policyRows: PolicyNewsRow[] = useMemo(() => filterPolicyNews(rawRows), [rawRows]);
  const counts = useMemo(() => countPolicyByTopic(policyRows), [policyRows]);

  const visibleRows = useMemo(
    () => (topicFilter ? policyRows.filter(r => r.topic === topicFilter) : policyRows),
    [policyRows, topicFilter]
  );

  if (loading && !rawRows) {
    return (
      <Card>
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}>
          <Spin tip="加载政策要闻…" />
        </div>
      </Card>
    );
  }
  if (error && !rawRows) {
    return (
      <Alert
        type="error"
        showIcon
        message="加载政策要闻失败"
        description={error}
        action={
          <Button size="small" onClick={load}>
            重试
          </Button>
        }
      />
    );
  }

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="policy-news-tab">
      {error && rawRows && (
        <Alert
          type="warning"
          showIcon
          message="数据刷新失败 (展示上次缓存)"
          description={error}
          action={
            <Button size="small" onClick={load}>
              重试
            </Button>
          }
        />
      )}

      {/* 控件 + 6 个 topic chip 切换 */}
      <Card size="small">
        <Space size={12} wrap style={{ alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#666' }}>近 N 日:</span>
          <InputNumber
            data-testid="policy-news-days-input"
            min={1}
            max={30}
            value={days}
            onChange={v => setDays(Number(v) || 3)}
            style={{ width: 100 }}
            addonAfter="日"
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>
            刷新
          </Button>
          <Text type="secondary" style={{ fontSize: 12 }}>
            全量 {rawRows?.length ?? 0} 条 · 政策类 <Text strong>{policyRows.length}</Text> 条
          </Text>
        </Space>
        <div style={{ marginTop: 12 }}>
          <Space size={[8, 8]} wrap>
            <Tag.CheckableTag
              checked={topicFilter === null}
              onChange={() => setTopicFilter(null)}
              data-testid="policy-topic-chip-all"
            >
              全部 ({policyRows.length})
            </Tag.CheckableTag>
            {POLICY_TOPIC_ORDER.map(t => (
              <Tag.CheckableTag
                key={t}
                checked={topicFilter === t}
                onChange={() => setTopicFilter(topicFilter === t ? null : t)}
                data-testid={`policy-topic-chip-${t}`}
                style={{
                  // 选中态用颜色更明显的 antd Tag color, 但 CheckableTag 只有 1 色,
                  // 用 background+border 自定义凸显当前 topic.
                  background: topicFilter === t ? undefined : '#fafafa',
                  border: `1px solid ${topicFilter === t ? '#1890ff' : '#e8e8e8'}`,
                }}
              >
                {POLICY_TOPIC_LABELS[t]} ({counts[t]})
              </Tag.CheckableTag>
            ))}
          </Space>
        </div>
      </Card>

      {/* 时间线 */}
      <Card
        size="small"
        title={
          <Space>
            <span>政策要闻时间线</span>
            <Tag color="blue">{visibleRows.length} 条</Tag>
            {topicFilter && (
              <Tag color={TOPIC_COLOR[topicFilter]}>{POLICY_TOPIC_LABELS[topicFilter]}</Tag>
            )}
          </Space>
        }
      >
        {visibleRows.length === 0 ? (
          <Empty
            description={
              policyRows.length === 0
                ? `近 ${days} 日内未识别到政策类要闻 — 试着加大天数, 或在 SchedulerService 检查 MARKET_NEWS_SYNC 是否在跑`
                : `当前筛选 (${
                    topicFilter ? POLICY_TOPIC_LABELS[topicFilter] : '?'
                  }) 无数据 — 切到 "全部" 看完整列表`
            }
          />
        ) : (
          <div
            data-testid="policy-news-timeline"
            style={{
              maxHeight: 600,
              overflowY: 'auto',
              borderLeft: '2px solid #f0f0f0',
              paddingLeft: 16,
            }}
          >
            {visibleRows.map((n, i) => (
              <div
                key={`${n.publish_time}-${i}`}
                style={{
                  borderLeft: `3px solid ${
                    n.topic === 'monetary'
                      ? '#faad14'
                      : n.topic === 'regulatory'
                      ? '#dc2626'
                      : n.topic === 'fiscal'
                      ? '#fa8c16'
                      : n.topic === 'capital_market'
                      ? '#1890ff'
                      : n.topic === 'industry'
                      ? '#722ed1'
                      : '#16a34a'
                  }`,
                  marginLeft: -18,
                  paddingLeft: 14,
                  marginBottom: 12,
                  paddingBottom: 6,
                  borderBottom: '1px dashed #eee',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Text strong style={{ fontSize: 14 }} ellipsis={{ tooltip: n.title }}>
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer">
                        {n.title}
                      </a>
                    ) : (
                      n.title
                    )}
                  </Text>
                  <Space size={4}>
                    <Tooltip
                      title={`命中关键词: ${
                        n.matched_keywords.length > 0 ? n.matched_keywords.join(' / ') : '—'
                      }`}
                    >
                      <Tag color={TOPIC_COLOR[n.topic]}>{POLICY_TOPIC_LABELS[n.topic]}</Tag>
                    </Tooltip>
                    <Tag color={sourceColor(n.source)}>{n.source}</Tag>
                  </Space>
                </div>
                <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
                  {formatNewsTime(n.publish_time)}
                  {n.category && <Tag style={{ marginLeft: 4 }}>{n.category}</Tag>}
                </div>
                {n.content && (
                  <div style={{ fontSize: 12, color: '#555', marginTop: 4, lineHeight: 1.5 }}>
                    {n.content.length > 160 ? `${n.content.slice(0, 158)}…` : n.content}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
          💡 政策识别基于前端关键字字典 (<Text code>policyNewsHelpers.POLICY_KEYWORDS</Text>),
          命中即归类; topic 优先级: 货币 → 财政 → 监管 → 资本市场 → 产业 → 宏观信号. 数据源 backend
          MARKET_NEWS_SYNC (cls/em/sina/baidu 四源汇聚).
        </Typography.Paragraph>
      </Card>
    </Space>
  );
};

export default PolicyNewsTab;
