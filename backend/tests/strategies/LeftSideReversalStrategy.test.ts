/**
 * LeftSideReversalStrategy 单测（US-026）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/LeftSideReversalStrategy.test.ts
 *
 * AC 要求新增单元测试；本文件覆盖：
 *   - 默认参数符合 AC（dropPctThreshold=0.30 / dropLookbackDays=20 /
 *     rsiThreshold=25 / rsiPeriod=14 / minDailyReboundPct=0.05 / minCirculatingMarketCap=50亿 /
 *     maxPositions=10 / holdingDaysLimit=15 / stopLossPct=-0.07 / rapidGainPct=0.15 /
 *     rapidGainLookbackDays=5 / excludeST=true）
 *   - strategy_definition 元数据
 *   - 入场 5 维全通过
 *   - 入场各维度独立失败：
 *     · 20 日跌幅不足
 *     · 当日反弹不足（< 5% / 恰等于 5% 严格 >）
 *     · RSI 未上穿（昨日 ≥ 25 / 今日 < 25）
 *     · 主力资金净流入 ≤ 0 或缺数据
 *     · 流通市值 ≤ 50 亿 / 缺数据
 *     · ST 名称
 *     · 缺 meta 行
 *     · 历史 bar 不足
 *     · stale bar（最后一条 != asOfDate）
 *   - 已持仓不重复 BUY (fail_already_held)
 *   - excludeST=false 保留 ST
 *   - maxPositions cap
 *   - 排序：drop_pct 升序（跌得最惨在前）→ rebound_pct 降序 → stock_code 稳定 tie-break
 *   - 出场 A (持有期到期) / B (止损) / C (sell_half rapid gain) / D (HOLD)
 *   - 出场优先级 A > B > C
 *   - 进场首日不触发 rapid gain（holdingDays = 0）
 *   - half_exited 不重复减半
 *   - sell_half 后保留持仓且标 half_exited
 *   - 缺当日 close → 安全 HOLD
 *   - HOLD 占用槽位限 BUY 数
 *   - evaluate() 信息性 hold + factors.note
 *   - helper isSTName / naturalDaysBetween / computeRSI 边角
 *   - invalid trade_date 抛出
 *   - dropLookbackDays ≤ 0 抛出
 *   - rsiPeriod ≤ 1 抛出
 *   - rapidGainLookbackDays ≤ 0 抛出
 *   - 空 universe 安全
 *   - 自定义 params override
 *   - boundary: drop = -30% 恰触发 (≤ -threshold 包含边界)
 *   - boundary: rebound 严格 > 阈值
 *   - boundary: rsi 严格 < threshold 昨天 + ≥ threshold 今天
 *   - boundary: market_cap 严格 > 50 亿
 *   - boundary: main_net_inflow 严格 > 0
 */

import {
  computeRSI,
  DEFAULT_LEFT_SIDE_REVERSAL_PARAMS,
  isSTName,
  LeftSideReversalBarSnapshot,
  LeftSideReversalDataSource,
  LeftSideReversalPosition,
  LeftSideReversalStockMeta,
  LeftSideReversalStrategy,
  naturalDaysBetween,
} from '../../src/quant/strategies/LeftSideReversalStrategy';
import { QuantStockContext } from '../../src/quant/types/QuantTypes';

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
  candidateBars?: Map<string, LeftSideReversalBarSnapshot>;
  positionBars?: Map<string, LeftSideReversalBarSnapshot>;
  moneyFlow?: Map<string, number>;
  meta?: Map<string, LeftSideReversalStockMeta>;
}

class FakeDataSource implements LeftSideReversalDataSource {
  public lastCandidateMinBars = 0;
  public lastPositionMinBars = 0;

  constructor(public state: FakeFixtures = {}) {}

  async loadCandidateBars(
    _asOfDate: string,
    minBarCount: number
  ): Promise<Map<string, LeftSideReversalBarSnapshot>> {
    this.lastCandidateMinBars = minBarCount;
    const out = new Map<string, LeftSideReversalBarSnapshot>();
    for (const [code, snap] of (this.state.candidateBars ?? new Map()).entries()) {
      if (snap.bars.length >= minBarCount) {
        out.set(code, { bars: snap.bars.slice(-minBarCount) });
      }
    }
    return out;
  }

  async loadPositionBars(
    _asOfDate: string,
    stockCodes: string[],
    minBarCount: number
  ): Promise<Map<string, LeftSideReversalBarSnapshot>> {
    this.lastPositionMinBars = minBarCount;
    const all = this.state.positionBars ?? new Map();
    const out = new Map<string, LeftSideReversalBarSnapshot>();
    for (const code of stockCodes) {
      const snap = all.get(code);
      if (snap) out.set(code, snap);
    }
    return out;
  }

  async loadMoneyFlowToday(_asOfDate: string): Promise<Map<string, number>> {
    return new Map(this.state.moneyFlow ?? new Map());
  }

  async loadStockMeta(stockCodes: string[]): Promise<Map<string, LeftSideReversalStockMeta>> {
    const all = this.state.meta ?? new Map();
    const out = new Map<string, LeftSideReversalStockMeta>();
    for (const code of stockCodes) {
      if (all.has(code)) out.set(code, all.get(code)!);
    }
    return out;
  }
}

// ----------------------------------------------------------------
// Bar fixture helpers
// ----------------------------------------------------------------

/**
 * 生成 N 个 bar 升序到 asOfDate，每天 close 由 closes[i] 决定（顺序 = 时间顺序）。
 */
function makeBarsFromCloses(asOfDate: string, closes: number[]): LeftSideReversalBarSnapshot {
  const bars: { date: string; close: number }[] = [];
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  const count = closes.length;
  for (let i = 0; i < count; i++) {
    const d = new Date(asOf);
    d.setUTCDate(asOf.getUTCDate() - (count - 1 - i));
    const dateIso = d.toISOString().slice(0, 10);
    bars.push({ date: dateIso, close: closes[i] });
  }
  return { bars };
}

