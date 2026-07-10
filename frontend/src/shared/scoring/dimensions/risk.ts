import type { Dimension, RiskInputs } from "../types";
import { buildDimension } from "./_base";

export function scoreRisk(inputs: RiskInputs): Dimension {
  const vol30 = Math.max(
    0,
    Math.min(100, ((50 - inputs.realized_vol_30d) / 35) * 100),
  );
  const vol90 = Math.max(
    0,
    Math.min(100, ((50 - inputs.realized_vol_90d) / 35) * 100),
  );
  const ddScore = Math.max(
    0,
    Math.min(
      100,
      ((40 - Math.abs(inputs.max_drawdown_12m)) / 30) * 100,
    ),
  );
  const betaScore = Math.max(
    0,
    Math.min(100, ((2 - inputs.beta_30d_rolling) / 1.5) * 100),
  );
  const debtScore = Math.max(
    0,
    Math.min(100, ((5 - inputs.net_debt_ebitda) / 4) * 100),
  );
  const currentScore = Math.min(
    100,
    (inputs.current_ratio / 2) * 100,
  );
  const concScore = Math.max(
    0,
    100 - inputs.concentration_risk * 100,
  );
  const regPenalty = inputs.regulatory_litigation_flag ? -15 : 0;

  const raw =
    vol30 * 0.15 +
    vol90 * 0.1 +
    ddScore * 0.2 +
    betaScore * 0.15 +
    debtScore * 0.15 +
    currentScore * 0.1 +
    concScore * 0.1 +
    5 +
    regPenalty;

  const evidence: string[] = [];
  if (inputs.realized_vol_30d < 20)
    evidence.push(`Low 30d vol ${inputs.realized_vol_30d}%`);
  if (Math.abs(inputs.max_drawdown_12m) > 25)
    evidence.push(
      `12m max drawdown ${inputs.max_drawdown_12m}% elevated`,
    );
  if (inputs.regulatory_litigation_flag)
    evidence.push("Active regulatory/litigation flag");
  if (inputs.net_debt_ebitda > 3)
    evidence.push(
      `Net debt/EBITDA ${inputs.net_debt_ebitda}x elevated`,
    );
  if (evidence.length === 0)
    evidence.push("Risk profile within normal range");

  return buildDimension(
    raw,
    evidence,
    inputs as unknown as Record<string, unknown>,
  );
}
