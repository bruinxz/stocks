import type { RecommendationEvidenceRef } from './types';

export type EvidenceSegment =
  | { kind: 'text'; value: string }
  | { kind: 'evidence'; value: string; evidence: RecommendationEvidenceRef };

export function tokenizeEvidence(
  body: string,
  evidenceRefs: RecommendationEvidenceRef[]
): EvidenceSegment[] {
  const byId = new Map(evidenceRefs.map(item => [item.id, item]));
  const segments: EvidenceSegment[] = [];
  const pattern = /\[(E\d+)\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (match.index > cursor)
      segments.push({ kind: 'text', value: body.slice(cursor, match.index) });
    const evidence = byId.get(match[1]);
    if (!evidence) throw new Error(`Unknown evidence token ${match[0]}`);
    segments.push({ kind: 'evidence', value: match[0], evidence });
    cursor = pattern.lastIndex;
  }
  if (cursor < body.length) segments.push({ kind: 'text', value: body.slice(cursor) });
  return segments;
}