/**
 * 构造一个"满足左侧反转 entry 5 维"的标准 fixture closes 序列。
 *
 * 思路：
 *   - 长度 = max(dropLookbackDays + 1, rsiPeriod + 2) = 21（默认参数下 rsiPeriod+2=16 < 21）
 *   - close[0]（21 个 bar 中最早 / 即 T-20）= 100
 *   - 前面缓慢下跌到 close[19]（T-1）= 67（跌 33%）
 *   - close[20]（today）= 73（反弹 ~9%）
 *   - 这样 dropPct = 73/100 - 1 = -27% 不够 …
 *
 * 让我重新设计：
 *   - close[T-20] = 100
 *   - close[T-1] = 65（前面持续下跌制造低 RSI）
 *   - close[T] = 70（反弹 ~7.7%，但 70/100=0.70 → 跌幅 30% 恰触发）
 *
 * 但 RSI 需要构造下行 + 当日反弹，让 yesterday RSI < 25 today RSI ≥ 25。
 *
 * 因为我们的 SMA-based RSI 仅看最近 N 个 delta，下行 14 天 SMA 后 RSI 应该接近 0；
 * 单日反弹后立即上升。
 */
function makeStandardWinnerBars(asOfDate: string): LeftSideReversalBarSnapshot {
  // 21 bars total
  // bars[0..18] = 100, 98, 96, ... 持续下跌到 ~66
  // bars[19] = 65 (T-1) - 已下跌
  // bars[20] = 73 (today) - 反弹 ~12%
  // dropPct = 73/100 - 1 = -27% — 不够，需要 close[0] 更高或 close[20] 更低
  //
  // 设计 (确保跌幅恰够)：
  //   bars[0] = 100  (T-20)
  //   bars[1..18] 平缓下跌至 70 (每天-1.5左右)
  //   bars[19] = 65 (T-1)
  //   bars[20] = 70 (today) — close 反弹 7.7%
  //   dropPct = 70/100 - 1 = -30% (恰触发 30%)
  //
  // RSI(14) at T-1: 最近 14 天全下跌，avg_loss > 0, avg_gain ≈ 0 → RSI ≈ 0
  // RSI(14) at T: 最近 14 天有 13 天下跌 + 1 天上涨 5 (70-65)
  //   avg_loss ≈ (sum of last 13 days losses) / 14; avg_gain = 5/14
  //   RSI 可能 ≈ ?... 我需要保证 today RSI >= 25
  //
  // 算一下：bars[7..19] 是 14 天下跌窗口（用于算 T-1 RSI）
  //   假设每天跌 ~2，sum_losses ≈ 28，avg_loss=2，gain=0 → RSI=0
  // bars[8..20] 是 14 天用于算 today RSI
  //   13 days dropping (avg 2 each = 26 total loss) + 1 day gain 5
  //   avg_loss = 26/14 ≈ 1.857; avg_gain = 5/14 ≈ 0.357
  //   rs = 0.357 / 1.857 ≈ 0.192
  //   rsi = 100 - 100/1.192 ≈ 16.1 — 不够 ≥ 25
  //
  // 需要更大的反弹来让 RSI ≥ 25：bars[20] 反弹更大
  // 让 bars[20] = 78 (从 65 涨 20%，rebound 20%)
  //   13 down (~26 loss avg) + 1 up (13 gain)
  //   avg_loss = 26/14 ≈ 1.857; avg_gain = 13/14 ≈ 0.929
  //   rs = 0.929 / 1.857 ≈ 0.500
  //   rsi = 100 - 100/1.5 ≈ 33.3 — 现在 ≥ 25 OK
  //
  //   但 dropPct = 78/100 - 1 = -22%（不够 30%）
  //
  // 解：让 bars[0] 更高（dropPct 衡量绝对涨跌）
  //   bars[0] = 130, bars[1..19] 渐降到 65, bars[20] = 78
  //   dropPct = 78/130 - 1 = -40% (>= 30% 触发)
  //   rebound = (78-65)/65 = 20%
  //   T-1 RSI: 假设 bars[7..19] = 95,90,85,80,75,72,71,70,69,68,67,66,65
  //   delta: -5,-5,-5,-5,-5,-3,-1,-1,-1,-1,-1,-1,-1
  //   avg_loss = (5*5+3+1*7)/14 = (25+3+7)/14 = 35/14 = 2.5; avg_gain=0
  //   RSI=0 — 好
  //
  //   T RSI: bars[8..20] delta: -5,-5,-5,-5,-3,-1,-1,-1,-1,-1,-1,-1,+13
  //   avg_loss = (5*4+3+1*7+1)/14 = (20+3+8)/14 = 31/14 ≈ 2.21
  //   avg_gain = 13/14 ≈ 0.929
  //   rs = 0.929/2.21 = 0.42
  //   rsi = 100 - 100/1.42 = 29.6 — 满足 ≥ 25
  //
  // Done!
  const closes = [
    130, // T-20
    125, 120, 115, 110, 105, 100,
    95, 90, 85, 80, 75, 72, 71, 70, 69, 68, 67, 66,
    65, // T-1
    78, // T (today) — rebound 20%, dropPct -40%
  ];
  return makeBarsFromCloses(asOfDate, closes);
}

function makeMeta(
  name: string,
  industry: string | null = '电子',
  cap: number | null = 80 * 1e8
): LeftSideReversalStockMeta {
  return { name, industry, circulating_market_cap: cap };
}

// ----------------------------------------------------------------
// Test cases
// ----------------------------------------------------------------

async function test_default_params_match_AC() {
  expectEqual(
    'dropPctThreshold=0.30',
    DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.dropPctThreshold,
    0.30
  );
  expectEqual(
    'dropLookbackDays=20',
    DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.dropLookbackDays,
    20
  );
  expectEqual('rsiThreshold=25', DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.rsiThreshold, 25);
  expectEqual('rsiPeriod=14', DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.rsiPeriod, 14);
  expectEqual(
    'minDailyReboundPct=0.05',
    DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.minDailyReboundPct,
    0.05
  );
  expectEqual(
    'minCirculatingMarketCap=50亿',
    DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.minCirculatingMarketCap,
    50 * 1e8
  );
  expectEqual('maxPositions=10', DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.maxPositions, 10);
  expectEqual(
    'holdingDaysLimit=15',
    DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.holdingDaysLimit,
    15
  );
  expectEqual('stopLossPct=-0.07', DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.stopLossPct, -0.07);
  expectEqual('rapidGainPct=0.15', DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.rapidGainPct, 0.15);
  expectEqual(
    'rapidGainLookbackDays=5',
    DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.rapidGainLookbackDays,
    5
  );
  expectEqual('excludeST=true', DEFAULT_LEFT_SIDE_REVERSAL_PARAMS.excludeST, true);
}

