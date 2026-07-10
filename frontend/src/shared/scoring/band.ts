import type { Band } from "./types";

const BAND_THRESHOLDS: readonly [number, Band][] = [
  [85, "A"],
  [70, "B"],
  [55, "C"],
  [40, "D"],
];

export function scoreToBand(score: number): Band {
  for (const [threshold, band] of BAND_THRESHOLDS) {
    if (score >= threshold) return band;
  }
  return "F";
}
