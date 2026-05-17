import moment from 'moment-timezone';
import { AIInvestmentSignal } from '../../models/AIInvestmentSignal';
import { QuantFusionAudit } from '../../models/QuantFusionAudit';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { round } from '../engine/QuantMath';

function asPlainObject(value: any): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function toNumber(value: any, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeDecisionSide(value: any): 'bullish' | 'neutral' | 'bearish' {
  const normalized = String(value || '').toLowerCase();
  if (['strong_buy', 'buy'].includes(normalized)) return 'bullish';
  if (['sell', 'strong_sell'].includes(normalized)) return 'bearish';
  return 'neutral';
}

function agentDecisionScore(value: any): number {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'strong_buy') return 92;
  if (normalized === 'buy') return 78;
  if (normalized === 'hold') return 55;
  if (normalized === 'sell') return 28;
  if (normalized === 'strong_sell') return 12;
  return 50;
}

function marketScoreFromMetadata(metadata: Record<string, any>): number {
  const environment = asPlainObject(metadata.market_environment);
  const regime = String(environment.market_regime || '').toLowerCase();
  if (regime === 'bull') return 82;
  if (regime === 'rebound') return 68;
  if (regime === 'range') return 55;
  if (regime === 'bear') return 35;
  if (regime === 'stress') return 20;
  return 55;
}

function riskControlScore(signal: AIInvestmentSignal, metadata: Record<string, any>): number {
  const riskLevel = String(signal.risk_level || metadata.risk_level || '').toLowerCase();
  const dataQualityScore = toNumber(metadata.data_quality_score, 80);
  let score = dataQualityScore;
  if (riskLevel === 'low') score += 8;
  if (riskLevel === 'medium') score -= 2;
  if (riskLevel === 'high') score -= 22;
  const warnings = Array.isArray(metadata.warnings) ? metadata.warnings : [];
  score -= warnings.length * 3;
  return clamp(score);
}

function finalDecision(score: number, agentDecision: string, riskScore: number): string {
  const side = normalizeDecisionSide(agentDecision);
  if (side === 'bearish') return 'avoid';
  if (riskScore < 42) return 'watch';
  if (score >= 76 && side === 'bullish') return 'buy';
  if (score >= 66) return 'watch';
  if (score >= 50) return 'hold';
  return 'avoid';
}

export class QuantFusionAuditService {
  async recordAgentFusion(
    agentSignal: AIInvestmentSignal,
    options: {
      task_id?: string;
      quant_score?: number;
      strategy_key?: string;
      strategy_variant?: Record<string, any>;
      current_price?: number | null;
    } = {}
  ) {
    const metadata = asPlainObject(agentSignal.metadata);
    const strategyVariant = asPlainObject(options.strategy_variant || metadata.strategy_variant);
    const strategyKeys = [
      options.strategy_key || metadata.strategy_key || strategyVariant.strategy_key,
      ...(Array.isArray(strategyVariant.strategy_keys) ? strategyVariant.strategy_keys : []),
    ]
      .map(item => String(item || '').trim())
      .filter(Boolean);
    const quantScore = toNumber(
      options.quant_score ?? strategyVariant.fusion_score ?? strategyVariant.quant_score,
      toNumber(metadata.raw_confidence_score, toNumber(agentSignal.confidence_score, 50))
    );
    const agentScore = toNumber(
      agentSignal.confidence_score,
      agentDecisionScore(agentSignal.normalized_decision)
    );
    const marketRegimeScore = marketScoreFromMetadata(metadata);
    const riskScore = riskControlScore(agentSignal, metadata);
    const quantSide = quantScore >= 70 ? 'bullish' : quantScore <= 45 ? 'bearish' : 'neutral';
    const agentSide = normalizeDecisionSide(agentSignal.normalized_decision);
    const disagreementPenalty = quantSide !== agentSide && agentSide !== 'neutral' ? 12 : 0;
    const finalScore = round(
      clamp(
        quantScore * 0.45 +
          agentScore * 0.35 +
          marketRegimeScore * 0.1 +
          riskScore * 0.1 -
          disagreementPenalty
      ),
      4
    );
    const decision = finalDecision(finalScore, agentSignal.normalized_decision, riskScore);
    const rationale = [
      `最终分 ${finalScore}`,
      `量化 ${round(quantScore, 2)} / Agent ${round(agentScore, 2)}`,
      `市场 ${round(marketRegimeScore, 2)} / 风控 ${round(riskScore, 2)}`,
      disagreementPenalty
        ? `量化与Agent方向分歧，扣 ${disagreementPenalty} 分`
        : '量化与Agent方向一致或中性',
      `最终动作 ${decision}`,
    ].join('；');

    const [audit] = await QuantFusionAudit.findOrCreate({
      where: {
        agent_task_id: options.task_id || metadata.task_id || `agent_signal_${agentSignal.id}`,
      },
      defaults: {
        quant_signal_id: strategyVariant.ai_signal_id,
        agent_signal_id: agentSignal.id,
        agent_task_id: options.task_id || metadata.task_id,
        symbol: normalizeSymbol(agentSignal.symbol),
        name: agentSignal.name,
        signal_date: agentSignal.signal_date || moment().format('YYYY-MM-DD'),
        strategy_key: strategyKeys[0],
        strategy_keys: [...new Set(strategyKeys)],
        quant_score: round(quantScore, 4),
        agent_score: round(agentScore, 4),
        market_regime_score: round(marketRegimeScore, 4),
        risk_control_score: round(riskScore, 4),
        disagreement_penalty: disagreementPenalty,
        final_score: finalScore,
        quant_decision: quantSide,
        agent_decision: agentSignal.normalized_decision,
        final_decision: decision,
        risk_level: agentSignal.risk_level,
        current_price: options.current_price ?? agentSignal.current_price,
        rationale,
        metadata: {
          formula: '0.45*quant + 0.35*agent + 0.10*market + 0.10*risk - disagreement',
          strategy_variant: strategyVariant,
          signal_metadata: metadata,
        },
      },
    });

    await audit.update({
      quant_signal_id: strategyVariant.ai_signal_id,
      agent_signal_id: agentSignal.id,
      agent_task_id: options.task_id || metadata.task_id,
      symbol: normalizeSymbol(agentSignal.symbol),
      name: agentSignal.name,
      signal_date: agentSignal.signal_date || moment().format('YYYY-MM-DD'),
      strategy_key: strategyKeys[0],
      strategy_keys: [...new Set(strategyKeys)],
      quant_score: round(quantScore, 4),
      agent_score: round(agentScore, 4),
      market_regime_score: round(marketRegimeScore, 4),
      risk_control_score: round(riskScore, 4),
      disagreement_penalty: disagreementPenalty,
      final_score: finalScore,
      quant_decision: quantSide,
      agent_decision: agentSignal.normalized_decision,
      final_decision: decision,
      risk_level: agentSignal.risk_level,
      current_price: options.current_price ?? agentSignal.current_price,
      rationale,
      metadata: {
        formula: '0.45*quant + 0.35*agent + 0.10*market + 0.10*risk - disagreement',
        strategy_variant: strategyVariant,
        signal_metadata: metadata,
      },
    });

    return audit;
  }

