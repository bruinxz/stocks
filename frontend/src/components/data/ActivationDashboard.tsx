/**
 * ActivationDashboard — Sprint 27: L1-L8 决策链激活面板
 *
 * 数据源: GET /api/paper-trading/activation-summary?days=7
 *   - 总信号 + outcome 分布 (executed/skipped/rejected)
 *   - 8 层每层 reached/blocked/contributed 计数 + 比例
 *   - Top 5 block reasons
 *   - 最近 10 笔 trade 的逐层激活快照 (8 个 chip 每行)
 *
 * 视觉:
 *   1. 顶部 4 个 Statistic Card 横排 (总信号 / executed / skipped / rejected)
 *   2. 8 层活跃概览 — 每行 = 一层: [layer icon + label] [水平堆叠柱 reached+blocked+contributed] [stat 数字]
 *   3. 下方双栏 — 左: Top block reasons 表, 右: 最近 trade 表 (每行 8 chip)
 *
 * 配合拓扑图 (SystemTopologyMap) 同 health tab 阅读 — 拓扑图回答"架构有什么",
 * 本面板回答"实际运行时哪些层真的被激活了 + 拦下了什么 + 改了什么".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Card,
  Spin,
  Alert,
  Button,
  Space,
  Tag,
  Tooltip,
  Statistic,
  Row,
  Col,
  Table,
  Empty,
  Select,
} from 'antd';
import {
  ReloadOutlined,
  ApartmentOutlined,
  CheckCircleOutlined,
  StopOutlined,
  ThunderboltOutlined,
  MinusOutlined,
} from '@ant-design/icons';
import api from '../../services/api';
import type { ColumnsType } from 'antd/es/table';

// ---------- types ----------

type LayerKey =
  | 'L1_data'
  | 'L2_signal'
  | 'L3_meta'
  | 'L4_construction'
  | 'L5_feasibility'
  | 'L6_risk'
  | 'L7_governor'
  | 'L8_reflection';

interface LayerStat {
  layer: LayerKey;
  reached: number;
  blocked: number;
  contributed: number;
  reach_rate: number;
  block_rate: number;
  contribute_rate: number;
}

interface BlockReason {
  layer: LayerKey;
  reason: string;
  count: number;
}

interface RecentTrade {
  order_intent_id: number;
  intent_date: string;
  symbol: string;
  name: string | null;
  outcome: 'executed' | 'skipped' | 'rejected' | 'planned' | 'pending' | 'unknown';
  reached_layer: string | null;
  blocked_at: string | null;
  layer_marks: Record<LayerKey, '✓' | '★' | '✗' | '—'>;
  /** Sprint 31: 每层真实 detail (来自 activation.<layer>.detail) — chip hover tooltip 用 */
  layer_details?: Record<LayerKey, Record<string, any> | null>;
  reason_text: string | null;
}

interface ActivationSummaryData {
  window_days: number;
  generated_at: string;
  total_signals: number;
  outcomes: { executed: number; skipped: number; rejected: number; other: number };
  layer_stats: LayerStat[];
  top_block_reasons: BlockReason[];
  recent_trades: RecentTrade[];
}

// ---------- visual tokens ----------

// 每层显示用 中文标签 (与后端 SystemTopologyMap.STAGES 保持一致)
const LAYER_LABEL: Record<LayerKey, string> = {
  L1_data: 'L1 数据',
  L2_signal: 'L2 信号',
  L3_meta: 'L3 元决策',
  L4_construction: 'L4 组合',
  L5_feasibility: 'L5 执行',
  L6_risk: 'L6 风控',
  L7_governor: 'L7 治理',
  L8_reflection: 'L8 复盘',
};

// 每层用 emoji 让面板与拓扑图视觉对齐
const LAYER_ICON: Record<LayerKey, string> = {
  L1_data: '📊',
  L2_signal: '🎯',
  L3_meta: '🤖',
  L4_construction: '📐',
  L5_feasibility: '🚦',
  L6_risk: '🛡️',
  L7_governor: '🎛️',
  L8_reflection: '🔬',
};

const LAYERS_IN_ORDER: ReadonlyArray<LayerKey> = [
  'L1_data',
  'L2_signal',
  'L3_meta',
  'L4_construction',
  'L5_feasibility',
  'L6_risk',
  'L7_governor',
  'L8_reflection',
];

// ---------- stacked bar (per-layer activation bar) ----------

interface StackedBarProps {
  total: number;
  reached: number;
  blocked: number;
  contributed: number;
}

