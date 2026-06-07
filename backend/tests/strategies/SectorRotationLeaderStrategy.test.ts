/**
 * SectorRotationLeaderStrategy 单测（US-021）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/SectorRotationLeaderStrategy.test.ts
 *
 * FakeDataSource 注入到 SectorRotationLeaderStrategy(constructor)，避免任何 DB 依赖。
 *
 * 覆盖：
 *   - 默认参数（AC 指定: topIndustries=10, stocksPerIndustry=2, lookbackDays=5,
 *     minCirculatingMarketCap=50亿, holdingDaysLimit=10, exitIndustryTopN=15,
 *     exitStockTopN=5, excludeST=true）
 *   - strategy_definition 元数据
 *   - 入场两阶段：Step 1 选行业 + Step 2 行业内挑龙头
 *   - 入场各维度过滤：市值 / ST / 缺数据
 *   - 已持仓不重复 BUY
 *   - 入场 industry × stocks_per_industry 自然 cap（top 2 行业 × 每行业 2 = 4 BUY）
 *   - 排序：行业按 cumulative_inflow 降序 + 行业内按 change_pct 降序 + stock_code tie-break
 *   - 出场三类：holdingDaysLimit / 行业掉出 top 15 / 个股跌出行业 top 5
 *   - 出场优先级：A 持有期 > B 行业排名 > C 个股排名
 *   - 持仓在 entry_industry 当日 metric 缺失 → 安全 HOLD
 *   - HOLD 占用槽位后限制 BUY 数
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName / naturalDaysBetween 边角
 *   - invalid trade_date 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 *   - top_industries 输出结构
 */

import {
  DEFAULT_SECTOR_ROTATION_LEADER_PARAMS,
  isSTName,
  naturalDaysBetween,
  SectorRotationLeaderDataSource,
  SectorRotationLeaderStrategy,
  SectorRotationPosition,
  SectorRotationStockMetric,
} from '../../src/quant/strategies/SectorRotationLeaderStrategy';

let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ----------------------------------------------------------------
// FakeDataSource — 测试用注入实现
// ----------------------------------------------------------------

interface FakeFixtures {
  /** 行业 cumulative_inflow 排名（按降序传，DataSource 也保证返回降序） */
  industryRanking?: Array<{ industry_name: string; cumulative_inflow: number }>;
  /** 每个行业的成份股 metric（已按 change_pct 降序排好） */
  constituents?: Map<string, SectorRotationStockMetric[]>;
  /** 当日 close 价格 */
  dailyClose?: Map<string, number>;
}

class FakeDataSource implements SectorRotationLeaderDataSource {
  constructor(public state: FakeFixtures = {}) {}

  async loadIndustryRanking(
    _asOfDate: string,
    _lookbackDays: number
  ): Promise<Array<{ industry_name: string; cumulative_inflow: number }>> {
    return [...(this.state.industryRanking ?? [])];
  }

  async loadIndustryConstituentMetrics(
    _asOfDate: string,
    industryNames: string[]
  ): Promise<Map<string, SectorRotationStockMetric[]>> {
    const all = this.state.constituents ?? new Map();
    const out = new Map<string, SectorRotationStockMetric[]>();
    for (const ind of industryNames) {
      out.set(ind, [...(all.get(ind) ?? [])]);
    }
    return out;
  }

  async loadDailyClose(_asOfDate: string, stockCodes: string[]): Promise<Map<string, number>> {
    const all = this.state.dailyClose ?? new Map();
    const out = new Map<string, number>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }
}

// ----------------------------------------------------------------
// 公共 fixtures 工厂
// ----------------------------------------------------------------

function makeStock(
  code: string,
  name: string,
  change_pct: number,
  mktCapBillion: number
): SectorRotationStockMetric {
  return { stock_code: code, name, change_pct, circulating_market_cap: mktCapBillion * 1e8 };
}

