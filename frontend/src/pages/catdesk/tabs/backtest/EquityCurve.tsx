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
  background: '#fffaf2',
  border: '1px solid #dbc8ba',
  borderRadius: 8,
  color: '#3d302a',
  fontFamily: 'var(--cd-font-mono)',
};

export function EquityCurve({ data }: EquityCurveProps) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 16, right: 20, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id="backtest-equity-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#d87867" stopOpacity={0.24} />
            <stop offset="100%" stopColor="#d87867" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="#eadfd5" strokeDasharray="2 6" vertical={false} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          minTickGap={28}
          tick={{ fill: '#8b766b', fontSize: 11 }}
          tickFormatter={(date: string) => date.slice(5)}
        />
        <YAxis
          domain={['auto', 'auto']}
          axisLine={false}
          tickLine={false}
          width={54}
          tick={{ fill: '#8b766b', fontSize: 11 }}
          tickFormatter={(value: number) => value.toFixed(2)}
        />
        <Tooltip
          contentStyle={tooltipStyle}
          labelFormatter={date => `快照 ${String(date)}`}
          formatter={(value: number) => [value.toFixed(4), '累计净值']}
          cursor={{ stroke: '#b89f91', strokeDasharray: '3 3' }}
        />
        <ReferenceLine y={1} stroke="#b89f91" strokeDasharray="4 4" />
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
          stroke="#c96458"
          strokeWidth={2.5}
          dot={false}
          activeDot={{ r: 4, fill: '#ffe5d8', stroke: '#b55048', strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
