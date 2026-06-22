/**
 * FundamentalAnalyzer — 复用 ValueFactor / GrowthFactor / QualityFactor /
 * QualityHighFactor / AnalystConsensusFactor / EarningsSurpriseFactor z-score.
 *
 * 同行业 peer rank — 对 PE/PB (value) / 营收利润 yoy (growth) / ROE (quality)
 * 三个核心因子各做一次同行业横向排名, evidence 显式含 percentile (0~100).
 * 任一因子拿不到 peer 时降级为 data_missing 标记, 不阻塞其它因子.
 *
 * 输出 evidence: 因子值 z-score + 三因子 peer percentile + 整体分析师一致预期方向.
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean, zScoreToScore } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

export type FundamentalPeerFactor = 'value' | 'growth' | 'quality';

export interface FundamentalPeerSource {
  /**
   * 返回同行业 peer 的 (stock_code, z) 列表 (含目标股); analyzer 算 rank / percentile.
   * 拿不到 → 返回空数组, analyzer 标 data_missing=['peer_rank.<factor>'].
   */
  loadIndustryPeerScores(
    industry: string | null,
    as_of: string,
    factor: FundamentalPeerFactor
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
  // BA-B (用户清单 #10) — fund_consensus fallback 显式 label, 让 UI 看到"代理"事实.
  fund_consensus: '分析师一致预期 (基金一致预期代理)',
};

/**
 * 同行业 peer rank 因子展示名 (中文, 给 UI evidence 用).
 */
export const PEER_FACTOR_LABELS: Record<FundamentalPeerFactor, string> = {
  value: 'PE/PB',
  growth: '营收/利润 yoy',
  quality: 'ROE',
};

const PEER_FACTORS: readonly FundamentalPeerFactor[] = ['value', 'growth', 'quality'];

/**
 * 单因子同行业 peer rank 结果, evidence 显式带 percentile (0~100).
 * 排名越靠前 → percentile 越接近 100. 同分按相对位置稳定.
 */
export interface PeerRankResult {
  factor: FundamentalPeerFactor;
  rank: number;
  total: number;
  /** 百分位, 0~100. 100 = 行业第一, 0 = 行业垫底. */
  percentile: number;
  /** 衍生分数, [-100, +100]. percentile=50 → 0, 100 → +100, 0 → -100. */
  peerScore: number;
}

/**
 * 给定 peer z-score 列表 + 目标股 code, 计算其在同行业的排名 + percentile.
 * - peerList 含 z=null 的成员视为无数据, 不参与排序;
 * - 至少需 2 个有效成员 + 目标股 z 不为 null 才能算;
 * - 同分按数组出现顺序稳定 (sort stable);
 * 返回 null 表示无法计算 (拿不到 peer / 自己不在行业内 / 仅 1 个 peer).
 */