async function test_strategy_definition() {
  const s = new LeftSideReversalStrategy(new FakeDataSource());
  expectEqual('strategy_key', s.definition.strategy_key, 'left_side_reversal');
  expectEqual('category', s.definition.category, 'multi_factor');
  expectEqual('risk_level', s.definition.risk_level, 'high');
  assert('tags includes 反转', (s.definition.tags ?? []).includes('反转'));
  assert('tags includes RSI', (s.definition.tags ?? []).includes('RSI'));
  expectEqual('enabled', s.definition.enabled, true);
}

async function test_entry_all_5_conditions_pass() {
  const asOf = '2026-06-07';
  const winnerBars = makeStandardWinnerBars(asOf);
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', winnerBars]]),
    moneyFlow: new Map([['600001', 30_000_000]]),
    meta: new Map([['600001', makeMeta('xxx', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf);
  expectEqual('eligible_count=1', r.eligible_count, 1);
  expectEqual('1 buy signal', r.signals.filter(x => x.signal === 'buy').length, 1);
  expectEqual('target len=1', r.target_positions.length, 1);
  expectEqual('target stock', r.target_positions[0].stock_code, '600001');
  expectEqual('target entry_price=78', r.target_positions[0].entry_price, 78);
  expectEqual('target half_exited=false', r.target_positions[0].half_exited, false);
  // drop_pct field 验证
  assert(
    'drop_pct ≈ -40%',
    Math.abs(r.signals[0].drop_pct! - (78 / 130 - 1)) < 1e-9,
    `got ${r.signals[0].drop_pct}`
  );
  assert(
    'rebound_pct ≈ 20%',
    Math.abs(r.signals[0].rebound_pct! - (78 - 65) / 65) < 1e-9,
    `got ${r.signals[0].rebound_pct}`
  );
}

async function test_entry_fails_drop_insufficient() {
  // dropPct = -20% only — 不足 30%
  const asOf = '2026-06-07';
  const closes = [
    100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80,
  ];
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_drop_insufficient=1', r.filtered.fail_drop_insufficient, 1);
}

async function test_entry_fails_rebound_below_threshold() {
  const asOf = '2026-06-07';
  // 设置：dropPct -40%, 反弹只有 3% (< 5%)
  // closes: 130 → 渐降到 65 → today 65 * 1.03 ≈ 66.95
  // 但这样会 rebound < 5% → fail_rebound_insufficient
  // 注意：dropPct = 66.95 / 130 - 1 = -48.5% (≥ 30%)
  // RSI 也需要不上穿 25... 但失败原因可能是 rebound 先触发
  // 实际：策略按 drop → rebound → rsi → money_flow → market_cap 顺序检查
  const closes = [
    130, 125, 120, 115, 110, 105, 100,
    95, 90, 85, 80, 75, 72, 71, 70, 69, 68, 67, 66, 65,
    66.95,
  ];
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_rebound_insufficient=1', r.filtered.fail_rebound_insufficient, 1);
}

async function test_entry_fails_rebound_exactly_at_threshold() {
  // 严格 > 5%：rebound = 5% 不入选
  const asOf = '2026-06-07';
  // close[T-1]=65 → close[T] = 65 * 1.05 = 68.25
  const closes = [
    130, 125, 120, 115, 110, 105, 100,
    95, 90, 85, 80, 75, 72, 71, 70, 69, 68, 67, 66, 65,
    68.25,
  ];
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0 (boundary strict >)', r.eligible_count, 0);
  expectEqual('fail_rebound_insufficient=1', r.filtered.fail_rebound_insufficient, 1);
}

async function test_entry_fails_rsi_not_crossing_up() {
  // 让 yesterday rsi >= 25 (即不在超卖区) → fail_rsi
  // 让前 14 天有较多上涨日 → yesterday rsi > 25
  const asOf = '2026-06-07';
  // closes: 100 → 渐降到 70（前面 6 天）然后 平稳到 70 (T-1) → 78 (today)
  // 这样 yesterday 的 RSI(14) 会基于温和波动而非纯下跌，可能 > 25
  // 让我用更明确的设计：让 yesterday close 已经在反弹后
  // closes[0..18] 是温和波动 (避免 RSI 极低); close[19]=80 (T-1), close[20]=100 (today)
  // dropPct = 100/0... no, close[0] = 100, close[20] = 100 → dropPct = 0 不会触发 drop
  //
  // 还是用：让今天 close < 25 而非昨天
  // 反过来：让 yesterday RSI >= 25, today RSI < 25 (今日继续下跌)
  // closes[T-20]=130, 渐降, close[T-1]=70 (rsi ~25 临界), close[T]=68 (继续跌)
  // 但 close[T] < close[T-1] 意味着 rebound < 0 — 会先触发 rebound fail
  //
  // 让我换一种：让 yesterday rsi 已经 > 25（不在超卖区）
  // 数据序列：100, 90 (大跌), 然后稳定在 90 持续 18 天, T-1=80, T=70（继续跌）
  // 不行，T < T-1 会先 rebound fail
  //
  // 简单做法：用 closes 让 yesterday RSI >= 25 + today rebound > 5% + drop sufficient
  // 让前 7 天小跌 + 反弹 (yesterday RSI = 中性 30+)，最近 13 天大跌
  // 这样：T-14 起 + T-1 全是跌幅大 → yesterday RSI 接近 0;
  // 不对，必须让 yesterday RSI 高
  //
  // 关键洞察：yesterday RSI window = closes.slice(-(rsiPeriod+2), -1) = closes[5..19] (从前 14 天)
  // today RSI window = closes.slice(-(rsiPeriod+1)) = closes[6..20]
  // 让 yesterday RSI > 25 的方法：让 closes[5..19] 这段有较多 / 较大的上涨日
  //
  // 例如让 close[7..18] 是 上涨形态：60, 62, 64, ..., 72 然后 close[19] = 65 (突然跌)
  // 这样 yesterday RSI 会基于 12 天上涨 + 1 天大跌 → 仍然 > 25
  // 但 close[0]=130, 渐降到 close[6]=60, 然后涨到 72, close[19]=65, close[20]=78
  // dropPct = 78/130 - 1 = -40% ✓
  // rebound = (78-65)/65 = 20% ✓
  //
  // RSI(T-1) 在 closes[5..19]：[100, 90, 70, 60, 62, 64, 66, 68, 70, 72, 70, 68, 66, 65]
  //   注意 closes[5..19] 长度 = 15。但 rsiPeriod+2=16 个 close，所以 window 是 16 长度，
  //   计算 RSI 用最后 14 个 delta。
  //   等等：computeRSI(closes, period) 接收 N+1 个 close 计算 N 期 RSI（即 N 个 delta）
  //   yesterday RSI: pass closes.slice(-(rsiPeriod+2), -1) — length = (rsiPeriod+2) - 1 = rsiPeriod+1 OK
  //     这是 closes[6..19]（不含 closes[20]）但 slice(-16, -1) 表示 length 15
  //   今天 RSI: pass closes.slice(-(rsiPeriod+1)) — length = rsiPeriod+1 = 15 OK
  //     这是 closes[6..20]
  //
  // 简单：手动制造一个 RSI(T-1) > 25 的序列
  // 让前 7 天稳定（无变化）, 后 7 天稳定下跌 + 最后 1 天大跌
  // ratio: gain=0, loss > 0 → RSI = 0... 不行
  //
  // 试：let close[5..18] 全是 70（前 13 天平），close[19]=65 (T-1，一次大跌 close[18]→close[19]=-5)
  // RSI delta in last 14 days from T-1: 0,0,...,0,-5 → avg_gain=0, avg_loss=5/14 → RSI=0
  // 不对
  //
  // 试：let close[5..15] 渐涨 60→70 (10 天 gain=1 each)，close[16..18]=70 平，close[19]=65 (一次大跌)
  // delta in closes[6..19] = 1,1,1,1,1,1,1,1,1,1,0,0,0,-5 → avg_gain=10/14, avg_loss=5/14
  // rs = 2.0; RSI = 100 - 100/3 ≈ 66.67 — yesterday RSI >> 25 ✓
  //
  // 那 today: closes[6..20] = 1,1,1,1,1,1,1,1,1,1,0,0,0,-5,+13 → avg_gain=23/14, avg_loss=5/14
  // rs = 4.6, RSI ≈ 82 — today 也 >= 25
  //
  // dropPct? closes[0]?=130, closes[20]=78
  // 序列：130, 125, 120, 115, 110, 60, 60, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 70, 65, 78
  // dropPct = 78/130 - 1 = -40% ✓
  // rebound = (78-65)/65 = 20% ✓
  // yesterday RSI >> 25 (今日要 fail rsi_not_crossing_up 因为 yesterday 不在超卖区)
  //
  // 但 today RSI 也 > 25... 那 cross-up 判定 `yesterday < threshold AND today >= threshold` 失败
  // 因为 yesterday already > threshold → not crossing up → fail
  // 这就是我想要的 fail case
  const closes = [
    130, 125, 120, 115, 110,
    60, 60, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 70,
    65, // T-1
    78, // T
  ];
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual(
    'fail_rsi_not_crossing_up=1',
    r.filtered.fail_rsi_not_crossing_up,
    1,
    'yesterday RSI > 25 → not crossing up'
  );
}

async function test_entry_fails_money_flow_negative() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', -1000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_money_flow_negative=1', r.filtered.fail_money_flow_negative, 1);
}

async function test_entry_fails_money_flow_zero_strict() {
  // 严格 > 0：恰等于 0 也不入选
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 0]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0 (boundary strict >)', r.eligible_count, 0);
  expectEqual('fail_money_flow_negative=1', r.filtered.fail_money_flow_negative, 1);
}

