export const REPLAY_PROTOCOL_VERSION = '1.0.0' as const;

export const REPLAY_PROFILES = [
  'us_preferred',
  'multibagger',
  'japan_blue_chip',
  'japan_multibagger',
  'korea_semiconductor_chain',
  'korea_multibagger',
] as const;

export const REPLAY_MARKET_SCOPES = ['cn_a', 'us', 'jp', 'kr'] as const;

export type ReplayProfile = (typeof REPLAY_PROFILES)[number];
export type ReplayMarketScope = (typeof REPLAY_MARKET_SCOPES)[number];

export const REPLAY_PROFILE_SCOPES: Record<ReplayProfile, readonly ReplayMarketScope[]> = {
  us_preferred: ['cn_a', 'us'],
  multibagger: ['cn_a', 'us'],
  japan_blue_chip: ['jp'],
  japan_multibagger: ['jp'],
  korea_semiconductor_chain: ['kr'],
  korea_multibagger: ['kr'],
};

export interface ReplayPins {
  trading_day: string;
  as_of: string;
  profile: ReplayProfile;
  market_scope: ReplayMarketScope;
  profile_version: string;
  contract_version: '0.3.1';
  input_fingerprint: string;
  strategy_version: string;
  pipeline_version: string;
}

export type ReplayJob =
  | { job_id: string; status: 'queued' | 'running' }
  | { job_id: string; status: 'completed'; snapshot_id: string }
  | { job_id: string; status: 'failed'; error: string };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TRADING_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class ReplayContractError extends Error {
  constructor(message = 'Replay contract is invalid') {
    super(message);
    this.name = 'ReplayContractError';
  }
}

export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function isCanonicalSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

export function isSemVer(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

export function isTradingDay(value: unknown): value is string {
  if (typeof value !== 'string' || !TRADING_DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isUtcSeconds(value: unknown): value is string {
  if (typeof value !== 'string' || !UTC_SECONDS.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value.replace('Z', '.000Z');
}

export function isReplayScopeCompatible(
  profile: ReplayProfile,
  marketScope: ReplayMarketScope
): boolean {
  return REPLAY_PROFILE_SCOPES[profile].includes(marketScope);
}

export function parseReplayPins(value: unknown): ReplayPins {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReplayContractError();
  }
  const raw = value as Record<string, unknown>;
  const expectedKeys = [
    'trading_day',
    'as_of',
    'profile',
    'market_scope',
    'profile_version',
    'contract_version',
    'input_fingerprint',
    'strategy_version',
    'pipeline_version',
  ].sort();
  const actualKeys = Object.keys(raw).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new ReplayContractError();
  }
  if (
    !isTradingDay(raw.trading_day) ||
    !isUtcSeconds(raw.as_of) ||
    typeof raw.profile !== 'string' ||
    !REPLAY_PROFILES.includes(raw.profile as ReplayProfile) ||
    typeof raw.market_scope !== 'string' ||
    !REPLAY_MARKET_SCOPES.includes(raw.market_scope as ReplayMarketScope) ||
    !isReplayScopeCompatible(raw.profile as ReplayProfile, raw.market_scope as ReplayMarketScope) ||
    !isSemVer(raw.profile_version) ||
    raw.contract_version !== '0.3.1' ||
    !isCanonicalSha256(raw.input_fingerprint) ||
    !isSemVer(raw.strategy_version) ||
    !isSemVer(raw.pipeline_version)
  ) {
    throw new ReplayContractError();
  }
  return Object.freeze({ ...raw }) as unknown as ReplayPins;
}
