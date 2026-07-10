import type {
  GateStatus,
  RiskGate,
  RiskGateTriggerCode,
  Trigger,
  TriggerSeverity,
} from "./types";

export interface RiskSignals {
  ticker: string;
  earningsDaysAway: number | null;
  isHalted: boolean;
  mergerPending: boolean;
  litigationMaterial30d: boolean;
  ivPercentile30d: number;
  avgDailyValueUsd: number;
  restatement30d: boolean;
  delistingNotice: boolean;
  stTag: boolean;
  priceLimitApproachPct: number | null;
  isSuspended: boolean;
}

interface TriggerDef {
  code: RiskGateTriggerCode;
  severity: TriggerSeverity;
  check: (s: RiskSignals) => string | null;
}

const TRIGGER_DEFS: TriggerDef[] = [
  {
    code: "EARNINGS_T-2",
    severity: "warn",
    check: (s) =>
      s.earningsDaysAway != null &&
      s.earningsDaysAway <= 2 &&
      s.earningsDaysAway > 0
        ? `earnings within ${s.earningsDaysAway} trading days`
        : null,
  },
  {
    code: "EARNINGS_T-0",
    severity: "block",
    check: (s) =>
      s.earningsDaysAway === 0
        ? "earnings today / after-close"
        : null,
  },
  {
    code: "HALT_ACTIVE",
    severity: "block",
    check: (s) =>
      s.isHalted ? "trading halt in effect" : null,
  },
  {
    code: "MERGER_PENDING",
    severity: "warn",
    check: (s) =>
      s.mergerPending
        ? "announced M&A pending close"
        : null,
  },
  {
    code: "LITIGATION_MATERIAL",
    severity: "warn",
    check: (s) =>
      s.litigationMaterial30d
        ? "material litigation disclosed within 30d"
        : null,
  },
  {
    code: "IV_SHOCK",
    severity: "warn",
    check: (s) =>
      s.ivPercentile30d >= 90
        ? `implied vol at ${s.ivPercentile30d}th percentile`
        : null,
  },
  {
    code: "LIQUIDITY_LOW",
    severity: "warn",
    check: (s) =>
      s.avgDailyValueUsd < 5_000_000
        ? `avg daily value $${(s.avgDailyValueUsd / 1_000_000).toFixed(1)}M < $5M`
        : null,
  },
  {
    code: "RESTATEMENT_30D",
    severity: "block",
    check: (s) =>
      s.restatement30d
        ? "accounting restatement within 30d"
        : null,
  },
  {
    code: "DELISTING_NOTICE",
    severity: "block",
    check: (s) =>
      s.delistingNotice
        ? "exchange delisting notice"
        : null,
  },
  {
    code: "ST_TAG",
    severity: "block",
    check: (s) =>
      s.stTag ? "ST/*ST tag active" : null,
  },
  {
    code: "PRICE_LIMIT_APPROACH",
    severity: "warn",
    check: (s) =>
      s.priceLimitApproachPct != null &&
      s.priceLimitApproachPct <= 1
        ? `within ${s.priceLimitApproachPct}% of price limit`
        : null,
  },
  {
    code: "SUSPENDED",
    severity: "block",
    check: (s) =>
      s.isSuspended
        ? "exchange suspension active"
        : null,
  },
];

export function evaluateRiskGate(
  signals: RiskSignals,
  evaluatedAt: string,
): RiskGate {
  const triggers: Trigger[] = [];

  for (const def of TRIGGER_DEFS) {
    const detail = def.check(signals);
    if (detail != null) {
      triggers.push({
        code: def.code,
        severity: def.severity,
        detail,
      });
    }
  }

  const gate = deriveGate(triggers);

  return {
    ticker: signals.ticker,
    evaluated_at: evaluatedAt,
    gate,
    triggers,
    ok_to_enter: gate === "GREEN",
  };
}

function deriveGate(triggers: Trigger[]): GateStatus {
  if (triggers.some((t) => t.severity === "block")) return "RED";
  if (triggers.some((t) => t.severity === "warn")) return "YELLOW";
  return "GREEN";
}