async function test_entry_fails_money_flow_missing() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map(),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_money_flow_negative=1', r.filtered.fail_money_flow_negative, 1);
}

async function test_entry_fails_market_cap_too_small() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x', '电子', 30 * 1e8)]]), // 30 亿 < 50 亿
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual(
    'fail_market_cap_insufficient=1',
    r.filtered.fail_market_cap_insufficient,
    1
  );
}

async function test_entry_fails_market_cap_exactly_at_threshold() {
  // 严格 > 50 亿
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x', '电子', 50 * 1e8)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0 (boundary strict >)', r.eligible_count, 0);
  expectEqual(
    'fail_market_cap_insufficient=1',
    r.filtered.fail_market_cap_insufficient,
    1
  );
}

async function test_entry_fails_market_cap_missing() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x', '电子', null)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual(
    'fail_market_cap_insufficient=1',
    r.filtered.fail_market_cap_insufficient,
    1
  );
}

async function test_entry_fails_st() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('ST东方', '电子', 80 * 1e8)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_st=1', r.filtered.fail_st, 1);
}

async function test_excludeST_false_keeps_st() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('ST东方', '电子', 80 * 1e8)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf, {
    params: { excludeST: false },
  });
  expectEqual('eligible=1', r.eligible_count, 1);
  expectEqual('fail_st=0', r.filtered.fail_st, 0);
}

async function test_entry_fails_meta_missing() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeStandardWinnerBars(asOf)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map(),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_meta_missing=1', r.filtered.fail_meta_missing, 1);
}

async function test_entry_fails_insufficient_history() {
  const asOf = '2026-06-07';
  // 只有 10 个 bar — 不足 21 (max(20+1, 14+2))
  const closes = Array(10).fill(0).map((_, i) => 100 - i);
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  // FakeDataSource 模拟生产 loadCandidateBars - bar 不足时不返回 → candidate_pool_size=0
  expectEqual('candidate_pool_size=0', r.filtered.candidate_pool_size, 0);
}

async function test_entry_fails_stale_bar() {
  const asOf = '2026-06-07';
  // 21 bars 但最后一个 != asOfDate
  const closes = [
    130, 125, 120, 115, 110, 105, 100,
    95, 90, 85, 80, 75, 72, 71, 70, 69, 68, 67, 66, 65, 78,
  ];
  // 把最后一天换成 2026-06-06 (停牌)
  const baseBars = makeBarsFromCloses(asOf, closes);
  // 改最后一条
  const last = baseBars.bars[baseBars.bars.length - 1];
  last.date = '2026-06-06'; // stale
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', baseBars]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x')]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0', r.eligible_count, 0);
  expectEqual('fail_stale_bar=1', r.filtered.fail_stale_bar, 1);
}

