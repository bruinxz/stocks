import React, { useMemo } from 'react';
import { Typography } from 'antd';

/**
 * 轻量 20d sparkline — 纯 SVG, 不引 ECharts / recharts (~1.5MB chunk).
 *
 * 用途: v3 推荐卡 (CA-1) "近 20 日走势" mini-chart, 60×200 默认尺寸.
 *
 * 设计:
 *   - 颜色按首末 close 自动: 末 ≥ 首 红 (中股惯例涨红), 末 < 首 绿;
 *   - 末点小圆 + 轻填充渐变 (与 [[SparklinePctRow]] FactorWorkspace 同款风格);
 *   - 空 data: 渲染 50px 高灰色 dashed border + "数据不足" 提示 (与 Empty 同语义但更省空间);
 *   - 防御 NaN / Infinity: 用前一个 valid 值兜底, 保证 polyline 连续不断点;
 *   - data 单点: 只画一个点不画线 (避免 zero-length polyline 警告).
 *
 * 不做:
 *   - 不响应 hover / tooltip (mini sparkline 不抢交互, 详情走全屏 K 线);
 *   - 不画 grid / axis / label (定位是 "数据点状趋势暗示");
 *   - 不接 ResizeObserver 自适应 (用 prop 显式 size, 父容器固定布局即可).
 */
export interface Sparkline20dPoint {
  date: string;
  close: number;
}

export interface Sparkline20dProps {
  data: Sparkline20dPoint[];
  /** 默认 60. */
  height?: number;
  /** 默认 200. */
  width?: number;
  /** 显式覆盖默认涨/跌色 — 不传则按首末 close 自动. */
  color?: string;
}

const DEFAULT_HEIGHT = 60;
const DEFAULT_WIDTH = 200;
const COLOR_UP = '#cf1322'; // 中股惯例 涨红
const COLOR_DOWN = '#52c41a'; // 跌绿
const COLOR_FLAT = '#1677ff';

/**
 * 把 raw data 清洗为 [{date, close}] (有效数值), NaN/Infinity 用前一个值兜底.
 * 全数组无效 → 返 []. 单 valid 点 → 返单点.
 */
export function sanitizeSparklineData(
  data: ReadonlyArray<Sparkline20dPoint> | null | undefined
): Sparkline20dPoint[] {
  if (!Array.isArray(data) || data.length === 0) return [];
  const out: Sparkline20dPoint[] = [];
  let lastValid: number | null = null;
  for (const p of data) {
    if (!p || typeof p.date !== 'string') continue;
    const v = Number(p.close);
    if (Number.isFinite(v)) {
      out.push({ date: p.date, close: v });
      lastValid = v;
    } else if (lastValid !== null) {
      out.push({ date: p.date, close: lastValid });
    }
    // lastValid 还未建立且当前无效 → 直接丢弃 (前导无效, 不能用 0 兜底, 会拉错趋势)
  }
  return out;
}

/**
 * 决定线条颜色 — 末 ≥ 首 红 / 末 < 首 绿 / 完全相等也算 flat (蓝).
 * 单点 / 空时返 flat.
 */
export function pickSparklineColor(data: ReadonlyArray<Sparkline20dPoint>): string {
  if (!Array.isArray(data) || data.length < 2) return COLOR_FLAT;
  const first = data[0].close;
  const last = data[data.length - 1].close;
  if (!Number.isFinite(first) || !Number.isFinite(last)) return COLOR_FLAT;
  if (last > first) return COLOR_UP;
  if (last < first) return COLOR_DOWN;
  return COLOR_FLAT;
}

const { Text } = Typography;

const Sparkline20d: React.FC<Sparkline20dProps> = ({
  data,
  height = DEFAULT_HEIGHT,
  width = DEFAULT_WIDTH,
  color,
}) => {
  const cleaned = useMemo(() => sanitizeSparklineData(data), [data]);

  if (cleaned.length === 0) {
    return (
      <div
        style={{
          height: 50,
          width: '100%',
          border: '1px dashed #d9d9d9',
          borderRadius: 4,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        data-testid="sparkline20d-empty"
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          数据不足
        </Text>
      </div>
    );
  }

  const lineColor = color ?? pickSparklineColor(cleaned);
  // 单点: 画一个小圆即可
  const closes = cleaned.map(p => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  // 范围 == 0 时 (全平行) 把所有点画到中线, 避免 NaN
  const range = max - min === 0 ? 1 : max - min;
  // 留点上下 padding (避免线条贴边)
  const pad = 4;
  const innerH = height - pad * 2;
  const stepX = cleaned.length > 1 ? (width - pad * 2) / (cleaned.length - 1) : 0;

  const points = cleaned.map((p, i) => {
    const x = pad + i * stepX;
    const y = pad + innerH - ((p.close - min) / range) * innerH;
    return { x, y };
  });

  const polylinePoints = points.map(p => `${p.x},${p.y}`).join(' ');
  // 填充区域 (polygon): polyline + 底边
  const fillPoints = `${pad},${height - pad} ${polylinePoints} ${width - pad},${height - pad}`;
  const lastPoint = points[points.length - 1];

  // 唯一 gradient id (按 color 区分, 避免多个 sparkline 共用导致颜色串)
  const gradientId = `sparkline20d-grad-${lineColor.replace('#', '')}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="20 日价格走势"
      data-testid="sparkline20d-svg"
      data-color={lineColor}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lineColor} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lineColor} stopOpacity="0" />
        </linearGradient>
      </defs>
      {points.length > 1 && (
        <>
          <polygon points={fillPoints} fill={`url(#${gradientId})`} />
          <polyline
            points={polylinePoints}
            fill="none"
            stroke={lineColor}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
      {/* 末点小圆 — 单点也画 (此时也是 "末点") */}
      <circle cx={lastPoint.x} cy={lastPoint.y} r={2.5} fill={lineColor} />
    </svg>
  );
};

export default Sparkline20d;
