/**
 * PortfolioCorrelationService 单测 — Phase 6 持仓相关性热力图
 *
 * 测纯函数: computePearsonCorr / closeToDailyReturns / alignReturns / buildMatrix /
 *           findHighCorrelationClusters / avgOffDiagonalCorrelation。
 * 测 getReport 注入 fake DataSource 脱 DB。
 */

import {
  PortfolioCorrelationService,
  computePearsonCorr,
  closeToDailyReturns,
  alignReturns,
  buildMatrix,
  findHighCorrelationClusters,
  avgOffDiagonalCorrelation,
  MIN_OBSERVATIONS,
  PortfolioCorrelationDataSource,
} from '../../src/services/PortfolioCorrelationService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-3) {
  assert(
    name,
    Number.isFinite(actual) && Math.abs(actual - expected) < eps,
    `expected≈${expected}, got=${actual}`
  );
}

function testComputePearsonCorr() {
  console.log('\n## computePearsonCorr');

  // 完美正相关
  const N = MIN_OBSERVATIONS;
  const x = Array.from({ length: N }, (_, i) => i);
  const y = x.map(v => 2 * v + 5);
  expectClose('完美正相关 → 1', computePearsonCorr(x, y)!, 1);

  // 完美负相关
  const yNeg = x.map(v => -v + 10);
  expectClose('完美负相关 → -1', computePearsonCorr(x, yNeg)!, -1);

  // 无相关 (随机) — 用确定的两个不相关序列
  const xAlt = [];
  const yAlt = [];
  for (let i = 0; i < N; i++) {
    xAlt.push(i % 3);
    yAlt.push(((i * 7) % 11) - 5);
  }
  const corr = computePearsonCorr(xAlt, yAlt);
  assert(
    '近似不相关 (|corr| < 0.5)',
    corr !== null && Math.abs(corr) < 0.5,
    `actual=${corr}`
  );

  // 长度太短 → null
  const short = Array.from({ length: 5 }, (_, i) => i);
  assert('长度 < MIN_OBSERVATIONS → null', computePearsonCorr(short, short) === null);

  // 长度不等 → null
  assert(
    '长度不等 → null',
    computePearsonCorr(
      Array(30).fill(0),
      Array(31).fill(0)
    ) === null
  );

  // 全相等 → null
  const flat = Array(N).fill(5);
  assert('全相等 (方差 0) → null', computePearsonCorr(flat, x) === null);

  // 含 NaN 对 — 剔除后样本仍够
  const xn = Array.from({ length: N + 5 }, (_, i) => (i === 0 ? NaN : i));
  const yn = Array.from({ length: N + 5 }, (_, i) => (i === N + 4 ? NaN : 2 * i));
  const corrNaN = computePearsonCorr(xn, yn);
  assert('含 NaN 对剔除后仍能算 → 非 null', corrNaN !== null);
}

function testCloseToDailyReturns() {
  console.log('\n## closeToDailyReturns');
  // close [100, 110, 99, 105] → returns [0.1, -0.1, 0.0606]
  const closes = [100, 110, 99, 105];
  const returns = closeToDailyReturns(closes);
  expectClose('length = closes.length - 1', returns.length, 3);
  expectClose('[0] = 0.1', returns[0], 0.1);
  expectClose('[1] ≈ -0.1', returns[1], -0.1, 0.001);
  expectClose('[2] ≈ 0.0606', returns[2], 0.0606, 0.001);

  // close 含 0 / 负数 / NaN → 对应 returns 处理
  const dirty = [100, 0, 110, NaN, 95];
  const dirtyRet = closeToDailyReturns(dirty);
  // [0]: prev=100, curr=0 → (0-100)/100 = -1 (有效，stock 跌到 0 视为 -100%)
  expectClose('close 100→0 → -1.0 (满跌)', dirtyRet[0], -1);
  // [1]: prev=0 → trigger NaN (除 0)
  assert('prev=0 → returns NaN', !Number.isFinite(dirtyRet[1]));
  // [2]: prev=110, curr=NaN → NaN
  assert('curr=NaN → returns NaN', !Number.isFinite(dirtyRet[2]));
  // [3]: prev=NaN → NaN
  assert('prev=NaN → returns NaN', !Number.isFinite(dirtyRet[3]));
}

