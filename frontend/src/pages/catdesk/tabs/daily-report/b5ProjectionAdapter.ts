import {
  assertExactObject,
  jcsCanonicalize,
  sha256Text,
  strictArray,
  strictDay,
  strictIso8601,
  strictNumber,
  strictSemVer,
  strictSha256,
  strictString,
  strictStringArray,
} from './contractSchema';
import {
  canonicalizeRecommendationFingerprintPreimage,
  parseRecommendationSnapshot,
  RecommendationContractError,
} from './recommendationAdapter';
import {
  RECOMMENDATION_MARKET_SCOPES,
  RECOMMENDATION_PROFILES,
  RECOMMENDATION_PROFILE_SCOPES,
  type B5DailyReportWire,
  type B5ReportSection,
  type DailyReportDocument,
  type RatingBand,
  type RatingCounts,
  type RecommendationMarketScope,
  type RecommendationProfile,
} from './types';
import type {
  B5HistoryEntryWire,
  B5ReportHistoryWire,
  ReportHistoryEntry,
  ReportHistoryPage,
  ReportHistoryQuery,
} from '../report-history/types';

const BANDS = ['A', 'B', 'C', 'D', 'F'] as const;

function profile(value: unknown, path: string): RecommendationProfile {
  const parsed = strictString(value, path);
  if (!RECOMMENDATION_PROFILES.includes(parsed as RecommendationProfile)) {
    throw new RecommendationContractError(`${path} is invalid`);
  }
  return parsed as RecommendationProfile;
}

function scope(value: unknown, path: string): RecommendationMarketScope {
  const parsed = strictString(value, path);
  if (!RECOMMENDATION_MARKET_SCOPES.includes(parsed as RecommendationMarketScope)) {
    throw new RecommendationContractError(`${path} is invalid`);
  }
  return parsed as RecommendationMarketScope;
}

function nullable<T>(value: unknown, parser: (value: unknown) => T): T | null {
  return value == null ? null : parser(value);
}

function ratingCounts(value: unknown, path: string): RatingCounts {
  const raw = assertExactObject(value, BANDS, [], path);
  return Object.fromEntries(
    BANDS.map(band => [band, strictNumber(raw[band], `${path}.${band}`, { min: 0, integer: true })])
  ) as unknown as RatingCounts;
}

function sameRatingCounts(left: RatingCounts, right: RatingCounts): boolean {
  return BANDS.every(band => left[band] === right[band]);
}

function deriveRatingCounts(items: DailyReportDocument['snapshot']['items']): RatingCounts {
  const counts: RatingCounts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const item of items) counts[item.rating_band] += 1;
  return counts;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseSection(value: unknown, index: number): B5ReportSection {
  const path = `sections[${index}]`;
  const base = assertExactObject(
    value,
    ['kind', 'section_id', 'title'],
    [
      'item_count',
      'high_conviction_count',
      'rating_counts',
      'ticker',
      'rating_band',
      'evidence_ids',
    ],
    path
  );
  if (base.kind === 'summary') {
    const raw = assertExactObject(
      value,
      ['kind', 'section_id', 'title', 'item_count', 'high_conviction_count', 'rating_counts'],
      [],
      path
    );
    if (raw.section_id !== 'summary') throw new RecommendationContractError('summary id mismatch');
    return {
      kind: 'summary',
      section_id: 'summary',
      title: strictString(raw.title, `${path}.title`),
      item_count: strictNumber(raw.item_count, `${path}.item_count`, { min: 0, integer: true }),
      high_conviction_count: strictNumber(
        raw.high_conviction_count,
        `${path}.high_conviction_count`,
        { min: 0, integer: true }
      ),
      rating_counts: ratingCounts(raw.rating_counts, `${path}.rating_counts`),
    };
  }
  const raw = assertExactObject(
    value,
    ['kind', 'section_id', 'title', 'ticker', 'rating_band', 'evidence_ids'],
    [],
    path
  );
  if (raw.kind !== 'recommendation') {
    throw new RecommendationContractError(`${path}.kind is invalid`);
  }
  const rating = strictString(raw.rating_band, `${path}.rating_band`) as RatingBand;
  if (!BANDS.includes(rating)) throw new RecommendationContractError(`${path}.rating is invalid`);
  return {
    kind: 'recommendation',
    section_id: strictString(raw.section_id, `${path}.section_id`),
    title: strictString(raw.title, `${path}.title`),
    ticker: strictString(raw.ticker, `${path}.ticker`),
    rating_band: rating,
    evidence_ids: strictStringArray(raw.evidence_ids, `${path}.evidence_ids`),
  };
}

