/**
 * IntradayMomentumDetector 单测 (PR-M2 2026-06-29).
 *
 * 跑: npx ts-node --transpile-only tests/services/intraday-momentum-detector.test.ts
 *
 * 覆盖: pure helpers + classifyMomentumSignal + dedupKeyFor + formatMomentumMessage
 * + runOnce: buy → 全 user / sell → 仅持仓 / dedup / dry_run / 守卫 / fail-OPEN.
 */

import {
  MOMENTUM_BUY_THRESHOLD_PCT,
  MOMENTUM_SELL_THRESHOLD_PCT,
  RULE_ID_BUY,
  RULE_ID_SELL,
  DEDUP_HOURS,
  computeR1,
  classifyMomentumSignal,
  dedupKeyFor,
  formatMomentumMessage,
  todayTradeDate,
  IntradayMomentumDataSource,
  SymbolKline930And1000,
  IntradayMomentumDetector,
} from '../../src/services/IntradayMomentumDetector';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass++;
    // eslint-disable-next-line no-console
    console.log(`  PASS ${label}`);
  } else {
    fail++;
    // eslint-disable-next-line no-console
    console.log(`  FAIL ${label}`);
  }
}
function equal<T>(label: string, actual: T, expected: T): void {
  check(`${label} (expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)})`, actual === expected);
}

