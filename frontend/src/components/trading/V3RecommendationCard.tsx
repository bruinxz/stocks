import React, { useMemo, useState } from 'react';
import { Card, Space, Tag, Typography, Button, Tooltip, Row, Col, Statistic, Alert } from 'antd';
import {
  RobotOutlined,
  DownOutlined,
  RightOutlined,
  WarningOutlined,
  BarChartOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import Sparkline20d from '../charts/Sparkline20d';
import type {
  V3RecommendationItem,
  V3DimensionItem,
  V3PlaybookItem,
} from '../../services/v3RecommendationService';

/**
 * CA-1/CA-2/CA-3 抖音风 v3 推荐卡片 — 单条 stacked card.
 *
 * 布局 (top→down):
 *   - 顶部: 名称 + 代码 + 涨跌幅 (右对齐) + 行业/市值 Tag;
 *   - KPI 4 列: 现价 / 换手 / 振幅 / 20 日;
 *   - Sparkline20d 折线图;
 *   - 3 个高亮 Tag (橙色);
 *   - 推荐理由 (一句话);
 *   - 4 维评分 (人气/逻辑/资金/结构) 大字横排;
 *   - CA-2 场景化 5 档 playbook (collapsible, 默认折叠);
 *   - CA-3 技术面段落 (灰底, 默认展开);
 *   - CA-3 观察点 bullet list (默认展开);
 *   - CA-3 风险硬规则 (红框 + warning icon, 默认展开);
 *   - "查看完整分析" 按钮 → onClickDetail(item).
 *
 * 不做:
 *   - 不内嵌 modal — 父组件接 onClickDetail 后自己渲 modal.
 *
 * 容错 (与后端 enrichSignal fail-OPEN 同款):
 *   - sparkline 空 → Sparkline20d 自身渲染 "数据不足";
 *   - dimensions 少于 4 维 → 缺的位置不渲染 (不强制占位);
 *   - 行业 / 市值 null → tag 不渲染;
 *   - technical_summary / observation_points / risk_rules 缺失 → 整段不渲染.
 */
export interface V3RecommendationCardProps {
  item: V3RecommendationItem;
  onClickDetail?: (item: V3RecommendationItem) => void;
}

const { Text, Paragraph } = Typography;

/** 中股惯例: 涨红跌绿. null/0 灰. */
function changePctColor(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct) || pct === 0) return '#8c8c8c';
  return pct > 0 ? '#cf1322' : '#52c41a';
}

/** 4 维评分大字颜色: ≥80 红强 / 60-79 橙中 / 40-59 灰 / <40 绿弱. */
export function dimensionScoreColor(barValue: number | null | undefined): string {
  if (typeof barValue !== 'number' || !Number.isFinite(barValue)) return '#8c8c8c';
  if (barValue >= 80) return '#cf1322';
  if (barValue >= 60) return '#fa8c16';
  if (barValue >= 40) return '#8c8c8c';
  return '#52c41a';
}

/** confidence_tier → 卡片 border 强度 (高 confidence 加深 border). */
function tierBorder(tier: 'high' | 'medium' | 'low' | undefined): string {
  if (tier === 'high') return '2px solid #cf1322';
  if (tier === 'medium') return '1px solid #fa8c16';
  return '1px solid #f0f0f0';
}

/** 市值 (单位元) → 中文档位 tag. circulating 优先, 缺则 total. null 返 null. */
export function marketCapBucketLabel(circ: number | null, total: number | null): string | null {
  const cap =
    circ != null && Number.isFinite(circ) && circ > 0
      ? circ
      : total != null && Number.isFinite(total) && total > 0
        ? total
        : null;
  if (cap == null) return null;
  if (cap >= 1e11) return '超大市值';
  if (cap >= 5e10) return '千亿大盘';
  if (cap >= 1e10) return '中盘股';
  return '小盘股';
}

/** 4 维 fixed 顺序 — 人气 → 逻辑 → 资金 → 结构 (与后端 V3_DIMENSION_KEYS 同源). */
const DIMENSION_ORDER: ReadonlyArray<V3DimensionItem['key']> = Object.freeze([
  'popularity',
  'logic',
  'capital',
  'structure',
]);

