export interface SecurityDescriptor {
  symbol?: string | null;
  name?: string | null;
  industry?: string | null;
  type?: string | null;
}

export type SecurityTypeLabel = '股票' | '指数' | 'ETF' | '基金' | '债券' | '未分类';

function looksLikeEtf(security: SecurityDescriptor): boolean {
  const name = String(security.name ?? '');
  const industry = String(security.industry ?? '');
  return /ETF/i.test(name) || /ETF/i.test(industry) || /交易型开放式/.test(name);
}

/**
 * Convert the persisted instrument type into a user-facing A-share catalogue
 * label. Older ETF rows may only carry an ETF industry/name marker, so the
 * fund branch retains that compatibility without treating every fund as ETF.
 */
export function securityTypeLabel(security: SecurityDescriptor): SecurityTypeLabel {
  const type = String(security.type ?? '')
    .trim()
    .toLowerCase();
  if (type === 'stock') return '股票';
  if (type === 'index') return '指数';
  if (type === 'etf') return 'ETF';
  if (type === 'fund') return looksLikeEtf(security) ? 'ETF' : '基金';
  if (type === 'bond') return '债券';

  // Honest compatibility for legacy rows whose type predates the type column.
  if (looksLikeEtf(security)) return 'ETF';
  return '未分类';
}

export interface SecurityListQueryInput {
  page: number;
  limit: number;
  market?: string;
  search?: string;
}

/**
 * The catalogue query deliberately has no `type` constraint: listed stocks,
 * indices, ETFs, other funds and bonds must all remain visible.
 */
export function buildSecurityListParams(
  input: SecurityListQueryInput
): Record<string, string | number> {
  return {
    page: input.page,
    limit: input.limit,
    listedOnly: 'true',
    ...(input.market ? { market: input.market } : {}),
    ...(input.search ? { search: input.search } : {}),
  };
}