function testAlignReturns() {
  console.log('\n## alignReturns');
  // 不同长度对齐到最短
  const closesMap = new Map<string, number[]>([
    ['A', [10, 11, 12, 13, 14, 15]], // returns 5
    ['B', [20, 21, 22, 23]],          // returns 3
    ['C', [30, 31, 32, 33, 34]],      // returns 4
  ]);
  const aligned = alignReturns(closesMap);
  expectClose('A returns length aligned to 3', aligned.get('A')!.length, 3);
  expectClose('B returns length 3', aligned.get('B')!.length, 3);
  expectClose('C returns length 3', aligned.get('C')!.length, 3);
  // A 对齐后保留尾部 3 个
  // returns 完整: [0.1, 0.0909, 0.0833, 0.0769, 0.0714]; 尾部 3 = [0.0833, 0.0769, 0.0714]
  expectClose('A 对齐后保留尾部', aligned.get('A')![0], 0.0833, 0.001);
}

function testBuildMatrix() {
  console.log('\n## buildMatrix');
  const symbols = ['A', 'B', 'C'];
  // 构造 30 个对齐序列：A 与 B 完全相关，A 与 C 无关
  const N = MIN_OBSERVATIONS;
  const a = Array.from({ length: N }, (_, i) => i * 0.01);
  const b = a.slice(); // 完全相关
  const c = Array.from({ length: N }, (_, i) => Math.sin(i));
  const returnsMap = new Map<string, number[]>([
    ['A', a],
    ['B', b],
    ['C', c],
  ]);
  const matrix = buildMatrix(symbols, returnsMap);
  expectClose('diag = 1', matrix[0][0]!, 1);
  expectClose('A-B 完全相关 = 1', matrix[0][1]!, 1);
  expectClose('B-A 对称 = 1', matrix[1][0]!, 1);
  assert('A-C 弱相关 (|corr| < 0.5)', Math.abs(matrix[0][2]!) < 0.5);

  // 一只数据缺失
  const partialMap = new Map<string, number[]>([
    ['A', a],
    ['B', [1, 2, 3]], // 太短
    ['C', c],
  ]);
  const matrix2 = buildMatrix(symbols, partialMap);
  assert('B 数据不足 → A-B null', matrix2[0][1] === null);
  expectClose('A-C 不受影响', matrix2[0][2]!, matrix[0][2]!, 0.001);
}

function testFindHighCorrelationClusters() {
  console.log('\n## findHighCorrelationClusters');
  // 4 个 symbol: A-B-C 高度相关 (>0.8), D 与所有无关
  const symbols = ['A', 'B', 'C', 'D'];
  const matrix: Array<Array<number | null>> = [
    [1, 0.9, 0.85, 0.1],
    [0.9, 1, 0.88, 0.05],
    [0.85, 0.88, 1, 0.2],
    [0.1, 0.05, 0.2, 1],
  ];
  const mvMap = new Map<string, number>([
    ['A', 10000],
    ['B', 20000],
    ['C', 15000],
    ['D', 5000],
  ]);
  const indMap = new Map<string, string | null>([
    ['A', '银行'],
    ['B', '银行'],
    ['C', '银行'],
    ['D', '医药'],
  ]);
  const clusters = findHighCorrelationClusters(symbols, matrix, 0.7, mvMap, indMap);
  expectClose('cluster 数 = 1', clusters.length, 1);
  expectClose('cluster 成员 3', clusters[0].members.length, 3);
  assert('cluster 含 A B C', clusters[0].members.includes('A') && clusters[0].members.includes('B') && clusters[0].members.includes('C'));
  expectClose('cluster avg ≈ (0.9+0.85+0.88)/3 = 0.877', clusters[0].avg_correlation, 0.877, 0.01);
  expectClose('cluster MV 45000', clusters[0].total_market_value, 45000);
  // 总 MV = 50000 → cluster 占 90%
  expectClose('cluster pct 90%', clusters[0].pct_of_portfolio, 90.0, 0.5);
  assert('dominant_industry = 银行', clusters[0].dominant_industry === '银行');

  // 阈值过高 → 无 cluster
  const noClusters = findHighCorrelationClusters(symbols, matrix, 0.95, mvMap);
  expectClose('threshold=0.95 → 0 cluster', noClusters.length, 0);

  // 单 cluster < 2 成员不算
  const single = findHighCorrelationClusters(['X'], [[1]], 0.5, new Map());
  expectClose('1 个 symbol → 0 cluster', single.length, 0);
}

