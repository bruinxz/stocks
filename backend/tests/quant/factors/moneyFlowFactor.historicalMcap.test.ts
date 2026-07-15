/**
 * MoneyFlowFactor historical market cap — unit tests (audit M-8 修复).
 *
 *   cd backend && npx ts-node --transpile-only tests/quant/factors/moneyFlowFactor.historicalMcap.test.ts
 *
 * 验证 loadHistoricalCirculatingMarketCap helper:
 *   - 优先用 StockValuationFactor (有 factor_date), 取最新 ≤ as_of 的;
 *   - 兜底用 Stock.circulating_market_cap;
 *   - 缺失数据的股票不入 Map (走 Pipeline 中性补全).
 *
 * 注入方式: monkey-patch StockValuationFactor.findAll + Stock.findAll, 测完恢复.
 * 这与 ShareholderConcentrationFactor 等既有 factor 测试 (脱 DB) 同款模式.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

// 在 import factor 前先 monkey-patch 模型 (因为 factor 文件可能在 import 时绑定 ref)
import { StockValuationFactor } from '../../../src/models/StockValuationFactor';
import { Stock } from '../../../src/models/Stock';
import { loadHistoricalCirculatingMarketCap } from '../../../src/quant/factors/library/_historicalMarketCap';

const _origValFindAll = (StockValuationFactor as any).findAll;
const _origStockFindAll = (Stock as any).findAll;

function patchValFindAll(rows: any[]) {
  (StockValuationFactor as any).findAll = async () => rows;
}
function patchStockFindAll(rows: any[]) {
  (Stock as any).findAll = async () => rows;
}
function restore() {
  (StockValuationFactor as any).findAll = _origValFindAll;
  (Stock as any).findAll = _origStockFindAll;
}

async function main() {
  console.log('loadHistoricalCirculatingMarketCap (audit M-8)');

  await it('MoneyFlowFactor 使用共享历史市值 loader，不再走永久空 Map stub', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../src/quant/factors/library/MoneyFlowFactor.ts'),
      'utf8'
    );
    assert.match(
      source,
      /import\s+\{\s*loadHistoricalCirculatingMarketCap\s*\}\s+from\s+['"]\.\/_historicalMarketCap['"]/,
      'MoneyFlowFactor must import the PIT-aware shared loader'
    );
    assert.doesNotMatch(
      source,
      /loadHistoricalCirculatingMarketCap\s*=.*new Map/,
      'MoneyFlowFactor must not silently replace the loader with an empty stub'
    );
  });

  await it('happy: 用 valuation factor 取 as_of 当时市值, 不用最新 snapshot', async () => {
    // 模拟: 600519 在 2020-01 的市值 5000 亿, 但 Stock 表最新 snapshot 25000 亿
    patchValFindAll([
      { symbol: 'sh.600519', factor_date: '2020-01-15', circulating_market_cap: 5_000_000_000_000 },
      { symbol: 'sh.600519', factor_date: '2020-01-10', circulating_market_cap: 4_900_000_000_000 },
    ]);
    patchStockFindAll([]); // 不需要兜底
    const map = await loadHistoricalCirculatingMarketCap(['600519'], '2020-01-20');
    assert.equal(map.size, 1);
    // 关键断言: 拿到的是 2020-01-15 当时的 5000 亿, 不是 Stock 表的 25000 亿
    assert.equal(map.get('600519'), 5_000_000_000_000);
    restore();
  });

  await it('valuation 表为空 → 兜底 Stock 表 (旧行为兼容)', async () => {
    patchValFindAll([]);
    patchStockFindAll([
      { symbol: 'sh.600519', circulating_market_cap: 25_000_000_000_000 },
    ]);
    const map = await loadHistoricalCirculatingMarketCap(['600519'], '2020-01-20');
    assert.equal(map.get('600519'), 25_000_000_000_000);
    restore();
  });

  await it('valuation 抛错 → 仍走兜底, 不阻塞', async () => {
    (StockValuationFactor as any).findAll = async () => {
      throw new Error('db down');
    };
    patchStockFindAll([{ symbol: 'sh.600519', circulating_market_cap: 100 }]);
    const map = await loadHistoricalCirculatingMarketCap(['600519'], '2020-01-20');
    assert.equal(map.get('600519'), 100);
    restore();
  });

  await it('两套都缺 → 返回空 Map (该股不入 → Pipeline 中性补全)', async () => {
    patchValFindAll([]);
    patchStockFindAll([]);
    const map = await loadHistoricalCirculatingMarketCap(['600519'], '2020-01-20');
    assert.equal(map.size, 0);
    restore();
  });

  await it('mcap ≤ 0 / NaN / null 行被剔除', async () => {
    patchValFindAll([
      { symbol: 'sh.600519', factor_date: '2020-01-15', circulating_market_cap: 0 },
      { symbol: 'sh.000001', factor_date: '2020-01-15', circulating_market_cap: null },
      { symbol: 'sh.600036', factor_date: '2020-01-15', circulating_market_cap: -1 },
    ]);
    patchStockFindAll([]);
    const map = await loadHistoricalCirculatingMarketCap(['600519', '000001', '600036'], '2020-01-20');
    assert.equal(map.size, 0);
    restore();
  });

  await it('多 symbol: per-stock 各取最新 factor_date', async () => {
    patchValFindAll([
      { symbol: 'sh.600519', factor_date: '2020-01-10', circulating_market_cap: 1000 },
      { symbol: 'sh.600519', factor_date: '2020-01-15', circulating_market_cap: 1200 },
      { symbol: 'sz.000001', factor_date: '2020-01-12', circulating_market_cap: 300 },
    ]);
    patchStockFindAll([]);
    const map = await loadHistoricalCirculatingMarketCap(['600519', '000001'], '2020-01-20');
    assert.equal(map.get('600519'), 1200); // 取 01-15 而非 01-10
    assert.equal(map.get('000001'), 300);
    restore();
  });

  await it('部分覆盖: valuation 命中 1 个, 另一个走 Stock 兜底', async () => {
    patchValFindAll([
      { symbol: 'sh.600519', factor_date: '2020-01-15', circulating_market_cap: 1000 },
    ]);
    patchStockFindAll([
      { symbol: 'sz.000001', circulating_market_cap: 500 },
    ]);
    const map = await loadHistoricalCirculatingMarketCap(['600519', '000001'], '2020-01-20');
    assert.equal(map.get('600519'), 1000);
    assert.equal(map.get('000001'), 500);
    restore();
  });

  await it('空 universe 或空 asOfDate 直接返回空 Map', async () => {
    const m1 = await loadHistoricalCirculatingMarketCap([], '2020-01-20');
    assert.equal(m1.size, 0);
    const m2 = await loadHistoricalCirculatingMarketCap(['600519'], '');
    assert.equal(m2.size, 0);
  });

  console.log(`\nloadHistoricalCirculatingMarketCap: ${passed} ok / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
