import type { DailyReportDocument, RecommendationItem } from './types';

export interface DailyBriefIndex {
  symbol: string;
  name: string;
  current_price: number;
  change: number;
  change_percent: number;
  five_day_change_percent: number | null;
}

export interface DailyBriefSector {
  industry: string;
  average_change_percent: number;
  advancing_count: number;
  declining_count: number;
  stock_count: number;
  leading_stock_name: string;
  leading_stock_change_percent: number;
}

export interface DailyBriefMover {
  symbol: string;
  name: string;
  industry: string | null;
  change_percent: number;
}

export interface DailyMarketBrief {
  trade_date: string;
  generated_at: string;
  indices: DailyBriefIndex[];
  breadth: {
    total_count: number;
    advancing_count: number;
    declining_count: number;
    flat_count: number;
  };
  sectors: {
    leaders: DailyBriefSector[];
    laggards: DailyBriefSector[];
  };
  movers: {
    gainers: DailyBriefMover[];
    laggards: DailyBriefMover[];
  };
}

export interface AShareEditorialCopy {
  tone: 'positive' | 'balanced' | 'cautious';
  headline: string;
  lead: string;
  sector_paragraph: string;
  mover_paragraph: string;
  watch_paragraph: string;
}

export function signedPercent(value: number, digits = 2): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe > 0 ? '+' : ''}${safe.toFixed(digits)}%`;
}

export function recommendationDisplayName(item: RecommendationItem): string {
  const ticker = item.recommendation.ticker;
  const evidence = item.recommendation.evidence_refs.find(ref => ref.short_text)?.short_text || '';
  const separatorIndex = evidence.search(/[：:]/);
  const candidate = separatorIndex > 0 ? evidence.slice(0, separatorIndex).trim() : '';
  if (candidate && candidate !== ticker && candidate.length <= 16) return candidate;
  return ticker;
}

function joinChinese(items: string[]): string {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join('、')}和${items.at(-1)}`;
}

function marketDirection(indices: DailyBriefIndex[]) {
  const valid = indices.filter(index => Number.isFinite(index.change_percent));
  const average = valid.length
    ? valid.reduce((sum, index) => sum + index.change_percent, 0) / valid.length
    : 0;
  const strongest = [...valid].sort((a, b) => b.change_percent - a.change_percent)[0];
  const weakest = [...valid].sort((a, b) => a.change_percent - b.change_percent)[0];
  return { valid, average, strongest, weakest };
}

export function buildAShareEditorialCopy(
  brief: DailyMarketBrief,
  report: DailyReportDocument
): AShareEditorialCopy {
  const { valid, average, strongest, weakest } = marketDirection(brief.indices);
  const allUp = valid.length > 0 && valid.every(index => index.change_percent > 0.05);
  const allDown = valid.length > 0 && valid.every(index => index.change_percent < -0.05);
  const tone: AShareEditorialCopy['tone'] =
    average >= 0.5 ? 'positive' : average <= -0.5 ? 'cautious' : 'balanced';
  const headline = allUp
    ? `A股收盘：主要指数集体走强，${strongest?.name || '成长方向'}领涨`
    : allDown
      ? `A股收盘：主要指数集体回落，${weakest?.name || '成长方向'}跌幅居前`
      : `A股收盘：指数表现分化，${strongest?.name || '权重方向'}相对占优`;

  const indexSentence = valid
    .map(index => `${index.name}${signedPercent(index.change_percent)}`)
    .join('，');
  const { advancing_count, declining_count, flat_count } = brief.breadth;
  const lead = `${brief.trade_date}，${indexSentence || '主要指数完成收盘'}。全市场上涨 ${advancing_count} 家、下跌 ${declining_count} 家、平盘 ${flat_count} 家，盘面整体${
    tone === 'positive' ? '偏暖' : tone === 'cautious' ? '偏谨慎' : '多空交错'
  }。`;

  const leaders = brief.sectors.leaders
    .slice(0, 3)
    .map(sector => `${sector.industry}${signedPercent(sector.average_change_percent)}`);
  const laggards = brief.sectors.laggards
    .slice(0, 3)
    .map(sector => `${sector.industry}${signedPercent(sector.average_change_percent)}`);
  const sectorParagraph = leaders.length
    ? `板块方面，${joinChinese(leaders)}表现靠前${laggards.length ? `；${joinChinese(laggards)}相对承压` : ''}。行业强弱以完整交易日成分股平均涨跌幅计算，避免单只股票放大板块印象。`
    : '板块强弱数据仍在汇总，本期先以指数和个股证据为主。';

  const gainers = brief.movers.gainers.slice(0, 4).map(item => item.name);
  const laggingStocks = brief.movers.laggards.slice(0, 4).map(item => item.name);
  const moverParagraph =
    gainers.length || laggingStocks.length
      ? `个股方面，${gainers.length ? `${joinChinese(gainers)}涨幅居前` : '强势股线索有限'}${
          laggingStocks.length ? `；${joinChinese(laggingStocks)}跌幅居前` : ''
        }。极端涨跌仅用于描述盘面，不直接构成次日交易建议。`
      : '个股涨跌两端暂未形成稳定样本。';

  const watchNames = report.snapshot.items.slice(0, 6).map(recommendationDisplayName);
  const watchParagraph = watchNames.length
    ? `研究池方面，本期保留 ${report.snapshot.items.length} 条 A 股观察线索，重点包括${joinChinese(
        watchNames
      )}。下方按评分、确信度与风险门禁逐条保留证据。`
    : '本期没有达到报告门槛的 A 股观察线索。';

  return {
    tone,
    headline,
    lead,
    sector_paragraph: sectorParagraph,
    mover_paragraph: moverParagraph,
    watch_paragraph: watchParagraph,
  };
}