// ----------------------------------------------------------------
// 测试用例
// ----------------------------------------------------------------

async function runTests() {
  console.log('Running SectorRotationLeaderStrategy.test.ts ...\n');

  // ========== Test 1: 默认参数 ==========
  console.log('Test 1: 默认参数 (AC 指定值)');
  {
    expectEqual(
      '  topIndustries 默认 10',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.topIndustries,
      10
    );
    expectEqual(
      '  stocksPerIndustry 默认 2',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.stocksPerIndustry,
      2
    );
    expectEqual(
      '  lookbackDays 默认 5',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.lookbackDays,
      5
    );
    expectEqual(
      '  minCirculatingMarketCap 默认 50 亿',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.minCirculatingMarketCap,
      50 * 1e8
    );
    expectEqual(
      '  holdingDaysLimit 默认 10',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.holdingDaysLimit,
      10
    );
    expectEqual(
      '  exitIndustryTopN 默认 15',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.exitIndustryTopN,
      15
    );
    expectEqual(
      '  exitStockTopN 默认 5',
      DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.exitStockTopN,
      5
    );
    expectEqual('  excludeST 默认 true', DEFAULT_SECTOR_ROTATION_LEADER_PARAMS.excludeST, true);
  }

  // ========== Test 2: strategy_definition 元数据 ==========
  console.log('\nTest 2: strategy_definition 元数据');
  {
    const s = new SectorRotationLeaderStrategy(new FakeDataSource());
    expectEqual('  strategy_key', s.definition.strategy_key, 'sector_rotation_leader');
    expectEqual('  enabled', s.definition.enabled, true);
    expectEqual('  category', s.definition.category, 'multi_factor');
    expectEqual('  risk_level', s.definition.risk_level, 'medium');
    assert('  name 非空', s.definition.name.length > 0);
    assert('  description 非空', s.definition.description.length > 0);
    assert('  tags 含 行业轮动', (s.definition.tags ?? []).includes('行业轮动'));
  }

  // ========== Test 3: 入场基础流程 — top 2 行业 × 每行业 2 龙头 = 4 BUY ==========
  console.log('\nTest 3: 入场基础流程 - top 2 行业 × 每行业 2 龙头 = 4 BUY');
  {
    const industryRanking = [
      { industry_name: '半导体', cumulative_inflow: 100e8 },
      { industry_name: '白酒', cumulative_inflow: 80e8 },
      { industry_name: '银行', cumulative_inflow: -20e8 }, // 没进 top 2 也不进 top 15(实际有 3 个行业)
    ];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          makeStock('300100', '中芯国际', 0.09, 800),
          makeStock('300101', '韦尔股份', 0.05, 600),
          makeStock('300102', '兆易创新', 0.03, 300),
        ],
      ],
      [
        '白酒',
        [
          makeStock('600519', '贵州茅台', 0.04, 21000),
          makeStock('000858', '五粮液', 0.02, 6000),
          makeStock('600809', '山西汾酒', 0.015, 2500),
        ],
      ],
    ]);
    const dailyClose = new Map([
      ['300100', 80.0],
      ['300101', 100.0],
      ['600519', 1800.0],
      ['000858', 130.0],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents, dailyClose });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { topIndustries: 2 } });
    expectEqual('  eligible_count = 4', r.eligible_count, 4);
    expectEqual('  BUY 4 笔', r.signals.filter(s => s.signal === 'buy').length, 4);
    expectEqual('  target_positions = 4', r.target_positions.length, 4);
    const buys = r.signals.filter(s => s.signal === 'buy').map(s => s.stock_code);
    // 行业排名: 半导体 (rank 1) → 龙头 300100, 300101；白酒 (rank 2) → 600519, 000858
    expectEqual('  BUY codes 顺序', buys, ['300100', '300101', '600519', '000858']);
    // top_industries 输出
    expectEqual('  top_industries.length = 2', r.top_industries.length, 2);
    expectEqual('  top_industries[0].rank = 1', r.top_industries[0].rank, 1);
    expectEqual('  top_industries[0].industry_name', r.top_industries[0].industry_name, '半导体');
    expectEqual(
      '  target.entry_industry 第一只 = 半导体',
      r.target_positions[0].entry_industry,
      '半导体'
    );
    expectEqual('  target.entry_date', r.target_positions[0].entry_date, '2026-06-07');
    expectEqual('  target.entry_price', r.target_positions[0].entry_price, 80.0);
  }

  // ========== Test 4: 入场失败 - 市值不足 ==========
  console.log('\nTest 4: 入场失败 - 流通市值不足 50 亿被剔除');
  {
    const industryRanking = [{ industry_name: '半导体', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          makeStock('300100', '小盘股', 0.1, 30), // 30 亿 < 50 亿
          makeStock('300101', '大盘股', 0.05, 600),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { topIndustries: 1 } });
    expectEqual('  eligible_count = 1', r.eligible_count, 1);
    expectEqual('  filtered.fail_market_cap_low = 1', r.filtered.fail_market_cap_low, 1);
    const buys = r.signals.filter(s => s.signal === 'buy').map(s => s.stock_code);
    expectEqual('  BUY = 大盘股', buys, ['300101']);
  }

  // ========== Test 5: 入场失败 - ST 名称 ==========
  console.log('\nTest 5: 入场失败 - ST 股票被剔除');
  {
    const industryRanking = [{ industry_name: '行业 A', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '行业 A',
        [
          makeStock('000001', 'ST 测试', 0.1, 200),
          makeStock('000002', '正常股', 0.08, 200),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { topIndustries: 1 } });
    expectEqual('  filtered.fail_st = 1', r.filtered.fail_st, 1);
    expectEqual('  eligible_count = 1', r.eligible_count, 1);
    const buys = r.signals.filter(s => s.signal === 'buy').map(s => s.stock_code);
    expectEqual('  BUY = 正常股', buys, ['000002']);
  }

  // ========== Test 6: 入场失败 - excludeST=false 时 ST 保留 ==========
  console.log('\nTest 6: excludeST=false 时 ST 不被剔除');
  {
    const industryRanking = [{ industry_name: '行业 A', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '行业 A',
        [
          makeStock('000001', 'ST 测试', 0.1, 200),
          makeStock('000002', '正常股', 0.08, 200),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 1, excludeST: false },
    });
    expectEqual('  filtered.fail_st = 0', r.filtered.fail_st, 0);
    expectEqual('  eligible_count = 2', r.eligible_count, 2);
  }

  // ========== Test 7: 入场失败 - 缺市值元数据 ==========
  console.log('\nTest 7: 入场失败 - 缺 circulating_market_cap');
  {
    const industryRanking = [{ industry_name: '行业 A', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '行业 A',
        [
          {
            stock_code: '600001',
            name: '某股',
            change_pct: 0.1,
            circulating_market_cap: null,
          },
          makeStock('600002', '正常股', 0.05, 200),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', { params: { topIndustries: 1 } });
    expectEqual('  filtered.fail_metric_missing = 1', r.filtered.fail_metric_missing, 1);
    expectEqual('  eligible_count = 1', r.eligible_count, 1);
  }

  // ========== Test 8: 已持仓不重复 BUY ==========
  console.log('\nTest 8: 已持仓股票当日依然满足入场不会重复 BUY (fail_already_held)');
  {
    const industryRanking = [
      { industry_name: '半导体', cumulative_inflow: 100e8 },
      { industry_name: '白酒', cumulative_inflow: 80e8 },
    ];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          makeStock('300100', '中芯国际', 0.09, 800),
          makeStock('300101', '韦尔股份', 0.05, 600),
        ],
      ],
      [
        '白酒',
        [
          makeStock('600519', '贵州茅台', 0.04, 21000),
          makeStock('000858', '五粮液', 0.02, 6000),
        ],
      ],
    ]);
    const dailyClose = new Map([
      ['300100', 80.0],
      ['300101', 100.0],
      ['600519', 1800.0],
      ['000858', 130.0],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents, dailyClose });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 2 },
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    // 已持仓 300100 仍然是当日龙头之一 → 应该 HOLD 不重复 BUY；
    // 入场流程跳过它后下一名 300101 入选，白酒两只入选 = 3 BUY
    expectEqual('  fail_already_held = 1', r.filtered.fail_already_held, 1);
    expectEqual('  BUY = 3 (300101 / 600519 / 000858)', r.signals.filter(s => s.signal === 'buy').length, 3);
    expectEqual('  HOLD = 1 (300100)', r.signals.filter(s => s.signal === 'hold').length, 1);
    expectEqual('  target_positions = 4 (1 HOLD + 3 BUY)', r.target_positions.length, 4);
  }

  // ========== Test 9: 排序 - 行业按 cumulative_inflow 降序 ==========
  console.log('\nTest 9: 排序 - top_industries 按 cumulative_inflow 降序');
  {
    const industryRanking = [
      { industry_name: '半导体', cumulative_inflow: 300e8 }, // rank 1
      { industry_name: '白酒', cumulative_inflow: 200e8 }, // rank 2
      { industry_name: '医药', cumulative_inflow: 150e8 }, // rank 3
    ];
    const constituents = new Map<string, SectorRotationStockMetric[]>();
    for (const ind of ['半导体', '白酒', '医药']) {
      constituents.set(ind, [makeStock(`${ind}_股A`, `${ind}A`, 0.05, 200)]);
    }
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 3, stocksPerIndustry: 1 },
    });
    expectEqual('  top_industries[0]', r.top_industries[0].industry_name, '半导体');
    expectEqual('  top_industries[1]', r.top_industries[1].industry_name, '白酒');
    expectEqual('  top_industries[2]', r.top_industries[2].industry_name, '医药');
    expectEqual('  top_industries[0].rank = 1', r.top_industries[0].rank, 1);
    expectEqual('  top_industries[2].rank = 3', r.top_industries[2].rank, 3);
  }

  // ========== Test 10: 排序 - 行业内按 change_pct 降序 ==========
  console.log('\nTest 10: 排序 - 行业内按 change_pct 降序选龙头');
  {
    const industryRanking = [{ industry_name: '半导体', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          // DataSource 约定：已按 change_pct 降序排好
          makeStock('300100', '甲股', 0.1, 200),
          makeStock('300101', '乙股', 0.05, 200),
          makeStock('300102', '丙股', 0.02, 200),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 1, stocksPerIndustry: 2 },
    });
    const buys = r.signals.filter(s => s.signal === 'buy').map(s => s.stock_code);
    expectEqual('  BUY 顺序 = 涨幅最大的 2 只', buys, ['300100', '300101']);
  }

  // ========== Test 11: 出场 - holdingDaysLimit 到期 ==========
  console.log('\nTest 11: 出场 - 持有 10 自然日强制 SELL');
  {
    const industryRanking = [{ industry_name: '半导体', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['半导体', [makeStock('300100', '中芯国际', 0.05, 800)]],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-15', {
      params: { topIndustries: 1, stocksPerIndustry: 1 },
      currentPositions: [
        // 6/5 进场 → 6/15 = 10 自然日，到期
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  SELL = 1', sells.length, 1);
    assert('  SELL reason 含到期', sells[0].reason.includes('到期'));
  }

  // ========== Test 12: 出场 - 行业掉出 top exitIndustryTopN ==========
  console.log('\nTest 12: 出场 - 行业掉出 top 15 → SELL');
  {
    // 入场行业 半导体 (rank 5)；今日 半导体 跌到 rank 20 (>15) → SELL
    const industryRanking: Array<{ industry_name: string; cumulative_inflow: number }> = [];
    for (let i = 0; i < 20; i++) {
      industryRanking.push({
        industry_name: i === 19 ? '半导体' : `行业${i}`,
        cumulative_inflow: (20 - i) * 10e8,
      });
    }
    const constituents = new Map<string, SectorRotationStockMetric[]>();
    constituents.set('半导体', [makeStock('300100', '中芯国际', 0.05, 800)]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05', // 2 自然日，不到期
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  SELL = 1', sells.length, 1);
    assert('  SELL reason 含行业排名', sells[0].reason.includes('第 20 名'));
  }

  // ========== Test 13: 出场 - 个股跌出行业 top exitStockTopN ==========
  console.log('\nTest 13: 出场 - 个股跌出行业 top 5 → SELL');
  {
    const industryRanking = [{ industry_name: '半导体', cumulative_inflow: 100e8 }];
    // 我的持仓 300100 进场时是涨幅第一，今日跌到第 8 名（>5）
    const semiconductorStocks: SectorRotationStockMetric[] = [];
    for (let i = 0; i < 8; i++) {
      semiconductorStocks.push(
        i === 7
          ? makeStock('300100', '中芯国际', -0.05, 800) // 我持仓的票，跌到第 8
          : makeStock(`300${100 + i}`, `龙头${i}`, 0.05 + i * 0.001, 800)
      );
    }
    // DataSource 期待 change_pct 降序，rebuild
    semiconductorStocks.sort((a, b) => b.change_pct - a.change_pct);
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['半导体', semiconductorStocks],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  SELL = 1', sells.length, 1);
    assert('  SELL reason 含个股排名跌出', sells[0].reason.includes('跌出'));
  }

  // ========== Test 14: 出场 - HOLD 默认 ==========
  console.log('\nTest 14: 出场 - 行业 / 个股都在容忍域 → HOLD');
  {
    const industryRanking = [
      { industry_name: '半导体', cumulative_inflow: 100e8 },
      { industry_name: '白酒', cumulative_inflow: 80e8 },
    ];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          makeStock('300100', '中芯国际', 0.05, 800), // 行业内 rank 1 ≤ 5
          makeStock('300101', '韦尔股份', 0.03, 600),
        ],
      ],
      [
        '白酒',
        [
          makeStock('600519', '贵州茅台', 0.04, 21000),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const holds = r.signals.filter(s => s.signal === 'hold');
    expectEqual('  HOLD = 1', holds.length, 1);
    expectEqual('  holds[0].stock_code', holds[0].stock_code, '300100');
    expectEqual('  holds[0].industry_rank', holds[0].industry_rank, 1);
    expectEqual('  holds[0].stock_rank_in_industry', holds[0].stock_rank_in_industry, 1);
  }

  // ========== Test 15: 出场优先级 - 持有期 > 行业排名 ==========
  console.log('\nTest 15: 出场优先级 - 持有 10 日到期 > 行业掉出 top 15');
  {
    const industryRanking: Array<{ industry_name: string; cumulative_inflow: number }> = [];
    for (let i = 0; i < 20; i++) {
      industryRanking.push({
        industry_name: i === 19 ? '半导体' : `行业${i}`,
        cumulative_inflow: (20 - i) * 10e8,
      });
    }
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['半导体', [makeStock('300100', '中芯国际', 0.05, 800)]],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-15', {
      currentPositions: [
        // 持有 10 日 + 行业第 20（两条出场都触发，应该 reason = 到期）
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  SELL = 1', sells.length, 1);
    assert('  SELL reason 是"到期"而非"行业排名"', sells[0].reason.includes('到期'));
  }

  // ========== Test 16: 出场优先级 - 行业排名 > 个股排名 ==========
  console.log('\nTest 16: 出场优先级 - 行业掉出 top 15 > 个股跌出 top 5');
  {
    const industryRanking: Array<{ industry_name: string; cumulative_inflow: number }> = [];
    for (let i = 0; i < 20; i++) {
      industryRanking.push({
        industry_name: i === 19 ? '半导体' : `行业${i}`,
        cumulative_inflow: (20 - i) * 10e8,
      });
    }
    const semiconductorStocks: SectorRotationStockMetric[] = [];
    for (let i = 0; i < 8; i++) {
      semiconductorStocks.push(
        i === 7
          ? makeStock('300100', '中芯国际', -0.05, 800)
          : makeStock(`300${100 + i}`, `龙头${i}`, 0.05 + i * 0.001, 800)
      );
    }
    semiconductorStocks.sort((a, b) => b.change_pct - a.change_pct);
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['半导体', semiconductorStocks],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        // 持有 2 日不到期 + 行业 20 + 个股第 8 — 出场原因应为行业排名
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  SELL = 1', sells.length, 1);
    assert('  SELL reason 是"行业排名"', sells[0].reason.includes('第 20 名'));
    assert('  SELL reason 不含"跌出"', !sells[0].reason.includes('跌出'));
  }

  // ========== Test 17: 出场 - 行业内 metric 数据缺失 → 安全 HOLD ==========
  console.log('\nTest 17: 出场 - 行业在排名但成份股 metric 缺失 → 安全 HOLD');
  {
    const industryRanking = [{ industry_name: '半导体', cumulative_inflow: 100e8 }];
    // 半导体 行业本身在排名里，但 constituents 返回空数组（如 metric pipeline 抖动）
    const constituents = new Map<string, SectorRotationStockMetric[]>([['半导体', []]]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const holds = r.signals.filter(s => s.signal === 'hold');
    expectEqual('  HOLD = 1 (不当作出场)', holds.length, 1);
    assert('  HOLD reason 含"成份股 metric 数据缺失"', holds[0].reason.includes('数据缺失'));
  }

  // ========== Test 18: HOLD 占用 implicit cap 后限制 BUY 数 ==========
  console.log('\nTest 18: HOLD 占满 implicit cap → 新 BUY 减少');
  {
    // implicit cap = topIndustries × stocksPerIndustry = 2 × 1 = 2
    // 已持仓 2 只全 HOLD → 0 BUY
    const industryRanking = [
      { industry_name: '半导体', cumulative_inflow: 100e8 },
      { industry_name: '白酒', cumulative_inflow: 80e8 },
    ];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          makeStock('300100', '中芯国际', 0.05, 800),
          makeStock('300101', '韦尔股份', 0.04, 600),
        ],
      ],
      [
        '白酒',
        [
          makeStock('600519', '贵州茅台', 0.04, 21000),
          makeStock('000858', '五粮液', 0.02, 6000),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 2, stocksPerIndustry: 1 }, // implicit cap = 2
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
        {
          stock_code: '600519',
          entry_date: '2026-06-05',
          entry_price: 1700,
          entry_industry: '白酒',
        },
      ],
    });
    const holds = r.signals.filter(s => s.signal === 'hold');
    const buys = r.signals.filter(s => s.signal === 'buy');
    expectEqual('  HOLD = 2', holds.length, 2);
    expectEqual('  BUY = 0 (cap 已满)', buys.length, 0);
    expectEqual('  target_positions = 2', r.target_positions.length, 2);
  }

  // ========== Test 19: evaluate() 信息性 hold ==========
  console.log('\nTest 19: evaluate() 返回信息性 hold');
  {
    const s = new SectorRotationLeaderStrategy(new FakeDataSource());
    const result = s.evaluate({
      symbol: '300100.SZ',
      name: '中芯国际',
      bars: [
        {
          time: new Date('2026-06-07'),
          open: 80,
          high: 82,
          low: 79,
          close: 81,
          volume: 1000,
          turnover: 81000,
        },
      ],
      factor_snapshot: {},
    });
    expectEqual('  signal = hold', result.signal, 'hold');
    expectEqual(
      '  factors.note = use_generateSignals_instead',
      result.factors?.note,
      'use_generateSignals_instead'
    );
    expectEqual('  entry_price = 最后一 bar close', result.entry_price, 81);
    assert('  reasons 含提示', (result.reasons ?? []).some(r => r.includes('generateSignals')));
  }

  // ========== Test 20: helper isSTName ==========
  console.log('\nTest 20: helper isSTName 边角');
  {
    expectEqual('  null → false', isSTName(null), false);
    expectEqual('  "" → false', isSTName(''), false);
    expectEqual('  "贵州茅台" → false', isSTName('贵州茅台'), false);
    expectEqual('  "ST 测试" → true', isSTName('ST 测试'), true);
    expectEqual('  "*ST 测试" → true', isSTName('*ST 测试'), true);
    expectEqual('  "st 测试" 小写 → true', isSTName('st 测试'), true);
    expectEqual('  "正常股 ST" → false (不以 ST 开头)', isSTName('正常股 ST'), false);
  }

  // ========== Test 21: helper naturalDaysBetween ==========
  console.log('\nTest 21: helper naturalDaysBetween 边角');
  {
    expectEqual('  同日 → 0', naturalDaysBetween('2026-06-07', '2026-06-07'), 0);
    expectEqual('  next day → 1', naturalDaysBetween('2026-06-07', '2026-06-08'), 1);
    expectEqual('  10 days → 10', naturalDaysBetween('2026-06-05', '2026-06-15'), 10);
    expectEqual('  跨月 → 5', naturalDaysBetween('2026-05-30', '2026-06-04'), 5);
    expectEqual(
      '  反向输入 (entry > trade) → 0 (不为负)',
      naturalDaysBetween('2026-06-15', '2026-06-05'),
      0
    );
  }

  // ========== Test 22: invalid trade_date 抛出 ==========
  console.log('\nTest 22: invalid trade_date 抛出');
  {
    const s = new SectorRotationLeaderStrategy(new FakeDataSource());
    let thrown = false;
    try {
      await s.generateSignals('2026/06/07');
    } catch (_e) {
      thrown = true;
    }
    assert('  非 ISO 日期抛出 Error', thrown);
    thrown = false;
    try {
      await s.generateSignals('20260607');
    } catch (_e) {
      thrown = true;
    }
    assert('  无短横线 8 位日期抛出', thrown);
  }

  // ========== Test 23: 空 universe 安全 ==========
  console.log('\nTest 23: 空 industry_ranking 安全 (industry_pool_size=0)');
  {
    const ds = new FakeDataSource({});
    const s = new SectorRotationLeaderStrategy(ds);
    const r = await s.generateSignals('2026-06-07');
    expectEqual('  eligible_count = 0', r.eligible_count, 0);
    expectEqual('  signals = 0', r.signals.length, 0);
    expectEqual('  target_positions = 0', r.target_positions.length, 0);
    expectEqual('  top_industries = []', r.top_industries.length, 0);
  }

  // ========== Test 24: 自定义 params override ==========
  console.log('\nTest 24: 自定义 params override (lookbackDays=10, stocksPerIndustry=3)');
  {
    const industryRanking = [{ industry_name: '半导体', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      [
        '半导体',
        [
          makeStock('300100', '甲', 0.1, 200),
          makeStock('300101', '乙', 0.08, 200),
          makeStock('300102', '丙', 0.06, 200),
          makeStock('300103', '丁', 0.04, 200),
        ],
      ],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 1, stocksPerIndustry: 3, lookbackDays: 10 },
    });
    expectEqual('  params.lookbackDays = 10', r.params.lookbackDays, 10);
    expectEqual('  params.stocksPerIndustry = 3', r.params.stocksPerIndustry, 3);
    expectEqual('  BUY = 3', r.signals.filter(s => s.signal === 'buy').length, 3);
  }

  // ========== Test 25: 行业排名 = top exitIndustryTopN 边界 (rank == 15 不出场) ==========
  console.log('\nTest 25: 边界 - 行业 rank == 15 不出场 (≤ 15)');
  {
    const industryRanking: Array<{ industry_name: string; cumulative_inflow: number }> = [];
    for (let i = 0; i < 16; i++) {
      industryRanking.push({
        industry_name: i === 14 ? '半导体' : `行业${i}`,
        cumulative_inflow: (20 - i) * 10e8,
      });
    }
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['半导体', [makeStock('300100', '中芯国际', 0.05, 800)]],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const holds = r.signals.filter(s => s.signal === 'hold');
    expectEqual('  rank 15 时 HOLD 而非 SELL', holds.length, 1);
  }

  // ========== Test 26: 行业排名 = 16 (> 15) 出场 ==========
  console.log('\nTest 26: 边界 - 行业 rank == 16 → SELL (> 15)');
  {
    const industryRanking: Array<{ industry_name: string; cumulative_inflow: number }> = [];
    for (let i = 0; i < 16; i++) {
      industryRanking.push({
        industry_name: i === 15 ? '半导体' : `行业${i}`,
        cumulative_inflow: (20 - i) * 10e8,
      });
    }
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['半导体', [makeStock('300100', '中芯国际', 0.05, 800)]],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  rank 16 时 SELL', sells.length, 1);
    assert('  reason 含"第 16 名"', sells[0].reason.includes('第 16 名'));
  }

  // ========== Test 27: 出场 - 行业从 industryRanking 完全消失 → SELL ==========
  console.log('\nTest 27: 出场 - 行业完全不在 ranking → SELL (无主力净流入数据)');
  {
    const industryRanking = [{ industry_name: '别的行业', cumulative_inflow: 100e8 }];
    const constituents = new Map<string, SectorRotationStockMetric[]>([
      ['别的行业', [makeStock('600002', '不相关', 0.05, 200)]],
    ]);
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      currentPositions: [
        {
          stock_code: '300100',
          entry_date: '2026-06-05',
          entry_price: 75.0,
          entry_industry: '半导体',
        },
      ],
    });
    const sells = r.signals.filter(s => s.signal === 'sell');
    expectEqual('  SELL = 1', sells.length, 1);
    assert('  reason 含"无主力净流入"', sells[0].reason.includes('无主力净流入'));
  }

  // ========== Test 28: top_industries 输出 cumulative_inflow 字段 ==========
  console.log('\nTest 28: top_industries 包含 cumulative_inflow + rank 字段');
  {
    const industryRanking = [
      { industry_name: '半导体', cumulative_inflow: 100e8 },
      { industry_name: '白酒', cumulative_inflow: 80e8 },
    ];
    const constituents = new Map<string, SectorRotationStockMetric[]>();
    for (const ind of ['半导体', '白酒']) {
      constituents.set(ind, [makeStock(`${ind}_股`, ind, 0.05, 200)]);
    }
    const ds = new FakeDataSource({ industryRanking, constituents });
    const s = new SectorRotationLeaderStrategy(ds);

    const r = await s.generateSignals('2026-06-07', {
      params: { topIndustries: 2 },
    });
    expectEqual('  top_industries.length', r.top_industries.length, 2);
    expectEqual(
      '  top_industries[0].cumulative_inflow',
      r.top_industries[0].cumulative_inflow,
      100e8
    );
    expectEqual('  top_industries[0].rank', r.top_industries[0].rank, 1);
    expectEqual(
      '  top_industries[1].cumulative_inflow',
      r.top_industries[1].cumulative_inflow,
      80e8
    );
    expectEqual('  top_industries[1].rank', r.top_industries[1].rank, 2);
  }

  // ========== 总结 ==========
  console.log('\n--------------------------------');
  if (failed === 0) {
    console.log('All tests passed ✓');
  } else {
    console.log(`FAILED: ${failed} assertion(s)`);
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