export function parseB5DailyReport(value: unknown): DailyReportDocument {
  const raw = assertExactObject(
    value,
    [
      'projection_version',
      'report_id',
      'trading_day',
      'profile',
      'market_scope',
      'source_snapshot_id',
      'source_as_of',
      'source_output_fingerprint',
      'source_fingerprint_preimage_jcs',
      'disclaimer',
      'meta',
      'summary',
      'entries',
      'sections',
      'markdown',
    ],
    [],
    'daily_report'
  );
  const parsedProfile = profile(raw.profile, 'daily_report.profile');
  const parsedScope = scope(raw.market_scope, 'daily_report.market_scope');
  const sourceSnapshotId = strictString(raw.source_snapshot_id, 'daily_report.source_snapshot_id');
  const sourceAsOf = strictIso8601(raw.source_as_of, 'daily_report.source_as_of');
  const sourceFingerprint = strictSha256(
    raw.source_output_fingerprint,
    'daily_report.source_output_fingerprint'
  );
  const entries = strictArray(raw.entries, 'daily_report.entries');
  const snapshot = parseRecommendationSnapshot({
    snapshot_id: sourceSnapshotId,
    as_of: sourceAsOf,
    profile: parsedProfile,
    market_scope: parsedScope,
    items: entries,
    output_fingerprint: sourceFingerprint,
    disclaimer: raw.disclaimer,
    meta: raw.meta,
  });
  const preimage = strictString(
    raw.source_fingerprint_preimage_jcs,
    'daily_report.source_fingerprint_preimage_jcs'
  );
  let decodedPreimage: unknown;
  try {
    decodedPreimage = JSON.parse(preimage);
  } catch (_error) {
    throw new RecommendationContractError('daily_report preimage is not JSON');
  }
  if (jcsCanonicalize(decodedPreimage) !== preimage) {
    throw new RecommendationContractError('daily_report preimage is not canonical JCS');
  }
  if (sha256Text(preimage) !== sourceFingerprint) {
    throw new RecommendationContractError('daily_report preimage hash mismatch');
  }
  const reconstructedEnvelope = {
    snapshot_id: sourceSnapshotId,
    as_of: sourceAsOf,
    profile: parsedProfile,
    market_scope: parsedScope,
    items: entries,
    output_fingerprint: sourceFingerprint,
    disclaimer: raw.disclaimer,
    meta: raw.meta,
  };
  if (canonicalizeRecommendationFingerprintPreimage(reconstructedEnvelope) !== preimage) {
    throw new RecommendationContractError('daily_report preimage does not match source envelope');
  }
  const summaryRaw = assertExactObject(
    raw.summary,
    ['item_count', 'high_conviction_count', 'rating_counts'],
    [],
    'daily_report.summary'
  );
  const summary = {
    item_count: strictNumber(summaryRaw.item_count, 'daily_report.summary.item_count', {
      min: 0,
      integer: true,
    }),
    high_conviction_count: strictNumber(
      summaryRaw.high_conviction_count,
      'daily_report.summary.high_conviction_count',
      { min: 0, integer: true }
    ),
    rating_counts: ratingCounts(summaryRaw.rating_counts, 'daily_report.summary.rating_counts'),
  };
  if (
    summary.item_count !== snapshot.items.length ||
    summary.high_conviction_count !==
      snapshot.items.filter(item => item.recommendation.conviction.level === 'HIGH').length ||
    !sameRatingCounts(summary.rating_counts, deriveRatingCounts(snapshot.items))
  ) {
    throw new RecommendationContractError('daily_report summary mismatch');
  }
  const sections = strictArray(raw.sections, 'daily_report.sections').map(parseSection);
  const summarySection = sections[0];
  const recommendationSections = sections.filter(section => section.kind === 'recommendation');
  if (
    summarySection?.kind !== 'summary' ||
    summarySection.item_count !== summary.item_count ||
    summarySection.high_conviction_count !== summary.high_conviction_count ||
    !sameRatingCounts(summarySection.rating_counts, summary.rating_counts) ||
    recommendationSections.length !== snapshot.items.length ||
    recommendationSections.some(
      (section, index) =>
        section.kind !== 'recommendation' ||
        section.ticker !== snapshot.items[index].recommendation.ticker ||
        section.rating_band !== snapshot.items[index].rating_band ||
        !sameStringArray(
          section.evidence_ids,
          snapshot.items[index].recommendation.evidence_refs.map(evidence => evidence.id)
        )
    )
  ) {
    throw new RecommendationContractError('daily_report sections mismatch');
  }
  const wire: B5DailyReportWire = {
    projection_version: strictSemVer(raw.projection_version, 'daily_report.projection_version'),
    report_id: strictString(raw.report_id, 'daily_report.report_id'),
    trading_day: strictDay(raw.trading_day, 'daily_report.trading_day'),
    profile: parsedProfile,
    market_scope: parsedScope,
    source_snapshot_id: sourceSnapshotId,
    source_as_of: sourceAsOf,
    source_output_fingerprint: sourceFingerprint,
    source_fingerprint_preimage_jcs: preimage,
    disclaimer: snapshot.disclaimer,
    meta: snapshot.meta,
    summary,
    entries: snapshot.items,
    sections,
    markdown: strictString(raw.markdown, 'daily_report.markdown'),
  };
  return {
    wire,
    report_id: wire.report_id,
    trading_day: wire.trading_day,
    source_snapshot_ids: [wire.source_snapshot_id],
    snapshot,
    title: `${wire.trading_day} ${wire.profile} / ${wire.market_scope} 每日研究报告`,
    markdown: wire.markdown,
    sections: wire.sections.map(section => ({
      key: section.section_id,
      title: section.title,
      markdown:
        section.kind === 'summary'
          ? `推荐 ${section.item_count} 条，高确信度 ${section.high_conviction_count} 条。`
          : `${section.ticker} · ${section.rating_band} · ${section.evidence_ids.join(', ')}`,
    })),
  };
}