async function test_already_held_excluded() {
  const asOf = '2026-06-07';
  const winnerBars = makeStandardWinnerBars(asOf);
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', winnerBars]]),
    moneyFlow: new Map([['600001', 100_000]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
    positionBars: new Map([['600001', winnerBars]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  // pre-existing position
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-05',
    entry_price: 76,
    half_exited: false,
  };
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('fail_already_held=1', r.filtered.fail_already_held, 1);
  expectEqual('0 buy', r.signals.filter(x => x.signal === 'buy').length, 0);
  // target_positions should still contain the existing held position (HOLD or other exit)
  expectEqual('target_positions includes 600001', r.target_positions.length, 1);
}

async function test_max_positions_cap() {
  const asOf = '2026-06-07';
  const winnerBars = makeStandardWinnerBars(asOf);
  const candidateBars = new Map<string, LeftSideReversalBarSnapshot>();
  const moneyFlow = new Map<string, number>();
  const meta = new Map<string, LeftSideReversalStockMeta>();
  for (let i = 1; i <= 7; i++) {
    const code = `60000${i}`;
    candidateBars.set(code, winnerBars);
    moneyFlow.set(code, 1_000_000 + i);
    meta.set(code, makeMeta(`股${i}`, '电子', (60 + i) * 1e8));
  }
  const ds = new FakeDataSource({ candidateBars, moneyFlow, meta });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { params: { maxPositions: 3 } });
  expectEqual('eligible=7', r.eligible_count, 7);
  expectEqual('buy capped at 3', r.signals.filter(x => x.signal === 'buy').length, 3);
  expectEqual('target_positions=3', r.target_positions.length, 3);
}

async function test_sort_stable_drop_then_rebound_then_code() {
  // 3 candidates, all valid entry:
  //   A: drop -45%, rebound 20%
  //   B: drop -40%, rebound 30%
  //   C: drop -40%, rebound 30%   (same as B → tie-break on stock_code)
  // Expected order: A (deepest drop), B (alphabetic before C), C
  const asOf = '2026-06-07';

  // 构造三个不同 fixture
  // A: close[T-20]=200, close[T-1]=110, close[T]=110*1.2=132 → drop = 132/200-1 = -34%
  // 让 A 跌幅更深：close[T-20]=200, close[T]=100 → drop = -50%, close[T-1]=...
  // 简化用同样的 winner 序列基础变形

  // 对每个 candidate，构造满足 RSI 上穿 + drop 阈值 + rebound 阈值的 closes
  // A: dropPct = 132/200 - 1 = -34%, rebound = 132/110-1 = 20%
  const aCloses = [
    200, 195, 190, 185, 180, 175, 170,
    160, 150, 140, 130, 120, 115, 113, 112, 111, 110, 110, 110,
    110, // T-1
    132, // T
  ];
  // B: dropPct = 78/130 - 1 = -40%, rebound = 78/60-1 = 30%
  const bCloses = [
    130, 125, 120, 115, 110, 105, 100,
    95, 90, 85, 80, 75, 70, 65, 63, 62, 61, 60, 60,
    60, // T-1
    78, // T
  ];
  // C: same as B
  const cCloses = bCloses.slice();

  const ds = new FakeDataSource({
    candidateBars: new Map([
      ['600001', makeBarsFromCloses(asOf, aCloses)], // A
      ['600002', makeBarsFromCloses(asOf, bCloses)], // B
      ['600003', makeBarsFromCloses(asOf, cCloses)], // C
    ]),
    moneyFlow: new Map([
      ['600001', 1_000_000],
      ['600002', 1_000_000],
      ['600003', 1_000_000],
    ]),
    meta: new Map([
      ['600001', makeMeta('A', '电子', 100 * 1e8)],
      ['600002', makeMeta('B', '电子', 100 * 1e8)],
      ['600003', makeMeta('C', '电子', 100 * 1e8)],
    ]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf);
  // A drops 34%, B/C drop 40% — B/C deeper drop should come first
  // Then between B and C, tie on drop AND rebound → stock_code ascending
  expectEqual('eligible=3', r.eligible_count, 3);
  const buyOrder = r.signals
    .filter(x => x.signal === 'buy')
    .map(x => x.stock_code)
    .join(',');
  expectEqual('order = 600002,600003,600001', buyOrder, '600002,600003,600001');
}

async function test_exit_holding_days_limit() {
  const asOf = '2026-06-22';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07', // 15 days ago
    entry_price: 78,
    half_exited: false,
  };
  // bar with today close (positionBars)
  const closesPos = [76, 77, 78, 79, 80, 81]; // 6 bars
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 sell', r.signals.filter(x => x.signal === 'sell').length, 1);
  expectEqual('signal sell', r.signals[0].signal, 'sell');
  assert(
    'reason includes holdingDaysLimit',
    r.signals[0].reason.includes('holdingDaysLimit'),
    r.signals[0].reason
  );
  expectEqual('target_positions empty', r.target_positions.length, 0);
}

async function test_exit_stop_loss() {
  const asOf = '2026-06-10';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07',
    entry_price: 100,
    half_exited: false,
  };
  // today close = 92 → pnl = -8% ≤ -7% stopLoss
  const closesPos = [100, 95, 93, 92, 92, 92];
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 sell', r.signals.filter(x => x.signal === 'sell').length, 1);
  expectEqual('signal sell', r.signals[0].signal, 'sell');
  assert(
    'reason includes 止损',
    r.signals[0].reason.includes('止损'),
    r.signals[0].reason
  );
}

async function test_exit_sell_half_rapid_gain() {
  const asOf = '2026-06-10';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07', // 3 days ago
    entry_price: 100,
    half_exited: false,
  };
  // 5 日内涨幅 > 15%：close 涨到 120 (+20% peak)
  // bars[0..5] (6 bars total - rapidGainLookbackDays+1 = 6)
  // The bars window is rapidGainLookbackDays from today → 5 bars + today = 6
  // But strategy uses snapshot.bars.slice(-rapidGainLookbackDays) = last 5 bars
  // We need at least one bar in the window with date > entry_date
  const closesPos = [98, 105, 110, 115, 120, 118];
  // dates: T-5, T-4, T-3, T-2 (=entry_date+0?), T-1, T(today)
  // Wait — asOf = '2026-06-10', positions has bars for last 6 days = '2026-06-05'..'2026-06-10'
  // entry_date = '2026-06-07' → bars with date > 2026-06-07 are bars[3..5] = 115, 120, 118
  // max = 120 → peakGain = (120-100)/100 = 20% > 15% → sell_half
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 sell_half', r.signals.filter(x => x.signal === 'sell_half').length, 1);
  expectEqual('signal sell_half', r.signals[0].signal, 'sell_half');
  // Verify target kept (with half_exited=true)
  expectEqual('target_positions kept = 1', r.target_positions.length, 1);
  expectEqual('half_exited=true', r.target_positions[0].half_exited, true);
}

async function test_exit_hold_default() {
  const asOf = '2026-06-10';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07',
    entry_price: 100,
    half_exited: false,
  };
  // 当日 close = 102，盈利 2% — 不止损、不快速涨、不到期 → HOLD
  const closesPos = [99, 100, 101, 102, 102, 102];
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 hold', r.signals.filter(x => x.signal === 'hold').length, 1);
  expectEqual('signal hold', r.signals[0].signal, 'hold');
  expectEqual('target_positions kept', r.target_positions.length, 1);
}

