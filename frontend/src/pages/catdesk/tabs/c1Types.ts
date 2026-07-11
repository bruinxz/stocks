import type {
  Band,
  CatalystKind,
  Conviction,
  EntryPlan,
  RiskGate,
  Score,
} from 'shared/scoring/types';

export type { Band, CatalystKind };

export interface CandidateListEntry {
  symbol: string;
  name: string;
  score: Score | null;
  rating_band: Band;
  conviction?: Conviction;
  risk_gate?: RiskGate;
  entry_plan?: EntryPlan;
  latest_catalyst?: {
    kind: CatalystKind;
    title: string;
    occurred_at: string;
    sector?: string;
  };
}

const SCORE_DIMENSION_LABELS = [
  ['quality', '质量'],
  ['growth', '成长'],
  ['valuation', '估值'],
  ['moat', '护城河'],
  ['trend', '趋势'],
  ['risk', '风险'],
] as const;

export function scoreBandDimensions(score: Score | null) {
  if (!score) return [];

  return SCORE_DIMENSION_LABELS.map(([key, label]) => ({
    label,
    band: score[key].band,
  }));
}