interface HistorySemanticPins {
  as_of: string;
  profile: RecommendationProfile;
  market_scope: RecommendationMarketScope;
  input_fingerprint: string;
  contract_version: '0.3.1';
  profile_version: string;
  strategy_version: string;
  pipeline_version: string;
  disclaimer_version: string;
  item_count: number;
  high_conviction_count: number;
  rating_counts: RatingCounts;
}

function parseHistoryPreimage(
  preimage: string,
  fingerprint: string,
  path: string
): HistorySemanticPins {
  let decoded: unknown;
  try {
    decoded = JSON.parse(preimage);
  } catch (_error) {
    throw new RecommendationContractError(`${path} is not JSON`);
  }
  if (jcsCanonicalize(decoded) !== preimage) {
    throw new RecommendationContractError(`${path} is not canonical JCS`);
  }
  if (sha256Text(preimage) !== fingerprint) {
    throw new RecommendationContractError(`${path} hash mismatch`);
  }
  const envelope = assertExactObject(
    decoded,
    ['as_of', 'disclaimer', 'items', 'market_scope', 'meta', 'profile'],
    [],
    path
  );
  const parsedProfile = profile(envelope.profile, `${path}.profile`);
  const parsedScope = scope(envelope.market_scope, `${path}.market_scope`);
  if (!RECOMMENDATION_PROFILE_SCOPES[parsedProfile].includes(parsedScope)) {
    throw new RecommendationContractError(`${path} profile/market_scope is incompatible`);
  }
  const meta = assertExactObject(
    envelope.meta,
    [
      'contract_version',
      'input_fingerprint',
      'pipeline_version',
      'profile_version',
      'strategy_version',
    ],
    [],
    `${path}.meta`
  );
  if (meta.contract_version !== '0.3.1') {
    throw new RecommendationContractError(`${path}.meta.contract_version is invalid`);
  }
  const disclaimer = assertExactObject(
    envelope.disclaimer,
    ['effective_at', 'full_text', 'hash', 'language', 'short_text', 'version'],
    [],
    `${path}.disclaimer`
  );
  const rawItems = strictArray(envelope.items, `${path}.items`);
  const counts: RatingCounts = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  let highConvictionCount = 0;
  rawItems.forEach((value, index) => {
    const itemPath = `${path}.items[${index}]`;
    const item = assertExactObject(value, ['rating_band', 'recommendation'], [], itemPath);
    const band = strictString(item.rating_band, `${itemPath}.rating_band`) as RatingBand;
    if (!BANDS.includes(band)) {
      throw new RecommendationContractError(`${itemPath}.rating_band is invalid`);
    }
    counts[band] += 1;
    const recommendation = assertExactObject(
      item.recommendation,
      [
        'as_of',
        'conviction',
        'disclaimer_version',
        'entry_plan',
        'evidence_refs',
        'explanation',
        'model_version',
        'risk_gate',
        'score',
        'ticker',
        'trigger_signals',
        'weights',
      ],
      ['catalyst_relevance'],
      `${itemPath}.recommendation`
    );
    const conviction = assertExactObject(
      recommendation.conviction,
      ['adjustments', 'as_of', 'base', 'final', 'level', 'score_ref', 'ticker'],
      [],
      `${itemPath}.recommendation.conviction`
    );
    if (conviction.level === 'HIGH') highConvictionCount += 1;
    else if (conviction.level !== 'MED' && conviction.level !== 'LOW') {
      throw new RecommendationContractError(
        `${itemPath}.recommendation.conviction.level is invalid`
      );
    }
  });
  return {
    as_of: strictIso8601(envelope.as_of, `${path}.as_of`),
    profile: parsedProfile,
    market_scope: parsedScope,
    input_fingerprint: strictSha256(meta.input_fingerprint, `${path}.meta.input_fingerprint`),
    contract_version: '0.3.1',
    profile_version: strictSemVer(meta.profile_version, `${path}.meta.profile_version`),
    strategy_version: strictSemVer(meta.strategy_version, `${path}.meta.strategy_version`),
    pipeline_version: strictSemVer(meta.pipeline_version, `${path}.meta.pipeline_version`),
    disclaimer_version: strictSemVer(disclaimer.version, `${path}.disclaimer.version`),
    item_count: rawItems.length,
    high_conviction_count: highConvictionCount,
    rating_counts: counts,
  };
}