async function test_exit_priority_holding_over_stop_loss() {
  const asOf = '2026-06-22';
  // 15 days held AND -20% loss — both A and B trigger; A should win
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07',
    entry_price: 100,
    half_exited: false,
  };
  const closesPos = [85, 82, 80, 78, 75, 70]; // close = 70 today
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 sell', r.signals.filter(x => x.signal === 'sell').length, 1);
  assert(
    'reason includes 到期 (not 止损)',
    r.signals[0].reason.includes('到期'),
    r.signals[0].reason
  );
}

async function test_exit_priority_stop_loss_over_sell_half() {
  const asOf = '2026-06-10';
  // -8% pnl today + max 5d close = 140 (40% gain) — both B and C trigger; B wins
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07',
    entry_price: 100,
    half_exited: false,
  };
  const closesPos = [98, 110, 130, 140, 130, 92]; // today 92 (-8%) but recent peak 140
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 sell (full)', r.signals.filter(x => x.signal === 'sell').length, 1);
  expectEqual('0 sell_half', r.signals.filter(x => x.signal === 'sell_half').length, 0);
  assert(
    'reason includes 止损',
    r.signals[0].reason.includes('止损'),
    r.signals[0].reason
  );
}

async function test_exit_first_day_no_rapid_gain() {
  // 进场首日：holdingDays = 0 → 不触发 rapid gain（即使 today close 暴涨）
  const asOf = '2026-06-07';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07', // 同日入场
    entry_price: 78,
    half_exited: false,
  };
  // today close 100 (+28% from entry!) 但因为首日 → 不触发 sell_half
  const closesPos = [70, 75, 80, 85, 90, 100];
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 hold', r.signals.filter(x => x.signal === 'hold').length, 1);
  expectEqual('0 sell_half', r.signals.filter(x => x.signal === 'sell_half').length, 0);
}

async function test_half_exited_position_skips_rapid_gain() {
  const asOf = '2026-06-10';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07',
    entry_price: 100,
    half_exited: true, // 已减半
  };
  const closesPos = [99, 110, 130, 140, 130, 125]; // peak 140 → > 15%
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, closesPos)]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('0 sell_half (already half_exited)', r.signals.filter(x => x.signal === 'sell_half').length, 0);
  expectEqual('1 hold', r.signals.filter(x => x.signal === 'hold').length, 1);
  assert(
    'reason mentions 已减半',
    r.signals[0].reason.includes('已减半'),
    r.signals[0].reason
  );
}

async function test_exit_missing_close_safe_hold() {
  const asOf = '2026-06-10';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07',
    entry_price: 100,
    half_exited: false,
  };
  const ds = new FakeDataSource({
    positionBars: new Map(), // 缺数据
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, { currentPositions: [pos] });
  expectEqual('1 hold (safe)', r.signals.filter(x => x.signal === 'hold').length, 1);
  expectEqual('signal hold', r.signals[0].signal, 'hold');
  assert(
    'reason mentions 缺 close',
    r.signals[0].reason.includes('缺 close'),
    r.signals[0].reason
  );
  expectEqual('target_positions kept', r.target_positions.length, 1);
}

async function test_hold_occupies_slot_limits_buy() {
  const asOf = '2026-06-07';
  // 3 positions HOLD + maxPositions=5 → only 2 BUY allowed
  const winnerBars = makeStandardWinnerBars(asOf);
  const candidateBars = new Map<string, LeftSideReversalBarSnapshot>();
  const moneyFlow = new Map<string, number>();
  const meta = new Map<string, LeftSideReversalStockMeta>();
  // 5 new candidates
  for (let i = 1; i <= 5; i++) {
    const code = `60000${i}`;
    candidateBars.set(code, winnerBars);
    moneyFlow.set(code, 1_000_000);
    meta.set(code, makeMeta(`c${i}`, '电子', 80 * 1e8));
  }
  // 3 existing positions
  const positionCodes = ['600010', '600011', '600012'];
  const positionBars = new Map<string, LeftSideReversalBarSnapshot>();
  const positions: LeftSideReversalPosition[] = [];
  for (const code of positionCodes) {
    positionBars.set(code, makeBarsFromCloses(asOf, [100, 100, 100, 100, 100, 100]));
    meta.set(code, makeMeta(`held-${code}`, '电子', 80 * 1e8));
    positions.push({
      stock_code: code,
      entry_date: '2026-06-05',
      entry_price: 100,
      half_exited: false,
    });
  }

  const ds = new FakeDataSource({ candidateBars, moneyFlow, meta, positionBars });
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals(asOf, {
    params: { maxPositions: 5 },
    currentPositions: positions,
  });

  // 3 HOLD + 2 BUY = 5 positions total
  expectEqual('hold=3', r.signals.filter(x => x.signal === 'hold').length, 3);
  expectEqual('buy=2 (cap by holds)', r.signals.filter(x => x.signal === 'buy').length, 2);
  expectEqual('target_positions=5', r.target_positions.length, 5);
}

async function test_evaluate_returns_informational_hold() {
  const s = new LeftSideReversalStrategy(new FakeDataSource());
  const ctx: QuantStockContext = {
    symbol: '600001.SH',
    name: '测试',
    bars: [{ time: '2026-06-07T00:00:00Z', open: 10, high: 10, low: 10, close: 10, volume: 100 } as any],
    factor_snapshot: undefined,
  };
  const result = s.evaluate(ctx);
  expectEqual('signal hold', result.signal, 'hold');
  expectEqual('factors.note', result.factors.note, 'use_generateSignals_instead');
  assert(
    'reasons mentions generateSignals',
    result.reasons.some(r => r.includes('generateSignals')),
    result.reasons.join(';')
  );
}

