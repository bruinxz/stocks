import React from 'react';
import { Progress, Typography } from 'antd';

const { Text } = Typography;

type FxSensitivityCardProps = {
  fxBeta: number;
  currency: 'JPY' | 'KRW';
  revenueByRegion: Array<{ region: string; pct: number }>;
  ariaLabel: string;
};

export function FxSensitivityCard({
  fxBeta,
  currency,
  revenueByRegion,
  ariaLabel,
}: FxSensitivityCardProps) {
  const pair = currency === 'JPY' ? 'USD/JPY' : 'USD/KRW';
  const abs = Math.abs(fxBeta);
  const level = abs > 0.5 ? 'HIGH' : abs > 0.2 ? 'MED' : 'LOW';
  const color = level === 'HIGH' ? '#cf1322' : level === 'MED' ? '#faad14' : '#389e0d';
  const levelLabel = level === 'HIGH' ? '高' : level === 'MED' ? '中' : '低';

  return (
    <div aria-label={ariaLabel}>
      <div style={{ marginBottom: 8 }}>
        <Text strong>{pair} β:</Text>{' '}
        <Text style={{ color }}>
          {fxBeta > 0 ? '+' : ''}
          {fxBeta.toFixed(3)}（{levelLabel}）
        </Text>
      </div>
      <div>
        <Text type="secondary">收入地区分布:</Text>
        {revenueByRegion.map(r => (
          <div key={r.region} style={{ marginTop: 4 }}>
            <Text style={{ display: 'inline-block', width: 60 }}>{r.region}</Text>
            <Progress
              percent={r.pct}
              size="small"
              strokeColor={r.region === 'CN' || r.region === 'US' ? '#1890ff' : undefined}
              format={p => `${p?.toFixed(1)}%`}
              style={{ display: 'inline-block', width: 'calc(100% - 70px)' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