function parseHistoryEntry(value: unknown, index: number): B5HistoryEntryWire {
  const path = `history.entries[${index}]`;
  const raw = assertExactObject(
    value,
    [
      'report_id',
      'trading_day',
      'profile',
      'market_scope',
      'source_snapshot_id',
      'source_as_of',
      'source_output_fingerprint',
      'source_fingerprint_preimage_jcs',
      'input_fingerprint',
      'contract_version',
      'profile_version',
      'strategy_version',
      'pipeline_version',
      'disclaimer_version',
      'item_count',
      'high_conviction_count',
      'rating_counts',
      'content_preview',
    ],
    [],
    path
  );
  const parsedProfile = profile(raw.profile, `${path}.profile`);
  const parsedScope = scope(raw.market_scope, `${path}.market_scope`);
  if (!RECOMMENDATION_PROFILE_SCOPES[parsedProfile].includes(parsedScope)) {
    throw new RecommendationContractError(`${path} profile/market_scope is incompatible`);
  }
  const sourceAsOf = strictIso8601(raw.source_as_of, `${path}.source_as_of`);
  const sourceFingerprint = strictSha256(
    raw.source_output_fingerprint,
    `${path}.source_output_fingerprint`
  );
  const preimage = strictString(
    raw.source_fingerprint_preimage_jcs,
    `${path}.source_fingerprint_preimage_jcs`
  );
  const pins = parseHistoryPreimage(
    preimage,
    sourceFingerprint,
    `${path}.source_fingerprint_preimage_jcs`
  );
  const inputFingerprint = strictSha256(raw.input_fingerprint, `${path}.input_fingerprint`);
  const contractVersion =
    raw.contract_version === '0.3.1'
      ? '0.3.1'
      : (() => {
          throw new RecommendationContractError(`${path}.contract_version is invalid`);
        })();
  const profileVersion = strictSemVer(raw.profile_version, `${path}.profile_version`);
  const strategyVersion = strictSemVer(raw.strategy_version, `${path}.strategy_version`);
  const pipelineVersion = strictSemVer(raw.pipeline_version, `${path}.pipeline_version`);
  const disclaimerVersion = strictSemVer(raw.disclaimer_version, `${path}.disclaimer_version`);
  const itemCount = strictNumber(raw.item_count, `${path}.item_count`, {
    min: 0,
    integer: true,
  });
  const highConvictionCount = strictNumber(
    raw.high_conviction_count,
    `${path}.high_conviction_count`,
    { min: 0, integer: true }
  );
  const counts = ratingCounts(raw.rating_counts, `${path}.rating_counts`);
  if (
    pins.profile !== parsedProfile ||
    pins.market_scope !== parsedScope ||
    pins.as_of !== sourceAsOf ||
    pins.input_fingerprint !== inputFingerprint ||
    pins.contract_version !== contractVersion ||
    pins.profile_version !== profileVersion ||
    pins.strategy_version !== strategyVersion ||
    pins.pipeline_version !== pipelineVersion ||
    pins.disclaimer_version !== disclaimerVersion ||
    pins.item_count !== itemCount ||
    pins.high_conviction_count !== highConvictionCount ||
    !sameRatingCounts(pins.rating_counts, counts)
  ) {
    throw new RecommendationContractError(`${path} semantic preimage mismatch`);
  }
  const tradingDay = strictDay(raw.trading_day, `${path}.trading_day`);
  // Backfilled reports keep the signed snapshot timestamp immutable while the
  // persisted business date is supplied independently by the history store.
  return {
    report_id: strictString(raw.report_id, `${path}.report_id`),
    trading_day: tradingDay,
    profile: parsedProfile,
    market_scope: parsedScope,
    source_snapshot_id: strictString(raw.source_snapshot_id, `${path}.source_snapshot_id`),
    source_as_of: sourceAsOf,
    source_output_fingerprint: sourceFingerprint,
    source_fingerprint_preimage_jcs: preimage,
    input_fingerprint: inputFingerprint,
    contract_version: contractVersion,
    profile_version: profileVersion,
    strategy_version: strategyVersion,
    pipeline_version: pipelineVersion,
    disclaimer_version: disclaimerVersion,
    item_count: itemCount,
    high_conviction_count: highConvictionCount,
    rating_counts: counts,
    content_preview: strictString(raw.content_preview, `${path}.content_preview`, { max: 200 }),
  };
}