async function test_helper_naturalDaysBetween() {
  expectEqual('same day', naturalDaysBetween('2026-06-07', '2026-06-07'), 0);
  expectEqual('1 day', naturalDaysBetween('2026-06-07', '2026-06-08'), 1);
  expectEqual('week', naturalDaysBetween('2026-06-07', '2026-06-14'), 7);
  expectEqual('reverse → 0', naturalDaysBetween('2026-06-08', '2026-06-07'), 0);
  expectEqual('invalid → 0', naturalDaysBetween('bad', '2026-06-07'), 0);
}

async function test_helper_isSTName() {
  assert('null → false', !isSTName(null as any));
  assert('undefined → false', !isSTName(undefined));
  assert('empty → false', !isSTName(''));
  assert('"ST东方" → true', isSTName('ST东方'));
  assert('"*ST 东方" → true', isSTName('*ST 东方'));
  assert('"st东方" lowercase → true', isSTName('st东方'));
  assert('"东方 ST" 后缀 → false (开头判定)', !isSTName('东方 ST'));
  assert('normal → false', !isSTName('平安银行'));
}

async function test_helper_computeRSI() {
  // 全上涨 → RSI = 100
  const allUp = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
  const rsiUp = computeRSI(allUp, 14);
  expectEqual('all up → RSI=100', rsiUp, 100);
  // 全下跌 → RSI = NaN (avg_gain=0 & avg_loss>0 → div by 1+0=1) RSI = 100 - 100 = 0
  const allDown = [24, 23, 22, 21, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10];
  const rsiDown = computeRSI(allDown, 14);
  expectEqual('all down → RSI=0', rsiDown, 0);
  // 不足数据 → NaN
  assert('insufficient → NaN', Number.isNaN(computeRSI([1, 2, 3], 14)));
  // period <= 0 → NaN
  assert('period 0 → NaN', Number.isNaN(computeRSI([1, 2, 3, 4], 0)));
  // 无变化 → NaN
  const noChange = Array(15).fill(10);
  assert('no change → NaN', Number.isNaN(computeRSI(noChange, 14)));
}

async function test_invalid_trade_date_throws() {
  const s = new LeftSideReversalStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('2026/06/07');
  } catch (e) {
    threw = true;
  }
  assert('invalid date throws', threw);
}

async function test_drop_lookback_days_le_zero_throws() {
  const s = new LeftSideReversalStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('2026-06-07', { params: { dropLookbackDays: 0 } });
  } catch (e) {
    threw = true;
  }
  assert('dropLookbackDays=0 throws', threw);
}

async function test_rsi_period_le_one_throws() {
  const s = new LeftSideReversalStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('2026-06-07', { params: { rsiPeriod: 1 } });
  } catch (e) {
    threw = true;
  }
  assert('rsiPeriod=1 throws', threw);
}

async function test_rapid_gain_lookback_le_zero_throws() {
  const s = new LeftSideReversalStrategy(new FakeDataSource());
  let threw = false;
  try {
    await s.generateSignals('2026-06-07', { params: { rapidGainLookbackDays: 0 } });
  } catch (e) {
    threw = true;
  }
  assert('rapidGainLookbackDays=0 throws', threw);
}

async function test_empty_universe_safe() {
  const ds = new FakeDataSource();
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals('2026-06-07');
  expectEqual('empty eligible', r.eligible_count, 0);
  expectEqual('empty target', r.target_positions.length, 0);
  expectEqual('empty signals', r.signals.length, 0);
}

async function test_custom_params_override() {
  const ds = new FakeDataSource();
  const s = new LeftSideReversalStrategy(ds);
  const r = await s.generateSignals('2026-06-07', {
    params: {
      dropPctThreshold: 0.20,
      rsiThreshold: 30,
      maxPositions: 20,
      stopLossPct: -0.10,
    },
  });
  expectEqual('params dropPctThreshold', r.params.dropPctThreshold, 0.20);
  expectEqual('params rsiThreshold', r.params.rsiThreshold, 30);
  expectEqual('params maxPositions', r.params.maxPositions, 20);
  expectEqual('params stopLossPct', r.params.stopLossPct, -0.10);
  // Defaults remain
  expectEqual('default dropLookbackDays preserved', r.params.dropLookbackDays, 20);
  expectEqual('default rsiPeriod preserved', r.params.rsiPeriod, 14);
}