(async () => {
  // 常量
  equal('BUY_THRESHOLD=1', MOMENTUM_BUY_THRESHOLD_PCT, 1.0);
  equal('SELL_THRESHOLD=-1', MOMENTUM_SELL_THRESHOLD_PCT, -1.0);
  equal('RULE_ID_BUY', RULE_ID_BUY, 'intraday_momentum_buy');
  equal('RULE_ID_SELL', RULE_ID_SELL, 'intraday_momentum_sell');
  equal('DEDUP_HOURS=24', DEDUP_HOURS, 24);

  // computeR1
  equal('computeR1 100→101 = +1%', computeR1({ close_9_30: 100, close_10_00: 101 }), 1);
  equal('computeR1 100→99 = -1%', computeR1({ close_9_30: 100, close_10_00: 99 }), -1);
  equal('computeR1 null/0 → null', computeR1({ close_9_30: null, close_10_00: 100 }), null);
  equal('computeR1 0 → null (div by zero)', computeR1({ close_9_30: 0, close_10_00: 100 }), null);

  // classifyMomentumSignal
  equal('r1>+1 buy (no pos)', classifyMomentumSignal({ r1_pct: 2, is_position: false }), 'buy');
  equal('r1>+1 buy (with pos)', classifyMomentumSignal({ r1_pct: 2, is_position: true }), 'buy');
  equal('r1<-1 + pos → sell', classifyMomentumSignal({ r1_pct: -2, is_position: true }), 'sell');
  equal('r1<-1 no pos → none', classifyMomentumSignal({ r1_pct: -2, is_position: false }), 'none');
  equal('r1=0 → none', classifyMomentumSignal({ r1_pct: 0, is_position: true }), 'none');
  equal('r1=+1 (边界) → none', classifyMomentumSignal({ r1_pct: 1, is_position: false }), 'none');
  equal('r1=-1 (边界) + pos → none', classifyMomentumSignal({ r1_pct: -1, is_position: true }), 'none');
  equal('r1=null → none', classifyMomentumSignal({ r1_pct: null, is_position: true }), 'none');
  equal('r1=NaN → none', classifyMomentumSignal({ r1_pct: NaN, is_position: true }), 'none');

  // dedupKeyFor
  equal('dedupKey format', dedupKeyFor('rule_X', 'sh.600519', '2026-06-29'), 'rule_X::sh.600519::2026-06-29');

  // formatMomentumMessage
  const msg = formatMomentumMessage({
    symbol: 'sh.600519',
    name: '贵州茅台',
    r1_pct: 2.5,
    signal: 'buy',
    trade_date: '2026-06-29',
  });
  check('msg 含 14:30 加仓', msg.includes('建议 14:30 加仓'));
  check('msg 含 dedup_key', msg.includes('[dedup_key:intraday_momentum_buy::sh.600519::2026-06-29]'));
  check('msg 含名字', msg.includes('贵州茅台'));
  const msgSell = formatMomentumMessage({
    symbol: 'sz.000001',
    name: '平安银行',
    r1_pct: -2.0,
    signal: 'sell',
    trade_date: '2026-06-29',
  });
  check('sell msg 含 14:30 减仓', msgSell.includes('建议 14:30 减仓 (T+1)'));

  // todayTradeDate
  const after = new Date('2026-06-29T06:30:00Z'); // 14:30 Shanghai
  equal('todayTradeDate 2026-06-29', todayTradeDate(after), '2026-06-29');

  // ---------------- runOnce ----------------
  // fake DS: 3 symbols, A r1=+2% (buy), B r1=-2% (sell, 持仓), C r1=-2% (none, 无持仓)
  const fakeDs: IntradayMomentumDataSource = {
    async loadUniverseSymbols() {
      return ['sh.A', 'sh.B', 'sh.C'];
    },
    async loadOpeningKlines(symbols, _td): Promise<SymbolKline930And1000[]> {
      const map: Record<string, [number, number]> = {
        'sh.A': [100, 102],
        'sh.B': [100, 98],
        'sh.C': [100, 98],
      };
      return symbols.map(s => ({
        symbol: s,
        close_9_30: map[s]?.[0] ?? null,
        close_10_00: map[s]?.[1] ?? null,
      }));
    },
    async loadPositionsByUser() {
      const m = new Map<number, Set<string>>();
      m.set(1, new Set(['sh.B'])); // user 1 holds B
      return m;
    },
    async listActiveUserIds() {
      return [1, 2];
    },
    async loadRecentDedupKeys() {
      return new Set<string>();
    },
    async writeRiskAlerts(input) {
      return { created_ids: input.user_ids.map(u => u + 1000), failed: 0 };
    },
    async loadStockNames(symbols) {
      const m = new Map<string, string>();
      for (const s of symbols) m.set(s, `name-${s}`);
      return m;
    },
  };

  const svc = new IntradayMomentumDetector(fakeDs);
  let res = await svc.runOnce({ now: after, force: true, dry_run: false });
  equal('scanned=3', res.scanned, 3);
  equal('matched_buy=1 (A)', res.matched_buy, 1);
  equal('matched_sell=1 (B 持仓)', res.matched_sell, 1);
  // buy A → 2 users; sell B → 1 user; C 不触发
  equal('written=3 (2 buy + 1 sell)', res.written_alerts, 3);
  equal('skipped null', res.skipped_reason, null);

  // dry_run 不写
  res = await svc.runOnce({ now: after, force: true, dry_run: true });
  equal('dry written=0', res.written_alerts, 0);
  equal('dry matched_buy=1', res.matched_buy, 1);
  equal('dry matched_sell=1', res.matched_sell, 1);

  // dedup
  const dedupedDs: IntradayMomentumDataSource = {
    ...fakeDs,
    async loadRecentDedupKeys() {
      return new Set([
        dedupKeyFor(RULE_ID_BUY, 'sh.A', todayTradeDate(after)),
      ]);
    },
  };
  res = await new IntradayMomentumDetector(dedupedDs).runOnce({
    now: after,
    force: true,
  });
  equal('dedup buy skipped', res.deduped, 1);
  equal('dedup written = 0 buy + 1 sell = 1', res.written_alerts, 1);

  // empty universe
  const emptyDs: IntradayMomentumDataSource = {
    ...fakeDs,
    async loadUniverseSymbols() {
      return [];
    },
  };
  res = await new IntradayMomentumDetector(emptyDs).runOnce({
    now: after,
    force: true,
  });
  equal('empty universe', res.skipped_reason, 'empty_universe');

  // kline loader throws → still works, just no signals
  const klineThrowDs: IntradayMomentumDataSource = {
    ...fakeDs,
    async loadOpeningKlines() {
      throw new Error('kline boom');
    },
  };
  res = await new IntradayMomentumDetector(klineThrowDs).runOnce({
    now: after,
    force: true,
  });
  check('kline throw → errors contains', res.errors.some(e => e.includes('kline')));
  equal('kline throw → written=0', res.written_alerts, 0);

  // explicit symbols
  res = await new IntradayMomentumDetector(fakeDs).runOnce({
    now: after,
    force: true,
    symbols: ['sh.A'],
    dry_run: true,
  });
  equal('explicit symbols scanned=1', res.scanned, 1);
  equal('explicit buy=1', res.matched_buy, 1);

  // eslint-disable-next-line no-console
  console.log(`\n========= IntradayMomentumDetector tests: ${pass} pass, ${fail} fail =========`);
  if (fail > 0) process.exit(1);
})();
