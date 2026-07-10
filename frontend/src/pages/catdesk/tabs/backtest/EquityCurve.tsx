import React from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityDataPoint } from './types';

interface EquityCurveProps {
  data: EquityDataPoint[];
}

const tooltipStyle: React.CSSProperties = {
  background: '#17171a',
  border: '1px solid #2a2a2f',
  borderRadius: 8,
  color: '#e6e6e6',
  fontFamily: 'var(--cd-font-mono)',
};

export function EquityCurve({ data }: EquityCurveProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 16, right: 20, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="backtest-equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.26} />
            <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#2a2a2f" strokeDasharray="2 6" vertical={false} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          minTickGap={28}
          tick={{ fill: '#77777f', fontSize: 11 }}
          tickFormatter={(date: string) => date.slice(5)}
        />
        <YAxis
          domain={['auto', 'auto']}
          axisLine={false}
          tickLine={false}
          width={54}
          tick={{ fill: '#77777f', fontSize: 11 }}
          tickFormatter={(value: number) => value.toFixed(2)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={date => `快照 ${String(date)}`}
          formatter={(value: number) => [value.toFixed(4), '累计净值']}
          cursor={{ stroke: '#64748b', strokeDasharray: '3 3' }}
        />
        <ReferenceLine y={1} stroke="#64748b" strokeDasharray="4 4" />
        <Area
          type="monotone"
          dataKey="netValue"
          fill="url(#backtest-equity-fill)"
          stroke="none"
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="netValue"
          stroke="#60a5fa"
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4, fill: '#bfdbfe', stroke: '#2563eb', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
