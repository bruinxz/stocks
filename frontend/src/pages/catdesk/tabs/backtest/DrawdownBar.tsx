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
        <CartesianGrid stroke="#eadfd5" strokeDasharray="2 6" vertical={false} />
        <XAxis
          dataKey="date"
          axisLine={false}
          tickLine={false}
          minTickGap={28}
          tick={{ fill: '#8b766b', fontSize: 10 }}
          tickFormatter={(date: string) => date.slice(5)}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          width={54}
          tick={{ fill: '#8b766b', fontSize: 10 }}
          tickFormatter={(value: number) => `${(value * 100).toFixed(0)}%`}
        />
        <Tooltip
          contentStyle={{
            background: '#fffaf2',
            border: '1px solid #dbc8ba',
            borderRadius: 8,
            color: '#3d302a',
          }}
          formatter={(value: number) => [`${(value * 100).toFixed(2)}%`, '回撤']}
          labelFormatter={date => `快照 ${String(date)}`}
          cursor={{ fill: 'rgba(201, 100, 88, 0.06)' }}
        />
        <ReferenceLine y={0} stroke="#b89f91" />
        <Bar dataKey="drawdown" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map(point => (
            <Cell
              key={point.date}
              fill={point.drawdown <= -0.1 ? '#d65f5f' : '#d8a044'}
              fillOpacity={point.drawdown <= -0.1 ? 0.9 : 0.72}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
