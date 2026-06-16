/**
 * checkAShareTradingHours 单元测试 (2026-06-16 盘前下单 bug 后新增)
 *
 * 不依赖 DB / jest, 直接 node 跑:
 *   cd backend && npx ts-node --transpile-only tests/utils/tradingCalendar-hours.test.ts
 *
 * 覆盖维度:
 *   - 交易时段 (09:30 / 11:30 边界 / 13:00 / 15:00 边界)
 *   - 非交易时段 (集合竞价 / 午休 / 收盘后 / 早晨 / 周末 / 节假日)
 */
import { checkAShareTradingHours, isAShareTradeDay } from '../../src/utils/tradingCalendar';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

// 构造一个 "2026-06-16 (周二, 非节假日) HH:MM:SS Asia/Shanghai" 的 Date.
// 用 ISO 字符串 +08:00 让结果 stable, 跟 host 时区无关.
function shanghaiDate(yyyymmdd: string, hhmm: string): Date {
  return new Date(`${yyyymmdd}T${hhmm}:00+08:00`);
}

// 2026-06-16 是周二, 非节假日 (端午 6.19-6.21 不在 16)
assert(isAShareTradeDay(shanghaiDate('2026-06-16', '10:00')), '2026-06-16 应该是交易日');

// ----- 交易时段 (allowed=true) -----
assert(
  checkAShareTradingHours(shanghaiDate('2026-06-16', '09:30')).allowed === true,
  '09:30 应该允许 (上午开盘边界)'
);
assert(
  checkAShareTradingHours(shanghaiDate('2026-06-16', '11:29')).allowed === true,
  '11:29 应该允许 (午前 1 分钟)'
);
assert(
  checkAShareTradingHours(shanghaiDate('2026-06-16', '13:00')).allowed === true,
  '13:00 应该允许 (下午开盘边界)'
);
assert(
  checkAShareTradingHours(shanghaiDate('2026-06-16', '14:59')).allowed === true,
  '14:59 应该允许 (收盘前 1 分钟)'
);

// ----- 非交易时段 (allowed=false) -----
const earlyMorning = checkAShareTradingHours(shanghaiDate('2026-06-16', '08:59'));
assert(
  earlyMorning.allowed === false && earlyMorning.code === 'NON_TRADING_HOURS_EARLY_MORNING',
  '08:59 应该拒绝 (尚未开盘)'
);

const preOpen = checkAShareTradingHours(shanghaiDate('2026-06-16', '09:20'));
assert(
  preOpen.allowed === false && preOpen.code === 'NON_TRADING_HOURS_PRE_OPEN',
  '09:20 应该拒绝 (集合竞价时段 — bug 现场!)'
);

const preOpen2 = checkAShareTradingHours(shanghaiDate('2026-06-16', '09:29'));
assert(
  preOpen2.allowed === false && preOpen2.code === 'NON_TRADING_HOURS_PRE_OPEN',
  '09:29 应该拒绝 (开盘前 1 分钟)'
);

const lunch = checkAShareTradingHours(shanghaiDate('2026-06-16', '12:00'));
assert(
  lunch.allowed === false && lunch.code === 'NON_TRADING_HOURS_LUNCH',
  '12:00 应该拒绝 (午休时段)'
);

const lunchBoundary1 = checkAShareTradingHours(shanghaiDate('2026-06-16', '11:30'));
assert(
  lunchBoundary1.allowed === false && lunchBoundary1.code === 'NON_TRADING_HOURS_LUNCH',
  '11:30 应该拒绝 (上午收盘恰好 11:30, 进入午休)'
);

const lunchBoundary2 = checkAShareTradingHours(shanghaiDate('2026-06-16', '12:59'));
assert(
  lunchBoundary2.allowed === false && lunchBoundary2.code === 'NON_TRADING_HOURS_LUNCH',
  '12:59 应该拒绝 (午休最后 1 分钟)'
);

const afterClose = checkAShareTradingHours(shanghaiDate('2026-06-16', '15:00'));
assert(
  afterClose.allowed === false && afterClose.code === 'NON_TRADING_HOURS_AFTER_CLOSE',
  '15:00 应该拒绝 (收盘恰好)'
);

const afterClose2 = checkAShareTradingHours(shanghaiDate('2026-06-16', '15:32'));
assert(
  afterClose2.allowed === false && afterClose2.code === 'NON_TRADING_HOURS_AFTER_CLOSE',
  '15:32 应该拒绝 (15:32 量化扫描时段, 不该下单)'
);

// ----- 周末 (allowed=false, code=HOLIDAY) -----
// 2026-06-14 是周日
const sunday = checkAShareTradingHours(shanghaiDate('2026-06-14', '11:35'));
assert(
  sunday.allowed === false && sunday.code === 'NON_TRADING_HOURS_HOLIDAY',
  '周日 11:35 应该拒绝 (周末 — bug 现场: 2026-06-15 11:35 周日下单!)'
);

// 2026-06-13 是周六
const saturday = checkAShareTradingHours(shanghaiDate('2026-06-13', '10:00'));
assert(
  saturday.allowed === false && saturday.code === 'NON_TRADING_HOURS_HOLIDAY',
  '周六 10:00 应该拒绝 (周末)'
);

// ----- 节假日 (端午 2026-06-19 是周五但放假) -----
const holiday = checkAShareTradingHours(shanghaiDate('2026-06-19', '10:00'));
assert(
  holiday.allowed === false && holiday.code === 'NON_TRADING_HOURS_HOLIDAY',
  '端午节 (2026-06-19 周五) 应该拒绝 (节假日)'
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) {
  console.error(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join('\n')}`);
  process.exit(1);
} else {
  console.log('✓ all checkAShareTradingHours boundary tests passed.');
  process.exit(0);
}
