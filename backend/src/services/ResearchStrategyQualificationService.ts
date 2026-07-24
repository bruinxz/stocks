import { createHash } from 'crypto';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';

export type ResearchStrategySource = 'morning_brief' | 'multibagger';
export type ResearchStrategyQualificationStatus = 'pass' | 'fail' | 'insufficient';

export const RESEARCH_QUALIFICATION_CONTRACT_VERSION = 'research-paper-v1';
export const RESEARCH_QUALIFICATION_POLICY = Object.freeze({
  min_pit_snapshot_count: 27,
  min_oos_trading_days: 252,
  min_after_cost_annual_return_pct: 10,
  min_benchmark_excess_return_pct: 0,
  max_drawdown_pct: 20,
  max_overfit_score: 0.3,
  required_walk_forward_verdict: 'PASS',
  min_double_cost_total_return_pct: 0,
});

export const RESEARCH_SOURCE_STRATEGY_KEYS: Record<ResearchStrategySource, string> = {
  morning_brief: 'us_preferred',
  multibagger: 'multibagger',
};

export interface ResearchQualificationBlocker {
  code: string;
  title: string;
  detail: string;
  observed?: string | number | boolean | null;
  required?: string | number | boolean | null;
}

export interface ResearchPitEvidence {
  strategy_key: string;
  snapshot_count: number;
  first_day: string | null;
  last_day: string | null;
  cumulative_return_pct: number | null;
  sharpe_ratio: number | null;
  max_drawdown_pct: number | null;
  win_rate_pct: number | null;
  evidence_hash: string | null;
}

export interface ResearchQualificationAudit {
  strategy_key: string;
  verdict: string;
  created_at: string | Date;
  metadata: Record<string, unknown>;
}

export interface ResearchStrategyQualification {
  source: ResearchStrategySource;
  strategy_key: string;
  status: ResearchStrategyQualificationStatus;
  eligible_for_new_positions: boolean;
  verdict: string;
  evaluated_at: string;
  audit_created_at: string | null;
  evidence: {
    pit: ResearchPitEvidence | null;
    qualification_contract_version: string | null;
    oos_trading_days: number | null;
    after_cost_annual_return_pct: number | null;
    benchmark_excess_return_pct: number | null;
    max_drawdown_pct: number | null;
    walk_forward_verdict: string | null;
    overfit_score: number | null;
    double_cost_total_return_pct: number | null;
    point_in_time_ready: boolean;
    evidence_hash: string | null;
  };
  blockers: ResearchQualificationBlocker[];
  summary: string;
}

export interface ResearchStrategyQualificationSummary {
  status: 'pass' | 'partial' | 'blocked';
  eligible_source_count: number;
  source_count: number;
  allows_new_positions: boolean;
  evaluated_at: string;
  sources: Record<ResearchStrategySource, ResearchStrategyQualification>;
}

interface PitEvidenceRow {
  strategy_key: string;
  snapshot_count: number | string;
  first_day: string | Date | null;
  last_day: string | Date | null;
  cumulative_return_pct: number | string | null;
  sharpe_ratio: number | string | null;
  max_drawdown_pct: number | string | null;
  win_rate_pct: number | string | null;
  evidence_material: string | null;
}

