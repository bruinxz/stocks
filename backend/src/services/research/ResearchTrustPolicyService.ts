import { Op } from 'sequelize';
import { QuantBacktestOptions } from '../../quant/types/QuantTypes';
// QuantResearchArtifact deleted - use local type
type QuantResearchArtifactStatus =
  | 'pending'
  | 'pass'
  | 'watch'
  | 'reject'
  | 'insufficient'
  | string;

type ExecutionSide = 'BUY' | 'SELL';

export interface ResearchExecutionGateInput {
  side: ExecutionSide;
  symbol: string;
  profile: Record<string, any>;
  quote?: Record<string, any> | null;
  policy?: Record<string, any> | null;
}

export interface ResearchExecutionGateDecision {
  allowed: boolean;
  side: ExecutionSide;
  action: 'allow' | 'reject';
  label: string;
  reasons: string[];
  price?: number;
  price_source?: string;
  change_percent?: number;
  checks: Record<string, any>;
}

export interface TrustedRerunBuildInput {
  source_task_id: number;
  experiment_id?: number | null;
  task_name?: string;
  universe?: string;
  strategy_keys?: string[];
  symbols?: string[];
  start_date: string;
  end_date: string;
  initial_capital?: number;
  commission_rate?: number;
  slippage_rate?: number;
  parameters?: Record<string, any> | null;
}

