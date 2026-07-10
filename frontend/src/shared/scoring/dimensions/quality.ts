import type { Dimension, QualityInputs } from "../types";
import { buildDimension } from "./_base";

export function scoreQuality(inputs: QualityInputs): Dimension {
  const roicScore = Math.min(100, (inputs.roic_5y_median / 30) * 100);
  const roeScore = Math.min(100, (inputs.roe_5y_median / 25) * 100);
  const fcfScore = Math.min(100, (inputs.fcf_margin_5y_median / 20) * 100);
  const stabilityScore = Math.max(
    0,
    100 - inputs.gross_margin_stability_5y_sigma * 20,
  );
  const coverageScore = Math.min(
    100,
    (inputs.interest_coverage_4q / 10) * 100,
  );
  const accrualScore = Math.max(
    0,
    100 - Math.abs(inputs.accruals_ratio_sloan) * 1000,
  );

  const raw =
    roicScore * 0.25 +
    roeScore * 0.2 +
    fcfScore * 0.2 +
    stabilityScore * 0.15 +
    coverageScore * 0.1 +
    accrualScore * 0.1;

  const evidence: string[] = [];
  if (inputs.roic_5y_median >= 15)
    evidence.push(
      `ROIC 5y median ${inputs.roic_5y_median}% above 15% threshold`,
    );
  if (inputs.fcf_margin_5y_median >= 15)
    evidence.push(
      `FCF margin 5y median ${inputs.fcf_margin_5y_median}% strong`,
    );
  if (inputs.interest_coverage_4q >= 8)
    evidence.push(
      `Interest coverage ${inputs.interest_coverage_4q}x comfortable`,
    );
  if (Math.abs(inputs.accruals_ratio_sloan) < 0.05)
    evidence.push("Low accruals ratio indicates earnings quality");
  if (evidence.length === 0)
    evidence.push("No standout quality signals");

  return buildDimension(
    raw,
    evidence,
    inputs as unknown as Record<string, unknown>,
  );
}
