/**
 * AI polling worker — Phase 10 缺漏 P0-2 burst 告警单测
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/jobs/ai-polling-worker-burst.test.ts
 *
 * 覆盖:
 *   [1] recordAiPollingFailureForBurst 纯函数:
 *     - 单次失败 → window_size=1, burst_triggered=false, push 不调
 *     - 5 min 内累计 < 10 → 不触发
 *     - 5 min 内累计 = 10 → 触发一次 push (HIGH, ai_polling_burst)
 *     - 5 min 内累计 = 15 → 每次都触发 push (caller 用 SystemAdminAlertPusher 1h dedup 兜底)
 *     - 老失败 (> 5 min) → 自动 shift 出 window
 *     - clearAiPollingFailureWindowForTests 清空
 *   [2] getAiPollingFailureWindowForTests 返 snapshot
 *
 * 不真起 Bull worker (单测只验 burst 检测函数).
 */

import {
  recordAiPollingFailureForBurst,
  clearAiPollingFailureWindowForTests,
  getAiPollingFailureWindowForTests,
} from '../../src/jobs/aiPollingBurstDetector';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function main() {
  console.log('\n[1] recordAiPollingFailureForBurst 纯函数...');

  // (a) 单次失败 → window_size=1, 不触发
  {
    const state: number[] = [];
    const pushed: any[] = [];
    const r = recordAiPollingFailureForBurst(1_700_000_000_000, state, {
      push: input => pushed.push(input),
    });
    assertEqual('单次失败: window_size=1', r.window_size, 1);
    assertEqual('单次失败: burst_triggered=false', r.burst_triggered, false);
    assertEqual('单次失败: push 不调', pushed.length, 0);
  }

  // (b) 5min 内累计 9 次 → 不触发
  {
    const state: number[] = [];
    const pushed: any[] = [];
    for (let i = 0; i < 9; i++) {
      recordAiPollingFailureForBurst(1_700_000_000_000 + i * 1000, state, {
        push: input => pushed.push(input),
      });
    }
    assertEqual('9 次: window_size=9', state.length, 9);
    assertEqual('9 次: push 不调', pushed.length, 0);
  }

  // (c) 5min 内累计 10 次 → 触发 1 次
  {
    const state: number[] = [];
    const pushed: any[] = [];
    let lastResult: { window_size: number; burst_triggered: boolean } | undefined;
    for (let i = 0; i < 10; i++) {
      lastResult = recordAiPollingFailureForBurst(1_700_000_000_000 + i * 1000, state, {
        push: input => pushed.push(input),
      });
    }
    assertEqual('10 次: window_size=10', state.length, 10);
    assertEqual('10 次: 最后一次 burst_triggered=true', lastResult?.burst_triggered, true);
    assertEqual('10 次: push 调 1 次', pushed.length, 1);
    assertEqual('10 次: push dedup_key=ai_polling_burst', pushed[0]?.dedup_key, 'ai_polling_burst');
    assertEqual('10 次: push level=HIGH', pushed[0]?.level, 'HIGH');
    assert(
      '10 次: push title 含 burst',
      String(pushed[0]?.title || '').includes('burst')
    );
  }

  // (d) 累计 15 次 → 每次超阈值都触发 push (caller SystemAdminAlertPusher 1h dedup 兜底)
  {
    const state: number[] = [];
    const pushed: any[] = [];
    for (let i = 0; i < 15; i++) {
      recordAiPollingFailureForBurst(1_700_000_000_000 + i * 1000, state, {
        push: input => pushed.push(input),
      });
    }
    assertEqual('15 次: window_size=15', state.length, 15);
    // 第 10~15 次都 burst_triggered → 6 次 push 调用. SystemAdminAlertPusher 1h dedup 才是 dedup 真实源
    assertEqual('15 次: push 调 6 次 (10-15)', pushed.length, 6);
  }

  // (e) 老失败 (> 5min) 自动 shift 出 window
  {
    const state: number[] = [];
    const pushed: any[] = [];
    // 老的 5 个失败 (10min 前) — 全部应被清出
    for (let i = 0; i < 5; i++) {
      recordAiPollingFailureForBurst(1_700_000_000_000 + i * 1000, state, {
        push: input => pushed.push(input),
      });
    }
    assertEqual('插入老 5 个: window_size=5', state.length, 5);
    // 跳到 10 min 后再插 1 个 — 老的 5 个应该全被 shift 出
    const r = recordAiPollingFailureForBurst(1_700_000_000_000 + 10 * 60 * 1000, state, {
      push: input => pushed.push(input),
    });
    assertEqual('10min 后再插 1: window_size=1 (5 老的全清)', r.window_size, 1);
    assertEqual('10min 后再插 1: burst_triggered=false', r.burst_triggered, false);
  }

  // (f) clearAiPollingFailureWindowForTests 清空 global state
  {
    recordAiPollingFailureForBurst(Date.now());
    assert('insert 后 global window_size > 0', getAiPollingFailureWindowForTests().length > 0);
    clearAiPollingFailureWindowForTests();
    assertEqual('clear 后 = 0', getAiPollingFailureWindowForTests().length, 0);
  }

  // (g) getAiPollingFailureWindowForTests 返 snapshot (修改不污染 internal)
  {
    clearAiPollingFailureWindowForTests();
    recordAiPollingFailureForBurst(Date.now());
    const snap = getAiPollingFailureWindowForTests();
    snap.push(999);
    assertEqual('snapshot.push 不影响 internal', getAiPollingFailureWindowForTests().length, 1);
    clearAiPollingFailureWindowForTests();
  }

  console.log('========================================');
  console.log(`ai-polling-worker-burst test summary: ${passed} ok / ${failed} failed`);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test unexpected error:', err);
  process.exit(1);
});