const StackedBar: React.FC<StackedBarProps> = ({ total, reached, blocked, contributed }) => {
  // 三种状态相对于 total 的宽度 — reached 是 base, blocked 重叠覆盖 (拦截即 reached),
  // contributed 也是覆盖 reached (改了仓位即 reached). 但 blocked + contributed 互斥
  // (拦截的不能 contributed), 所以视觉上分 3 段: 通过未改 (reached - blocked - contributed) /
  // 通过且改 (contributed) / 拦截 (blocked).
  const safeTotal = total > 0 ? total : 1;
  const passThru = Math.max(0, reached - blocked - contributed);
  const passThruPct = (passThru / safeTotal) * 100;
  const contribPct = (contributed / safeTotal) * 100;
  const blockedPct = (blocked / safeTotal) * 100;
  // unused 是没 reached 的部分 (= total - reached)
  const unusedPct = Math.max(0, ((total - reached) / safeTotal) * 100);

  return (
    <Tooltip
      title={
        <div style={{ fontSize: 12 }}>
          <div>已通过未改: {passThru}</div>
          <div>已通过 + 改了仓位: {contributed}</div>
          <div>拦截: {blocked}</div>
          <div>未参与 (没走到): {total - reached}</div>
        </div>
      }
    >
      <div
        style={{
          display: 'flex',
          width: '100%',
          height: 14,
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--surface-soft)',
          border: '1px solid rgba(15, 23, 42, 0.06)',
        }}
      >
        {passThruPct > 0 && (
          <div
            style={{
              width: `${passThruPct}%`,
              background: 'rgba(39, 100, 184, 0.45)',
              transition: 'width 0.3s',
            }}
          />
        )}
        {contribPct > 0 && (
          <div
            style={{
              width: `${contribPct}%`,
              background: 'rgba(0, 143, 107, 0.75)',
              transition: 'width 0.3s',
            }}
          />
        )}
        {blockedPct > 0 && (
          <div
            style={{
              width: `${blockedPct}%`,
              background: 'rgba(209, 67, 67, 0.75)',
              transition: 'width 0.3s',
            }}
          />
        )}
        {unusedPct > 0 && (
          <div
            style={{
              width: `${unusedPct}%`,
              background: 'rgba(191, 191, 191, 0.25)',
              transition: 'width 0.3s',
            }}
          />
        )}
      </div>
    </Tooltip>
  );
};

// ---------- main component ----------

