import { QuantResearchArtifactStatus } from '../../models/QuantResearchArtifact';

export type PointInTimeAuditStatus = Extract<
  QuantResearchArtifactStatus,
  'pass' | 'watch' | 'reject' | 'insufficient'
>;

export interface DisclosureVisibilityInput {
  source_name: string;
  as_of_date: string;
  rows: Array<Record<string, any>>;
  disclosure_date_required?: boolean;
}

export interface DisclosureVisibilityResult {
  key: 'disclosure_date';
  source_name: string;
  status: PointInTimeAuditStatus;
  as_of_date: string;
  total_count: number;
  visible_count: number;
  future_count: number;
  missing_disclosure_count: number;
  future_rows: Array<Record<string, any>>;
  missing_rows: Array<Record<string, any>>;
  summary: string;
}

export interface HistoricalMembershipInput {
  source_name: string;
  as_of_date: string;
  rows: Array<Record<string, any>>;
}

export interface HistoricalMembershipResult {
  key: 'universe_visibility';
  source_name: string;
  status: PointInTimeAuditStatus;
  as_of_date: string;
  total_count: number;
  active_symbols: string[];
  future_rows: Array<Record<string, any>>;
  expired_rows: Array<Record<string, any>>;
  missing_effective_count: number;
  summary: string;
}

export interface PointInTimeArtifactInput {
  data_policy_json?: Record<string, any> | null;
  constraint_policy_json?: Record<string, any> | null;
  disclosure_checks?: DisclosureVisibilityResult[];
  universe_checks?: HistoricalMembershipResult[];
}

function statusRank(status: PointInTimeAuditStatus): number {
  if (status === 'reject') return 4;
  if (status === 'insufficient') return 3;
  if (status === 'watch') return 2;
  return 1;
}

function worstStatus(statuses: PointInTimeAuditStatus[]): PointInTimeAuditStatus {
  if (statuses.length === 0) return 'insufficient';
  return statuses.slice().sort((a, b) => statusRank(b) - statusRank(a))[0];
}

function readIsoDate(row: Record<string, any>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row?.[key];
    if (value === null || value === undefined || value === '') continue;
    return String(value).slice(0, 10);
  }
  return null;
}

function slimRow(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of [
    'id',
    'stock_code',
    'symbol',
    'report_period',
    'report_date',
    'announce_date',
    'effective_date',
    'end_date',
    'industry',
    'index_code',
  ]) {
    if (row?.[key] !== undefined) out[key] = row[key];
  }
  return Object.keys(out).length ? out : row;
}

export function auditDisclosureVisibility(
  input: DisclosureVisibilityInput
): DisclosureVisibilityResult {
  const required = input.disclosure_date_required !== false;
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const futureRows: Array<Record<string, any>> = [];
  const missingRows: Array<Record<string, any>> = [];
  let visibleCount = 0;

  for (const row of rows) {
    const announceDate = readIsoDate(row, ['announce_date', 'disclosure_date', 'published_at']);
    if (!announceDate) {
      if (required) missingRows.push(slimRow(row));
      continue;
    }
    if (announceDate > input.as_of_date) {
      futureRows.push(slimRow(row));
      continue;
    }
    visibleCount += 1;
  }

  const status: PointInTimeAuditStatus =
    futureRows.length > 0 ? 'reject' : missingRows.length > 0 ? 'insufficient' : 'pass';
  const summary =
    status === 'reject'
      ? `${input.source_name} 有 ${futureRows.length} 条数据在 ${input.as_of_date} 后才披露。`
      : status === 'insufficient'
      ? `${input.source_name} 有 ${missingRows.length} 条数据缺少披露日，无法证明点时可见。`
      : `${input.source_name} 的 ${visibleCount} 条披露式数据在 ${input.as_of_date} 前可见。`;

  return {
    key: 'disclosure_date',
    source_name: input.source_name,
    status,
    as_of_date: input.as_of_date,
    total_count: rows.length,
    visible_count: visibleCount,
    future_count: futureRows.length,
    missing_disclosure_count: missingRows.length,
    future_rows: futureRows,
    missing_rows: missingRows,
    summary,
  };
}

