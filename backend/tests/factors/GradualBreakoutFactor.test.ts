/**
 * GradualBreakoutFactor 单元测试 (US-036).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/GradualBreakoutFactor.test.ts
 *
 * 覆盖：
 *   - 常量校验
 *   - 纯函数 extractSortedBars:
 *     空 / 正常升序 / 倒序输入升序输出 / close ≤ 0 / volume ≤ 0 / NaN /
 *     非有限 time / Date / string / number 三种 time / string close+volume
 *   - 纯函数 computeChangeSigns:
 *     空 → []，单元素 → [0]，全涨 / 全跌 / 全平 / 混合，首位永远 0，
 *     close 异常（0 / 负）位 sign=0
 *   - 纯函数 compute60dAvgVolumes:
 *     i < baselineDays → null，恰好够 → 非 null + 正确均值，
 *     超出 → 滑动窗口，baselineDays=0 → 全部 null，
 *     有效 obs < minObs → null
 *   - 纯函数 computeGradualBreakoutScore:
 *     - 业务方向 4 象限：价涨量增 / 价涨量减 / 价跌量减 / 价跌量增
 *     - 全平盘 → score = 0 / flat = recentDays
 *     - 数据卫生：bars 不足 / 全无效 volume / effective_days < min
 *     - 中间停牌（volume=0）参与跳过
 *     - 自定义 recentDays / baselineDays
 *   - Factor metadata + 已注册 + Signal-First 主线 16 因子完整
 *   - compute() 空 universe 安全路径
 *   - 端到端：构造 91 个 bar，验证 score 算法正确性
 */

import {
  gradualBreakoutFactor,
  extractSortedBars,
  computeChangeSigns,
  compute60dAvgVolumes,
  computeGradualBreakoutScore,
  RECENT_WINDOW_DAYS,
  VOLUME_BASELINE_DAYS,
  QUERY_CALENDAR_DAYS,
  MIN_VOLUME_BASELINE_OBS,
  MIN_RECENT_DAYS_FOR_VALID,
  SortedBar,
} from '../../src/quant/factors/library/GradualBreakoutFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
// eslint-disable-next-line @typescript-eslint/no-var-requires
import '../../src/quant/factors/library';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-9) {
  assert(name, near(actual, expected, eps), `expected≈${expected}, got=${actual}`);
}

console.log('\n## 常量');
assert(`RECENT_WINDOW_DAYS = 30 (got ${RECENT_WINDOW_DAYS})`, RECENT_WINDOW_DAYS === 30);
assert(
  `VOLUME_BASELINE_DAYS = 60 (got ${VOLUME_BASELINE_DAYS})`,
  VOLUME_BASELINE_DAYS === 60
);
assert(
  `QUERY_CALENDAR_DAYS >= 150 (got ${QUERY_CALENDAR_DAYS})`,
  QUERY_CALENDAR_DAYS >= 150
);
assert(
  `MIN_VOLUME_BASELINE_OBS = 30 (got ${MIN_VOLUME_BASELINE_OBS})`,
  MIN_VOLUME_BASELINE_OBS === 30
);
assert(
  `MIN_RECENT_DAYS_FOR_VALID = 21 (got ${MIN_RECENT_DAYS_FOR_VALID})`,
  MIN_RECENT_DAYS_FOR_VALID === 21
);

