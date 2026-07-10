import type { Dimension, GrowthInputs } from "../types";
import { buildDimension } from "./_base";

export function scoreGrowth(inputs: GrowthInputs): Dimension {
  const revCagr3 = Math.min(
    100,
    (Math.max(0, inputs.revenue_cagr_3y) / 20) * 100,
  );
  const revCagr5 = Math.min(
    100,
    (Math.max(0, inputs.revenue_cagr_5y) / 20) * 100,
  );
  const epsCagr3 = Math.min(
    100,
    (Math.max(0, inputs.eps_cagr_3y) / 25) * 100,
  );
  const epsCagr5 = Math.min(
    100,
    (Math.max(0, inputs.eps_cagr_5y) / 25) * 100,
  );

  let raw =
    revCagr3 * 0.25 + revCagr5 * 0.2 + epsCagr3 * 0.3 + epsCagr5 * 0.2;

  if (inputs.segment_mix_available && inputs.segment_mix_score != null) {
    raw = raw * 0.95 + inputs.segment_mix_score * 0.05;
  }

  const evidence: string[] = [];
  if (inputs.revenue_cagr_3y >= 15)
    evidence.push(`Revenue CAGR 3y ${inputs.revenue_cagr_3y}% strong`);
  if (inputs.eps_cagr_3y >= 20)
    evidence.push(`EPS CAGR 3y ${inputs.eps_cagr_3y}% robust`);
  if (inputs.revenue_cagr_5y >= 10)
    evidence.push(`Revenue CAGR 5y ${inputs.revenue_cagr_5y}% sustained`);
  if (evidence.length === 0)
    evidence.push("Growth metrics below standout thresholds");

  return buildDimension(
    raw,
    evidence,
    inputs as unknown as Record<string, unknown>,
  );
}