  async listAudits(options: { limit?: number; symbol?: string } = {}) {
    const where: any = {};
    if (options.symbol) where.symbol = normalizeSymbol(options.symbol);
    return QuantFusionAudit.findAll({
      where,
      order: [['created_at', 'DESC']],
      limit: Math.min(Math.max(Number(options.limit || 100), 1), 500),
    });
  }

  async getRankingDashboard(options: { signal_date?: string; limit?: number } = {}) {
    const signalDate =
      options.signal_date ||
      (
        await QuantFusionAudit.findOne({
          order: [
            ['signal_date', 'DESC'],
            ['final_score', 'DESC'],
          ],
        })
      )?.signal_date;
    if (!signalDate) {
      return {
        signal_date: null,
        fusion_rankings: [],
        summary: {
          fusion_count: 0,
          buy_count: 0,
          watch_count: 0,
          avoid_count: 0,
          agent_rescored: false,
        },
      };
    }
    const limit = Math.min(Math.max(Number(options.limit || 30), 1), 100);
    const audits = await QuantFusionAudit.findAll({
      where: { signal_date: signalDate },
      order: [
        ['final_score', 'DESC'],
        ['created_at', 'DESC'],
      ],
      limit: Math.max(limit * 2, 50),
    });
    const bySymbol = new Map<string, QuantFusionAudit>();
    for (const audit of audits) {
      const existing = bySymbol.get(audit.symbol);
      if (!existing || Number(audit.final_score || 0) > Number(existing.final_score || 0)) {
        bySymbol.set(audit.symbol, audit);
      }
    }
    const fusion_rankings = [...bySymbol.values()]
      .sort((a, b) => Number(b.final_score || 0) - Number(a.final_score || 0))
      .slice(0, limit)
      .map((audit, index) => ({
        rank: index + 1,
        id: audit.id,
        symbol: audit.symbol,
        name: audit.name,
        signal_date: audit.signal_date,
        strategy_key: audit.strategy_key,
        strategy_keys: audit.strategy_keys || [],
        quant_score: round(Number(audit.quant_score || 0), 2),
        agent_score: round(Number(audit.agent_score || 0), 2),
        final_score: round(Number(audit.final_score || 0), 2),
        score_delta: round(Number(audit.final_score || 0) - Number(audit.quant_score || 0), 2),
        final_decision: audit.final_decision,
        agent_decision: audit.agent_decision,
        risk_level: audit.risk_level,
        current_price: audit.current_price,
        rationale: audit.rationale,
        disagreement_penalty: audit.disagreement_penalty,
        created_at: audit.created_at,
      }));
    return {
      signal_date: signalDate,
      fusion_rankings,
      summary: {
        fusion_count: audits.length,
        buy_count: audits.filter(item => item.final_decision === 'buy').length,
        watch_count: audits.filter(item => item.final_decision === 'watch').length,
        avoid_count: audits.filter(item => item.final_decision === 'avoid').length,
        agent_rescored: audits.length > 0,
        avg_quant_score: round(
          audits.reduce((sum, item) => sum + Number(item.quant_score || 0), 0) /
            Math.max(audits.length, 1),
          2
        ),
        avg_final_score: round(
          audits.reduce((sum, item) => sum + Number(item.final_score || 0), 0) /
            Math.max(audits.length, 1),
          2
        ),
      },
    };
  }
}

export const quantFusionAuditService = new QuantFusionAuditService();