console.log('\n## extractSortedBars');
{
  assert('空数组 → []', extractSortedBars([]).length === 0);
}
{
  // 升序输入 → 升序输出
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: 101, volume: 1100 },
    { time: '2026-06-03T00:00:00Z', close: 102, volume: 1200 },
  ];
  const bars = extractSortedBars(rows);
  assert('升序输入 length 3', bars.length === 3);
  expectClose('bars[0].close = 100', bars[0].close, 100);
  expectClose('bars[2].volume = 1200', bars[2].volume, 1200);
}
{
  // 倒序输入 → 升序输出
  const rows = [
    { time: '2026-06-03T00:00:00Z', close: 102, volume: 1200 },
    { time: '2026-06-01T00:00:00Z', close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: 101, volume: 1100 },
  ];
  const bars = extractSortedBars(rows);
  assert('倒序输入仍 3 个', bars.length === 3);
  expectClose('排序后 bars[0].close = 100', bars[0].close, 100);
  expectClose('排序后 bars[1].close = 101', bars[1].close, 101);
  expectClose('排序后 bars[2].close = 102', bars[2].close, 102);
}
{
  // close ≤ 0 跳过
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: 0, volume: 1100 },
    { time: '2026-06-03T00:00:00Z', close: -5, volume: 1200 },
    { time: '2026-06-04T00:00:00Z', close: 105, volume: 1300 },
  ];
  const bars = extractSortedBars(rows);
  assert('close ≤ 0 跳过：剩 2 个', bars.length === 2);
  expectClose('bars[0].close = 100', bars[0].close, 100);
  expectClose('bars[1].close = 105', bars[1].close, 105);
}
{
  // volume ≤ 0 跳过（停牌等）
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: 101, volume: 0 },
    { time: '2026-06-03T00:00:00Z', close: 102, volume: -10 },
    { time: '2026-06-04T00:00:00Z', close: 103, volume: 1300 },
  ];
  const bars = extractSortedBars(rows);
  assert('volume ≤ 0 跳过：剩 2 个', bars.length === 2);
}
{
  // NaN 跳过
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: NaN, volume: 1100 },
    { time: '2026-06-03T00:00:00Z', close: 102, volume: NaN },
    { time: '2026-06-04T00:00:00Z', close: 103, volume: 1300 },
  ];
  const bars = extractSortedBars(rows);
  assert('NaN 跳过：剩 2 个', bars.length === 2);
}
{
  // 缺字段（undefined）跳过
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: 101 }, // 缺 volume
    { time: '2026-06-03T00:00:00Z', volume: 1200 }, // 缺 close
  ];
  const bars = extractSortedBars(rows);
  assert('缺字段跳过：剩 1 个', bars.length === 1);
}
{
  // 非有限时间戳跳过
  const rows = [
    { time: 'INVALID-DATE' as any, close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z', close: 101, volume: 1100 },
  ];
  const bars = extractSortedBars(rows);
  assert('非法时间跳过：剩 1 个', bars.length === 1);
  expectClose('剩下的是 101', bars[0].close, 101);
}
{
  // Date / string / number 三种 time 形式
  const baseMs = new Date('2026-06-01T00:00:00Z').getTime();
  const rows = [
    { time: new Date('2026-06-01T00:00:00Z'), close: 100, volume: 1000 },
    { time: '2026-06-02T00:00:00Z' as any, close: 101, volume: 1100 },
    { time: baseMs + 2 * 86400_000, close: 102, volume: 1200 },
  ];
  const bars = extractSortedBars(rows);
  assert('3 种 time 形式都接受', bars.length === 3);
}
{
  // string close + volume (Sequelize raw DECIMAL/BIGINT)
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: '100' as any, volume: '1000' as any },
    { time: '2026-06-02T00:00:00Z', close: '105.5' as any, volume: '1500' as any },
  ];
  const bars = extractSortedBars(rows);
  assert('string close+volume 也转 Number', bars.length === 2);
  expectClose('bars[0].close = 100', bars[0].close, 100);
  expectClose('bars[1].volume = 1500', bars[1].volume, 1500);
}