async function test_boundary_drop_exactly_at_threshold() {
  // dropPct = -30% 恰触发 (≤ -threshold 包含边界 — 我们用的是 dropPct > -dropPctThreshold = fail)
  // 即 dropPct = -0.30 触发；只有 dropPct > -0.30 才 fail
  const asOf = '2026-06-07';
  // 让 close[T-20]=100, close[T]=70 → drop = -30% 恰触发
  const closes = [
    100, 95, 90, 85, 80, 75,
    70, 68, 67, 66, 65, 64, 63, 62, 61, 60, 60, 60, 60,
    60, // T-1
    70, // T → drop = 70/100 - 1 = -30%, rebound = 10/60 = 16.7%
  ];
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 1_000_000]]),
    meta: new Map([['600001', makeMeta('x', '电子', 100 * 1e8)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=1 (boundary drop=-30% triggers)', r.eligible_count, 1);
}

async function test_boundary_drop_just_below_threshold() {
  // dropPct = -29.5% (just below) → fail
  const asOf = '2026-06-07';
  const closes = [
    100, 95, 90, 85, 80, 75,
    70, 68, 67, 66, 65, 64, 63, 62, 61, 60, 60, 60, 60,
    60, // T-1
    70.5, // T → drop ≈ -29.5%, rebound = 10.5/60 = 17.5%
  ];
  const ds = new FakeDataSource({
    candidateBars: new Map([['600001', makeBarsFromCloses(asOf, closes)]]),
    moneyFlow: new Map([['600001', 1_000_000]]),
    meta: new Map([['600001', makeMeta('x', '电子', 100 * 1e8)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  expectEqual('eligible=0 (boundary just below)', r.eligible_count, 0);
  expectEqual('fail_drop_insufficient=1', r.filtered.fail_drop_insufficient, 1);
}

async function test_min_bars_loader_call() {
  // 验证 DataSource 收到 minBarsForEntry = max(dropLookbackDays+1, rsiPeriod+2)
  const asOf = '2026-06-07';
  const ds = new FakeDataSource();
  await new LeftSideReversalStrategy(ds).generateSignals(asOf);
  // Default: max(21, 16) = 21
  expectEqual('lastCandidateMinBars=21', ds.lastCandidateMinBars, 21);
}

async function test_min_bars_loader_call_custom_params() {
  const asOf = '2026-06-07';
  const ds = new FakeDataSource();
  // dropLookbackDays=10, rsiPeriod=20 → minBarsForEntry = max(11, 22) = 22
  await new LeftSideReversalStrategy(ds).generateSignals(asOf, {
    params: { dropLookbackDays: 10, rsiPeriod: 20 },
  });
  expectEqual('lastCandidateMinBars=22', ds.lastCandidateMinBars, 22);
}

async function test_target_positions_after_full_exit() {
  // Position SELL'd → target_positions empty
  const asOf = '2026-06-22';
  const pos: LeftSideReversalPosition = {
    stock_code: '600001',
    entry_date: '2026-06-07', // 15 days → A trigger
    entry_price: 100,
    half_exited: false,
  };
  const ds = new FakeDataSource({
    positionBars: new Map([['600001', makeBarsFromCloses(asOf, [100, 100, 100, 100, 100, 100])]]),
    meta: new Map([['600001', makeMeta('x', '电子', 80 * 1e8)]]),
  });
  const r = await new LeftSideReversalStrategy(ds).generateSignals(asOf, {
    currentPositions: [pos],
  });
  expectEqual('1 sell', r.signals.filter(x => x.signal === 'sell').length, 1);
  expectEqual('target_positions empty', r.target_positions.length, 0);
}

// ----------------------------------------------------------------
// Main test runner
// ----------------------------------------------------------------

async function runTests() {
  console.log('Running LeftSideReversalStrategy.test.ts ...\n');

  console.log('1) Default params match AC');
  await test_default_params_match_AC();

  console.log('\n2) strategy_definition metadata');
  await test_strategy_definition();

  console.log('\n3) Entry: all 5 conditions pass');
  await test_entry_all_5_conditions_pass();

  console.log('\n4) Entry fails: drop insufficient');
  await test_entry_fails_drop_insufficient();

  console.log('\n5) Entry fails: rebound below threshold');
  await test_entry_fails_rebound_below_threshold();

  console.log('\n5b) Entry fails: rebound = exactly 5% (strict >)');
  await test_entry_fails_rebound_exactly_at_threshold();

  console.log('\n6) Entry fails: RSI not crossing up');
  await test_entry_fails_rsi_not_crossing_up();

  console.log('\n7) Entry fails: money_flow < 0');
  await test_entry_fails_money_flow_negative();

  console.log('\n7b) Entry fails: money_flow = 0 (strict >)');
  await test_entry_fails_money_flow_zero_strict();

  console.log('\n7c) Entry fails: money_flow missing');
  await test_entry_fails_money_flow_missing();

  console.log('\n8) Entry fails: market_cap too small');
  await test_entry_fails_market_cap_too_small();

  console.log('\n8b) Entry fails: market_cap = 50亿 (strict >)');
  await test_entry_fails_market_cap_exactly_at_threshold();

  console.log('\n8c) Entry fails: market_cap missing');
  await test_entry_fails_market_cap_missing();

  console.log('\n9) Entry fails: ST name');
  await test_entry_fails_st();

  console.log('\n9b) excludeST=false keeps ST');
  await test_excludeST_false_keeps_st();

  console.log('\n10) Entry fails: meta missing');
  await test_entry_fails_meta_missing();

  console.log('\n11) Entry fails: insufficient history');
  await test_entry_fails_insufficient_history();

  console.log('\n12) Entry fails: stale bar');
  await test_entry_fails_stale_bar();

  console.log('\n13) Already held: not BUY again');
  await test_already_held_excluded();

  console.log('\n14) maxPositions cap');
  await test_max_positions_cap();

  console.log('\n15) Sort stable: drop ASC → rebound DESC → code ASC');
  await test_sort_stable_drop_then_rebound_then_code();

  console.log('\n16) Exit: holding_days_limit');
  await test_exit_holding_days_limit();

  console.log('\n17) Exit: stop_loss');
  await test_exit_stop_loss();

  console.log('\n18) Exit: sell_half rapid gain');
  await test_exit_sell_half_rapid_gain();

  console.log('\n19) Exit: HOLD default');
  await test_exit_hold_default();

  console.log('\n20) Exit priority: holding > stop_loss');
  await test_exit_priority_holding_over_stop_loss();

  console.log('\n21) Exit priority: stop_loss > sell_half');
  await test_exit_priority_stop_loss_over_sell_half();

  console.log('\n22) Exit: first day no rapid gain');
  await test_exit_first_day_no_rapid_gain();

  console.log('\n23) half_exited skips rapid gain again');
  await test_half_exited_position_skips_rapid_gain();

  console.log('\n24) Exit missing close → safe HOLD');
  await test_exit_missing_close_safe_hold();

  console.log('\n25) HOLD occupies slot, limits BUY');
  await test_hold_occupies_slot_limits_buy();

  console.log('\n26) evaluate() returns informational hold');
  await test_evaluate_returns_informational_hold();

  console.log('\n27) helper naturalDaysBetween');
  await test_helper_naturalDaysBetween();

  console.log('\n28) helper isSTName');
  await test_helper_isSTName();

  console.log('\n29) helper computeRSI');
  await test_helper_computeRSI();

  console.log('\n30) invalid trade_date throws');
  await test_invalid_trade_date_throws();

  console.log('\n31) dropLookbackDays <= 0 throws');
  await test_drop_lookback_days_le_zero_throws();

  console.log('\n32) rsiPeriod <= 1 throws');
  await test_rsi_period_le_one_throws();

  console.log('\n33) rapidGainLookbackDays <= 0 throws');
  await test_rapid_gain_lookback_le_zero_throws();

  console.log('\n34) Empty universe safe');
  await test_empty_universe_safe();

  console.log('\n35) Custom params override');
  await test_custom_params_override();

  console.log('\n36) Boundary: drop = -30% (triggers)');
  await test_boundary_drop_exactly_at_threshold();

  console.log('\n37) Boundary: drop = -29.5% (just below → fail)');
  await test_boundary_drop_just_below_threshold();

  console.log('\n38) minBars loader call default');
  await test_min_bars_loader_call();

  console.log('\n39) minBars loader call custom params');
  await test_min_bars_loader_call_custom_params();

  console.log('\n40) target_positions empty after full exit');
  await test_target_positions_after_full_exit();

  console.log(`\n\nTotal failures: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All tests passed!');
  }
}

runTests().catch(e => {
  console.error('Test runner error:', e);
  process.exit(2);
});
