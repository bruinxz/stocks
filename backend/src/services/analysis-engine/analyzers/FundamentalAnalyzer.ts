/**
 * FundamentalAnalyzer — 复用 ValueFactor / GrowthFactor / QualityFactor /
 * QualityHighFactor / AnalystConsensusFactor / EarningsSurpriseFactor z-score.
 *
 * 新加: 同行业 peer rank (调 dataSource.loadIndustryPeerScores) —— 可选,
 * 拿不到时降级为单独因子分.
 *
 * 输出 evidence: 因子值 + peer 排名 + 整体分析师一致预期方向.
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

export interface FundamentalPeerSource {
  /**
   * 返回同行业 peer 的 (stock_code, value_z) 列表 (含目标股); analyzer 算 rank.
   * 拿不到 → 返回空数组, analyzer 标 data_missing=['peer_rank'].
   */
  loadIndustryPeerScores(
    industry: string | null,
    as_of: string,
    factor: 'value' | 'growth' | 'quality'
  ): Promise<Array<{ stock_code: string; z: number | null }>>;
}

export const PRODUCTION_FUNDAMENTAL_PEER_SOURCE: FundamentalPeerSource = {
  async loadIndustryPeerScores(industry, as_of, factor) {
    if (!industry) return [];
    try {
      // 懒加载 — 避免 analyzer 模块加载时引入 sequelize.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { FactorScore } = require('../../../models/FactorScore');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../../models/Stock');
      const stocks = await Stock.findAll({
        where: { industry },
        attributes: ['symbol'],
        raw: true,
      });
      if (!stocks || stocks.length === 0) return [];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { stripSuffix } = require('../../../quant/factors/library/_helpers');
      const codes: string[] = stocks
        .map((s: any) => stripSuffix(s.symbol))
        .filter((s: string) => !!s);
      if (codes.length === 0) return [];
      const rows = await FactorScore.findAll({
        where: { trade_date: as_of, factor_name: factor, stock_code: codes },
        attributes: ['stock_code', 'z_score'],
        raw: true,
      });
      return rows.map((r: any) => ({
        stock_code: r.stock_code,
        z: r.z_score === null || r.z_score === undefined ? null : Number(r.z_score),
      }));
    } catch (_err) {
      return [];
    }
  },
};

const FACTOR_LABELS: Record<string, string> = {
  value: '价值 (PE/PB)',
  growth: '成长 (营收/利润 yoy)',
  quality: '质量 (ROE/资产质量)',
  quality_high: '高质量 (高 ROIC)',
  analyst_consensus: '分析师一致预期',
  earnings_surprise: '业绩超预期',
};

export class FundamentalAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'fundamental';

  constructor(
    private readonly peerSource: FundamentalPeerSource = PRODUCTION_FUNDAMENTAL_PEER_SOURCE
  ) {
    super();
  }

  protected requiredFields: readonly string[] = ['factor.value', 'factor.growth', 'factor.quality'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const factors = ctx.factor_snapshot || {};
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];

    const partials: Array<{ value: number | null; weight: number }> = [];

    const factorWeights: Record<string, number> = {
      value: 0.25,
      growth: 0.25,
      quality: 0.2,
      quality_high: 0.1,
      analyst_consensus: 0.1,
      earnings_surprise: 0.1,
    };

    for (const fname of Object.keys(factorWeights)) {
      const z = factors[fname];
      if (z === undefined || z === null) {
        dataMissing.push(`factor.${fname}`);
        continue;
      }
      const score = zScoreToScore(z) ?? 0;
      partials.push({ value: score, weight: factorWeights[fname] });
      evidence.push({
        label: `${FACTOR_LABELS[fname] || fname} z=${z.toFixed(2)}`,
        detail: `归一化得分 ${score.toFixed(1)}`,
        metric_value: score,
        direction: score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: factorWeights[fname],
      });
    }

    // peer rank (value 因子, 同行业横向)
    try {
      const peerList = await this.peerSource.loadIndustryPeerScores(
        ctx.stock.industry,
        ctx.as_of,
        'value'
      );
      if (peerList.length > 1) {
        const myCode = ctx.stock.code.replace(/[a-zA-Z.]/g, '');
        const valid = peerList.filter(p => p.z !== null) as Array<{
          stock_code: string;
          z: number;
        }>;
        if (valid.length >= 2) {
          const sorted = [...valid].sort((a, b) => b.z - a.z); // value 因子越高越好 (低 PE)
          const idx = sorted.findIndex(p => p.stock_code === myCode);
          if (idx >= 0) {
            const rank = idx + 1;
            const pct = 1 - rank / sorted.length; // 排名靠前 → pct 接近 1
            const peerScore = (pct - 0.5) * 200; // 0.5 → 0, 1 → 100, 0 → -100
            partials.push({ value: peerScore, weight: 0.15 });
            evidence.push({
              label: `同行业价值排名 ${rank}/${sorted.length}`,
              detail: `行业=${ctx.stock.industry || '未知'}`,
              metric_value: peerScore,
              direction: peerScore > 0 ? 'bullish' : 'bearish',
              weight: 0.15,
            });
          } else {
            dataMissing.push('peer_rank.self_not_in_industry');
          }
        }
      } else {
        dataMissing.push('peer_rank');
      }
    } catch (_e) {
      dataMissing.push('peer_rank');
    }

    const score = weightedMean(partials) ?? 0;

    // confidence: 因子覆盖率
    const totalFactors = Object.keys(factorWeights).length;
    const haveFactors = totalFactors - dataMissing.filter(d => d.startsWith('factor.')).length;
    const confidence = totalFactors > 0 ? haveFactors / totalFactors : 0;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'factor_scores', as_of: ctx.as_of, is_realtime: false },
        { name: 'industry_peer_rank', as_of: ctx.as_of, is_realtime: false },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const fundamentalAnalyzer = new FundamentalAnalyzer();