console.log('\n## computeChangeSigns');
{
  assert('空数组 → []', computeChangeSigns([]).length === 0);
}
{
  // 单元素 → [0]
  const bars: SortedBar[] = [{ time: 1, close: 100, volume: 1000 }];
  const signs = computeChangeSigns(bars);
  assert('单元素 → [0]', signs.length === 1 && signs[0] === 0);
}
{
  // 全涨 → [0, +1, +1, +1]
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 101, volume: 1000 },
    { time: 3, close: 102, volume: 1000 },
    { time: 4, close: 103, volume: 1000 },
  ];
  const signs = computeChangeSigns(bars);
  assert(
    '全涨 → [0,+1,+1,+1]',
    signs[0] === 0 && signs[1] === 1 && signs[2] === 1 && signs[3] === 1
  );
}
{
  // 全跌 → [0, -1, -1, -1]
  const bars: SortedBar[] = [
    { time: 1, close: 103, volume: 1000 },
    { time: 2, close: 102, volume: 1000 },
    { time: 3, close: 101, volume: 1000 },
    { time: 4, close: 100, volume: 1000 },
  ];
  const signs = computeChangeSigns(bars);
  assert(
    '全跌 → [0,-1,-1,-1]',
    signs[0] === 0 && signs[1] === -1 && signs[2] === -1 && signs[3] === -1
  );
}
{
  // 全平 → [0, 0, 0, 0]
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 100, volume: 1000 },
    { time: 3, close: 100, volume: 1000 },
  ];
  const signs = computeChangeSigns(bars);
  assert('全平 → [0,0,0]', signs.every(s => s === 0));
}
{
  // 混合 涨/平/跌 → 三态
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 105, volume: 1000 }, // +1
    { time: 3, close: 105, volume: 1000 }, // 0 (平)
    { time: 4, close: 100, volume: 1000 }, // -1
    { time: 5, close: 110, volume: 1000 }, // +1
  ];
  const signs = computeChangeSigns(bars);
  assert(
    '混合 → [0,+1,0,-1,+1]',
    signs[0] === 0 &&
      signs[1] === 1 &&
      signs[2] === 0 &&
      signs[3] === -1 &&
      signs[4] === 1
  );
}
{
  // close 异常位 sign=0
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 0, volume: 1000 }, // 0 → sign=0
    { time: 3, close: 105, volume: 1000 }, // 前位 0 → sign=0
    { time: 4, close: 110, volume: 1000 }, // 前位 105 → +1
  ];
  const signs = computeChangeSigns(bars);
  assert(
    'close 异常位 sign=0',
    signs[0] === 0 && signs[1] === 0 && signs[2] === 0 && signs[3] === 1
  );
}

console.log('\n## compute60dAvgVolumes');
{
  // 长度 < baselineDays + 1 → 全 null
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 101, volume: 1100 },
  ];
  const out = compute60dAvgVolumes(bars, 5);
  assert(
    'length=2 < baselineDays(5)+1 → 全 null',
    out.length === 2 && out[0] === null && out[1] === null
  );
}
{
  // 恰好够：baselineDays=3，length=4，out[3] = mean(volume[0..2])
  // 但 minObs 默认 30 > 3 → 应该 null
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 101, volume: 2000 },
    { time: 3, close: 102, volume: 3000 },
    { time: 4, close: 103, volume: 4000 },
  ];
  const outDefault = compute60dAvgVolumes(bars, 3);
  assert(
    'minObs 默认 30 > 3 → out[3] = null',
    outDefault[3] === null,
    `actual=${outDefault[3]}`
  );
  // 显式 minObs=3 → out[3] = (1000+2000+3000)/3 = 2000
  const outOverride = compute60dAvgVolumes(bars, 3, 3);
  assert(
    `minObs=3 显式覆盖 → out[3] = 2000 (got ${outOverride[3]})`,
    outOverride[3] !== null && near(outOverride[3] as number, 2000)
  );
}
{
  // 滑动窗口：length=5，baselineDays=2，minObs=2
  // out[0..1] = null
  // out[2] = mean(volume[0..1])
  // out[3] = mean(volume[1..2])
  // out[4] = mean(volume[2..3])
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 100 },
    { time: 2, close: 100, volume: 200 },
    { time: 3, close: 100, volume: 300 },
    { time: 4, close: 100, volume: 400 },
    { time: 5, close: 100, volume: 500 },
  ];
  const out = compute60dAvgVolumes(bars, 2, 2);
  assert('out[0] = null', out[0] === null);
  assert('out[1] = null', out[1] === null);
  expectClose('out[2] = 150 (mean(100,200))', out[2] as number, 150);
  expectClose('out[3] = 250 (mean(200,300))', out[3] as number, 250);
  expectClose('out[4] = 350 (mean(300,400))', out[4] as number, 350);
}
{
  // baselineDays=0 → 全 null
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 101, volume: 1100 },
  ];
  const out = compute60dAvgVolumes(bars, 0);
  assert('baselineDays=0 → 全 null', out.every(v => v === null));
}
{
  // baselineDays=-1 → 全 null
  const bars: SortedBar[] = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 101, volume: 1100 },
  ];
  const out = compute60dAvgVolumes(bars, -1);
  assert('baselineDays=-1 → 全 null', out.every(v => v === null));
}

