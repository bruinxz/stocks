/**
 * _historicalMarketCap.ts 单元测试 (BD-2 raw_payload fallback).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/factors/historicalMarketCap.test.ts
 *
 * 覆盖纯函数 extractMcapFromPayload 的 path priority + 数据卫生.
 * 不覆盖 loadHistoricalCirculatingMarketCap (需要 Sequelize, 与其他 factor 单测
 * 一致 — 仅断言纯函数, 不走 DB).
 */

import { extractMcapFromPayload } from '../../src/quant/factors/library/_historicalMarketCap';

let passed = 0;
let failed = 0;

function expectEqual<T>(label: string, actual: T, expected: T) {
  if (actual === expected) {
    console.log(`  ok  ${label}`);
    passed += 1;
  } else {
    console.log(`  FAIL ${label} (got ${String(actual)}, expected ${String(expected)})`);
    failed += 1;
  }
}

console.log('## extractMcapFromPayload — 数据卫生');
expectEqual('null → null', extractMcapFromPayload(null), null);
expectEqual('undefined → null', extractMcapFromPayload(undefined), null);
expectEqual('空对象 → null', extractMcapFromPayload({}), null);
expectEqual('字符串 → null (非对象)', extractMcapFromPayload('not obj'), null);
expectEqual('数字 → null (非对象)', extractMcapFromPayload(123), null);

console.log('\n## extractMcapFromPayload — 路径优先级');
// Path 1: snapshot.circulating_market_cap (EastMoney 当前)
expectEqual(
  'snapshot.circulating_market_cap 优先',
  extractMcapFromPayload({
    snapshot: { circulating_market_cap: 1.23e10 },
    circulating_market_cap: 999, // 顶层不该被选
  }),
  1.23e10
);
// Path 2: 顶层 circulating_market_cap (snapshot 缺时)
expectEqual(
  '顶层 circulating_market_cap (snapshot 缺)',
  extractMcapFromPayload({ circulating_market_cap: 9.87e9 }),
  9.87e9
);
// Path 3: snapshot.total_market_cap (流通缺时退总市值)
expectEqual(
  'snapshot.total_market_cap 兜底',
  extractMcapFromPayload({
    snapshot: { total_market_cap: 5.0e9, name: '某股' },
  }),
  5.0e9
);
// Path 4: 顶层 total_market_cap
expectEqual(
  '顶层 total_market_cap 末位兜底',
  extractMcapFromPayload({ total_market_cap: 3.0e9 }),
  3.0e9
);

console.log('\n## extractMcapFromPayload — 数值过滤');
expectEqual(
  '0 跳过, 走下一路径',
  extractMcapFromPayload({
    snapshot: { circulating_market_cap: 0 },
    circulating_market_cap: 100,
  }),
  100
);
expectEqual(
  '负数跳过',
  extractMcapFromPayload({
    snapshot: { circulating_market_cap: -50 },
    circulating_market_cap: 200,
  }),
  200
);
expectEqual(
  'NaN 跳过',
  extractMcapFromPayload({
    snapshot: { circulating_market_cap: NaN },
    total_market_cap: 300,
  }),
  300
);
expectEqual(
  'Infinity 跳过',
  extractMcapFromPayload({
    snapshot: { circulating_market_cap: Infinity },
    total_market_cap: 400,
  }),
  400
);

console.log('\n## extractMcapFromPayload — 字符串转 Number');
expectEqual(
  '"1.5e10" string → 1.5e10',
  extractMcapFromPayload({ snapshot: { circulating_market_cap: '1.5e10' } }),
  1.5e10
);
expectEqual(
  '"not-a-number" → null',
  extractMcapFromPayload({ snapshot: { circulating_market_cap: 'not-a-number' } }),
  null
);

console.log('\n## extractMcapFromPayload — 真实 prod payload sample');
const realPayload = {
  provider: 'eastmoney',
  snapshot: {
    pb: 5.13,
    low: 20.15,
    roe: -2.11,
    name: '华胜天成',
    symbol: 'sh.600410',
    total_share: 1096494683,
    gross_margin: 34.31,
    payload_mode: 'stock_get',
    current_price: 20.15,
    turnover_rate: 0.37,
    change_percent: -1.13,
    previous_close: 20.38,
    main_net_inflow: 1,
    total_market_cap: 22094367862.449997,
    circulating_share: 1096494683,
    circulating_market_cap: 22094367862.449997,
  },
  source_note: 'EastMoney free quote snapshot',
};
expectEqual(
  '真实 EastMoney sh.600410 payload → 22094367862.45',
  extractMcapFromPayload(realPayload),
  22094367862.449997
);

console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
