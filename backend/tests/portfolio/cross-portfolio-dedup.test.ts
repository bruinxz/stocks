/**
 * CB-3 crossPortfolioDedup 单元测试 (2026/06/25)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/cross-portfolio-dedup.test.ts
 *
 * 覆盖:
 *   - 0 持仓 → 不 skip
 *   - 1 个 portfolio 持有 → 不 skip (under threshold)
 *   - 2 个 portfolio 持有 → skip (=threshold)
 *   - 3 个 portfolio 持有 → skip (over threshold)
 *   - 当前 portfolio 自己已持 → 不算入 (排除 current_portfolio_id)
 *   - 不同 user 互不影响
 *   - DataSource error → fail-OPEN 返 should_skip=false + error
 *   - threshold override
 *   - META-TEST: autoBuyFromSignals 必须 wire
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  shouldSkipForUserDedup,
  CROSS_PORTFOLIO_DEDUP_THRESHOLD,
  CrossPortfolioDedupDataSource,
} from '../../src/portfolio/internal/crossPortfolioDedup';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// fake DS
function makeDS(rowsByUser: Record<number, Array<{ portfolio_id: number; symbol: string }>>): CrossPortfolioDedupDataSource {
  return {
    async loadOpenPositionsByUser(user_id: number) {
      return rowsByUser[user_id] || [];
    },
  };
}

function makeErrorDS(msg = 'fake DB error'): CrossPortfolioDedupDataSource {
  return {
    async loadOpenPositionsByUser(): Promise<any> {
      throw new Error(msg);
    },
  };
}

async function run() {
  // ===== 0 持仓 — 不 skip =====
  {
    const ds = makeDS({ 2: [] });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds);
    assert('0 持仓 → 不 skip', !r.should_skip);
    assert('count=0', r.already_held_in_count === 0);
    assert('threshold=2 default', r.threshold === 2);
  }

  // ===== 1 个 portfolio 持有 (under threshold=2) =====
  {
    const ds = makeDS({
      2: [{ portfolio_id: 30, symbol: 'sh.600157' }],
    });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds);
    assert('1 持仓 under threshold → 不 skip', !r.should_skip);
    assert('count=1', r.already_held_in_count === 1);
  }

  // ===== 2 个 portfolio 持有 (=threshold) → skip =====
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 31, symbol: 'sh.600157' },
      ],
    });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds);
    assert('2 持仓 (=threshold) → skip', r.should_skip);
    assert('count=2', r.already_held_in_count === 2);
    assert('reason mentions cross_portfolio_dedup', r.reason.includes('cross_portfolio_dedup'));
    assert('reason 包含 symbol', r.reason.includes('sh.600157'));
  }

  // ===== 3 个 portfolio 持有 (>threshold) → skip =====
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 31, symbol: 'sh.600157' },
        { portfolio_id: 32, symbol: 'sh.600157' },
      ],
    });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds);
    assert('3 持仓 → skip', r.should_skip);
    assert('count=3', r.already_held_in_count === 3);
  }

  // ===== 当前 portfolio 自己 已持有 — 不算入 =====
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 10, symbol: 'sh.600157' }, // current portfolio
      ],
    });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds);
    assert('exclude current portfolio → count=1', r.already_held_in_count === 1);
    assert('exclude current → 不 skip', !r.should_skip);
  }

  // ===== 不同 user 互不影响 =====
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 31, symbol: 'sh.600157' },
      ],
      4: [], // 不同 user
    });
    const r4 = await shouldSkipForUserDedup(4, 'sh.600157', 10, ds);
    assert('不同 user 不影响 — 不 skip', !r4.should_skip);
    assert('user=4 count=0', r4.already_held_in_count === 0);
  }

  // ===== 不同 symbol 互不影响 =====
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 31, symbol: 'sh.600157' },
      ],
    });
    const r = await shouldSkipForUserDedup(2, 'sz.300750', 10, ds);
    assert('不同 symbol 不影响', !r.should_skip);
    assert('不同 symbol count=0', r.already_held_in_count === 0);
  }

  // ===== DataSource error → fail-OPEN =====
  {
    const ds = makeErrorDS('connection refused');
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds);
    assert('DS error → 不 skip (fail-OPEN)', !r.should_skip);
    assert('DS error → error 包含 connection refused', !!r.error && r.error.includes('connection refused'));
  }

  // ===== threshold override =====
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 31, symbol: 'sh.600157' },
        { portfolio_id: 32, symbol: 'sh.600157' },
      ],
    });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds, 5);
    assert('threshold=5, 3 持仓 → 不 skip', !r.should_skip);
    assert('returned threshold=5', r.threshold === 5);
  }

  // threshold 非法 fallback 到 2
  {
    const ds = makeDS({
      2: [
        { portfolio_id: 30, symbol: 'sh.600157' },
        { portfolio_id: 31, symbol: 'sh.600157' },
      ],
    });
    const r = await shouldSkipForUserDedup(2, 'sh.600157', 10, ds, NaN as any);
    assert('NaN threshold → fallback 2 → skip', r.should_skip);
    assert('returned threshold=2', r.threshold === 2);
  }

  // ===== CROSS_PORTFOLIO_DEDUP_THRESHOLD frozen =====
  {
    assert('CROSS_PORTFOLIO_DEDUP_THRESHOLD.value === 2', CROSS_PORTFOLIO_DEDUP_THRESHOLD.value === 2);
    let threwOnWrite = false;
    try {
      (CROSS_PORTFOLIO_DEDUP_THRESHOLD as any).value = 5;
    } catch {
      threwOnWrite = true;
    }
    // Object.freeze: 严格模式 throw, 非严格 silent. 二者都接受.
    assert(
      'CROSS_PORTFOLIO_DEDUP_THRESHOLD frozen (value 没改)',
      CROSS_PORTFOLIO_DEDUP_THRESHOLD.value === 2,
      `value after write=${CROSS_PORTFOLIO_DEDUP_THRESHOLD.value}, threw=${threwOnWrite}`
    );
  }

  // ===== META-TEST =====
  console.log('## META-TEST: autoBuyFromSignals 必须 wire CB-3');
  const ROOT = path.resolve(__dirname, '../../');
  const automationSrc = fs.readFileSync(
    path.join(ROOT, 'src/portfolio/internal/PaperTradingAutomationService.ts'),
    'utf-8'
  );

  assert(
    'import shouldSkipForUserDedup',
    /shouldSkipForUserDedup/.test(automationSrc),
    'PaperTradingAutomationService.ts 没 import shouldSkipForUserDedup'
  );
  assert(
    'import PRODUCTION_CROSS_PORTFOLIO_DEDUP_DATA_SOURCE',
    /PRODUCTION_CROSS_PORTFOLIO_DEDUP_DATA_SOURCE/.test(automationSrc),
    'PaperTradingAutomationService.ts 没 import PRODUCTION_CROSS_PORTFOLIO_DEDUP_DATA_SOURCE'
  );
  assert(
    'call shouldSkipForUserDedup(portfolio.user_id, symbol, portfolio.id',
    /shouldSkipForUserDedup\(\s*portfolio\.user_id,\s*symbol,\s*portfolio\.id/.test(automationSrc),
    'autoBuyFromSignals 没 call shouldSkipForUserDedup(portfolio.user_id, symbol, portfolio.id, ...)'
  );

  console.log(`\n# summary: ${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error('test runner fatal:', err);
  process.exit(1);
});