console.log('\n## computeGradualBreakoutScore — 业务方向 4 象限');
{
  // 场景 1：价涨量增 → score 显著 > 0
  // 构造 70 个 bar：close 从 100 线性涨到 170，volume 从 1000 线性涨到 1700
  // baselineDays=60 → out[60..69] 才有 baseline；recentDays=10, minRecent=7
  const bars: SortedBar[] = [];
  for (let i = 0; i < 70; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 + i * 10 });
  }
  // 自定义 recentDays=10, baselineDays=60, minRecentDaysForValid=7, minObs=30
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 30);
  assert(
    '场景 1：价涨量增 → result 非 null',
    result !== null,
    JSON.stringify(result)
  );
  if (result) {
    assert(
      `场景 1：score > 0 (got ${result.score})`,
      result.score > 0
    );
    assert(
      `场景 1：positive_days = 10 (得 ${result.positive_days})`,
      result.positive_days === 10
    );
    assert(
      `场景 1：negative_days = 0 (得 ${result.negative_days})`,
      result.negative_days === 0
    );
    assert(
      `场景 1：flat_days = 0 (得 ${result.flat_days})`,
      result.flat_days === 0
    );
    assert(
      `场景 1：effective_days = 10 (得 ${result.effective_days})`,
      result.effective_days === 10
    );
  }
}
{
  // 场景 2：价涨量减 → 量价背离 → score < 0
  // 构造 70 个 bar：close 线性涨；前 60 高 volume=2000，后 10 低 volume=1000
  // 后 10 日（i=60..69）都是 sign=+1 但 vol/base < 1 → 贡献 = 负
  // 注意：baseline 是滑动窗口，从 i=61 开始 baseline 会被低 vol 拉低
  const bars: SortedBar[] = [];
  for (let i = 0; i < 60; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 2000 });
  }
  for (let i = 60; i < 70; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 });
  }
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 30);
  // 算 expected：对每个 k=0..9：baseline_k = (2000*(60-k) + 1000*k)/60
  // contribution_k = (1000 / baseline_k - 1) * (+1)
  let expectedScore = 0;
  for (let k = 0; k <= 9; k += 1) {
    const baseline = (2000 * (60 - k) + 1000 * k) / 60;
    expectedScore += 1000 / baseline - 1;
  }
  assert('场景 2：价涨量减 → result 非 null', result !== null);
  if (result) {
    assert(
      `场景 2：score < 0 (got ${result.score}) - 量价背离`,
      result.score < 0
    );
    expectClose(
      `场景 2：score 精确匹配滑动 baseline 算法`,
      result.score,
      expectedScore,
      1e-9
    );
    assert('场景 2：positive_days = 10', result.positive_days === 10);
  }
}
{
  // 场景 3：价跌量减 → 缩量调整不杀伤 → score > 0
  const bars: SortedBar[] = [];
  for (let i = 0; i < 60; i += 1) {
    bars.push({ time: i, close: 200 - i * 0.5, volume: 2000 });
  }
  // 前 60 日 close 从 200 跌到 200 - 59*0.5 = 170.5
  // 后 10 日 close 继续跌：close[60] = 170, 然后每天跌 1
  for (let i = 60; i < 70; i += 1) {
    bars.push({ time: i, close: 170 - (i - 59), volume: 1000 });
  }
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 30);
  // 算 expected：对每个 k=0..9：baseline_k = (2000*(60-k) + 1000*k)/60
  // contribution_k = (1000 / baseline_k - 1) * (-1)
  let expectedScore = 0;
  for (let k = 0; k <= 9; k += 1) {
    const baseline = (2000 * (60 - k) + 1000 * k) / 60;
    expectedScore += (1000 / baseline - 1) * -1;
  }
  assert('场景 3：价跌量减 → result 非 null', result !== null);
  if (result) {
    expectClose(
      `场景 3：score 精确匹配滑动 baseline 算法`,
      result.score,
      expectedScore,
      1e-9
    );
    assert(
      `场景 3：score > 0 (got ${result.score}) - 缩量调整加分`,
      result.score > 0
    );
    assert(
      `场景 3：negative_days = 10 (got ${result.negative_days})`,
      result.negative_days === 10
    );
    assert(
      `场景 3：positive_days = 0`,
      result.positive_days === 0
    );
  }
}
{
  // 场景 4：价跌量增 → 恐慌出货 → score < 0
  const bars: SortedBar[] = [];
  for (let i = 0; i < 60; i += 1) {
    bars.push({ time: i, close: 200 - i * 0.5, volume: 1000 });
  }
  for (let i = 60; i < 70; i += 1) {
    bars.push({ time: i, close: 170 - (i - 59), volume: 2000 });
  }
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 30);
  // 算 expected：对每个 k=0..9：baseline_k = (1000*(60-k) + 2000*k)/60
  // contribution_k = (2000 / baseline_k - 1) * (-1)
  let expectedScore = 0;
  for (let k = 0; k <= 9; k += 1) {
    const baseline = (1000 * (60 - k) + 2000 * k) / 60;
    expectedScore += (2000 / baseline - 1) * -1;
  }
  assert('场景 4：价跌量增 → result 非 null', result !== null);
  if (result) {
    expectClose(
      `场景 4：score 精确匹配滑动 baseline 算法`,
      result.score,
      expectedScore,
      1e-9
    );
    assert(
      `场景 4：score < 0 (got ${result.score}) - 恐慌出货`,
      result.score < 0
    );
    assert('场景 4：negative_days = 10', result.negative_days === 10);
  }
}
{
  // 场景 5：全平盘 → flat_days = 10, score = 0
  const bars: SortedBar[] = [];
  for (let i = 0; i < 70; i += 1) {
    bars.push({ time: i, close: 100, volume: 1000 });
  }
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 30);
  assert('场景 5：全平盘 → result 非 null', result !== null);
  if (result) {
    expectClose('场景 5：score = 0', result.score, 0);
    assert(`场景 5：flat_days = 10 (got ${result.flat_days})`, result.flat_days === 10);
    assert('场景 5：positive_days = 0', result.positive_days === 0);
    assert('场景 5：negative_days = 0', result.negative_days === 0);
  }
}

