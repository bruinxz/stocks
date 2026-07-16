import React from 'react';
import { Tag } from 'antd';
import type { BacktestHolding } from './types';

interface HoldingsTableProps {
  holdings: BacktestHolding[];
  loading: boolean;
}

export function HoldingsTable({ holdings, loading }: HoldingsTableProps) {
  if (loading) return <div className="holdings-loading">加载持仓中...</div>;
  if (!holdings.length) return <div className="holdings-empty">暂无持仓数据</div>;

  return (
    <table className="holdings-table">
      <thead>
        <tr>
          <th>股票代码</th>
          <th style={{ textAlign: 'right' }}>权重</th>
          <th style={{ textAlign: 'right' }}>入选以来收益</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map(h => (
          <tr key={h.ticker} className={h.is_stale ? 'stale-row' : ''}>
            <td>{h.ticker}</td>
            <td style={{ textAlign: 'right' }}>{(h.weight * 100).toFixed(1)}%</td>
            <td style={{ textAlign: 'right' }}>
              <span className={h.return_since_entry >= 0 ? 'text-positive' : 'text-negative'}>
                {h.return_since_entry >= 0 ? '+' : ''}
                {(h.return_since_entry * 100).toFixed(2)}%
              </span>
            </td>
            <td>{h.is_stale && <Tag color="orange">数据可能滞后</Tag>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
