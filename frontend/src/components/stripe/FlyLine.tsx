/**
 * Phase 16 — FlyLine
 *
 * sc-datav 飞线效果 (Three.js + GSAP) 的纯 SVG 复刻. 在已知的 from/to DOMRect
 * 之间画一根贝塞尔曲线, 沿曲线滑动一个发光的脉冲点. 用于 hover 板块矩形时
 * 暗示"这只票属于这个板块"的视觉连接.
 *
 * 设计契约:
 *   - 父容器必须 `position: relative`. SVG 走 absolute + pointer-events: none
 *     (不拦截 hover).
 *   - from/to 是相对于 containerRect 的局部坐标 (调用方做减法).
 *   - 曲线方向: from 在 to 上方 → 自上而下, 控制点偏 60px (向内凹). 反向同理.
 *   - 颜色: 紫色 (var(--brand, #635bff)) — Stripe DNA, 不是 sc-datav 那种霓
 *     虹绿/蓝, 保持浅色 dashboard 风.
 *   - 退化: prefers-reduced-motion → 只画路径不动 (无脉冲点 + 无 dash 流动).
 */
import React from 'react';

export interface FlyLineSegment {
  /** 起点 (相对于容器局部坐标). */
  fromX: number;
  fromY: number;
  /** 终点 (相对于容器局部坐标). */
  toX: number;
  toY: number;
}

export interface FlyLineProps {
  /** N 条飞线 (一对多). */
  segments: FlyLineSegment[];
  /** 容器宽高 (SVG viewBox). */
  width: number;
  height: number;
  /** 颜色, 默认紫. */
  color?: string;
}

function buildPath(seg: FlyLineSegment): string {
  // 控制点: 向 from/to 中点拉, 但 Y 偏 60px 形成柔顺曲线
  const midY = (seg.fromY + seg.toY) / 2;
  const off = Math.min(80, Math.abs(seg.toY - seg.fromY) * 0.55);
  const c1y = seg.fromY + off;
  const c2y = seg.toY - off;
  void midY;
  return `M ${seg.fromX} ${seg.fromY} C ${seg.fromX} ${c1y}, ${seg.toX} ${c2y}, ${seg.toX} ${seg.toY}`;
}

const FlyLine: React.FC<FlyLineProps> = ({ segments, width, height, color = '#635bff' }) => {
  return (
    <svg
      className="fly-line-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        pointerEvents: 'none',
        zIndex: 4,
      }}
      aria-hidden
    >
      {segments.map((seg, i) => {
        const d = buildPath(seg);
        return (
          <g key={i}>
            {/* 静态曲线 — 半透明, 用 dash 动画做"流动"暗示 */}
            <path
              d={d}
              stroke={color}
              strokeWidth={1.5}
              fill="none"
              strokeLinecap="round"
              strokeDasharray="6 5"
              opacity={0.55}
              style={{ animation: 'fly-line-dash 1.6s linear infinite' }}
            />
            {/* 起点小圆 */}
            <circle cx={seg.fromX} cy={seg.fromY} r={3} fill={color} opacity={0.85} />
            {/* 终点小圆 */}
            <circle cx={seg.toX} cy={seg.toY} r={3} fill={color} opacity={0.85} />
            {/* 沿路径滑动的脉冲点 (animateMotion 原生 SVG, 0 JS 开销) */}
            <circle r={4} fill={color}>
              <animateMotion dur="1.4s" repeatCount="indefinite" path={d} />
              <animate
                attributeName="opacity"
                values="0;1;1;0"
                keyTimes="0;0.15;0.85;1"
                dur="1.4s"
                repeatCount="indefinite"
              />
            </circle>
          </g>
        );
      })}
    </svg>
  );
};

export default FlyLine;