interface AuditRow {
  strategy_key: string;
  verdict: string;
  created_at: string | Date;
  metadata: Record<string, unknown> | null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoDay(value: string | Date | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function isoTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function metricBlocker(input: {
  code: string;
  title: string;
  observed: number | null;
  required: number;
  passes: (observed: number) => boolean;
  unit?: string;
}): ResearchQualificationBlocker | null {
  if (input.observed === null) {
    return {
      code: `${input.code}_missing`,
      title: `${input.title}缺失`,
      detail: `没有可核验的${input.title}，按失败关闭处理。`,
      observed: null,
      required: `${input.required}${input.unit || ''}`,
    };
  }
  if (input.passes(input.observed)) return null;
  return {
    code: input.code,
    title: `${input.title}未达标`,
    detail: `${input.title}为 ${input.observed}${input.unit || ''}，要求 ${input.required}${
      input.unit || ''
    }。`,
    observed: input.observed,
    required: input.required,
  };
}

export function evaluateResearchStrategyQualification(input: {
  source: ResearchStrategySource;
  pit: ResearchPitEvidence | null;
  audit: ResearchQualificationAudit | null;
  evaluated_at?: Date;
}): ResearchStrategyQualification {
  const evaluatedAt = (input.evaluated_at || new Date()).toISOString();
  const strategyKey = RESEARCH_SOURCE_STRATEGY_KEYS[input.source];
  const auditMetadata = objectValue(input.audit?.metadata);
  const qualification = objectValue(auditMetadata.qualification || auditMetadata);
  const contractVersion =
    typeof qualification.qualification_contract_version === 'string'
      ? qualification.qualification_contract_version
      : null;
  const oosTradingDays = finiteOrNull(qualification.oos_trading_days);
  const afterCostAnnualReturn = finiteOrNull(qualification.after_cost_annual_return_pct);
  const benchmarkExcessReturn = finiteOrNull(qualification.benchmark_excess_return_pct);
  const maxDrawdown = finiteOrNull(qualification.max_drawdown_pct);
  const walkForwardVerdict =
    typeof qualification.walk_forward_verdict === 'string'
      ? qualification.walk_forward_verdict.toUpperCase()
      : null;
  const overfitScore = finiteOrNull(qualification.overfit_score);
  const doubleCostReturn = finiteOrNull(qualification.double_cost_total_return_pct);
  const pointInTimeReady = qualification.point_in_time_ready === true;
  const auditEvidenceHash =
    typeof qualification.evidence_hash === 'string' && qualification.evidence_hash.length >= 32
      ? qualification.evidence_hash
      : null;
  const blockers: ResearchQualificationBlocker[] = [];
  let hasHardFailure = false;

  if (
    !input.pit ||
    input.pit.snapshot_count < RESEARCH_QUALIFICATION_POLICY.min_pit_snapshot_count
  ) {
    blockers.push({
      code: 'pit_evidence_insufficient',
      title: 'PIT 回测证据不足',
      detail: `至少需要 ${RESEARCH_QUALIFICATION_POLICY.min_pit_snapshot_count} 个可信检查点。`,
      observed: input.pit?.snapshot_count || 0,
      required: RESEARCH_QUALIFICATION_POLICY.min_pit_snapshot_count,
    });
  }

  if (input.pit && input.pit.cumulative_return_pct === null) {
    blockers.push({
      code: 'pit_metrics_missing',
      title: 'PIT 收益指标缺失',
      detail: '可信快照没有完整累计收益，不能证明策略具备正收益。',
    });
  }

  if (input.pit?.cumulative_return_pct !== null && input.pit?.cumulative_return_pct !== undefined) {
    if (input.pit.cumulative_return_pct <= 0) {
      hasHardFailure = true;
      blockers.push({
        code: 'pit_after_cost_return_non_positive',
        title: '真实成本后回测亏损',
        detail: `当前可信 PIT 回测累计收益为 ${input.pit.cumulative_return_pct.toFixed(
          2
        )}%，亏损策略不得新增模拟仓位。`,
        observed: input.pit.cumulative_return_pct,
        required: '> 0%',
      });
    }
    if ((input.pit.sharpe_ratio ?? 0) <= 0) {
      hasHardFailure = true;
      blockers.push({
        code: 'pit_sharpe_non_positive',
        title: '风险调整收益为负',
        detail: `当前可信 PIT 回测 Sharpe 为 ${(input.pit.sharpe_ratio ?? 0).toFixed(2)}。`,
        observed: input.pit.sharpe_ratio,
        required: '> 0',
      });
    }
    if (
      (input.pit.max_drawdown_pct ?? Number.POSITIVE_INFINITY) >
      RESEARCH_QUALIFICATION_POLICY.max_drawdown_pct
    ) {
      hasHardFailure = true;
      blockers.push({
        code: 'pit_drawdown_too_high',
        title: '历史回撤超限',
        detail: `当前可信 PIT 回测最大回撤为 ${(input.pit.max_drawdown_pct ?? 0).toFixed(
          2
        )}%，超过纸面策略准入上限。`,
        observed: input.pit.max_drawdown_pct,
        required: RESEARCH_QUALIFICATION_POLICY.max_drawdown_pct,
      });
    }
  }

  const auditVerdict = String(input.audit?.verdict || 'INSUFFICIENT').toUpperCase();
  if (!input.audit) {
    blockers.push({
      code: 'qualification_audit_missing',
      title: '策略资格审计缺失',
      detail: '尚未生成包含样本外、walk-forward 与成本压力结果的资格审计。',
    });
  } else if (auditVerdict !== 'PASS') {
    if (auditVerdict === 'FAIL') hasHardFailure = true;
    blockers.push({
      code: 'qualification_audit_not_passed',
      title: '策略资格审计未通过',
      detail: `最新审计结论为 ${auditVerdict}，只有 PASS 可以新增模拟仓位。`,
      observed: auditVerdict,
      required: 'PASS',
    });
  }

  if (input.audit) {
    if (contractVersion !== RESEARCH_QUALIFICATION_CONTRACT_VERSION) {
      blockers.push({
        code: 'qualification_contract_invalid',
        title: '资格审计契约不匹配',
        detail: `必须使用 ${RESEARCH_QUALIFICATION_CONTRACT_VERSION} 完整证据契约。`,
        observed: contractVersion,
        required: RESEARCH_QUALIFICATION_CONTRACT_VERSION,
      });
    }
    if (!pointInTimeReady) {
      blockers.push({
        code: 'point_in_time_not_ready',
        title: 'PIT 约束未通过',
        detail: '审计没有证明所有训练、验证和成交输入在当时可见。',
        observed: pointInTimeReady,
        required: true,
      });
    }
    if (
      !auditEvidenceHash ||
      (input.pit?.evidence_hash && auditEvidenceHash !== input.pit.evidence_hash)
    ) {
      blockers.push({
        code: 'qualification_evidence_hash_invalid',
        title: '资格证据无法追溯',
        detail: '审计证据哈希缺失或与当前 PIT 快照不一致。',
        observed: auditEvidenceHash,
        required: input.pit?.evidence_hash || '当前 PIT 证据哈希',
      });
    }

    const metricChecks = [
      metricBlocker({
        code: 'oos_history_too_short',
        title: '样本外交易日',
        observed: oosTradingDays,
        required: RESEARCH_QUALIFICATION_POLICY.min_oos_trading_days,
        passes: value => value >= RESEARCH_QUALIFICATION_POLICY.min_oos_trading_days,
        unit: '天',
      }),
      metricBlocker({
        code: 'after_cost_return_too_low',
        title: '成本后年化收益',
        observed: afterCostAnnualReturn,
        required: RESEARCH_QUALIFICATION_POLICY.min_after_cost_annual_return_pct,
        passes: value => value >= RESEARCH_QUALIFICATION_POLICY.min_after_cost_annual_return_pct,
        unit: '%',
      }),
      metricBlocker({
        code: 'benchmark_excess_not_positive',
        title: '基准超额收益',
        observed: benchmarkExcessReturn,
        required: RESEARCH_QUALIFICATION_POLICY.min_benchmark_excess_return_pct,
        passes: value => value > RESEARCH_QUALIFICATION_POLICY.min_benchmark_excess_return_pct,
        unit: '%',
      }),
      metricBlocker({
        code: 'drawdown_too_high',
        title: '最大回撤',
        observed: maxDrawdown,
        required: RESEARCH_QUALIFICATION_POLICY.max_drawdown_pct,
        passes: value => value <= RESEARCH_QUALIFICATION_POLICY.max_drawdown_pct,
        unit: '%',
      }),
      metricBlocker({
        code: 'overfit_score_too_high',
        title: '过拟合风险分',
        observed: overfitScore,
        required: RESEARCH_QUALIFICATION_POLICY.max_overfit_score,
        passes: value => value <= RESEARCH_QUALIFICATION_POLICY.max_overfit_score,
      }),
      metricBlocker({
        code: 'double_cost_return_not_positive',
        title: '双倍成本压力收益',
        observed: doubleCostReturn,
        required: RESEARCH_QUALIFICATION_POLICY.min_double_cost_total_return_pct,
        passes: value => value > RESEARCH_QUALIFICATION_POLICY.min_double_cost_total_return_pct,
        unit: '%',
      }),
    ].filter((item): item is ResearchQualificationBlocker => Boolean(item));
    blockers.push(...metricChecks);

    if (walkForwardVerdict !== RESEARCH_QUALIFICATION_POLICY.required_walk_forward_verdict) {
      blockers.push({
        code: 'walk_forward_not_passed',
        title: 'Walk-forward 未通过',
        detail: '滚动样本外验证必须明确为 PASS。',
        observed: walkForwardVerdict,
        required: RESEARCH_QUALIFICATION_POLICY.required_walk_forward_verdict,
      });
    }
  }

  const eligible = Boolean(input.audit) && auditVerdict === 'PASS' && blockers.length === 0;
  const status: ResearchStrategyQualificationStatus = eligible
    ? 'pass'
    : hasHardFailure
    ? 'fail'
    : 'insufficient';
  const summary = eligible
    ? '资格证据完整，允许进入模拟盘新增仓位。'
    : status === 'fail'
    ? `资格失败：${blockers[0]?.detail || '历史证据未达标。'}`
    : `证据不足：${blockers[0]?.detail || '尚未完成完整资格审计。'}`;

  return {
    source: input.source,
    strategy_key: strategyKey,
    status,
    eligible_for_new_positions: eligible,
    verdict: auditVerdict,
    evaluated_at: evaluatedAt,
    audit_created_at: isoTime(input.audit?.created_at),
    evidence: {
      pit: input.pit,
      qualification_contract_version: contractVersion,
      oos_trading_days: oosTradingDays,
      after_cost_annual_return_pct: afterCostAnnualReturn,
      benchmark_excess_return_pct: benchmarkExcessReturn,
      max_drawdown_pct: maxDrawdown,
      walk_forward_verdict: walkForwardVerdict,
      overfit_score: overfitScore,
      double_cost_total_return_pct: doubleCostReturn,
      point_in_time_ready: pointInTimeReady,
      evidence_hash: auditEvidenceHash,
    },
    blockers,
    summary,
  };
}

export function summarizeResearchStrategyQualifications(input: {
  qualifications: Record<ResearchStrategySource, ResearchStrategyQualification>;
  evaluated_at?: Date;
}): ResearchStrategyQualificationSummary {
  const items = Object.values(input.qualifications);
  const eligibleCount = items.filter(item => item.eligible_for_new_positions).length;
  return {
    status: eligibleCount === items.length ? 'pass' : eligibleCount > 0 ? 'partial' : 'blocked',
    eligible_source_count: eligibleCount,
    source_count: items.length,
    allows_new_positions: eligibleCount > 0,
    evaluated_at: (input.evaluated_at || new Date()).toISOString(),
    sources: input.qualifications,
  };
}

export class ResearchStrategyQualificationService {
  async getSummary(now = new Date()): Promise<ResearchStrategyQualificationSummary> {
    const strategyKeys = Object.values(RESEARCH_SOURCE_STRATEGY_KEYS);
    const [pitRows, auditRows] = await Promise.all([
      sequelize.query<PitEvidenceRow>(
        `WITH trusted AS (
           SELECT bps.*
             FROM backtest_pit_snapshot bps
            WHERE bps.strategy IN (:strategy_keys)
              AND bps.market_scope = 'cn_a'
              AND bps.is_survivorship_biased = FALSE
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_each_text(bps.source_versions) source
                 WHERE LOWER(source.value) ~ '(fixture|synthetic|mock|seed)'
              )
              AND (
                bps.strategy <> 'us_preferred'
                OR (
                  bps.source_versions->>'calendar' LIKE 'production-daily-bars-calendar@%'
                  AND bps.source_versions->>'membership' = 'stock-master-listing-history@1.0.0'
                  AND bps.source_versions->>'prices' = 'daily-bars-close-execution@2.0.0'
                  AND bps.source_versions->>'ranking' = 'six-factor-prior-session@2.0.0'
                  AND bps.source_versions->>'cost_model' = 'commission5-slippage5@1.0.0'
                )
              )
         ), ranked AS (
           SELECT trusted.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY trusted.strategy ORDER BY trusted.snapshot_day DESC
                  ) AS recency
             FROM trusted
         ), aggregate AS (
           SELECT strategy AS strategy_key,
                  COUNT(*)::int AS snapshot_count,
                  MIN(snapshot_day)::text AS first_day,
                  MAX(snapshot_day)::text AS last_day,
                  (MAX(ABS((metrics->>'drawdown')::numeric)) * 100) AS max_drawdown_pct,
                  STRING_AGG(fact_hash, '' ORDER BY snapshot_day) AS evidence_material
             FROM trusted
            GROUP BY strategy
         )
         SELECT aggregate.*,
                ((ranked.metrics->>'cumulative_return')::numeric * 100) AS cumulative_return_pct,
                (ranked.metrics->>'sharpe_ratio_6m')::numeric AS sharpe_ratio,
                aggregate.max_drawdown_pct,
                ((ranked.metrics->>'win_rate_6m')::numeric * 100) AS win_rate_pct
           FROM aggregate
           JOIN ranked ON ranked.strategy = aggregate.strategy_key AND ranked.recency = 1`,
        {
          replacements: { strategy_keys: strategyKeys },
          type: QueryTypes.SELECT,
        }
      ),
      sequelize.query<AuditRow>(
        `SELECT DISTINCT ON (strategy_key)
                strategy_key, verdict, created_at, COALESCE(metadata, '{}'::jsonb) AS metadata
           FROM research_integrity_audits
          WHERE strategy_key IN (:strategy_keys)
            AND source = 'standalone'
            AND created_at <= :now
          ORDER BY strategy_key, created_at DESC, id DESC`,
        {
          replacements: { strategy_keys: strategyKeys, now },
          type: QueryTypes.SELECT,
        }
      ),
    ]);

    const pitByStrategy = new Map<string, ResearchPitEvidence>();
    for (const row of pitRows) {
      pitByStrategy.set(row.strategy_key, {
        strategy_key: row.strategy_key,
        snapshot_count: Number(row.snapshot_count || 0),
        first_day: isoDay(row.first_day),
        last_day: isoDay(row.last_day),
        cumulative_return_pct: finiteOrNull(row.cumulative_return_pct),
        sharpe_ratio: finiteOrNull(row.sharpe_ratio),
        max_drawdown_pct: finiteOrNull(row.max_drawdown_pct),
        win_rate_pct: finiteOrNull(row.win_rate_pct),
        evidence_hash: row.evidence_material
          ? createHash('sha256').update(row.evidence_material).digest('hex')
          : null,
      });
    }
    const auditByStrategy = new Map<string, ResearchQualificationAudit>();
    for (const row of auditRows) {
      auditByStrategy.set(row.strategy_key, {
        strategy_key: row.strategy_key,
        verdict: row.verdict,
        created_at: row.created_at,
        metadata: objectValue(row.metadata),
      });
    }

    const qualifications = {} as Record<ResearchStrategySource, ResearchStrategyQualification>;
    for (const source of Object.keys(RESEARCH_SOURCE_STRATEGY_KEYS) as ResearchStrategySource[]) {
      const strategyKey = RESEARCH_SOURCE_STRATEGY_KEYS[source];
      qualifications[source] = evaluateResearchStrategyQualification({
        source,
        pit: pitByStrategy.get(strategyKey) || null,
        audit: auditByStrategy.get(strategyKey) || null,
        evaluated_at: now,
      });
    }
    return summarizeResearchStrategyQualifications({ qualifications, evaluated_at: now });
  }
}

export const researchStrategyQualificationService = new ResearchStrategyQualificationService();
