import type { Dimension, MoatInputs } from "../types";
import { buildDimension } from "./_base";

export function scoreMoat(inputs: MoatInputs): Dimension {
  if (inputs.evidence.length < 2) {
    throw new Error("Moat dimension requires evidence[] mandatory >= 2");
  }

  const gmAbsolute = Math.min(
    100,
    (inputs.gross_margin_absolute / 50) * 100,
  );
  const gmRank = Math.max(0, 100 - inputs.gross_margin_sector_rank);
  const roicWaccScore = Math.min(
    100,
    (Math.max(0, inputs.roic_wacc_spread_2y) / 10) * 100,
  );
  const mktShare = Math.min(100, inputs.market_share_stability_3y * 100);
  const rdScore = Math.min(100, inputs.intangible_rd_intensity * 100);

  const raw =
    gmAbsolute * 0.2 +
    gmRank * 0.15 +
    roicWaccScore * 0.3 +
    mktShare * 0.2 +
    rdScore * 0.15;

  return buildDimension(
    raw,
    inputs.evidence.slice(0, 5),
    inputs as unknown as Record<string, unknown>,
  );
}
