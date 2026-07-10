import type { Dimension } from "../types";
import { scoreToBand } from "../band";

export function buildDimension(
  rawScore: number,
  evidence: string[],
  inputs: Record<string, unknown>,
): Dimension {
  const score =
    Math.round(Math.max(0, Math.min(100, rawScore)) * 10) / 10;
  return {
    score,
    band: scoreToBand(score),
    evidence: evidence.slice(0, 5),
    inputs,
  };
}