function testAvgOffDiagonal() {
  console.log('\n## avgOffDiagonalCorrelation');
  const matrix: Array<Array<number | null>> = [
    [1, 0.5, 0.3],
    [0.5, 1, 0.2],
    [0.3, 0.2, 1],
  ];
  // off-diagonal 上三角: 0.5 + 0.3 + 0.2 = 1.0, avg = 0.333
  expectClose('avg = (0.5+0.3+0.2)/3 ≈ 0.333', avgOffDiagonalCorrelation(matrix)!, 0.333, 0.01);

  // 单 N=1 → null
  assert('1×1 → null', avgOffDiagonalCorrelation([[1]]) === null);

  // 含 null → 跳过
  const withNull: Array<Array<number | null>> = [
    [1, 0.5, null],
    [0.5, 1, 0.2],
    [null, 0.2, 1],
  ];
  // off-diagonal 有效: 0.5 + 0.2 = 0.7, count = 2 → 0.35
  expectClose('含 null 跳过 → 0.35', avgOffDiagonalCorrelation(withNull)!, 0.35, 0.01);

  // 全 null → null
  const allNull: Array<Array<number | null>> = [
    [1, null],
    [null, 1],
  ];
  assert('全 null off-diag → null', avgOffDiagonalCorrelation(allNull) === null);
}

