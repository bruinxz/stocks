/**
 * _tradingDayWindow — unit tests (audit M-9 修复).
 *
 *   cd backend && npx ts-node --transpile-only tests/quant/factors/tradingDayWindow.test.ts
 *
 * 覆盖维度:
 *   - happy path: 跨春节 (假设 2026-02-09 ~ 2026-02-15 闭市) 取近 5 交易日,
 *     窗口起始日不是 7 自然日前而是真实 5 交易日起点;
 *   - 单日 / 数据缺失 / 极小 N / N > 可得交易日 等边界;
 *   - tradingDayLookbackStartDate 与 previousNTradingDays 行为一致.
 *
 * 注入 fake DataService.getTradingDays 完全脱 DB.
 */

import assert from 'node:assert/strict';
import {
  previousNTradingDays,
  tradingDayLookbackStartDate,
  _setDataServiceForTest,
} from '../../../src/quant/factors/library/_tradingDayWindow';

let failed = 0;
let passed = 0;

async function it(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    failed += 1;
  }
}

function makeFakeService(tradingDaysIso: string[]) {
  return {
    async getTradingDays(_start: Date, end: Date): Promise<Date[]> {
      // 返回 ≤ end 的全部 (转 Date), 模拟 daily_bars distinct trade_dates
      const endIso = end.toISOString().slice(0, 10);
      return tradingDaysIso
        .filter(d => d <= endIso)
        .map(d => new Date(`${d}T00:00:00Z`));
    },
  } as any;
}

async function main() {
  console.log('_tradingDayWindow');

  await it('跨春节: 11 个交易日里取近 5, 起始日 = 倒数第 5 个交易日', async () => {
    // 模拟 2026-02-02 ~ 2026-02-20, 春节 02-09..02-15 全闭市
    const tradingDays = [
      '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06',  // T-9..T-5 (周一 ~ 周五)
      // 2026-02-09..02-15 闭市
      '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',  // 节后 5 个交易日
    ];
    _setDataServiceForTest(makeFakeService(tradingDays));
    const dates = await previousNTradingDays('2026-02-20', 5);
    // 近 5 个交易日 = 节后 02-16 ~ 02-20 (完整跨过春节但因 N=5 落在节后窗内)
    assert.deepStrictEqual(dates, ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20']);
    assert.equal(dates[0], '2026-02-16');
    _setDataServiceForTest(null);
  });

  await it('跨春节: 取近 10 个交易日, 起始日跨节日窗口到 02-02', async () => {
    // 与上面同 fixture 但 N=10 → 起始 02-02 (倒数第 10 个), 验证跨节日窗口不丢日
    const tradingDays = [
      '2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06',
      '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
    ];
    _setDataServiceForTest(makeFakeService(tradingDays));
    const dates = await previousNTradingDays('2026-02-20', 10);
    assert.deepStrictEqual(dates, tradingDays);
    // 业务方向: 真实交易日历下取 N=10, 起点 02-02 (=10 个交易日前),
    // 不是按 14 自然日前算的 02-06 — helper 真的"跳过"了春节闭市天.
    assert.equal(dates[0], '2026-02-02');
    _setDataServiceForTest(null);
  });

  await it('单日: N=1 仅返回 as_of 自身 (含端点)', async () => {
    _setDataServiceForTest(makeFakeService(['2026-06-18']));
    const dates = await previousNTradingDays('2026-06-18', 1);
    assert.deepStrictEqual(dates, ['2026-06-18']);
    _setDataServiceForTest(null);
  });

  await it('N > 可得交易日: 取全部 (兜底)', async () => {
    _setDataServiceForTest(makeFakeService(['2026-06-17', '2026-06-18']));
    const dates = await previousNTradingDays('2026-06-18', 10);
    assert.deepStrictEqual(dates, ['2026-06-17', '2026-06-18']);
    _setDataServiceForTest(null);
  });

  await it('数据完全空: 返回 [] (业务方向: 让因子 fallback)', async () => {
    _setDataServiceForTest(makeFakeService([]));
    const dates = await previousNTradingDays('2026-06-18', 5);
    assert.deepStrictEqual(dates, []);
    _setDataServiceForTest(null);
  });

  await it('as_of 之后的日期被剔除', async () => {
    _setDataServiceForTest(makeFakeService(['2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20']));
    const dates = await previousNTradingDays('2026-06-18', 5);
    assert.deepStrictEqual(dates, ['2026-06-17', '2026-06-18']);
    _setDataServiceForTest(null);
  });

  await it('tradingDayLookbackStartDate: 返回 dates[0]', async () => {
    _setDataServiceForTest(makeFakeService(['2026-02-02', '2026-02-03', '2026-02-04', '2026-02-05', '2026-02-06', '2026-02-16']));
    const start = await tradingDayLookbackStartDate('2026-02-16', 5);
    assert.equal(start, '2026-02-03'); // 倒数 5 个: Feb 3, 4, 5, 6, 16
    _setDataServiceForTest(null);
  });

  await it('tradingDayLookbackStartDate 兜底: 数据缺失返回 as_of 自身', async () => {
    _setDataServiceForTest(makeFakeService([]));
    const start = await tradingDayLookbackStartDate('2026-06-18', 5);
    assert.equal(start, '2026-06-18');
    _setDataServiceForTest(null);
  });

  await it('非法 n (≤ 0 / NaN) 返回 []', async () => {
    _setDataServiceForTest(makeFakeService(['2026-06-18']));
    assert.deepStrictEqual(await previousNTradingDays('2026-06-18', 0), []);
    assert.deepStrictEqual(await previousNTradingDays('2026-06-18', -1), []);
    assert.deepStrictEqual(await previousNTradingDays('2026-06-18', NaN as any), []);
    _setDataServiceForTest(null);
  });

  await it('非法 as_of 返回 []', async () => {
    _setDataServiceForTest(makeFakeService(['2026-06-18']));
    assert.deepStrictEqual(await previousNTradingDays('', 5), []);
    assert.deepStrictEqual(await previousNTradingDays('not-a-date', 5), []);
    _setDataServiceForTest(null);
  });

  console.log(`\n_tradingDayWindow: ${passed} ok / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