export function auditHistoricalMembershipVisibility(
  input: HistoricalMembershipInput
): HistoricalMembershipResult {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const activeSymbols = new Set<string>();
  const futureRows: Array<Record<string, any>> = [];
  const expiredRows: Array<Record<string, any>> = [];
  let missingEffectiveCount = 0;

  for (const row of rows) {
    const effectiveDate = readIsoDate(row, ['effective_date', 'start_date', 'as_of_date']);
    const endDate = readIsoDate(row, ['end_date', 'removed_date', 'expire_date']);
    const symbol = String(row.symbol || row.stock_code || '').trim();
    if (!effectiveDate) {
      missingEffectiveCount += 1;
      continue;
    }
    if (effectiveDate > input.as_of_date) {
      futureRows.push(slimRow(row));
      continue;
    }
    if (endDate && endDate < input.as_of_date) {
      expiredRows.push(slimRow(row));
      continue;
    }
    if (symbol) activeSymbols.add(symbol);
  }

  const status: PointInTimeAuditStatus =
    missingEffectiveCount > 0 ? 'insufficient' : futureRows.length > 0 ? 'watch' : 'pass';
  const summary =
    status === 'insufficient'
      ? `${input.source_name} 有 ${missingEffectiveCount} 条成分记录缺少生效日。`
      : `${input.source_name} 在 ${input.as_of_date} 可见 ${activeSymbols.size} 个有效成分。`;

  return {
    key: 'universe_visibility',
    source_name: input.source_name,
    status,
    as_of_date: input.as_of_date,
    total_count: rows.length,
    active_symbols: Array.from(activeSymbols).sort(),
    future_rows: futureRows,
    expired_rows: expiredRows,
    missing_effective_count: missingEffectiveCount,
    summary,
  };
}

function policySlot(
  key: 'disclosure_date' | 'status_visibility' | 'universe_visibility',
  label: string,
  status: PointInTimeAuditStatus,
  summary: string
) {
  return { key, label, status, summary };
}

export function buildPointInTimeArtifact(input: PointInTimeArtifactInput) {
  const dataPolicy = input.data_policy_json || {};
  const constraintPolicy = input.constraint_policy_json || {};
  const disclosureChecks = input.disclosure_checks || [];
  const universeChecks = input.universe_checks || [];
  const issueSlots: any[] = [];

  if (dataPolicy.point_in_time === false) {
    issueSlots.push(
      policySlot('disclosure_date', '披露日可见性', 'reject', '数据策略显式关闭 point_in_time。')
    );
  } else if (disclosureChecks.length > 0) {
    issueSlots.push(...disclosureChecks);
  } else {
    const coverage = dataPolicy.audit_coverage?.disclosure_date;
    issueSlots.push(
      policySlot(
        'disclosure_date',
        '披露日可见性',
        coverage ? 'pass' : dataPolicy.disclosure_date_required ? 'insufficient' : 'watch',
        coverage
          ? '数据策略声明披露日由策略/因子层按 as-of 过滤。'
          : dataPolicy.disclosure_date_required
          ? '缺少披露日行级审计样本，无法证明财报/公告数据点时可见。'
          : '未要求披露日行级审计，建议补充。'
      )
    );
  }

  if (constraintPolicy.block_suspended === false) {
    issueSlots.push(
      policySlot('status_visibility', '停牌/ST 可见性', 'watch', '成交约束未强制阻断停牌。')
    );
  } else {
    issueSlots.push(
      policySlot(
        'status_visibility',
        '停牌/ST 可见性',
        'pass',
        'A 股约束引擎会在成交层检查停牌、零成交和 ST 过滤。'
      )
    );
  }

  if (universeChecks.length > 0) {
    issueSlots.push(...universeChecks);
  } else {
    const coverage = dataPolicy.audit_coverage?.universe_visibility;
    issueSlots.push(
      policySlot(
        'universe_visibility',
        '股票池历史可见性',
        coverage ? 'pass' : dataPolicy.universe_as_of_required ? 'insufficient' : 'watch',
        coverage
          ? '股票池/行业/指数成分声明按历史版本或 as-of 快照读取。'
          : dataPolicy.universe_as_of_required
          ? '缺少股票池历史版本审计样本，无法证明未使用未来成分。'
          : '未强制要求股票池历史版本审计，建议补充。'
      )
    );
  }

  const status = worstStatus(issueSlots.map(slot => slot.status));
  const blocking = issueSlots.filter(slot => slot.status === 'reject');
  const insufficient = issueSlots.filter(slot => slot.status === 'insufficient');
  const watch = issueSlots.filter(slot => slot.status === 'watch');
  const summary =
    status === 'reject'
      ? `点时数据审计阻断：${blocking.map(slot => slot.summary).join('；')}`
      : status === 'insufficient'
      ? `点时数据审计证据不足：${insufficient.map(slot => slot.summary).join('；')}`
      : status === 'watch'
      ? `点时数据审计需谨慎：${watch.map(slot => slot.summary).join('；')}`
      : '点时数据审计通过，未发现未来可见性阻断。';

  return {
    artifact_type: 'point_in_time_audit' as const,
    source_type: 'point_in_time_policy',
    source_id: null,
    status,
    title: '点时数据审计',
    summary,
    payload_json: {
      issue_slots: issueSlots,
      data_policy_json: dataPolicy,
      constraint_policy_json: constraintPolicy,
    },
  };
}