/** playbook verdict → 颜色 (与后端 VERDICT_COLOR 同源, 中股惯例红=买/橙=持有/蓝=观望/绿=避). */
export function playbookVerdictColor(verdict: V3PlaybookItem['verdict']): string {
  switch (verdict) {
    case 'buy':
      return '#cf1322';
    case 'hold':
      return '#fa8c16';
    case 'observe':
      return '#1890ff';
    case 'avoid':
      return '#52c41a';
    default:
      return '#8c8c8c';
  }
}

/** 把 dimensions 按 fixed order 排好, 缺的位置返 null. */
export function orderDimensions(
  dims: ReadonlyArray<V3DimensionItem>
): Array<V3DimensionItem | null> {
  const byKey = new Map<string, V3DimensionItem>();
  for (const d of dims) {
    if (d && typeof d.key === 'string') byKey.set(d.key, d);
  }
  return DIMENSION_ORDER.map(k => byKey.get(k) ?? null);
}

const V3RecommendationCard: React.FC<V3RecommendationCardProps> = ({ item, onClickDetail }) => {
  const orderedDims = useMemo(() => orderDimensions(item.dimensions ?? []), [item.dimensions]);
  const capLabel = useMemo(
    () => marketCapBucketLabel(item.circulating_market_cap, item.total_market_cap),
    [item.circulating_market_cap, item.total_market_cap]
  );
  const [playbookOpen, setPlaybookOpen] = useState(false);
  const playbookItems = Array.isArray(item.playbook) ? item.playbook : null;
  const hasPlaybook = !!playbookItems && playbookItems.length > 0;

  return (
    <Card
      size="default"
      style={{
        borderRadius: 12,
        border: tierBorder(item.confidence_tier),
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        transition: 'box-shadow 0.2s ease',
      }}
      bodyStyle={{ padding: 16 }}
      hoverable
      data-testid={`v3-card-${item.symbol}`}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* 顶部: 名称 + 代码 (左) + 涨跌幅 (右) */}
        <Row align="middle" gutter={8} wrap={false}>
          <Col flex="auto">
            <Space size={8} wrap>
              <Text strong style={{ fontSize: 18 }}>
                {item.name ?? item.symbol}
              </Text>
              <Text code style={{ fontSize: 12 }}>
                {item.symbol}
              </Text>
              {item.confidence_tier === 'high' && (
                <Tag color="red" style={{ marginLeft: 4 }}>
                  高置信
                </Tag>
              )}
            </Space>
          </Col>
          <Col flex="none">
            <Text
              strong
              style={{
                fontSize: 18,
                color: changePctColor(item.change_pct),
              }}
              data-testid={`v3-card-${item.symbol}-change-pct`}
            >
              {item.change_pct == null
                ? '—'
                : `${item.change_pct >= 0 ? '+' : ''}${item.change_pct.toFixed(2)}%`}
            </Text>
          </Col>
        </Row>

        {/* 行业 + 市值 Tag */}
        <Space size={4} wrap>
          {item.industry && <Tag color="blue">{item.industry}</Tag>}
          {capLabel && <Tag color="blue">{capLabel}</Tag>}
        </Space>

        {/* KPI 4 列 */}
        <Row gutter={[12, 8]}>
          <Col xs={6}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>现价</span>}
              value={item.current_price ?? '—'}
              precision={item.current_price == null ? undefined : 2}
              valueStyle={{ fontSize: 16, fontWeight: 600 }}
            />
          </Col>
          <Col xs={6}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>换手</span>}
              value={item.turnover_rate == null ? '—' : `${item.turnover_rate.toFixed(2)}%`}
              valueStyle={{ fontSize: 16 }}
            />
          </Col>
          <Col xs={6}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>振幅</span>}
              value={item.amplitude_pct == null ? '—' : `${item.amplitude_pct.toFixed(2)}%`}
              valueStyle={{ fontSize: 16 }}
            />
          </Col>
          <Col xs={6}>
            <Statistic
              title={<span style={{ fontSize: 12 }}>20日</span>}
              value={
                item.cumulative_change_pct_20d == null
                  ? '—'
                  : `${item.cumulative_change_pct_20d >= 0 ? '+' : ''}${item.cumulative_change_pct_20d.toFixed(2)}%`
              }
              valueStyle={{
                fontSize: 16,
                color: changePctColor(item.cumulative_change_pct_20d),
              }}
            />
          </Col>
        </Row>

        {/* Sparkline */}
        <div style={{ width: '100%', display: 'flex', justifyContent: 'center' }}>
          <Sparkline20d data={item.sparkline ?? []} width={280} height={60} />
        </div>

        {/* 高亮 tag 行 */}
        {item.highlight_tags && item.highlight_tags.length > 0 && (
          <Space size={4} wrap data-testid={`v3-card-${item.symbol}-tags`}>
            {item.highlight_tags.slice(0, 3).map(tag => (
              <Tag key={tag} color="orange" style={{ borderRadius: 12, padding: '0 10px' }}>
                {tag}
              </Tag>
            ))}
          </Space>
        )}

        {/* 推荐理由 */}
        {item.recommend_reason && (
          <div style={{ paddingLeft: 8, borderLeft: '3px solid #722ed1' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              推荐理由
            </Text>
            <Paragraph
              style={{ margin: '4px 0 0', fontSize: 13, lineHeight: 1.5, color: '#262626' }}
            >
              {item.recommend_reason}
            </Paragraph>
          </div>
        )}

        {/* 4 维评分大字横排 — 人气 / 逻辑 / 资金 / 结构 */}
        <Row gutter={[8, 8]} data-testid={`v3-card-${item.symbol}-dimensions`}>
          {orderedDims.map((d, idx) => {
            const key = DIMENSION_ORDER[idx];
            if (!d) {
              return (
                <Col xs={6} key={key}>
                  <div style={{ textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {dimensionLabel(key)}
                    </Text>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#d9d9d9' }}>—</div>
                  </div>
                </Col>
              );
            }
            const color = dimensionScoreColor(d.bar_value);
            const tooltip =
              d.subs_present === 0
                ? `${d.label} 维度无 analyzer 命中, 分数兜底为 0`
                : `${d.label} 子分 ${d.subs_present} 项, 置信度 ${(d.confidence * 100).toFixed(0)}%`;
            return (
              <Col xs={6} key={key}>
                <Tooltip title={tooltip}>
                  <div style={{ textAlign: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {d.label}
                    </Text>
                    <div
                      style={{ fontSize: 22, fontWeight: 700, color, lineHeight: '28px' }}
                      data-testid={`v3-card-${item.symbol}-dim-${d.key}`}
                    >
                      {d.bar_value}
                    </div>
                  </div>
                </Tooltip>
              </Col>
            );
          })}
        </Row>

        {/* CA-2 场景化 5 档 playbook — collapsible */}
        {hasPlaybook && (
          <div
            style={{
              borderTop: '1px dashed #e8e8e8',
              paddingTop: 8,
            }}
            data-testid={`v3-card-${item.symbol}-playbook`}
          >
            <div
              role="button"
              tabIndex={0}
              onClick={() => setPlaybookOpen(o => !o)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setPlaybookOpen(o => !o);
                }
              }}
              style={{
                cursor: 'pointer',
                userSelect: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
              data-testid={`v3-card-${item.symbol}-playbook-toggle`}
            >
              {playbookOpen ? (
                <DownOutlined style={{ fontSize: 12 }} />
              ) : (
                <RightOutlined style={{ fontSize: 12 }} />
              )}
              <Text style={{ fontSize: 13, fontWeight: 600 }}>操作建议 (5 档开盘场景)</Text>
            </div>
            {playbookOpen && (
              <div style={{ marginTop: 8 }}>
                {playbookItems!.map((p, idx) => {
                  const color = playbookVerdictColor(p.verdict);
                  return (
                    <div
                      key={p.bucket}
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 8,
                        padding: '6px 8px',
                        marginBottom: idx === playbookItems!.length - 1 ? 0 : 4,
                        background: p.avoid ? '#fff1f0' : '#fafafa',
                        borderLeft: p.avoid
                          ? '3px solid #cf1322'
                          : `3px solid ${color}`,
                        borderRadius: 4,
                      }}
                      data-testid={`v3-card-${item.symbol}-playbook-${p.bucket}`}
                    >
                      <div style={{ flexShrink: 0 }}>
                        <Text
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            color,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          【{p.trigger}】
                        </Text>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text style={{ fontSize: 12, color: '#262626', wordBreak: 'break-all' }}>
                          {p.action}
                        </Text>
                        {p.avoid && (
                          <WarningOutlined
                            style={{ color: '#cf1322', marginLeft: 4, fontSize: 12 }}
                          />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* CA-3: 技术面 / 观察点 / 风险 — 3 段结构化详情, 默认展开. 缺数据整段不渲染. */}
        {item.technical_summary && (
          <div
            style={{
              borderTop: '1px dashed #e8e8e8',
              paddingTop: 10,
            }}
            data-testid={`v3-card-${item.symbol}-tech`}
          >
            <Space size={6} align="center" style={{ marginBottom: 4 }}>
              <BarChartOutlined style={{ fontSize: 13, color: '#1890ff' }} />
              <Text style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>技术面</Text>
            </Space>
            <Paragraph
              style={{
                margin: 0,
                fontSize: 12,
                lineHeight: 1.6,
                color: '#262626',
                background: '#fafafa',
                padding: '8px 10px',
                borderRadius: 4,
              }}
              data-testid={`v3-card-${item.symbol}-tech-text`}
            >
              {item.technical_summary}
            </Paragraph>
          </div>
        )}

        {Array.isArray(item.observation_points) && item.observation_points.length > 0 && (
          <div data-testid={`v3-card-${item.symbol}-obs`}>
            <Space size={6} align="center" style={{ marginBottom: 4 }}>
              <EyeOutlined style={{ fontSize: 13, color: '#722ed1' }} />
              <Text style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>观察点</Text>
            </Space>
            <ul
              style={{
                margin: 0,
                paddingLeft: 18,
                fontSize: 12,
                lineHeight: 1.7,
                color: '#262626',
              }}
            >
              {item.observation_points.map((point, idx) => (
                <li
                  key={`${idx}-${point.slice(0, 8)}`}
                  data-testid={`v3-card-${item.symbol}-obs-${idx}`}
                >
                  {point}
                </li>
              ))}
            </ul>
          </div>
        )}

        {Array.isArray(item.risk_rules) && item.risk_rules.length > 0 && (
          <Alert
            type="error"
            showIcon
            icon={<WarningOutlined />}
            data-testid={`v3-card-${item.symbol}-risk`}
            style={{
              padding: '8px 12px',
              borderRadius: 6,
              border: '1px solid #ffa39e',
              background: '#fff1f0',
            }}
            message={
              <Text style={{ fontSize: 13, fontWeight: 600, color: '#cf1322' }}>风险硬规则</Text>
            }
            description={
              <ul
                style={{
                  margin: '4px 0 0',
                  paddingLeft: 18,
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: '#5c0011',
                }}
              >
                {item.risk_rules.map((rule, idx) => (
                  <li
                    key={`${idx}-${rule.slice(0, 8)}`}
                    data-testid={`v3-card-${item.symbol}-risk-${idx}`}
                  >
                    {rule}
                  </li>
                ))}
              </ul>
            }
          />
        )}

        {/* 查看完整分析 — 父组件触发 modal */}
        <Button
          type="primary"
          block
          icon={<RobotOutlined />}
          onClick={() => onClickDetail?.(item)}
          disabled={!onClickDetail}
          data-testid={`v3-card-${item.symbol}-detail-btn`}
        >
          查看完整分析
        </Button>
      </Space>
    </Card>
  );
};

/** Fallback label — 当 backend dimensions 缺该 key 时, 仍能渲染中文 label. */
function dimensionLabel(key: V3DimensionItem['key']): string {
  switch (key) {
    case 'popularity':
      return '人气';
    case 'logic':
      return '逻辑';
    case 'capital':
      return '资金';
    case 'structure':
      return '结构';
    default:
      return key;
  }
}

export default V3RecommendationCard;
