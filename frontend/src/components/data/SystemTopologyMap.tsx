/**
 * SystemTopologyMap — 系统架构拓扑图 (纯 CSS/SVG 版本)
 *
 * 设计原则:
 * - 5 层从上到下的清晰层级 (数据层 → 计算层 → 决策层 → 执行层 → 输出层)
 * - 每个节点是 antd Card 风格的卡片 (icon + 标题 + 状态指示灯 + 最近动作)
 * - SVG 连线 + CSS @keyframes 做流动粒子动画
 * - 状态颜色: 绿色脉冲 = 正常, 黄色 = 警告, 红色闪烁 = 异常, 灰色 = 未启动
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Spin, Alert, Button, Space, Tag, Tooltip } from 'antd';
import { ReloadOutlined, DeploymentUnitOutlined } from '@ant-design/icons';
import api from '../../services/api';

interface TopologyNode {
  id: string;
  label: string;
  category: string;
  status: 'green' | 'yellow' | 'red' | 'gray';
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

const STATUS_CONFIG: Record<string, { color: string; bg: string; border: string; label: string; pulse: boolean }> = {
  green: { color: '#52c41a', bg: '#f6ffed', border: '#b7eb8f', label: '正常', pulse: true },
  yellow: { color: '#faad14', bg: '#fffbe6', border: '#ffe58f', label: '警告', pulse: false },
  red: { color: '#f5222d', bg: '#fff2f0', border: '#ffa39e', label: '异常', pulse: true },
  gray: { color: '#8c8c8c', bg: '#fafafa', border: '#d9d9d9', label: '未启动', pulse: false },
};

const ICONS: Record<string, string> = {
  quant_system: '🏛️',
  data_collection: '📊',
  macro_env: '🌍',
  factor_engine: '🧮',
  strategy_engine: '🎯',
  autopilot: '🤖',
  risk_control: '🛡️',
  portfolio: '💰',
  notification: '🔔',
};

const LAYER_LABELS = ['核心', '数据层', '计算层', '决策层', '执行层'];

// 5 层布局: 每层的节点 id
const LAYERS: string[][] = [
  ['quant_system'],
  ['data_collection', 'macro_env'],
  ['factor_engine', 'strategy_engine'],
  ['autopilot', 'risk_control'],
  ['portfolio', 'notification'],
];

// 节点在 grid 中的 (col, row) — 用于 SVG 连线计算
const NODE_POS: Record<string, { col: number; row: number }> = {
  quant_system:    { col: 1, row: 0 },
  data_collection: { col: 0, row: 1 },
  macro_env:       { col: 2, row: 1 },
  factor_engine:   { col: 0, row: 2 },
  strategy_engine: { col: 2, row: 2 },
  autopilot:       { col: 0, row: 3 },
  risk_control:    { col: 2, row: 3 },
  portfolio:       { col: 0, row: 4 },
  notification:    { col: 2, row: 4 },
};

// ===== CSS-in-JS styles =====
const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    width: '100%',
    minHeight: 680,
    background: 'linear-gradient(180deg, #f0f5ff 0%, #f5f5f5 100%)',
    borderRadius: 8,
    padding: '24px 16px',
    overflow: 'hidden',
  },
  layerRow: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 32,
    marginBottom: 20,
    position: 'relative',
    zIndex: 2,
  },
  nodeCard: {
    width: 200,
    borderRadius: 12,
    cursor: 'pointer',
    transition: 'all 0.3s ease',
    position: 'relative',
    overflow: 'visible',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    display: 'inline-block',
    marginRight: 6,
  },
  svgOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: 1,
  },
};

// 流动粒子 CSS keyframes (注入一次)
const KEYFRAMES_ID = 'topology-flow-keyframes';
function ensureKeyframes() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(KEYFRAMES_ID)) return;
  const style = document.createElement('style');
  style.id = KEYFRAMES_ID;
  style.textContent = `
    @keyframes topology-flow {
      0% { stroke-dashoffset: 24; }
      100% { stroke-dashoffset: 0; }
    }
    @keyframes topology-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(82, 196, 26, 0.4); }
      50% { box-shadow: 0 0 0 6px rgba(82, 196, 26, 0); }
    }
    @keyframes topology-pulse-red {
      0%, 100% { box-shadow: 0 0 0 0 rgba(245, 34, 45, 0.4); }
      50% { box-shadow: 0 0 0 8px rgba(245, 34, 45, 0); }
    }
    .topology-node:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(0,0,0,0.12) !important;
    }
    .topology-flow-line {
      stroke-dasharray: 8 4;
      animation: topology-flow 1.5s linear infinite;
    }
  `;
  document.head.appendChild(style);
}

// 节点卡片组件
const NodeCard: React.FC<{ node: TopologyNode }> = ({ node }) => {
  const cfg = STATUS_CONFIG[node.status] || STATUS_CONFIG.gray;
  const pulseAnim = node.status === 'green' ? 'topology-pulse 2s ease-in-out infinite' :
                    node.status === 'red' ? 'topology-pulse-red 1s ease-in-out infinite' : 'none';
  return (
    <Tooltip
      title={
        <div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{ICONS[node.id]} {node.label}</div>
          <div>{node.lastAction}</div>
          {node.lastTrade && <div style={{ marginTop: 4, color: '#91d5ff' }}>最近交易: {node.lastTrade}</div>}
          {Object.entries(node.stats || {}).filter(([_, v]) => v != null).map(([k, v]) => (
            <div key={k} style={{ fontSize: 11 }}>{k}: {typeof v === 'number' ? v.toLocaleString() : String(v)}</div>
          ))}
        </div>
      }
      placement="right"
    >
      <div
        className="topology-node"
        style={{
          ...styles.nodeCard,
          background: cfg.bg,
          border: `2px solid ${cfg.border}`,
          padding: '12px 14px',
          animation: pulseAnim,
        }}
      >
        {/* 状态指示灯 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 20 }}>{ICONS[node.id] || '📦'}</span>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ ...styles.statusDot, backgroundColor: cfg.color }} />
            <span style={{ fontSize: 11, color: cfg.color, fontWeight: 500 }}>{cfg.label}</span>
          </div>
        </div>
        {/* 标题 */}
        <div style={{ fontSize: 14, fontWeight: 600, color: '#262626', marginBottom: 4 }}>
          {node.label}
        </div>
        {/* 最近动作 */}
        <div style={{
          fontSize: 11,
          color: '#8c8c8c',
          lineHeight: 1.4,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {node.lastAction}
        </div>
      </div>
    </Tooltip>
  );
};

