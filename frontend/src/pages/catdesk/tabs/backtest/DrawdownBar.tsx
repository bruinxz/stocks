import React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { EquityDataPoint } from './types';

interface DrawdownBarProps {
  data: EquityDataPoint[];
}

export function DrawdownBar({ data }: DrawdownBarProps) {
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data} margin={{ top: 8, right: 20, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#2a2a2f" strokeDasharray="2 6" vertical={false} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          minTickGap={28}
          tick={{ fill: '#77777f', fontSize: 10 }}
          tickFormatter={(date: string) => date.slice(5)}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={54}
          tick={{ fill: '#77777f', fontSize: 10 }}
          tickFormatter={(value: number) => `${(value * 100).toFixed(0)}%`}
        />
        <Tooltip
          contentStyle={{
            background: '#17171a',
            border: '1px solid #2a2a2f',
            borderRadius: 8,
            color: '#e6e6e6',
          }}
          formatter={(value: number) => [`${(value * 100).toFixed(2)}%`, '回撤']}
          labelFormatter={date => `快照 ${String(date)}`}
          cursor={{ fill: 'rgba(255, 255, 255, 0.03)' }}
        />
        <ReferenceLine y={0} stroke="#64748b" />
        <Bar dataKey="drawdown" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map(point => (
            <Cell
              key={point.date}
              fill={point.drawdown <= -0.1 ? '#ef4444' : '#f59e0b'}
              fillOpacity={point.drawdown <= -0.1 ? 0.9 : 0.72}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