export function computePeerRank(
  peerList: Array<{ stock_code: string; z: number | null }>,
  myCode: string,
  factor: FundamentalPeerFactor
): PeerRankResult | null {
  if (!peerList || peerList.length <= 1) return null;
  const valid = peerList.filter(
    (p): p is { stock_code: string; z: number } => p.z !== null && p.z !== undefined
  );
  if (valid.length < 2) return null;
  // value / growth / quality 三因子的 z-score 都是越高越好 (低 PE 对应高 value z-score).
  const sorted = [...valid].sort((a, b) => b.z - a.z);
  const idx = sorted.findIndex(p => p.stock_code === myCode);
  if (idx < 0) return null;
  const rank = idx + 1;
  const total = sorted.length;
  // percentile: rank=1 → 100, rank=total → 0; 中位 (rank ≈ total/2) → ≈50.
  // 公式 `(total - rank) / (total - 1) * 100` 让边界恰好命中 100/0, 中间分数线性插值.
  const percentile = total > 1 ? ((total - rank) / (total - 1)) * 100 : 50;
  // peerScore = (percentile - 50) * 2, 让 50 → 0, 100 → +100, 0 → -100.
  const peerScore = (percentile - 50) * 2;
  return {
    factor,
    rank,
    total,
    percentile: Math.round(percentile * 10) / 10,
    peerScore: Math.round(peerScore * 10) / 10,
  };
}

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
      let z = factors[fname];
      let usedFallback = false;
      // BA-B (用户清单 #10) — analyst_consensus 缺失时降级用 fund_consensus
      // (公募基金重仓抱团度) 作为代理.
      //
      // 问题: AnalystForecast 只覆盖 ~50 popular stocks (一次性 backfill, 无 cron 持续同步),
      // 80%+ A 股 (尤其小盘 / 北交所 / 新上市) factor.compute() 返回空 → FactorPipeline
      // 中性补全 raw_value=NULL z=0. AnalysisEngineService.loadFactorSnapshot 看到
      // raw_value=NULL 显式置 null (BA-B 同源修复), 这里再走 fund_consensus fallback.
      //
      // 业务合理性: fund_consensus (FundConsensusFactor.ts) 是"公募基金重仓数 × log(占净值)";
      // 与卖方研报一致预期都反映"机构对该股的关注度", 在 IC 上 ~0.4-0.5 相关 (实证).
      // 缺真研报时, 用 fund_consensus 当代理虽弱于真研报, 但远好于"中性 0 分".
      //
      // 升级路径: 若未来 AnalystForecast sync 接入 cron 全覆盖 ~5000 A 股,
      // analyst_consensus 大部分非 null, fallback 自动失活 (不影响 fund_consensus 自身在
      // CapitalAnalyzer / 其它 dim 的角色).
      if ((z === undefined || z === null) && fname === 'analyst_consensus') {
        const fundZ = factors['fund_consensus'];
        if (fundZ !== undefined && fundZ !== null && Number.isFinite(fundZ)) {
          z = fundZ;
          usedFallback = true;
        }
      }
      if (z === undefined || z === null) {
        dataMissing.push(`factor.${fname}`);
        continue;
      }
      const score = zScoreToScore(z) ?? 0;
      partials.push({ value: score, weight: factorWeights[fname] });
      const labelKey = usedFallback ? 'fund_consensus' : fname;
      evidence.push({
        label: `${FACTOR_LABELS[labelKey] || labelKey} z=${z.toFixed(2)}`,
        detail: usedFallback
          ? `归一化得分 ${score.toFixed(1)} (无真研报数据, 用基金抱团度代理)`
          : `归一化得分 ${score.toFixed(1)}`,
        metric_value: score,
        direction: score > 10 ? 'bullish' : score < -10 ? 'bearish' : 'neutral',
        weight: factorWeights[fname],
      });
    }

    // 同行业 peer rank — value/growth/quality 三因子各做一次, evidence 显式带 percentile.
    // 单因子 peer 权重 0.05 (三因子合计 0.15, 与原单 value peer 权重保持一致, 不改 caller score 平均水平).
    const myCode = ctx.stock.code.replace(/[a-zA-Z.]/g, '');
    for (const factor of PEER_FACTORS) {
      try {
        const peerList = await this.peerSource.loadIndustryPeerScores(
          ctx.stock.industry,
          ctx.as_of,
          factor
        );
        const ranked = computePeerRank(peerList, myCode, factor);
        if (!ranked) {
          dataMissing.push(`peer_rank.${factor}`);
          continue;
        }
        partials.push({ value: ranked.peerScore, weight: 0.05 });
        evidence.push({
          label: `同行业 ${PEER_FACTOR_LABELS[factor]} 排名 ${ranked.rank}/${ranked.total}`,
          detail: `百分位 ${ranked.percentile.toFixed(1)} (行业=${ctx.stock.industry || '未知'})`,
          metric_value: ranked.percentile,
          direction:
            ranked.peerScore > 0 ? 'bullish' : ranked.peerScore < 0 ? 'bearish' : 'neutral',
          weight: 0.05,
        });
      } catch (_e) {
        dataMissing.push(`peer_rank.${factor}`);
      }
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
