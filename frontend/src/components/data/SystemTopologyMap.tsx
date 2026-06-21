/**
 * SystemTopologyMap — 系统架构拓扑图 (Sprint 27: 纵向 8 行)
 *
 * 设计原则:
 * - Hero banner 横跨顶部，承担"系统总览 + 汇总状态"
 * - 8 行纵向 stage (L1 数据 → L2 信号 → L3 元决策 → L4 组合 →
 *   L5 执行 → L6 风控 → L7 治理 → L8 复盘)
 *   每行 = 一层, 内部用 grid auto-fit minmax(220px) 横排节点 (响应式 + 自动换行)
 *   对齐 Sprint 24 后端 8 层纵向架构 (backend/src/layers)
 * - Sprint 26 原为横向 8 列, 因桌面宽度溢出 (L5 仅露半边、L6-L8 溢出滚动)
 *   Sprint 27 改纵向 — 沿自然滚动方向铺开, 每个节点 ≥ 220px 不再被压扁
 * - 节点：白底 .modern-card 风格 + 左侧 4px 状态色条 + 右上 antd 状态 Tag，
 *   不再整卡变色，跟同 tab 的 DataHealthDashboard 视觉对齐
 * - SVG 流线 ↓ 竖直贝塞尔 (cpy 控制点 0.4*dy 纵移), 流动动画 2.5s
 * - 移动端不再走单独分支 — grid auto-fit minmax 在窄屏下自动收 1 列, 一套布局走天下
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Spin, Alert, Button, Space, Tag, Tooltip, Statistic, Row, Col } from 'antd';
import {
  ReloadOutlined,
  DeploymentUnitOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  ExclamationCircleOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import api from '../../services/api';

// ---------- types ----------

type StatusKey = 'green' | 'yellow' | 'red' | 'gray';

interface TopologyNode {
  id: string;
  label: string;
  category: string;
  status: StatusKey;
  stats: Record<string, any>;
  lastAction: string;
  lastTrade?: string | null;
}

interface TopologyEdge {
  source: string;
  target: string;
  label: string;
}

interface TopologyData {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  generated_at: string;
}

// ---------- visual tokens ----------

const STATUS_TOKENS: Record<
  StatusKey,
  {
    color: string; // 状态色条 / 文字颜色
    bg: string; // 状态色条背景的低饱和回声 (用于 banner 左边大色条 inset)
    tag: 'success' | 'warning' | 'error' | 'default';
    label: string;
    icon: React.ReactNode;
  }
> = {
  green: {
    color: 'var(--success)',
    bg: 'rgba(0, 143, 107, 0.12)',
    tag: 'success',
    label: '正常',
    icon: <CheckCircleOutlined />,
  },
  yellow: {
    color: 'var(--warning)',
    bg: 'rgba(183, 121, 31, 0.12)',
    tag: 'warning',
    label: '警告',
    icon: <WarningOutlined />,
  },
  red: {
    color: 'var(--danger)',
    bg: 'rgba(209, 67, 67, 0.12)',
    tag: 'error',
    label: '异常',
    icon: <ExclamationCircleOutlined />,
  },
  gray: {
    color: '#bfbfbf',
    bg: 'rgba(191, 191, 191, 0.16)',
    tag: 'default',
    label: '未启',
    icon: <QuestionCircleOutlined />,
  },
};

const ICONS: Record<string, string> = {
  quant_system: '🏛️',
  // L1 数据
  data_collection: '📊',
  macro_env: '🌍',
  capacity_monitor: '📈', // Sprint 23/25 — 容量 + Alpha 衰减
  northbound_data: '🌐', // Batch AQ — 北向资金
  insider_trade_data: '👔', // Batch AQ — 内部增减持
  dragon_tiger_data: '🐉', // Batch AQ — 龙虎榜
  realtime_quote_data: '📡', // Batch AQ — 真盘口 bid/ask
  // L2 信号
  factor_engine: '🧮',
  strategy_engine: '🎯',
  pattern_library: '🧩', // Sprint 13/21 — Bulkowski 15 形态
  factor_correlation: '🕸️', // Batch AQ — 因子相关性矩阵
  factor_ic_monitor: '📉', // Batch AQ — IC 衰减监测
  // L3 元决策 + 仓位
  meta_label_filter: '🎚️',
  autopilot: '🤖',
  sizing_decision: '⚖️', // Phase 2+ Sizing (Kelly / vol_target / ATR)
  ai_analysis_engine_v2: '🧠', // Batch AQ — AI 多维分析引擎 (8 analyzer)
  // L4 组合构建
  portfolio_construction: '📐',
  bl_hrp_qp: '🧪', // Sprint 16/19/20 — Black-Litterman + HRP + QP
  // L5 执行可行性
  execution_feasibility: '🚦',
  portfolio: '💰',
  tca_microstructure: '🔎', // v4/v5 — TCA + Kyle Lambda + RL execution
  live_trading_bridge: '🌉', // Batch AQ — 实盘 bridge
  reconciliation_alert: '🧾', // Batch AQ — 对账主动告警
  // L6 风控
  risk_control: '🛡️',
  kill_switch: '🚨', // Phase 4+ 策略熔断监控
  industry_concentration: '🏭', // Batch AQ — 行业集中度
  restricted_share_watchdog: '🔒', // Batch AQ — 限售解禁
  black_swan_watchdog: '🦢', // Batch AQ — 黑天鹅事件检测
  // L7 资金曲线治理
  equity_curve_governor: '🎛️',
  // L8 复盘 + 归因 + 输出
  outcome_analysis: '🔬', // Phase 5+ root_cause + postmortem
  attribution_brinson: '📊', // Sprint 20/25 — Brinson + MCR + Style + Crowding
  research_integrity: '🧫',
  notification: '🔔',
  daily_attribution: '📅', // Batch AQ — 每日归因
  ai_diary: '📔', // Batch AQ — AI 日记
  improvement_suggestions: '💡', // Batch AQ — 改进建议闭环
  black_swan_postmortem: '📝', // Batch AQ — 黑天鹅复盘
  // L9 平台层 (Batch AQ NEW)
  user_feedback: '💬',
  trade_reason: '🗂️',
  scheduler: '⏱️',
};

// 纵向 stage 布局 — Sprint 24 后端 8 层 + Batch AQ +L9 平台层 = 9 行
const STAGES: { key: string; label: string; sub: string; nodes: string[] }[] = [
  {
    key: 'L1_data',
    label: 'L1 数据',
    sub: 'Data',
    nodes: [
      'data_collection',
      'macro_env',
      'capacity_monitor',
      'northbound_data',
      'insider_trade_data',
      'dragon_tiger_data',
      'realtime_quote_data',
    ],
  },
  {
    key: 'L2_signal',
    label: 'L2 信号',
    sub: 'Signal',
    nodes: [
      'factor_engine',
      'strategy_engine',
      'pattern_library',
      'factor_correlation',
      'factor_ic_monitor',
    ],
  },
  {
    key: 'L3_meta',
    label: 'L3 元决策',
    sub: 'Meta',
    nodes: ['meta_label_filter', 'autopilot', 'sizing_decision', 'ai_analysis_engine_v2'],
  },
  {
    key: 'L4_construction',
    label: 'L4 组合',
    sub: 'Build',
    nodes: ['portfolio_construction', 'bl_hrp_qp'],
  },
  {
    key: 'L5_feasibility',
    label: 'L5 执行',
    sub: 'Execute',
    nodes: [
      'execution_feasibility',
      'portfolio',
      'tca_microstructure',
      'live_trading_bridge',
      'reconciliation_alert',
    ],
  },
  {
    key: 'L6_risk',
    label: 'L6 风控',
    sub: 'Risk',
    nodes: [
      'risk_control',
      'kill_switch',
      'industry_concentration',
      'restricted_share_watchdog',
      'black_swan_watchdog',
    ],
  },
  {
    key: 'L7_governor',
    label: 'L7 治理',
    sub: 'Governor',
    nodes: ['equity_curve_governor'],
  },
  {
    key: 'L8_reflection',
    label: 'L8 复盘',
    sub: 'Reflect',
    nodes: [
      'outcome_analysis',
      'attribution_brinson',
      'research_integrity',
      'notification',
      'daily_attribution',
      'ai_diary',
      'improvement_suggestions',
      'black_swan_postmortem',
    ],
  },
  {
    key: 'L9_platform',
    label: 'L9 平台',
    sub: 'Platform',
    nodes: ['user_feedback', 'trade_reason', 'scheduler'],
  },
];

// 节点 -> 所在 stage 的 index (用于 SVG 跨列连线过滤)
const NODE_STAGE: Record<string, number> = (() => {
  const out: Record<string, number> = {};
  STAGES.forEach((s, si) =>
    s.nodes.forEach(id => {
      out[id] = si;
    })
  );
  return out;
})();

// ---------- styles (内联 + ensureKeyframes 注入全局动画) ----------

const KEYFRAMES_ID = 'topology-flow-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  // 流动粒子：缓 (2.5s) + dasharray 4 6 比之前 8 4 更细密
  // 节点 hover：translateY(-1px) 跟项目通用微交互一致
  // banner 警示脉冲：仅 status=red 时给 hero banner 用
  style.textContent = `
    @keyframes topology-flow {
      0% { stroke-dashoffset: 10; }
      100% { stroke-dashoffset: 0; }
    }
    @keyframes topology-banner-pulse-red {
      0%, 100% { box-shadow: 0 0 0 0 rgba(209, 67, 67, 0.35); }
      50% { box-shadow: 0 0 0 8px rgba(209, 67, 67, 0); }
    }
    .topology-node {
      transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
    }
    .topology-node:hover {
      transform: translateY(-1px);
      box-shadow: 0 14px 32px rgba(18, 36, 63, 0.11) !important;
    }
    .topology-flow-line {
      stroke-dasharray: 4 6;
      animation: topology-flow 2.5s linear infinite;
    }
    .topology-stage__index {
      width: 22px; height: 22px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 600;
      background: var(--primary-soft);
      color: var(--primary-strong);
      margin-right: 8px;
    }
    .topology-stage__divider {
      height: 1px;
      background: linear-gradient(90deg, rgba(39, 100, 184, 0.18), rgba(39, 100, 184, 0.04) 70%, transparent);
      margin: 6px 0 14px;
    }
  `;
  document.head.appendChild(style);
}

// ---------- hero banner ----------

interface HeroBannerProps {
  node?: TopologyNode;
  summary: { green: number; yellow: number; red: number; gray: number };
  generatedAt?: string;
  onReload: () => void;
  loading: boolean;
}

const HeroBanner: React.FC<HeroBannerProps> = ({
  node,
  summary,
  generatedAt,
  onReload,
  loading,
}) => {
  const tokens = STATUS_TOKENS[node?.status || 'gray'];
  const isRed = node?.status === 'red';

  // 从 quant_system.stats / lastAction 抽核心数字
  // lastAction 文本是 "14 数据源 / 20 因子 / 13 策略"，直接用作副标题
  const stats = node?.stats || {};

  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 14,
        padding: '18px 22px 18px 26px',
        marginBottom: 20,
        background: 'linear-gradient(135deg, rgba(39, 100, 184, 0.04), rgba(15, 166, 166, 0.04))',
        border: '1px solid rgba(15, 23, 42, 0.06)',
        boxShadow: '0 6px 18px rgba(18, 36, 63, 0.045)',
        overflow: 'hidden',
        animation: isRed ? 'topology-banner-pulse-red 2s ease-in-out infinite' : 'none',
      }}
    >
      {/* 左侧 4px 状态色条 */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 4,
          background: tokens.color,
        }}
      />
      <Row align="middle" gutter={[16, 12]} wrap>
        {/* 左：图标 + 标题 + 副标题 */}
        <Col xs={24} sm={24} md={9}>
          <Space size={14} align="center">
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: tokens.bg,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
              }}
            >
              {ICONS.quant_system}
            </div>
            <div>
              <div
                style={{
                  fontSize: 17,
                  fontWeight: 700,
                  color: 'var(--text-main)',
                  lineHeight: 1.2,
                }}
              >
                {node?.label || '量化推荐系统'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
                {node?.lastAction || '系统状态汇总'}
              </div>
            </div>
          </Space>
        </Col>

        {/* 中：4 个 statistic */}
        <Col xs={24} sm={16} md={11}>
          <Row gutter={[16, 8]}>
            <Col span={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>数据源</span>}
                value={
                  Number(stats.totalSources ?? stats.sources ?? 0) ||
                  extractNumber(node?.lastAction, /(\d+)\s*数据源/)
                }
                valueStyle={{ fontSize: 18, fontWeight: 600, color: 'var(--text-main)' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>因子</span>}
                value={
                  Number(stats.factorCount ?? 0) || extractNumber(node?.lastAction, /(\d+)\s*因子/)
                }
                valueStyle={{ fontSize: 18, fontWeight: 600, color: 'var(--text-main)' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>活跃策略</span>}
                value={
                  Number(stats.activeModules ?? 0) ||
                  extractNumber(node?.lastAction, /(\d+)\s*策略/)
                }
                valueStyle={{ fontSize: 18, fontWeight: 600, color: 'var(--text-main)' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={<span style={{ fontSize: 11, color: 'var(--text-muted)' }}>调度任务</span>}
                value={Number(stats.totalCrons ?? 0)}
                valueStyle={{ fontSize: 18, fontWeight: 600, color: 'var(--text-main)' }}
              />
            </Col>
          </Row>
        </Col>

        {/* 右：汇总状态 Tag + 时间 + 刷新 */}
        <Col xs={24} sm={8} md={4} style={{ textAlign: 'right' }}>
          <Space direction="vertical" align="end" size={6} style={{ width: '100%' }}>
            <Space size={4} wrap>
              {summary.green > 0 && <Tag color="success">{summary.green} 正常</Tag>}
              {summary.yellow > 0 && <Tag color="warning">{summary.yellow} 警告</Tag>}
              {summary.red > 0 && <Tag color="error">{summary.red} 异常</Tag>}
              {summary.gray > 0 && <Tag>{summary.gray} 未启</Tag>}
            </Space>
            <Space size={6}>
              {generatedAt && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {new Date(generatedAt).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
              <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={onReload}>
                刷新
              </Button>
            </Space>
          </Space>
        </Col>
      </Row>
    </div>
  );
};

// 从 lastAction 抠数字 (e.g. "14 数据源" => 14) 作为 stats 缺失时的兜底
function extractNumber(text: string | undefined, pattern: RegExp): number {
  if (!text) return 0;
  const m = text.match(pattern);
  return m ? Number(m[1]) : 0;
}

// ---------- node card ----------

const NodeCard: React.FC<{ node: TopologyNode; nodeId: string }> = ({ node, nodeId }) => {
  const tokens = STATUS_TOKENS[node.status];

  // tooltip 内容：精简 - lastAction + 关键 stats (过滤掉 null/undefined)
  const tooltipStats = Object.entries(node.stats || {})
    .filter(([_, v]) => v !== null && v !== undefined && v !== '')
    .slice(0, 6);

  const tooltipContent = (
    <div style={{ minWidth: 200 }}>
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>
        {ICONS[nodeId]} {node.label}
      </div>
      <div style={{ fontSize: 12, marginBottom: 6, opacity: 0.9 }}>{node.lastAction}</div>
      {node.lastTrade && (
        <div style={{ marginTop: 4, marginBottom: 6, color: '#91d5ff', fontSize: 12 }}>
          最近交易: {node.lastTrade}
        </div>
      )}
      {tooltipStats.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: 6, marginTop: 6 }}>
          {tooltipStats.map(([k, v]) => (
            <div key={k} style={{ fontSize: 11, opacity: 0.85 }}>
              {k}: {typeof v === 'number' ? v.toLocaleString() : String(v)}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <Tooltip title={tooltipContent} placement="top" mouseEnterDelay={0.2}>
      <div
        className="topology-node"
        data-node-id={nodeId}
        style={{
          background:
            'linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(248, 250, 252, 0.98))',
          borderRadius: 12,
          padding: '12px 14px 12px 14px',
          border: '1px solid rgba(15, 23, 42, 0.07)',
          borderLeft: `4px solid ${tokens.color}`,
          boxShadow: '0 4px 12px rgba(18, 36, 63, 0.05)',
          cursor: 'default',
          position: 'relative',
        }}
      >
        {/* 顶行：emoji + 名称 + 状态 Tag */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 6,
            gap: 6,
          }}
        >
          <Space size={6} align="center" style={{ minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>{ICONS[nodeId] || '📦'}</span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--text-main)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {node.label}
            </span>
          </Space>
          <Tag
            color={tokens.tag}
            style={{ marginRight: 0, fontSize: 11, lineHeight: '18px', padding: '0 6px' }}
          >
            {tokens.label}
          </Tag>
        </div>

        {/* 中行：lastAction 1 行省略 */}
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
            lineHeight: 1.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {node.lastAction || '—'}
        </div>
      </div>
    </Tooltip>
  );
};

// ---------- SVG flow lines (Sprint 27: 竖直贝塞尔; Sprint 40: hover 高亮 + 绕行) ----------

// stage row 之间纵向间距
const ROW_GAP_Y = 24;
// 单个 stage row 内, 节点之间横向间距
const NODE_GAP_X = 12;

interface FlowLinesProps {
  edges: TopologyEdge[];
  stageRefs: Record<string, HTMLDivElement | null>;
  containerEl: HTMLDivElement | null;
}

const FlowLines: React.FC<FlowLinesProps> = ({ edges, stageRefs, containerEl }) => {
  // Sprint 40: hover 状态 — 哪条边被悬停;
  // 同时记录被它连接的两个 node id 让上层 ref 高亮 ring
  const [hoveredEdgeIdx, setHoveredEdgeIdx] = useState<number | null>(null);

  // 只渲染 跨 stage 的 edge (targetStage > sourceStage)
  // 同行 edge 视觉冗余，丢掉；从 quant_system 出发的"调度"线丢掉 (banner 已表达了系统层关系)
  const visibleEdges = edges.filter(e => {
    const ss = NODE_STAGE[e.source];
    const ts = NODE_STAGE[e.target];
    if (ss === undefined || ts === undefined) return false;
    return ts > ss;
  });

  // 节点边界 + 中心坐标：从 DOM 实测，比硬编码 grid 精确
  const getNodeGeo = (id: string): { cx: number; topY: number; botY: number } | null => {
    const el = stageRefs[id];
    if (!el || !containerEl) return null;
    const a = el.getBoundingClientRect();
    const b = containerEl.getBoundingClientRect();
    return {
      cx: a.left - b.left + a.width / 2,
      topY: a.top - b.top,
      botY: a.top - b.top + a.height,
    };
  };

  return (
    <svg
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        // Sprint 40: SVG 整体收 pointer event, 但每条 path 单独 stroke 接受 hover
        // (NodeCard 的 pointer event 完全不受影响, 因为 node 在 zIndex:1, SVG zIndex:0)
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <defs>
        <marker
          id="topology-arrow-v3"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="rgba(39, 100, 184, 0.7)" />
        </marker>
        <marker
          id="topology-arrow-active"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--primary, #2764b8)" />
        </marker>
      </defs>
      {visibleEdges.map((edge, i) => {
        const from = getNodeGeo(edge.source);
        const to = getNodeGeo(edge.target);
        if (!from || !to) return null;
        // 竖直贝塞尔: source 节点底边出, target 节点顶边进
        const fromX = from.cx;
        const fromY = from.botY;
        const toX = to.cx;
        const toY = to.topY;
        const dy = toY - fromY;
        // 纵向控制点偏移 — Sprint 40 加深: 用 0.55*dy 而不是 0.4*dy, 让贝塞尔
        // 向源/目标外伸更远, 避免穿过其他节点; min 50 让短距离边也有"弧度感"
        const cpy1 = fromY + Math.max(Math.abs(dy) * 0.55, 50) * Math.sign(dy || 1);
        const cpy2 = toY - Math.max(Math.abs(dy) * 0.55, 50) * Math.sign(dy || 1);
        const path = `M ${fromX} ${fromY} C ${fromX} ${cpy1}, ${toX} ${cpy2}, ${toX} ${toY}`;

        const isHovered = hoveredEdgeIdx === i;
        const isDimmed = hoveredEdgeIdx !== null && !isHovered;

        // 三层结构 (Sprint 40):
        //   1. 静态底线 — 总能见, 微浅蓝
        //   2. 流动粒子线 — 主视觉, hover 时颜色变深+变粗
        //   3. 不可见 hit 区 — strokeWidth 12, 透明, 接 mouse hover (扩大热区, 不挡视觉)
        return (
          <g
            key={`${edge.source}-${edge.target}-${i}`}
            style={{ pointerEvents: 'auto' }}
            onMouseEnter={() => setHoveredEdgeIdx(i)}
            onMouseLeave={() => setHoveredEdgeIdx(null)}
          >
            {/* 1. 静态底线 — Sprint 40 调深, dim 时变更淡 */}
            <path
              d={path}
              fill="none"
              stroke={isDimmed ? 'rgba(39, 100, 184, 0.05)' : 'rgba(39, 100, 184, 0.18)'}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ pointerEvents: 'none', transition: 'stroke 0.18s ease' }}
            />
            {/* 2. 流动粒子线 — hover 时高亮 */}
            <path
              d={path}
              fill="none"
              stroke={
                isHovered
                  ? 'var(--primary, #2764b8)'
                  : isDimmed
                    ? 'rgba(39, 100, 184, 0.2)'
                    : 'rgba(39, 100, 184, 0.65)'
              }
              strokeWidth={isHovered ? 3.5 : 2}
              strokeLinecap="round"
              markerEnd={isHovered ? 'url(#topology-arrow-active)' : 'url(#topology-arrow-v3)'}
              className="topology-flow-line"
              style={{
                pointerEvents: 'none',
                transition: 'stroke 0.18s ease, stroke-width 0.18s ease',
                filter: isHovered ? 'drop-shadow(0 0 4px rgba(39, 100, 184, 0.45))' : 'none',
              }}
            />
            {/* 3. 不可见 hit 区 — 扩大鼠标 hover 命中范围 (流动粒子线本身才 2px 太细难命中) */}
            <path
              d={path}
              fill="none"
              stroke="transparent"
              strokeWidth={12}
              strokeLinecap="round"
              style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
            >
              <title>{`${edge.label || '→'}\n${edge.source} → ${edge.target}`}</title>
            </path>
          </g>
        );
      })}
    </svg>
  );
};

// ---------- main component ----------

const SystemTopologyMap: React.FC = () => {
  const [data, setData] = useState<TopologyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  // 用于 SVG 计算节点位置：key = node id, value = node card DOM
  const nodeRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // 触发 SVG 重画的 tick (resize / 数据更新都 ++)
  const [redrawTick, setRedrawTick] = useState(0);

  useEffect(() => {
    ensureKeyframes();
  }, []);

  // 监听容器宽度变化，触发 SVG 重画 (节点 grid auto-fit 可能换行 → 节点中心位移)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setRedrawTick(t => t + 1));
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get('/data/system-topology');
      setData(resp.data?.data);
      // 数据加载完后下一帧再触发重画（等节点 DOM 挂载）
      requestAnimationFrame(() => setRedrawTick(t => t + 1));
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const tm = setInterval(() => void load(), 60_000);
    return () => clearInterval(tm);
  }, [load]);

  const nodeMap = useMemo(() => {
    if (!data) return new Map<string, TopologyNode>();
    return new Map(data.nodes.map(n => [n.id, n]));
  }, [data]);

  const summary = useMemo(() => {
    const init = { green: 0, yellow: 0, red: 0, gray: 0 };
    if (!data) return init;
    // 不算 hero 节点 (quant_system) - 它的状态是聚合的，避免双计
    for (const n of data.nodes) {
      if (n.id === 'quant_system') continue;
      if (n.status in init) (init as any)[n.status]++;
    }
    return init;
  }, [data]);

  // SVG 用：传入 setNodeRef 让 NodeCard 把自己 DOM 挂上来
  const setNodeRef = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      nodeRefs.current[id] = el;
    },
    []
  );

  // ===== render =====

  return (
    <Card
      className="modern-card"
      variant="borderless"
      size="small"
      title={
        <Space>
          <DeploymentUnitOutlined style={{ color: 'var(--primary)' }} />
          <span style={{ fontWeight: 600 }}>系统架构拓扑</span>
        </Space>
      }
      style={{ marginBottom: 16 }}
      styles={{ body: { padding: '16px 18px 18px' } }}
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}

      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin tip="加载系统拓扑..." />
        </div>
      ) : data ? (
        <>
          {/* Hero banner */}
          <HeroBanner
            node={nodeMap.get('quant_system')}
            summary={summary}
            generatedAt={data.generated_at}
            onReload={() => void load()}
            loading={loading}
          />

          {/* ---- 纵向 8 行 Pipeline (L1..L8) ---- */}
          <div
            ref={containerRef}
            style={{
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              gap: ROW_GAP_Y,
              padding: '4px 4px 8px',
            }}
            data-redraw-tick={redrawTick}
          >
            {/* SVG 流线层 (绝对定位铺满整个 container) */}
            <FlowLines
              edges={data.edges}
              stageRefs={nodeRefs.current}
              containerEl={containerRef.current}
            />

            {/* 8 个 stage 行 (L1..L8) */}
            {STAGES.map((stage, si) => (
              <div key={stage.key} style={{ position: 'relative', zIndex: 1 }}>
                {/* stage row header — 左上一排: 圆形 index + 中文名 + 英文 sub */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    marginBottom: 8,
                  }}
                >
                  <span className="topology-stage__index">{si + 1}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)' }}>
                    {stage.label}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
                    {stage.sub}
                  </span>
                </div>

                {/* stage 内节点 — grid auto-fit minmax 自动换行;
                    桌面端通常每行 3-4 节点, 窄屏自动收缩到 1-2 节点 */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: NODE_GAP_X,
                  }}
                >
                  {stage.nodes.map(id => {
                    const n = nodeMap.get(id);
                    if (!n) return null;
                    return (
                      <div key={id} ref={setNodeRef(id)} style={{ width: '100%' }}>
                        <NodeCard node={n} nodeId={id} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </Card>
  );
};

export default SystemTopologyMap;