// SVG 连线 — 带流动粒子
const FlowLines: React.FC<{ edges: TopologyEdge[]; containerWidth: number }> = ({ edges, containerWidth }) => {
  // 计算每个节点的中心坐标 (基于 grid 布局)
  const nodeWidth = 200;
  const nodeHeight = 100;
  const gapX = 32;
  const rowHeight = 130;
  const topPadding = 24;

  const getNodeCenter = (id: string): { x: number; y: number } => {
    const pos = NODE_POS[id];
    if (!pos) return { x: containerWidth / 2, y: 300 };

    const layer = LAYERS[pos.row] || [];
    const layerWidth = layer.length * nodeWidth + (layer.length - 1) * gapX;
    const layerStartX = (containerWidth - layerWidth) / 2;

    const colIndex = layer.indexOf(id);
    const x = layerStartX + colIndex * (nodeWidth + gapX) + nodeWidth / 2;
    const y = topPadding + pos.row * rowHeight + nodeHeight / 2;
    return { x, y };
  };

  return (
    <svg style={styles.svgOverlay}>
      <defs>
        <marker id="topology-arrow" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#1677ff" opacity="0.6" />
        </marker>
      </defs>
      {edges.map((edge, i) => {
        const from = getNodeCenter(edge.source);
        const to = getNodeCenter(edge.target);
        // 贝塞尔曲线控制点
        const midY = (from.y + to.y) / 2;
        const dx = to.x - from.x;
        const cpx1 = from.x + dx * 0.1;
        const cpx2 = to.x - dx * 0.1;
        const path = `M ${from.x} ${from.y + 20} C ${cpx1} ${midY}, ${cpx2} ${midY}, ${to.x} ${to.y - 20}`;
        return (
          <g key={i}>
            {/* 底线 (静态) */}
            <path
              d={path}
              fill="none"
              stroke="#e0e0e0"
              strokeWidth={2}
              markerEnd="url(#topology-arrow)"
            />
            {/* 流动线 (动态) */}
            <path
              d={path}
              fill="none"
              stroke="#1677ff"
              strokeWidth={2}
              opacity={0.5}
              className="topology-flow-line"
            />
          </g>
        );
      })}
    </svg>
  );
};

const SystemTopologyMap: React.FC = () => {
  const [data, setData] = useState<TopologyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const containerRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => { ensureKeyframes(); }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(entries => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    obs.observe(el);
    setContainerWidth(el.clientWidth);
    return () => obs.disconnect();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await api.get('/data/system-topology');
      setData(resp.data?.data);
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

  const statusSummary = useMemo(() => {
    if (!data) return null;
    return {
      green: data.nodes.filter(n => n.status === 'green').length,
      yellow: data.nodes.filter(n => n.status === 'yellow').length,
      red: data.nodes.filter(n => n.status === 'red').length,
      gray: data.nodes.filter(n => n.status === 'gray').length,
    };
  }, [data]);

  return (
    <Card
      size="small"
      title={
        <Space>
          <DeploymentUnitOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontWeight: 600 }}>系统架构拓扑</span>
          {statusSummary && (
            <>
              {statusSummary.green > 0 && <Tag color="green">{statusSummary.green} 正常</Tag>}
              {statusSummary.yellow > 0 && <Tag color="orange">{statusSummary.yellow} 警告</Tag>}
              {statusSummary.red > 0 && <Tag color="red">{statusSummary.red} 异常</Tag>}
              {statusSummary.gray > 0 && <Tag>{statusSummary.gray} 未启</Tag>}
            </>
          )}
        </Space>
      }
      extra={
        <Space size={4}>
          {data?.generated_at && (
            <span style={{ fontSize: 11, color: '#999' }}>
              {new Date(data.generated_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        </Space>
      }
      style={{ marginBottom: 16 }}
    >
      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}
      {loading && !data ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin tip="加载系统拓扑..." /></div>
      ) : data ? (
        <div ref={containerRef} style={styles.container}>
          {/* SVG 连线层 */}
          <FlowLines edges={data.edges} containerWidth={containerWidth} />

          {/* 节点层 */}
          {LAYERS.map((layerIds, layerIndex) => (
            <div key={layerIndex} style={{
              ...styles.layerRow,
              marginTop: layerIndex === 0 ? 0 : 4,
            }}>
              {/* 层级标签 */}
              {layerIndex > 0 && (
                <div style={{
                  position: 'absolute',
                  left: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  fontSize: 10,
                  color: '#bfbfbf',
                  writingMode: 'vertical-rl',
                  letterSpacing: 2,
                }}>
                  {LAYER_LABELS[layerIndex] || ''}
                </div>
              )}
              {layerIds.map(id => {
                const node = nodeMap.get(id);
                if (!node) return <div key={id} style={{ width: 200 }} />;
                return <NodeCard key={id} node={node} />;
              })}
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
};

export default SystemTopologyMap;
