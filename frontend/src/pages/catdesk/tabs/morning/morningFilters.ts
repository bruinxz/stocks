import type { CandidateListEntry, CatalystKind } from '../c1Types';

export function morningCatalystKind(row: CandidateListEntry): CatalystKind {
  return row.latest_catalyst?.kind ?? 'unclassified';
}

export function matchesMorningCatalyst(
  row: CandidateListEntry,
  catalystKind: CatalystKind
): boolean {
  return morningCatalystKind(row) === catalystKind;
}