export function parseB5ReportHistory(value: unknown, page = 1, pageSize = 20): ReportHistoryPage {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new RecommendationContractError('history pagination is invalid');
  }
  const raw = assertExactObject(
    value,
    ['projection_version', 'filters', 'entries', 'total'],
    [],
    'history'
  );
  const filtersRaw = assertExactObject(
    raw.filters,
    ['query', 'profile', 'market_scope', 'from_day', 'to_day'],
    [],
    'history.filters'
  );
  const filters = {
    query: strictString(filtersRaw.query, 'history.filters.query', { min: 0 }),
    profile: nullable(filtersRaw.profile, value => profile(value, 'history.filters.profile')),
    market_scope: nullable(filtersRaw.market_scope, value =>
      scope(value, 'history.filters.market_scope')
    ),
    from_day: nullable(filtersRaw.from_day, value => strictDay(value, 'history.filters.from_day')),
    to_day: nullable(filtersRaw.to_day, value => strictDay(value, 'history.filters.to_day')),
  };
  if (
    filters.profile &&
    filters.market_scope &&
    !RECOMMENDATION_PROFILE_SCOPES[filters.profile].includes(filters.market_scope)
  ) {
    throw new RecommendationContractError('history filter profile/market_scope is incompatible');
  }
  if (filters.from_day && filters.to_day && filters.from_day > filters.to_day) {
    throw new RecommendationContractError('history filter date range is invalid');
  }
  const wireEntries = strictArray(raw.entries, 'history.entries').map(parseHistoryEntry);
  if (
    wireEntries.some(
      entry =>
        (filters.profile != null && entry.profile !== filters.profile) ||
        (filters.market_scope != null && entry.market_scope !== filters.market_scope) ||
        (filters.from_day != null && entry.trading_day < filters.from_day) ||
        (filters.to_day != null && entry.trading_day > filters.to_day)
    )
  ) {
    throw new RecommendationContractError('history entry does not satisfy filters');
  }
  const total = strictNumber(raw.total, 'history.total', { min: 0, integer: true });
  if (total !== wireEntries.length) throw new RecommendationContractError('history total mismatch');
  const wire: B5ReportHistoryWire = {
    projection_version: strictSemVer(raw.projection_version, 'history.projection_version'),
    filters,
    entries: wireEntries,
    total,
  };
  const start = (page - 1) * pageSize;
  const visible = wireEntries.slice(start, start + pageSize);
  const entries: ReportHistoryEntry[] = visible.map(entry => {
    const topRating = BANDS.find(band => entry.rating_counts[band] > 0) ?? null;
    return {
      wire: entry,
      report_id: entry.report_id,
      trading_day: entry.trading_day,
      profile: entry.profile,
      market_scope: entry.market_scope,
      snapshot_id: entry.source_snapshot_id,
      output_fingerprint: entry.source_output_fingerprint,
      entry_count: entry.item_count,
      high_conviction_count: entry.high_conviction_count,
      top_rating: topRating,
      generated_at: entry.source_as_of,
      content_preview: entry.content_preview,
    };
  });
  const query: ReportHistoryQuery = {
    search: wire.filters.query || undefined,
    profile: wire.filters.profile ?? undefined,
    market_scope: wire.filters.market_scope ?? undefined,
    date:
      wire.filters.from_day === wire.filters.to_day
        ? (wire.filters.from_day ?? undefined)
        : undefined,
    page,
    page_size: pageSize,
  };
  return { wire, entries, total, page, page_size: pageSize, query };
}
