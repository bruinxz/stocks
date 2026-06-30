/**
 * Phase 15 — Stripe 同款 inline mini chart 集合.
 *
 * MiniSparkline:    60×16 SVG, 推荐卡近 5 日趋势.
 * MiniBars:         56×16 SVG, 持仓近 7 日 P&L bar (绿/红 mixed).
 * HeroAreaChart:    260+×80 recharts AreaChart, 首页 hero 30 日资产.
 * FactorICBars:     130×24 SVG, 因子近 30 日 IC bar (绿/红 mixed).
 *
 * 全部走 violet brand + 红涨绿跌, 与全站 token 一致. 没有过度装饰.
 */
import React, { useMemo } from 'react';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const UP = '#dc2626';
const DOWN = '#16a34a';
const BRAND = '#635bff';

interface MiniSparklineProps {
  values: number[];
  width?: number;
  height?: number;
  /** 若不给, 按首末值方向自动 (A 股: 涨红跌绿). */
  color?: string;
}

/**
 * 推荐卡右上角的 60×16 sparkline — 近 5 日股价折线.
 */
export const MiniSparkline: React.FC<MiniSparklineProps> = ({
  values,
  width = 60,
  height = 16,
  color,
}) => {
  const points = useMemo(() => {
    if (!values || values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    return values
      .map(
        (v, i) =>
          `${(i / (values.length - 1)) * (width - 2) + 1},${
            height - 1 - ((v - min) / range) * (height - 2)
          }`
      )
      .join(' ');
  }, [values, width, height]);
  if (!points) return null;
  const first = values[0];
  const last = values[values.length - 1];
  const trend = last - first;
  const stroke = color ?? (trend === 0 ? '#a3a3a3' : trend > 0 ? UP : DOWN);
  return (
    <svg width={width} height={height} aria-hidden="true" className="mini-sparkline">
      <polyline
        fill="none"
        stroke={stroke}
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
    </svg>
  );
};

interface MiniBarsProps {
  values: number[];
  width?: number;
  height?: number;
}

/**
 * 持仓近 7 日 P&L 柱状图 — 单根柱按当日正负着色 (红涨/绿跌).
 */
export const MiniBars: React.FC<MiniBarsProps> = ({
  values,
  width = 56,
  height = 16,
}) => {
  if (!values || values.length === 0) return null;
  const n = values.length;
  const slot = width / n;
  const barW = Math.max(2, Math.floor(slot * 0.6));
  const maxAbs = Math.max(1, ...values.map(v => Math.abs(v)));
  const mid = height / 2;
  return (
    <svg width={width} height={height} aria-hidden="true" className="mini-bars">
      {values.map((v, i) => {
        const h = (Math.abs(v) / maxAbs) * (height / 2 - 1);
        const x = slot * i + (slot - barW) / 2;
        const y = v >= 0 ? mid - h : mid;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={Math.max(1, h)}
            rx={0.5}
            fill={v === 0 ? '#a3a3a3' : v > 0 ? UP : DOWN}
            opacity={v === 0 ? 0.4 : 1}
          />
        );
      })}
    </svg>
  );
};

interface HeroAreaChartProps {
  data: Array<{ date: string; value: number }>;
  height?: number;
}

/**
 * HomeWorkspace hero 下方 80px area chart — 30 日资产曲线 + brand violet gradient.
 * Recharts; rotation 已与 Stripe Dashboard "Gross Volume" 同款配色.
 */
export const HeroAreaChart: React.FC<HeroAreaChartProps> = ({ data, height = 80 }) => {
  if (!data || data.length < 2) return null;
  return (
    <div className="hero-area-chart" style={{ width: '100%', height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="phase15-hero-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={BRAND} stopOpacity={0.16} />
              <stop offset="100%" stopColor={BRAND} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" hide />
          <YAxis hide domain={['dataMin', 'dataMax']} />
          <Tooltip
            cursor={{ stroke: '#e5e7eb', strokeWidth: 1 }}
            contentStyle={{
              border: '1px solid #e5e7eb',
              borderRadius: 6,
              fontSize: 12,
              padding: '6px 10px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            }}
            formatter={(v: number) => [
              '¥' +
                new Intl.NumberFormat('zh-CN', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(v),
              '资产',
            ]}
            labelFormatter={(d: string) => d}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={BRAND}
            strokeWidth={1.5}
            fill="url(#phase15-hero-grad)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

interface FactorICBarsProps {
  values: number[];
  width?: number;
  height?: number;
}

/**
 * 因子近 30 日 IC bar — 绿/红 mixed, 用于因子页 IC 稳定性展示.
 */
export const FactorICBars: React.FC<FactorICBarsProps> = ({
  values,
  width = 130,
  height = 24,
}) => {
  if (!values || values.length === 0) return null;
  const n = values.length;
  const slot = width / n;
  const barW = Math.max(1.5, slot * 0.7);
  const maxAbs = Math.max(0.01, ...values.map(v => Math.abs(v)));
  const mid = height / 2;
  return (
    <svg width={width} height={height} aria-hidden="true" className="factor-ic-bars">
      <line x1={0} y1={mid} x2={width} y2={mid} stroke="#e5e7eb" strokeWidth={0.5} />
      {values.map((v, i) => {
        const h = (Math.abs(v) / maxAbs) * (height / 2 - 1);
        const x = slot * i + (slot - barW) / 2;
        const y = v >= 0 ? mid - h : mid;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={Math.max(0.8, h)}
            fill={v === 0 ? '#a3a3a3' : v > 0 ? UP : DOWN}
            opacity={v === 0 ? 0.4 : 0.85}
          />
        );
      })}
    </svg>
  );
};
