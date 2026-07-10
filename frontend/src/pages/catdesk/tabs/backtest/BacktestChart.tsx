import React from 'react';
import type { BacktestSnapshotSlot } from './types';

interface BacktestChartProps {
  snapshots: BacktestSnapshotSlot[];
}

export function BacktestChart({ snapshots }: BacktestChartProps) {
  return (
    <div className="backtest-chart-placeholder">
      <div className="chart-section">
        <h4>净值曲线</h4>
        <div className="chart-placeholder-box">
          <p>图表组件 · Sprint 2 实装 · {snapshots.length} 个数据点就绪</p>
        </div>
      </div>
      <div className="chart-section">
        <h4>回撤条</h4>
        <div className="chart-placeholder-box">
          <p>回撤条组件 · Sprint 2 实装</p>
        </div>
      </div>
    </div>
  );
}