console.log('\n## computeGradualBreakoutScore — 数据卫生');
{
  // bars 不足 (< baselineDays+1) → null
  const bars: SortedBar[] = [];
  for (let i = 0; i < 10; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 });
  }
  const result = computeGradualBreakoutScore(bars, 5, 30, 3, 20);
  assert('bars 不足 baselineDays+1 → null', result === null);
}
{
  // recentDays=0 → null
  const bars: SortedBar[] = [];
  for (let i = 0; i < 70; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 + i });
  }
  assert(
    'recentDays=0 → null',
    computeGradualBreakoutScore(bars, 0, 60, 0, 30) === null
  );
  assert(
    'recentDays=-1 → null',
    computeGradualBreakoutScore(bars, -1, 60, 0, 30) === null
  );
  assert(
    'recentDays=3.5 非整数 → null',
    computeGradualBreakoutScore(bars, 3.5, 60, 0, 30) === null
  );
}
{
  // baselineDays=0 → null
  const bars: SortedBar[] = [];
  for (let i = 0; i < 70; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 });
  }
  assert(
    'baselineDays=0 → null',
    computeGradualBreakoutScore(bars, 10, 0, 7) === null
  );
}
{
  // minRecentDaysForValid=-1 → null
  const bars: SortedBar[] = [];
  for (let i = 0; i < 70; i += 1) {
    bars.push({ time: i, close: 100, volume: 1000 });
  }
  assert(
    'minRecentDaysForValid=-1 → null',
    computeGradualBreakoutScore(bars, 10, 60, -1, 30) === null
  );
}
{
  // effective_days < min → null
  // 构造 70 个 bar，但前 60 全是合规的，后 10 都让 baseline=null (通过 volume=0)
  // 不行：volume=0 在 extractSortedBars 已经过滤了。
  // 用另一种方式：让 minObs 抬得很高让 baseline 不可信
  const bars: SortedBar[] = [];
  for (let i = 0; i < 70; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 });
  }
  // baselineDays=60, minObs=100 → 永远不满足 → baselines 全 null →
  // effective_days = 0 < minRecent=7 → null
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 100);
  assert('minObs=100 让 baseline 全 null → null', result === null);
}
{
  // 中间停牌（volume=0）已被 extractSortedBars 滤掉
  // 这里直接测：raw bars 含 volume=0 → extractSortedBars 跳过
  const rows = [
    { time: 1, close: 100, volume: 1000 },
    { time: 2, close: 101, volume: 0 }, // 跳过
    { time: 3, close: 102, volume: 1100 },
  ];
  const bars = extractSortedBars(rows);
  assert('volume=0 被 extractSortedBars 跳过', bars.length === 2);
}
{
  // tail-index 测试：bars.length = 100，recentDays=10
  // baselines[40..99]（从 i=40 开始有 baseline，但 minObs 也得满足）
  // start = max(baselineDays=60, 100-10=90) = 90; end = 99 → recent 10 个 = [90..99]
  const bars: SortedBar[] = [];
  for (let i = 0; i < 100; i += 1) {
    bars.push({ time: i, close: 100 + i, volume: 1000 });
  }
  const result = computeGradualBreakoutScore(bars, 10, 60, 7, 30);
  assert('100 bar / recentDays=10 → 非 null', result !== null);
  if (result) {
    assert(
      `effective_days = 10 (got ${result.effective_days})`,
      result.effective_days === 10
    );
    // close 全部递增 1 → 都涨 → positive_days = 10
    assert(`positive_days = 10`, result.positive_days === 10);
    // baseline 不变（volume 全 1000）→ vol/base - 1 = 0 → score = 0
    expectClose('vol/base 恒等 → score = 0', result.score, 0);
  }
}

