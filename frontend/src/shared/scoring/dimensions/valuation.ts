import type { Dimension, ValuationInputs } from "../types";
import { buildDimension } from "./_base";

export function scoreValuation(inputs: ValuationInputs): Dimension {
  let peComponent: number;
  if (inputs.pe_ttm == null || inputs.pe_ttm <= 0) {
    peComponent = Math.max(0, 100 - inputs.ev_ebitda_ttm * 4);
  } else {
    peComponent = Math.max(
      0,
      Math.min(100, ((40 - inputs.pe_ttm) / 30) * 100),
    );
  }

  const evComponent = Math.max(
    0,
    Math.min(100, ((25 - inputs.ev_ebitda_ttm) / 17) * 100),
  );
  const peerPe = Math.max(0, 100 - inputs.peer_pe_percentile);
  const peerEv = Math.max(0, 100 - inputs.peer_ev_ebitda_percentile);
  const fcfYield = Math.min(100, (inputs.fcf_yield / 8) * 100);
  const pbComponent = Math.max(
    0,
    Math.min(100, ((3 - inputs.pb) / 2.5) * 100),
  );

  const raw =
    peComponent * 0.25 +
    evComponent * 0.2 +
    peerPe * 0.1 +
    peerEv * 0.1 +
    fcfYield * 0.2 +
    pbComponent * 0.15;

  const evidence: string[] = [];
  if (inputs.pe_ttm == null)
    evidence.push("Negative earnings: EV/EBITDA fallback applied");
  if (inputs.fcf_yield >= 5)
    evidence.push(`FCF yield ${inputs.fcf_yield}% attractive`);
  if (inputs.peer_pe_percentile <= 30)
    evidence.push(
      `P/E at ${inputs.peer_pe_percentile}th percentile vs peers`,
    );
  if (evidence.length === 0)
    evidence.push("Valuation metrics at peer median");

  return buildDimension(
    raw,
    evidence,
    inputs as unknown as Record<string, unknown>,
  );
}