async function testGetReport() {
  console.log('\n## getReport with fake DataSource');

  // 构造 5 个 symbols: AAA/BBB/CCC 强相关 (共享 daily shock) + DDD/EEE 独立
  // 用日度 returns 构造而非趋势 close (避免方差过小问题)
  const N = 50;
  // SeededRandom for deterministic test
  let seed = 1;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  // 共享 market shock
  const shock = Array.from({ length: N }, () => (rand() - 0.5) * 0.02);
  // AAA = shock + small noise
  const baseA: number[] = [100];
  const baseB: number[] = [100];
  const baseC: number[] = [100];
  const baseD: number[] = [100];
  const baseE: number[] = [100];
  for (let i = 0; i < N; i++) {
    baseA.push(baseA[i] * (1 + shock[i] + (rand() - 0.5) * 0.002));
    baseB.push(baseB[i] * (1 + shock[i] * 0.95 + (rand() - 0.5) * 0.003));
    baseC.push(baseC[i] * (1 + shock[i] * 1.05 + (rand() - 0.5) * 0.003));
    baseD.push(baseD[i] * (1 - shock[i] * 0.3 + (rand() - 0.5) * 0.02)); // 反向 + 大噪声
    baseE.push(baseE[i] * (1 + (rand() - 0.5) * 0.03)); // 纯随机
  }

  const fakeSource: PortfolioCorrelationDataSource = {
    async loadPortfolioHeader(pid) {
      return pid === 100 ? { user_id: 1 } : null;
    },
    async loadPositionsWithMV(_pid) {
      return [
        { stock_code: 'AAA', name: 'A 股', market_value: 10000, industry: '银行' },
        { stock_code: 'BBB', name: 'B 股', market_value: 12000, industry: '银行' },
        { stock_code: 'CCC', name: 'C 股', market_value: 8000, industry: '银行' },
        { stock_code: 'DDD', name: 'D 股', market_value: 5000, industry: '医药' },
        { stock_code: 'EEE', name: 'E 股', market_value: 5000, industry: '消费' },
      ];
    },
    async loadClosesSeries(codes, _asOf, _lookback) {
      const m = new Map<string, number[]>();
      m.set('AAA', baseA);
      m.set('BBB', baseB);
      m.set('CCC', baseC);
      m.set('DDD', baseD);
      m.set('EEE', baseE);
      // 只返回 codes 中要的
      const out = new Map<string, number[]>();
      for (const c of codes) {
        out.set(c, m.get(c) || []);
      }
      return out;
    },
  };

  const svc = new PortfolioCorrelationService(fakeSource);
  const report = await svc.getReport(100, { lookback_days: 60, cluster_threshold: 0.7 });

  assert('report 非空', report !== null);
  expectClose('position_count = 5', report!.position_count, 5);
  expectClose('matrix 5×5', report!.matrix.matrix.length, 5);
  expectClose('matrix[0] length 5', report!.matrix.matrix[0].length, 5);
  expectClose('matrix diag = 1', report!.matrix.matrix[0][0]!, 1);

  // AAA-BBB-CCC 应同 cluster (corr > 0.99)
  const cluster = report!.high_correlation_clusters[0];
  assert('cluster 存在', cluster !== undefined);
  if (cluster) {
    expectClose('cluster 成员 3', cluster.members.length, 3);
    assert(
      'cluster 含 AAA/BBB/CCC',
      cluster.members.includes('AAA') && cluster.members.includes('BBB') && cluster.members.includes('CCC')
    );
    assert('cluster 主导行业 = 银行', cluster.dominant_industry === '银行');
    expectClose('cluster pct = (10000+12000+8000)/(40000) = 75%', cluster.pct_of_portfolio, 75.0, 1);
  }

  // diversification level 看 avg
  assert(
    'diversification_level 有值',
    ['high', 'medium', 'low', 'insufficient'].includes(report!.diversification_level)
  );

  // ============================================================
  // 边界: 持仓 < 2 → insufficient
  const fakeSingleSource: PortfolioCorrelationDataSource = {
    async loadPortfolioHeader(_pid) {
      return { user_id: 1 };
    },
    async loadPositionsWithMV(_pid) {
      return [{ stock_code: 'X', name: 'X', market_value: 100, industry: null }];
    },
    async loadClosesSeries() {
      return new Map();
    },
  };
  const single = await new PortfolioCorrelationService(fakeSingleSource).getReport(1);
  assert('单持仓 → insufficient', single?.diversification_level === 'insufficient');

  // 数据不足
  const fakeShortSource: PortfolioCorrelationDataSource = {
    async loadPortfolioHeader() {
      return { user_id: 1 };
    },
    async loadPositionsWithMV() {
      return [
        { stock_code: 'P', name: 'P', market_value: 100, industry: null },
        { stock_code: 'Q', name: 'Q', market_value: 100, industry: null },
      ];
    },
    async loadClosesSeries() {
      return new Map([
        ['P', [100, 101, 102]],
        ['Q', [200, 201, 202]],
      ]);
    },
  };
  const short = await new PortfolioCorrelationService(fakeShortSource).getReport(1);
  assert('数据不足 → insufficient_data_symbols 有项', (short?.insufficient_data_symbols.length || 0) >= 1);

  // portfolio 不存在
  const fakeNullSource: PortfolioCorrelationDataSource = {
    async loadPortfolioHeader() {
      return null;
    },
    async loadPositionsWithMV() {
      return [];
    },
    async loadClosesSeries() {
      return new Map();
    },
  };
  const notFound = await new PortfolioCorrelationService(fakeNullSource).getReport(999);
  assert('portfolio 不存在 → null', notFound === null);
}

async function main() {
  testComputePearsonCorr();
  testCloseToDailyReturns();
  testAlignReturns();
  testBuildMatrix();
  testFindHighCorrelationClusters();
  testAvgOffDiagonal();
  await testGetReport();
  console.log(`\n========================================`);
  console.log(`PortfolioCorrelationService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
