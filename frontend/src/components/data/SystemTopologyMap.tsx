/**
 * SystemTopologyMap — 系统架构拓扑图
 *
 * 用 echarts graph 类型渲染：
 * - 9 个节点（量化系统/数据采集/宏观/因子/策略/自主决策/风控/模拟盘/通知）
 * - 动态数据流连线（箭头 + 流动效果）
 * - 节点颜色 = 真实健康状态 (green/yellow/red/gray)
 * - hover 显示详细信息
 *
 * 数据来自 GET /api/data/system-topology
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Card, Spin, Alert, Button, Space, Tag } from 'antd';
import { ReloadOutlined, DeploymentUnitOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
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

const STATUS_COLORS: Record<string, string> = {
  green: '#52c41a',
  yellow: '#faad14',
  red: '#f5222d',
  gray: '#d9d9d9',
};

const STATUS_LABELS: Record<string, string> = {
  green: '正常',
  yellow: '警告',
  red: '异常',
  gray: '未启动',
};

// 手动布局坐标 (0-1000 x 0-600)
const NODE_POSITIONS: Record<string, [number, number]> = {
  quant_system: [500, 30],
  data_collection: [200, 140],
  macro_env: [800, 140],
  factor_engine: [350, 260],
  strategy_engine: [250, 380],
  risk_control: [750, 380],
  autopilot: [500, 460],
  portfolio: [300, 560],
  notification: [700, 560],
};

const CATEGORY_ICONS: Record<string, string> = {
  core: '🏛',
  data: '📊',
  compute: '🧮',
  decision: '🧠',
  execution: '💰',
  output: '🔔',
};

function buildOption(data: TopologyData): Record<string, any> {
  const nodes = data.nodes.map((n) => ({
    name: n.id,
    x: NODE_POSITIONS[n.id]?.[0] ?? 500,
    y: NODE_POSITIONS[n.id]?.[1] ?? 300,
    symbolSize: n.id === 'quant_system' ? [180, 50] : [150, 44],
    symbol: 'roundRect',
    itemStyle: {
      color: STATUS_COLORS[n.status] || '#d9d9d9',
      borderColor: n.id === 'quant_system' ? '#1677ff' : '#e8e8e8',
      borderWidth: n.id === 'quant_system' ? 3 : 1,
      shadowBlur: n.status === 'red' ? 12 : 4,
      shadowColor: n.status === 'red' ? 'rgba(245,34,45,0.4)' : 'rgba(0,0,0,0.1)',
    },
    label: {
      show: true,
      formatter: `{icon|${CATEGORY_ICONS[n.category] || '📦'}} {title|${n.label}}\n{status|${STATUS_LABELS[n.status]}}`,
      rich: {
        icon: { fontSize: 14, lineHeight: 20 },
        title: { fontSize: 13, fontWeight: 'bold', color: '#fff', lineHeight: 20 },
        status: { fontSize: 10, color: 'rgba(255,255,255,0.85)', lineHeight: 16 },
      },
      color: '#fff',
    },
    // 自定义数据给 tooltip 用
    value: n,
  }));

  const edges = data.edges.map((e) => ({
    source: e.source,
    target: e.target,
    label: {
      show: true,
      formatter: e.label,
      fontSize: 9,
      color: '#999',
    },
    lineStyle: {
      color: '#c0c0c0',
      width: 1.5,
      curveness: 0.15,
      type: 'solid',
    },
    // 流动效果
    effect: {
      show: true,
      period: 4 + Math.random() * 3, // 4-7 秒随机
      trailLength: 0.3,
      symbol: 'arrow',
      symbolSize: 6,
      color: '#1677ff',
    },
  }));

  return {
    animation: true,
    tooltip: {
      trigger: 'item',
      formatter: (params: any) => {
        if (params.dataType === 'node') {
          const n = params.data?.value as TopologyNode;
          if (!n) return params.name;
          let html = `<div style="font-weight:bold;margin-bottom:6px">${CATEGORY_ICONS[n.category] || ''} ${n.label}</div>`;
          html += `<div>状态: <span style="color:${STATUS_COLORS[n.status]}">${STATUS_LABELS[n.status]}</span></div>`;
          html += `<div style="margin-top:4px;font-size:12px;color:#666">${n.lastAction}</div>`;
          if (n.lastTrade) {
            html += `<div style="margin-top:2px;font-size:11px;color:#888">最近交易: ${n.lastTrade}</div>`;
          }
          // stats
          const statsEntries = Object.entries(n.stats || {}).filter(([_, v]) => v != null);
          if (statsEntries.length > 0) {
            html += '<div style="margin-top:6px;border-top:1px solid #f0f0f0;padding-top:4px;font-size:11px">';
            for (const [k, v] of statsEntries) {
              html += `<div>${k}: ${typeof v === 'number' ? v.toLocaleString() : v}</div>`;
            }
            html += '</div>';
          }
          return html;
        }
        if (params.dataType === 'edge') {
          return `${params.data?.label || ''} (${params.data?.source} → ${params.data?.target})`;
        }
        return '';
      },
    },
    series: [
      {
        type: 'graph',
        layout: 'none',
        roam: false,
        coordinateSystem: undefined,
        data: nodes,
        links: edges,
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: [0, 8],
        emphasis: {
          focus: 'adjacency',
          itemStyle: {
            shadowBlur: 20,
            shadowColor: 'rgba(0,0,0,0.3)',
          },
        },
        lineStyle: {
          opacity: 0.6,
        },
      },
    ],
  };
}

const SystemTopologyMap: React.FC = () => {
  const [data, setData] = useState<TopologyData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // 60 秒自动刷新
    const tm = setInterval(() => void load(), 60_000);
    return () => clearInterval(tm);
  }, [load]);

  const statusSummary = data?.nodes
    ? {
        green: data.nodes.filter((n) => n.status === 'green').length,
        yellow: data.nodes.filter((n) => n.status === 'yellow').length,
        red: data.nodes.filter((n) => n.status === 'red').length,
        gray: data.nodes.filter((n) => n.status === 'gray').length,
      }
    : null;

  return (
    <Card
      size="small"
      title={
        <Space>
          <DeploymentUnitOutlined style={{ color: '#1677ff' }} />
          <span style={{ fontWeight: 600 }}>系统架构拓扑</span>
          {statusSummary && (
            <>
              <Tag color="green">{statusSummary.green} 正常</Tag>
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
        <div style={{ textAlign: 'center', padding: 60 }}>
          <Spin tip="加载系统拓扑..." />
        </div>
      ) : data ? (
        <ReactECharts
          option={buildOption(data)}
          style={{ height: 620, width: '100%' }}
          notMerge
          lazyUpdate
        />
      ) : null}
    </Card>
  );
};

export default SystemTopologyMap;