function toFiniteNumber(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBooleanDefault(value: any, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return Boolean(value);
}

function asObject(value: any): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function dateOnly(value: any): string {
  if (!value) return new Date().toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function countPitBlockingRows(pointInTimeArtifact: any): number {
  const slots = Array.isArray(pointInTimeArtifact?.payload_json?.issue_slots)
    ? pointInTimeArtifact.payload_json.issue_slots
    : [];
  return slots.reduce((sum: number, slot: any) => {
    if (!['reject', 'insufficient'].includes(String(slot?.status || ''))) return sum;
    return (
      sum +
      toFiniteNumber(slot?.future_count, 0) +
      toFiniteNumber(slot?.missing_disclosure_count, 0) +
      toFiniteNumber(slot?.missing_effective_count, 0)
    );
  }, 0);
}

export function buildPointInTimeFactorWhere(
  symbols: string[],
  as_of_date: string
): Record<string, any> {
  return {
    symbol: { [Op.in]: symbols },
    factor_date: { [Op.lte]: dateOnly(as_of_date) },
  };
}

export function buildAuditedReturnReplayArtifact(input: {
  best_result?: Record<string, any> | null;
  point_in_time_artifact?: Record<string, any> | null;
  execution_artifact?: Record<string, any> | null;
}) {
  const best = input.best_result || null;
  if (!best) {
    return {
      artifact_type: 'audited_return_replay' as const,
      source_type: 'trusted_return_replay',
      source_id: null,
      status: 'insufficient' as QuantResearchArtifactStatus,
      title: '审计后收益回放',
      summary: '缺少可回放的回测结果，无法生成审计后收益。',
      payload_json: {},
    };
  }

  const theoreticalReturn = toFiniteNumber(best.total_return_pct, 0);
  const theoreticalAnnualReturn = toFiniteNumber(best.annual_return_pct, theoreticalReturn);
  const theoreticalDrawdown = Math.abs(toFiniteNumber(best.max_drawdown_pct, 0));
  const tradeCount = Math.max(1, toFiniteNumber(best.trade_count, 0));
  const pitStatus = String(input.point_in_time_artifact?.status || 'pass');
  const executionStatus = String(input.execution_artifact?.status || 'pass');
  const pitBlockingRows = countPitBlockingRows(input.point_in_time_artifact);
  const rejectedOrderCount = toFiniteNumber(
    input.execution_artifact?.payload_json?.rejected_order_count,
    0
  );
  const pitPenalty =
    pitStatus === 'reject'
      ? Math.min(0.85, Math.max(0.2, pitBlockingRows / Math.max(tradeCount, 1)))
      : pitStatus === 'insufficient'
      ? 0.35
      : pitStatus === 'watch'
      ? 0.12
      : 0;
  const executionPenalty =
    executionStatus === 'reject' || executionStatus === 'watch'
      ? Math.min(0.8, rejectedOrderCount / Math.max(tradeCount + rejectedOrderCount, 1))
      : 0;
  const auditedReturn = theoreticalReturn * (1 - pitPenalty);
  const executableReturn = auditedReturn * (1 - executionPenalty);
  const auditedAnnualReturn = theoreticalAnnualReturn * (1 - pitPenalty);
  const executableAnnualReturn = auditedAnnualReturn * (1 - executionPenalty);
  const adjustedDrawdown = theoreticalDrawdown * (1 + pitPenalty * 0.35 + executionPenalty * 0.55);
  const status: QuantResearchArtifactStatus =
    pitPenalty > 0 || executionPenalty > 0 ? 'watch' : 'pass';

  return {
    artifact_type: 'audited_return_replay' as const,
    source_type: 'trusted_return_replay',
    source_id: best.id ? Number(best.id) : null,
    status,
    title: '审计后收益回放',
    summary:
      status === 'pass'
        ? '理论收益、点时审计收益和可成交收益一致，未发现需要扣减的审计项。'
        : `理论收益 ${theoreticalReturn.toFixed(
            2
          )}%，按 PIT 与成交约束回放后约 ${executableReturn.toFixed(2)}%。`,
    payload_json: {
      theoretical_return_pct: Number(theoreticalReturn.toFixed(4)),
      audited_return_pct: Number(auditedReturn.toFixed(4)),
      executable_return_pct: Number(executableReturn.toFixed(4)),
      theoretical_annual_return_pct: Number(theoreticalAnnualReturn.toFixed(4)),
      audited_annual_return_pct: Number(auditedAnnualReturn.toFixed(4)),
      executable_annual_return_pct: Number(executableAnnualReturn.toFixed(4)),
      theoretical_max_drawdown_pct: Number(theoreticalDrawdown.toFixed(4)),
      executable_max_drawdown_pct: Number(adjustedDrawdown.toFixed(4)),
      pit_penalty_pct: Number((pitPenalty * 100).toFixed(4)),
      execution_penalty_pct: Number((executionPenalty * 100).toFixed(4)),
      pit_blocking_rows: pitBlockingRows,
      rejected_order_count: rejectedOrderCount,
      execution_reason_counts: input.execution_artifact?.payload_json?.reason_counts || {},
      replay_method: 'backend_policy_replay_v1',
    },
  };
}

export class ResearchTrustPolicyService {
  buildDataPolicy(input: Record<string, any> = {}, context: Record<string, any> = {}) {
    const asOfDate = dateOnly(context.as_of_date || context.end_date || context.trade_date);
    return {
      ...input,
      point_in_time: true,
      disclosure_date_required: true,
      universe_as_of_required: true,
      factor_snapshot_as_of_required: true,
      market_status_as_of_required: true,
      as_of_date: asOfDate,
      enforcement: {
        ...(asObject(input.enforcement) || {}),
        mode: 'hard',
        visible_data_only: true,
        factor_snapshot_as_of: true,
        universe_as_of: true,
        market_status_as_of: true,
      },
      audit_coverage: {
        ...asObject(input.audit_coverage),
        disclosure_date: true,
        universe_visibility: true,
        factor_snapshot_as_of: true,
        market_status_as_of: true,
      },
    };
  }

  buildConstraintPolicy(input: Record<string, any> = {}) {
    return {
      ...input,
      enable_t_plus_one: toBooleanDefault(input.enable_t_plus_one, true),
      block_limit_up: toBooleanDefault(input.block_limit_up, true),
      block_limit_down: toBooleanDefault(input.block_limit_down, true),
      block_suspended: toBooleanDefault(input.block_suspended, true),
      block_st: toBooleanDefault(input.block_st, true),
      block_st_stocks: toBooleanDefault(input.block_st_stocks, true),
      lot_size: Math.max(100, toFiniteNumber(input.lot_size, 100)),
      enforcement: {
        ...asObject(input.enforcement),
        mode: 'hard',
        shared_gate: 'ResearchTrustPolicyService.evaluateExecutionGate',
      },
    };
  }

  normalizeBacktestOptions(options: QuantBacktestOptions): QuantBacktestOptions {
    const raw = options as any;
    const dataPolicy = this.buildDataPolicy(raw.data_policy_json, {
      as_of_date: raw.as_of_date || raw.start_date,
      start_date: raw.start_date,
      end_date: raw.end_date,
    });
    const constraintInput = { ...asObject(raw.constraint_policy_json) };
    for (const key of [
      'enable_t_plus_one',
      'block_limit_up',
      'block_limit_down',
      'block_suspended',
      'block_st',
      'block_st_stocks',
      'lot_size',
    ]) {
      if (constraintInput[key] === undefined && raw[key] !== undefined) {
        constraintInput[key] = raw[key];
      }
    }
    const constraintPolicy = this.buildConstraintPolicy(constraintInput);
    return {
      ...options,
      execution_timing: 'next_open',
      enable_t_plus_one: constraintPolicy.enable_t_plus_one,
      block_limit_up: constraintPolicy.block_limit_up,
      block_limit_down: constraintPolicy.block_limit_down,
      block_suspended: constraintPolicy.block_suspended,
      block_st_stocks: constraintPolicy.block_st_stocks,
      lot_size: Math.max(100, toFiniteNumber(raw.lot_size, 100)),
      data_policy_json: dataPolicy,
      constraint_policy_json: constraintPolicy,
    };
  }

  buildSignalDataPolicy(options: { trade_date?: string; as_of_date?: string }) {
    return this.buildDataPolicy(
      {},
      { as_of_date: options.as_of_date || options.trade_date, trade_date: options.trade_date }
    );
  }

  isTrustedRerunTask(parameters: Record<string, any> | null | undefined): boolean {
    const raw = asObject(parameters);
    return Boolean(raw.trusted_rerun === true || Number(raw.trusted_rerun_of_task_id || 0) > 0);
  }

  buildTrustedRerunOptions(
    input: TrustedRerunBuildInput
  ): QuantBacktestOptions & Record<string, any> {
    const rawParams = asObject(input.parameters);
    const merged = {
      ...rawParams,
      task_name: `${
        input.task_name || rawParams.task_name || `回测任务 ${input.source_task_id}`
      } · 可信重跑`,
      universe: input.universe || rawParams.universe || 'market',
      strategy_keys: input.strategy_keys?.length
        ? input.strategy_keys
        : rawParams.strategy_keys || [],
      symbols: Array.isArray(input.symbols) ? input.symbols : rawParams.symbols || [],
      start_date: input.start_date || rawParams.start_date,
      end_date: input.end_date || rawParams.end_date,
      initial_capital: input.initial_capital ?? rawParams.initial_capital,
      commission_rate: input.commission_rate ?? rawParams.commission_rate,
      slippage_rate: input.slippage_rate ?? rawParams.slippage_rate,
      trusted_rerun: true,
      trusted_rerun_of_task_id: Number(input.source_task_id),
      trusted_rerun_experiment_id: input.experiment_id || null,
      trusted_rerun_started_by: 'research_audit',
      auto_trusted_rerun: false,
    };
    return this.normalizeBacktestOptions(merged as QuantBacktestOptions) as QuantBacktestOptions &
      Record<string, any>;
  }

  evaluateExecutionGate(input: ResearchExecutionGateInput): ResearchExecutionGateDecision {
    const profile = asObject(input.profile);
    const quote = asObject(input.quote);
    const policy = this.buildConstraintPolicy(asObject(input.policy));
    const side = input.side;
    const reasons: string[] = [];
    const price = toFiniteNumber(quote.price ?? profile.latest_price, 0);
    const change = profile.latest_change_percent;

    if (!price || price <= 0) {
      reasons.push('执行可行性：没有有效现价，无法模拟成交');
    }
    if (policy.block_st && profile.is_st && side === 'BUY') {
      reasons.push('执行可行性：ST/退市风险标的禁止新增买入');
    }
    if (policy.block_suspended && profile.is_suspended) {
      reasons.push('执行可行性：最新交易日停牌，无法成交');
    }
    if (side === 'BUY' && policy.block_limit_up && profile.is_limit_up) {
      reasons.push(`执行可行性：涨幅 ${change ?? '--'}%，疑似涨停，买入可能排队无法成交`);
    }
    if (side === 'SELL' && policy.block_limit_down && profile.is_limit_down) {
      reasons.push(`执行可行性：跌幅 ${change ?? '--'}%，疑似跌停，卖出可能无法成交`);
    }
    if (profile.data_status && ['no_data', 'conflict'].includes(profile.data_status)) {
      reasons.push(`执行可行性：数据状态 ${profile.data_status}，成交假设不可信`);
    }

    const allowed = reasons.length === 0;
    return {
      allowed,
      side,
      action: allowed ? 'allow' : 'reject',
      label: allowed
        ? `${side === 'BUY' ? '买入' : '卖出'}可模拟成交：共享 A 股约束检查通过`
        : `${side === 'BUY' ? '买入' : '卖出'}执行受限：${reasons[0]}`,
      reasons: reasons.slice(0, 8),
      price: price > 0 ? Number(price.toFixed(4)) : undefined,
      price_source: quote.source || profile.price_source || 'unknown',
      change_percent: change,
      checks: {
        block_st: policy.block_st,
        block_suspended: policy.block_suspended,
        block_limit_up: policy.block_limit_up,
        block_limit_down: policy.block_limit_down,
        enable_t_plus_one: policy.enable_t_plus_one,
        is_st: Boolean(profile.is_st),
        is_suspended: Boolean(profile.is_suspended),
        is_limit_up: Boolean(profile.is_limit_up),
        is_limit_down: Boolean(profile.is_limit_down),
        data_status: profile.data_status,
        shared_gate: 'research_trust_policy',
      },
    };
  }

  buildAuditedReturnReplayArtifact = buildAuditedReturnReplayArtifact;
}

export const researchTrustPolicyService = new ResearchTrustPolicyService();