const ActivationDashboard: React.FC = () => {
  const [data, setData] = useState<ActivationSummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get('/paper-trading/activation-summary', { params: { days } });
      setData(resp.data?.data);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = data?.total_signals ?? 0;

  const recentTradeColumns = useMemo<ColumnsType<RecentTrade>>(
    () => [
      {
        title: '日期',
        dataIndex: 'intent_date',
        key: 'intent_date',
        width: 92,
        render: (v: string) => <span style={{ fontSize: 12 }}>{v?.slice(5) || '—'}</span>,
      },
      {
        title: '股票',
        dataIndex: 'symbol',
        key: 'symbol',
        width: 120,
        render: (v: string, row: RecentTrade) => (
          <span style={{ fontSize: 12 }}>
            <strong>{v}</strong>
            {row.name ? <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>{row.name}</span> : null}
          </span>
        ),
      },
      {
        title: '结果',
        dataIndex: 'outcome',
        key: 'outcome',
        width: 80,
        render: (v: RecentTrade['outcome']) => {
          const tone =
            v === 'executed'
              ? 'success'
              : v === 'rejected'
              ? 'error'
              : v === 'skipped'
              ? 'warning'
              : 'default';
          const label =
            v === 'executed'
              ? '成交'
              : v === 'rejected'
              ? '拒单'
              : v === 'skipped'
              ? '跳过'
              : v === 'planned'
              ? '计划'
              : '未知';
          return <Tag color={tone}>{label}</Tag>;
        },
      },
      {
        title: 'L1-L8 激活',
        key: 'layer_marks',
        render: (_: any, row: RecentTrade) => (
          <Space size={4} wrap>
            {LAYERS_IN_ORDER.map(layer => {
              const m = row.layer_marks?.[layer] || '—';
              const color =
                m === '★'
                  ? 'rgba(0, 143, 107, 0.18)'
                  : m === '✓'
                  ? 'rgba(39, 100, 184, 0.14)'
                  : m === '✗'
                  ? 'rgba(209, 67, 67, 0.18)'
                  : 'rgba(191, 191, 191, 0.18)';
              const fg =
                m === '★'
                  ? 'var(--success)'
                  : m === '✓'
                  ? 'var(--primary)'
                  : m === '✗'
                  ? 'var(--danger)'
                  : 'var(--text-muted)';
              // Sprint 31: tooltip 展示真实 detail (features_used / snapshot_source / multiplier 等)
              const detail = row.layer_details?.[layer];
              const tooltipBody = (
                <div style={{ minWidth: 200, maxWidth: 360 }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>
                    {LAYER_LABEL[layer]}: {markMeaning(m)}
                  </div>
                  {detail && Object.keys(detail).length > 0 ? (
                    <div style={{ marginTop: 4, fontSize: 11 }}>
                      {Object.entries(detail).map(([k, v]) => (
                        <div key={k} style={{ marginBottom: 2 }}>
                          <span style={{ color: 'rgba(255,255,255,0.6)' }}>{k}:</span>{' '}
                          <span style={{ fontFamily: 'monospace' }}>
                            {formatDetailValue(v)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>
                      (此层无 detail 数据)
                    </div>
                  )}
                </div>
              );
              return (
                <Tooltip key={layer} title={tooltipBody}>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 22,
                      height: 22,
                      borderRadius: 4,
                      background: color,
                      color: fg,
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                  >
                    {m}
                  </span>
                </Tooltip>
              );
            })}
          </Space>
        ),
      },
      {
        title: '原因',
        dataIndex: 'reason_text',
        key: 'reason_text',
        render: (v: string | null) =>
          v ? (
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{v}</span>
          ) : (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>—</span>
          ),
      },
    ],
    []
  );

  const blockReasonColumns = useMemo<ColumnsType<BlockReason>>(
    () => [
      {
        title: '层',
        dataIndex: 'layer',
        key: 'layer',
        width: 110,
        render: (v: LayerKey) => (
          <Tag color="default" style={{ fontSize: 11 }}>
            {LAYER_ICON[v]} {LAYER_LABEL[v]}
          </Tag>
        ),
      },
      {
        title: '拦截原因',
        dataIndex: 'reason',
        key: 'reason',
        render: (v: string) => <span style={{ fontSize: 12 }}>{v}</span>,
      },
      {
        title: '次数',
        dataIndex: 'count',
        key: 'count',
        width: 64,
        align: 'right',
        render: (v: number) => <strong style={{ color: 'var(--danger)' }}>{v}</strong>,
      },
    ],
    []
  );

  return (
    <Card
      className="modern-card"
      variant="borderless"
      size="small"
      title={
        <Space>
          <ApartmentOutlined style={{ color: 'var(--primary)' }} />
          <span style={{ fontWeight: 600 }}>L1-L8 决策链激活</span>
          <Tooltip title="近 N 天每笔信号沿 8 层决策流水线的激活情况。✓=通过 / ★=改了仓位 / ✗=被拦 / —=未参与">
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(每笔信号的逐层激活)</span>
          </Tooltip>
        </Space>
      }
      extra={
        <Space>
          <Select
            size="small"
            value={days}
            onChange={setDays}
            options={[
              { value: 1, label: '近 1 天' },
              { value: 7, label: '近 7 天' },
              { value: 30, label: '近 30 天' },
              { value: 90, label: '近 90 天' },
            ]}
            style={{ width: 100 }}
          />
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
            刷新
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
      styles={{ body: { padding: '16px 18px 18px' } }}
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}

      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin tip="加载激活数据..." />
        </div>
      ) : !data || data.total_signals === 0 ? (
        <Empty
          description={
            <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              近 {days} 天暂无 autopilot 信号。手动触发一次自动跟单后再回看。
            </span>
          }
          style={{ padding: 40 }}
        />
      ) : (
        <>
          {/* 顶部 4 个 Statistic */}
          <Row gutter={[16, 12]} style={{ marginBottom: 16 }}>
            <Col xs={12} md={6}>
              <Statistic
                title={
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {days}d 总信号
                  </span>
                }
                value={data.total_signals}
                valueStyle={{ fontSize: 22, fontWeight: 600 }}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>成交</span>}
                value={data.outcomes.executed}
                valueStyle={{ fontSize: 22, fontWeight: 600, color: 'var(--success)' }}
                prefix={<CheckCircleOutlined style={{ fontSize: 16 }} />}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>跳过</span>}
                value={data.outcomes.skipped}
                valueStyle={{ fontSize: 22, fontWeight: 600, color: 'var(--warning)' }}
                prefix={<MinusOutlined style={{ fontSize: 16 }} />}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>拒单</span>}
                value={data.outcomes.rejected}
                valueStyle={{ fontSize: 22, fontWeight: 600, color: 'var(--danger)' }}
                prefix={<StopOutlined style={{ fontSize: 16 }} />}
              />
            </Col>
          </Row>

          {/* 8 层激活概览 — 每行一层 */}
          <div
            style={{
              border: '1px solid rgba(15, 23, 42, 0.06)',
              borderRadius: 8,
              padding: '12px 16px',
              marginBottom: 16,
              background: 'rgba(248, 250, 252, 0.5)',
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 10, color: 'var(--text-secondary)' }}>
              8 层激活概览 · <span style={{ color: 'rgba(39, 100, 184, 0.6)' }}>■ 已通过</span> ·{' '}
              <span style={{ color: 'rgba(0, 143, 107, 0.8)' }}>■ 真改了仓位</span> ·{' '}
              <span style={{ color: 'rgba(209, 67, 67, 0.8)' }}>■ 被拦</span> ·{' '}
              <span style={{ color: 'rgba(160, 160, 160, 0.8)' }}>■ 未参与</span>
            </div>
            {data.layer_stats.map(s => (
              <div
                key={s.layer}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 220px',
                  gap: 12,
                  alignItems: 'center',
                  marginBottom: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 500 }}>
                  <span style={{ marginRight: 4 }}>{LAYER_ICON[s.layer]}</span>
                  {LAYER_LABEL[s.layer]}
                </div>
                <StackedBar
                  total={total}
                  reached={s.reached}
                  blocked={s.blocked}
                  contributed={s.contributed}
                />
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', textAlign: 'right' }}>
                  通 <strong>{s.reached}</strong>
                  <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
                  改{' '}
                  <strong style={{ color: 'var(--success)' }}>
                    {s.contributed}
                    {s.reached > 0 && (
                      <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 2 }}>
                        ({Math.round(s.contribute_rate * 100)}%)
                      </span>
                    )}
                  </strong>
                  <span style={{ color: 'var(--text-muted)', margin: '0 4px' }}>·</span>
                  拦{' '}
                  <strong style={{ color: 'var(--danger)' }}>
                    {s.blocked}
                    {s.reached > 0 && (
                      <span style={{ fontWeight: 400, fontSize: 10, marginLeft: 2 }}>
                        ({Math.round(s.block_rate * 100)}%)
                      </span>
                    )}
                  </strong>
                </div>
              </div>
            ))}
          </div>

          {/* 下方双栏 */}
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={10}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                <ThunderboltOutlined style={{ color: 'var(--danger)', marginRight: 4 }} />
                Top 拦截原因
              </div>
              {data.top_block_reasons.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={<span style={{ fontSize: 12 }}>近 {days} 天无拦截事件</span>}
                  style={{ padding: 20 }}
                />
              ) : (
                <Table<BlockReason>
                  rowKey={(r) => `${r.layer}-${r.reason}`}
                  size="small"
                  columns={blockReasonColumns}
                  dataSource={data.top_block_reasons}
                  pagination={false}
                />
              )}
            </Col>
            <Col xs={24} lg={14}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' }}>
                <CheckCircleOutlined style={{ color: 'var(--primary)', marginRight: 4 }} />
                最近 10 笔信号 (含 skipped / rejected)
              </div>
              <Table<RecentTrade>
                rowKey="order_intent_id"
                size="small"
                columns={recentTradeColumns}
                dataSource={data.recent_trades}
                pagination={false}
                scroll={{ x: 'max-content' }}
              />
            </Col>
          </Row>

          <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
            生成于 {new Date(data.generated_at).toLocaleString('zh-CN')}
          </div>
        </>
      )}
    </Card>
  );
};

function markMeaning(m: '✓' | '★' | '✗' | '—'): string {
  switch (m) {
    case '✓':
      return '已通过 (未改下游)';
    case '★':
      return '已通过 + 真改了仓位/参数';
    case '✗':
      return '被拦截';
    default:
      return '未参与 (此信号未走到这层)';
  }
}

/**
 * Sprint 31: 把 detail 字段值格式化成可读字符串.
 * - number: 6 位小数截断 + 千分位
 * - object: JSON stringify 但取出 嵌套的 1 级 (如 features_used.breadth_score)
 * - array: 用 , 拼
 */
function formatDetailValue(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v.toLocaleString();
    return v.toFixed(Math.min(4, 6));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.length === 0 ? '[]' : v.map(formatDetailValue).join(', ');
  if (typeof v === 'object') {
    const entries = Object.entries(v).slice(0, 4);
    return entries
      .map(([k, vv]) => `${k}=${formatDetailValue(vv)}`)
      .join(' / ');
  }
  return String(v);
}

export default ActivationDashboard;
