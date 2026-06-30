/**
 * 30-day synthetic distribution test for PR-O5 ThemeFermentationDetector.
 *
 * 模拟生产: 用合成的 30 个交易日 × 5 板块 industry_sentiment_indices 跑 classifier,
 * 看 5 阶段分布 + 主线切换命中次数. 给 PR-O5 完成报告输出真实数字.
 *
 * 不依赖 DB. 跑:
 *   cd backend && npx ts-node --transpile-only tests/services/theme-fermentation-30day-simulation.test.ts
 */

import {
  ThemeFermentationDetector,
  ThemeFermentationDataSource,
  ThemeFermentationRecord,
  IndustrySentimentSnapshot,
  FermentationPhase,
} from '../../src/services/ThemeFermentationDetector';

// ---------------------------------------------------------------------------
// 合成数据: 模拟一个"板块情绪 30 日演化"的典型场景
// ---------------------------------------------------------------------------
// 5 板块: 半导体 (爆发→高潮→退潮), 储能 (启动后转爆发), 新能源 (持续 launch),
//        电力 (持续 germinate), AI (中段崛起切换)
//
// 每板块的演化: 用 sin / step / random 函数构造涨停数 / 连板高度 / 综合分
// 整数化, 简单可解释.

const INDUSTRIES = ['半导体', '储能', '新能源', '电力', 'AI'];

function makeDay(dateIdx: number): IndustrySentimentSnapshot[] {
  const out: IndustrySentimentSnapshot[] = [];
  // 半导体: 第 0-9 天爬升 (launch → outbreak), 第 10-19 天高潮区, 第 20-29 天退潮
  let semiLim = 0;
  let semiCons = 0;
  if (dateIdx < 10) {
    semiLim = Math.min(8, 1 + dateIdx);
    semiCons = Math.min(3, 1 + Math.floor(dateIdx / 3));
  } else if (dateIdx < 20) {
    semiLim = 12 + (dateIdx % 3);
    semiCons = 4 + (dateIdx % 2);
  } else {
    // 退潮区: 高炸板率, 涨停减半
    semiLim = Math.max(0, 5 - (dateIdx - 20));
    semiCons = Math.max(0, 2 - Math.floor((dateIdx - 20) / 3));
  }
  out.push({
    trade_date: `2026-06-${String(dateIdx + 1).padStart(2, '0')}`,
    industry: '半导体',
    lim_up_count: semiLim,
    consecutive_max: semiCons,
    seal_rate: dateIdx < 20 ? 0.8 : 0.3,
    lim_up_failure_rate: dateIdx < 20 ? 0.1 : (dateIdx < 25 ? 0.6 : 0.7),
    industry_momentum_30d: dateIdx < 20 ? 1.5 : -0.5,
    composite_score: dateIdx < 10 ? 1.5 + dateIdx * 0.2 : (dateIdx < 20 ? 4 : -1),
    top_codes: ['SH600519'],
  });

  // 储能: 第 0-4 launch, 第 5-14 outbreak, 第 15-19 climax 短峰, 第 20-29 退潮
  let storLim = 0;
  if (dateIdx < 5) storLim = 1 + dateIdx;
  else if (dateIdx < 15) storLim = 5 + (dateIdx - 5);
  else if (dateIdx < 20) storLim = 11 + (dateIdx % 2);
  else storLim = Math.max(0, 4 - Math.floor((dateIdx - 20) / 4));
  out.push({
    trade_date: `2026-06-${String(dateIdx + 1).padStart(2, '0')}`,
    industry: '储能',
    lim_up_count: storLim,
    consecutive_max: dateIdx < 5 ? 1 : (dateIdx < 15 ? 2 : (dateIdx < 20 ? 4 : 1)),
    seal_rate: 0.6,
    lim_up_failure_rate: dateIdx < 20 ? 0.15 : 0.55,
    industry_momentum_30d: 0.8,
    composite_score: dateIdx < 5 ? 0.5 + dateIdx * 0.2 : (dateIdx < 20 ? 3 : -0.5),
    top_codes: ['SZ300750'],
  });

  // 新能源: 持续 launch (常驻 1-3 涨停)
  out.push({
    trade_date: `2026-06-${String(dateIdx + 1).padStart(2, '0')}`,
    industry: '新能源',
    lim_up_count: 1 + (dateIdx % 3),
    consecutive_max: 1,
    seal_rate: 0.5,
    lim_up_failure_rate: 0.2,
    industry_momentum_30d: 0.3,
    composite_score: 1.0 + (dateIdx % 5) * 0.2,
    top_codes: ['SH601012'],
  });

  // 电力: 持续 germinate
  out.push({
    trade_date: `2026-06-${String(dateIdx + 1).padStart(2, '0')}`,
    industry: '电力',
    lim_up_count: 0,
    consecutive_max: 0,
    seal_rate: 0,
    lim_up_failure_rate: 0,
    industry_momentum_30d: -1.0,
    composite_score: -1.5,
    top_codes: [],
  });

  // AI: 全程 germinate 直到第 20 天突然 launch (主线切换日 — 与半导体/储能退潮同步).
  // 21-28 天 outbreak/climax 接力.
  let aiLim = 0;
  let aiCons = 0;
  if (dateIdx < 20) {
    aiLim = 0;
  } else if (dateIdx === 20) {
    aiLim = 3; aiCons = 1;
  } else if (dateIdx < 25) {
    aiLim = 6 + (dateIdx - 21); aiCons = 2 + Math.floor((dateIdx - 21) / 2);
  } else {
    aiLim = 11 + ((dateIdx - 25) % 2); aiCons = 4;
  }
  out.push({
    trade_date: `2026-06-${String(dateIdx + 1).padStart(2, '0')}`,
    industry: 'AI',
    lim_up_count: aiLim,
    consecutive_max: aiCons,
    seal_rate: 0.7,
    lim_up_failure_rate: dateIdx < 25 ? 0.15 : 0.7,
    industry_momentum_30d: dateIdx < 10 ? -0.2 : 1.2,
    composite_score: dateIdx < 10 ? -0.5 : (dateIdx < 20 ? 2.5 + (dateIdx - 10) * 0.1 : 0),
    top_codes: ['SZ000001'],
  });

  return out;
}

