import React from 'react';
import { tokenizeEvidence } from './evidenceTokens';
import type { RecommendationEvidenceRef } from './types';

export function EvidenceText({
  body,
  evidenceRefs,
}: {
  body: string;
  evidenceRefs: RecommendationEvidenceRef[];
}) {
  return (
    <span>
      {tokenizeEvidence(body, evidenceRefs).map((segment, index) =>
        segment.kind === 'text' ? (
          <React.Fragment key={`${index}-${segment.value}`}>{segment.value}</React.Fragment>
        ) : (
          <a
            className="evidence-token"
            href={segment.evidence.source_uri}
            title={segment.evidence.short_text ?? segment.evidence.id}
            key={`${index}-${segment.value}`}
          >
            {segment.value}
          </a>
        )
      )}
    </span>
  );
}