console.log('\n## Factor metadata + 注册');
assert('name = gradual_breakout', gradualBreakoutFactor.name === 'gradual_breakout');
assert('category = momentum', gradualBreakoutFactor.category === 'momentum');
assert(
  'description 非空',
  typeof gradualBreakoutFactor.description === 'string' &&
    gradualBreakoutFactor.description.length > 0
);
assert(
  'description 含 "30" 或 "60" 或 "价量" 关键词',
  gradualBreakoutFactor.description.includes('30') ||
    gradualBreakoutFactor.description.includes('60') ||
    gradualBreakoutFactor.description.includes('价量')
);
assert(
  'description 含 "放量" / "走强" / "渐进" 至少一个',
  gradualBreakoutFactor.description.includes('放量') ||
    gradualBreakoutFactor.description.includes('走强') ||
    gradualBreakoutFactor.description.includes('渐进')
);
assert('compute 是函数', typeof gradualBreakoutFactor.compute === 'function');
assert('已注册到全局 factorRegistry', factorRegistry.has('gradual_breakout'));
assert(
  '已纳入 listNames()',
  factorRegistry.listNames().includes('gradual_breakout')
);
assert(
  '从 registry get 拿回同一对象',
  factorRegistry.get('gradual_breakout') === gradualBreakoutFactor
);

console.log('\n## Signal-First 主线 16 因子完整');
{
  const expectedFactors = [
    'analyst_consensus',
    'dragon_tiger',
    'earnings_surprise',
    'fund_consensus',
    'gradual_breakout',
    'growth',
    'liquidity',
    'low_vol',
    'momentum',
    'momentum_reversal',
    'money_flow',
    'northbound',
    'quality',
    'quality_high',
    'industry_momentum',
    'value',
  ];
  for (const f of expectedFactors) {
    assert(`factor "${f}" 存在`, factorRegistry.has(f));
  }
  const allNames = factorRegistry.listNames();
  assert(
    `registry 至少含 ${expectedFactors.length} 个 expected factors (实际 ${allNames.length})`,
    expectedFactors.every(f => allNames.includes(f)),
    `names=[${allNames.sort().join(',')}]`
  );
}

console.log('\n## 空 universe 路径不爆');
(async () => {
  const result = await gradualBreakoutFactor.compute({
    as_of_date: '2026-06-07',
    universe: [],
  });
  assert('compute(universe=[]) → 空 Map (不走 DB)', result.size === 0);

  console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch(e => {
  console.error('TEST_RUNNER_ERROR:', e);
  process.exit(2);
});
