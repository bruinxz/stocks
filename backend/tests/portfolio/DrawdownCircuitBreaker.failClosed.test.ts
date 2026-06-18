/**
 * DrawdownCircuitBreaker fail-CLOSED 单元测试 (BETA-7, audit M-13)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/DrawdownCircuitBreaker.failClosed.test.ts
 *
 * 不依赖 DB — 注入 fake DataSource:
 *  - loadConfig 抛 DB error → checkBuyAllowed 必须抛 RiskGuardUnavailableError (fail-CLOSED)
 *  - hasExistingPosition 抛 → 同样 fail-CLOSED
 *  - 正常返回 + pause inactive → ok=true (健康路径不变)
 *  - 正常返回 + pause active + 已有持仓 → ok=true is_new_holding=false
 *  - 正常返回 + pause active + 无持仓 → ok=false + paused_until 字段
 */

import {
  DrawdownCircuitBreaker,
  RiskGuardUnavailableError,
  DrawdownBreakerDataSource,
  DEFAULT_DRAWDOWN_BREAKER_CONFIG,
  DrawdownBreakerConfig,
} from '../../src/portfolio/risk/DrawdownCircuitBreaker';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`❌ ${name}${detail ? ' ' + detail : ''}`);
  }
}

function makeFakeSource(overrides: Partial<DrawdownBreakerDataSource> = {}): DrawdownBreakerDataSource {
  return {
    loadAllUserIdsWithPortfolios: async () => [],
    loadConfig: async () => ({ ...DEFAULT_DRAWDOWN_BREAKER_CONFIG }),
    saveConfig: async (_uid: number, cfg: DrawdownBreakerConfig) => cfg,
    loadPortfolio: async () => null,
    loadRecentSnapshots: async () => [],
    loadRecentSnapshotsByUser: async () => [],
    loadOpenPositions: async () => [],
    loadPausedUntil: async () => null,
    savePausedUntil: async () => {},
    hasExistingPosition: async () => false,
    writeAlert: async () => {},
    ...overrides,
  } as DrawdownBreakerDataSource;
}

async function test_fail_closed_on_loadConfig_error() {
  const fake = makeFakeSource({
    loadConfig: async () => {
      throw new Error('DB outage: cannot read User.risk_config');
    },
  });
  const guard = new DrawdownCircuitBreaker(fake);
  let caught: unknown = null;
  try {
    await guard.checkBuyAllowed({ user_id: 1, symbol: '600519' });
  } catch (err) {
    caught = err;
  }
  assert(
    'loadConfig throws → checkBuyAllowed re-throws',
    caught !== null
  );
  assert(
    'caught error is RiskGuardUnavailableError',
    caught instanceof RiskGuardUnavailableError
  );
  if (caught instanceof RiskGuardUnavailableError) {
    assert('error has statusCode=503', caught.statusCode === 503);
    assert('error has code=RISK_GUARD_UNAVAILABLE', caught.code === 'RISK_GUARD_UNAVAILABLE');
  }
}

async function test_fail_closed_on_hasExistingPosition_error() {
  const fake = makeFakeSource({
    loadConfig: async () => ({ ...DEFAULT_DRAWDOWN_BREAKER_CONFIG }),
    loadPausedUntil: async () => new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    hasExistingPosition: async () => {
      throw new Error('DB outage on PaperTradingPosition');
    },
  });
  const guard = new DrawdownCircuitBreaker(fake);
  let caught: unknown = null;
  try {
    await guard.checkBuyAllowed({ user_id: 1, symbol: '600519' });
  } catch (err) {
    caught = err;
  }
  assert(
    'hasExistingPosition throws → fail-CLOSED',
    caught instanceof RiskGuardUnavailableError
  );
}

async function test_healthy_no_pause() {
  const fake = makeFakeSource({
    loadConfig: async () => ({ ...DEFAULT_DRAWDOWN_BREAKER_CONFIG }),
    loadPausedUntil: async () => null,
  });
  const guard = new DrawdownCircuitBreaker(fake);
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: '600519' });
  assert('健康 + 无 pause → ok=true', r.ok === true);
}

async function test_pause_active_existing_holding() {
  const fake = makeFakeSource({
    loadConfig: async () => ({ ...DEFAULT_DRAWDOWN_BREAKER_CONFIG }),
    loadPausedUntil: async () => new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    hasExistingPosition: async () => true,
  });
  const guard = new DrawdownCircuitBreaker(fake);
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: '600519' });
  assert('pause + 已有持仓 → ok=true 加仓允许', r.ok === true);
}

async function test_pause_active_new_holding() {
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const fake = makeFakeSource({
    loadConfig: async () => ({ ...DEFAULT_DRAWDOWN_BREAKER_CONFIG }),
    loadPausedUntil: async () => futureIso,
    hasExistingPosition: async () => false,
  });
  const guard = new DrawdownCircuitBreaker(fake);
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: '300750' });
  assert('pause + 新开仓 → ok=false', r.ok === false);
  if (!r.ok) {
    assert('返回 paused_until', !!r.paused_until);
  }
}

async function test_config_disabled() {
  const fake = makeFakeSource({
    loadConfig: async () => ({ ...DEFAULT_DRAWDOWN_BREAKER_CONFIG, enabled: false }),
  });
  const guard = new DrawdownCircuitBreaker(fake);
  const r = await guard.checkBuyAllowed({ user_id: 1, symbol: '600519' });
  assert('config.enabled=false → ok=true (skip guard)', r.ok === true);
}

(async () => {
  await test_fail_closed_on_loadConfig_error();
  await test_fail_closed_on_hasExistingPosition_error();
  await test_healthy_no_pause();
  await test_pause_active_existing_holding();
  await test_pause_active_new_holding();
  await test_config_disabled();

  console.log('');
  console.log(`✅ passed=${passed}`);
  console.log(`❌ failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
