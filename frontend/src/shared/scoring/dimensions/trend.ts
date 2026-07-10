import type { Dimension, TrendInputs } from "../types";
import { buildDimension } from "./_base";

export function scoreTrend(inputs: TrendInputs): Dimension {
  const maScore =
    inputs.ma_50d > inputs.ma_200d
      ? 70 + inputs.ma_cross_slope * 10
      : 30 + inputs.ma_cross_slope * 10;
  const maClamped = Math.max(0, Math.min(100, maScore));
  const returnScore = inputs.return_6m_sector_percentile;
  const rsScore = Math.min(100, inputs.rs_line_vs_sector * 50);
  const volumeBonus = inputs.volume_breakout ? 10 : 0;

  const raw =
    maClamped * 0.35 + returnScore * 0.3 + rsScore * 0.25 + volumeBonus;

  const evidence: string[] = [];
  if (inputs.ma_50d > inputs.ma_200d)
    evidence.push("50d MA above 200d MA (bullish)");
  else evidence.push("50d MA below 200d MA (bearish)");
  if (inputs.return_6m_sector_percentile >= 70)
    evidence.push(
      `6m return in top ${100 - inputs.return_6m_sector_percentile}th percentile of sector`,
    );
  if (inputs.volume_breakout)
    evidence.push("Volume-confirmed breakout detected");
  if (evidence.length === 0) evidence.push("Trend metrics neutral");

  return buildDimension(
    raw,
    evidence,
    inputs as unknown as Record<string, unknown>,
  );
}