class InMemoryDataSource implements ThemeFermentationDataSource {
  todayBucket: IndustrySentimentSnapshot[] = [];
  prevBucket: Array<{ industry: string; phase: FermentationPhase; lim_up_count: number }> = [];
  written: ThemeFermentationRecord[] = [];

  async listSentimentByDate(_d: string): Promise<IndustrySentimentSnapshot[]> {
    return this.todayBucket;
  }
  async listPreviousPhases(_d: string): Promise<
    Array<{ industry: string; phase: FermentationPhase; lim_up_count: number }>
  > {
    return this.prevBucket;
  }
  async upsertPhase(r: ThemeFermentationRecord): Promise<void> {
    this.written.push(r);
  }
}

(async () => {
  const ds = new InMemoryDataSource();
  const svc = new ThemeFermentationDetector({ dataSource: ds });
  const dist: Record<FermentationPhase, number> = {
    germinate: 0,
    launch: 0,
    outbreak: 0,
    climax: 0,
    recession: 0,
  };
  let totalSwitches = 0;
  let totalRows = 0;
  let totalMainline = 0;

  for (let day = 0; day < 30; day++) {
    ds.todayBucket = makeDay(day);
    ds.written = [];
    const r = await svc.runOnce({ trade_date: `2026-06-${String(day + 1).padStart(2, '0')}` });
    for (const k of Object.keys(r.phase_distribution) as FermentationPhase[]) {
      dist[k] += r.phase_distribution[k];
    }
    totalSwitches += r.mainline_switch_events.length;
    totalRows += r.industries_written;
    for (const w of ds.written) if (w.is_mainline) totalMainline += 1;

    // 把今日 written 转 prevBucket 给明天 (模拟生产 DB 链)
    ds.prevBucket = ds.written.map(w => ({
      industry: w.industry,
      phase: w.phase,
      lim_up_count: w.lim_up_count,
    }));
  }

  console.log('\n========================================');
  console.log('PR-O5 ThemeFermentationDetector 30-day simulation');
  console.log('========================================');
  console.log(`Total rows written: ${totalRows} (= 30 days × 5 industries)`);
  console.log(`Phase distribution:`);
  for (const k of Object.keys(dist) as FermentationPhase[]) {
    const pct = ((dist[k] / totalRows) * 100).toFixed(1);
    console.log(`  ${k.padEnd(10)} ${String(dist[k]).padStart(3)} (${pct}%)`);
  }
  console.log(`Mainline marks: ${totalMainline}`);
  console.log(`Mainline switch events (sum 30 days): ${totalSwitches}`);
  console.log('========================================\n');
  process.exit(0);
})();
