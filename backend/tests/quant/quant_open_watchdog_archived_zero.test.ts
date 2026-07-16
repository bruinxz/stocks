/**
 * BL-1 (2026-06-25) — QuantOpenWatchdogService 区分 "扫描失败" vs "扫描成功但无候选"
 *
 * 真因背景: 2026-06-25 开盘扫描成功生成 166 条策略信号 (扫描正常), 但融合后无
 * 股票达到 min_score=55 阈值, 归档 0. 旧 watchdog 直接 critical → throw → cron
 * FAILED → Lark 告警. 这本质是合理的"今日市场无机会"业务空仓状态.
 *
 * 修后行为:
 *  - 扫描和归档都不足 → critical (真链路异常)
 *  - 扫描达标 + 归档不足 → warning (合理空仓)
 *  - 一切正常 → healthy
 *
 * 跑法 (项目约定 — IIFE + assert + process.exit, 不依赖 jest):
 *   cd backend && npx ts-node --transpile-only tests/quant/quant_open_watchdog_archived_zero.test.ts
 */

/* eslint-disable @typescript-eslint/no-var-requires */
import assert from 'node:assert/strict';
import Module from 'node:module';
import path from 'node:path';

// 必须先注册 model mocks, 再 require service (避免真实 Sequelize/DB 加载)
process.env.TZ = 'Asia/Shanghai';

const FAKE_NOW = new Date('2026-06-25T03:55:00.000Z'); // 11:55 CST (post-open)
const realDateNow = Date.now;
Date.now = () => FAKE_NOW.getTime();

const TASK = { id: 1, name: '量化策略开盘机会扫描', is_active: true };

interface MockOpts {
  quant_signal_count: number;
  archived_signal_count: number;
  latest_log_status: 'COMPLETED' | 'FAILED' | 'IN_PROGRESS';
}

// 拦截 require 把指定模块替换成 fake
const SRC_ROOT = path.resolve(__dirname, '../../src');
const originalResolve = (Module as any)._resolveFilename;
const originalLoad = (Module as any)._load;
const mockRegistry = new Map<string, any>();

(Module as any)._load = function (request: string, parent: any, ...rest: any[]) {
  let resolved: string;
  try {
    resolved = originalResolve.call(this, request, parent, false, ...rest);
  } catch {
    return originalLoad.call(this, request, parent, ...rest);
  }
  if (mockRegistry.has(resolved)) {
    return mockRegistry.get(resolved);
  }
  return originalLoad.call(this, request, parent, ...rest);
};

function setMocks(opts: MockOpts) {
  mockRegistry.clear();
  mockRegistry.set(path.join(SRC_ROOT, 'models/ScheduledTask.ts'), {
    ScheduledTask: { findOne: async () => TASK },
  });
  mockRegistry.set(path.join(SRC_ROOT, 'models/TaskExecutionLog.ts'), {
    TaskExecutionLog: {
      findOne: async () => ({
        id: 999,
        status: opts.latest_log_status,
        started_at: new Date('2026-06-25T01:35:00.000Z'),
        completed_at: new Date('2026-06-25T01:41:35.000Z'),
        total_items: opts.quant_signal_count,
        completed_items: opts.quant_signal_count,
        failed_items: 0,
        error_message: null,
      }),
    },
  });
  mockRegistry.set(path.join(SRC_ROOT, 'models/AIInvestmentSignal.ts'), {
    AIInvestmentSignal: { count: async () => opts.archived_signal_count },
    AISignalSourceType: { QUANT_RECOMMENDATION: 'quant_recommendation' },
  });
  mockRegistry.set(path.join(SRC_ROOT, 'models/PaperTradingTrade.ts'), {
    PaperTradingTrade: { count: async () => 0 },
  });
  mockRegistry.set(path.join(SRC_ROOT, 'data/services/RealtimeQuoteService.ts'), {
    realtimeQuoteService: {
      getPersistenceSummary: async () => ({ persisted: true, age_minutes: 5 }),
    },
  });

  // 清掉已 cache 的 service module 让新 mocks 生效
  const servicePath = path.join(SRC_ROOT, 'quant/health/internal/QuantOpenWatchdogService.ts');
  for (const k of Object.keys(require.cache)) {
    if (k.endsWith('QuantOpenWatchdogService.ts')) delete require.cache[k];
  }
}

async function loadSvc() {
  const mod = require(path.join(SRC_ROOT, 'quant/health/internal/QuantOpenWatchdogService.ts'));
  return mod.quantOpenWatchdogService;
}

(async () => {
  let pass = 0;
  let fail = 0;

  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'BL-1 修后: 扫描达标 (166) + 归档=0 → warning (合理空仓)',
      run: async () => {
        setMocks({
          quant_signal_count: 166,
          archived_signal_count: 0,
          latest_log_status: 'COMPLETED',
        });
        const svc = await loadSvc();
        const result = await svc.check({
          trade_date: '2026-06-25',
          latest_allowed_minutes: 15,
          min_quant_signals: 1,
          min_archived_signals: 1,
        });
        assert.equal(result.status, 'warning', `期望 warning, 实际 ${result.status}`);
        const archivedIssue = result.issues.find((i: any) => i.code === 'no_archived_signals');
        assert.ok(archivedIssue, 'archived issue 应存在');
        assert.equal(archivedIssue.level, 'warning');
        assert.ok(
          archivedIssue.message.includes('合理空仓'),
          `期望含"合理空仓", 实际: ${archivedIssue.message}`
        );
      },
    },
    {
      name: 'BL-1 修后: 扫描=0 + 归档=0 → critical (真链路异常)',
      run: async () => {
        setMocks({
          quant_signal_count: 0,
          archived_signal_count: 0,
          latest_log_status: 'COMPLETED',
        });
        const svc = await loadSvc();
        const result = await svc.check({
          trade_date: '2026-06-25',
          latest_allowed_minutes: 15,
          min_quant_signals: 1,
          min_archived_signals: 1,
        });
        assert.equal(result.status, 'critical', `期望 critical, 实际 ${result.status}`);
        const archivedIssue = result.issues.find((i: any) => i.code === 'no_archived_signals');
        assert.equal(archivedIssue.level, 'critical');
        assert.ok(
          !archivedIssue.message.includes('合理空仓'),
          `不应含"合理空仓", 实际: ${archivedIssue.message}`
        );
      },
    },
    {
      name: 'healthy 路径: 扫描达标 + 归档达标 → healthy',
      run: async () => {
        setMocks({
          quant_signal_count: 220,
          archived_signal_count: 2,
          latest_log_status: 'COMPLETED',
        });
        const svc = await loadSvc();
        const result = await svc.check({
          trade_date: '2026-06-25',
          latest_allowed_minutes: 15,
          min_quant_signals: 1,
          min_archived_signals: 1,
        });
        assert.equal(result.status, 'healthy', `期望 healthy, 实际 ${result.status}`);
        assert.equal(result.issues.length, 0, `应无 issue, 实际: ${JSON.stringify(result.issues)}`);
      },
    },
    {
      name: 'task_failed 优先: 扫描达标 + 归档=0 + latest_log=FAILED → critical (task_failed)',
      run: async () => {
        setMocks({
          quant_signal_count: 166,
          archived_signal_count: 0,
          latest_log_status: 'FAILED',
        });
        const svc = await loadSvc();
        const result = await svc.check({
          trade_date: '2026-06-25',
          latest_allowed_minutes: 15,
          min_quant_signals: 1,
          min_archived_signals: 1,
        });
        assert.equal(result.status, 'critical', `期望 critical, 实际 ${result.status}`);
        const taskFailedIssue = result.issues.find((i: any) => i.code === 'task_failed');
        assert.ok(taskFailedIssue, 'task_failed issue 应存在');
        assert.equal(taskFailedIssue.level, 'critical');
        const archivedIssue = result.issues.find((i: any) => i.code === 'no_archived_signals');
        assert.equal(
          archivedIssue.level,
          'warning',
          `archived 应是 warning (扫描达标), 实际: ${archivedIssue.level}`
        );
      },
    },
  ];

  for (const c of cases) {
    try {
      await c.run();
      console.log(`✓ ${c.name}`);
      pass++;
    } catch (e: any) {
      console.error(`✗ ${c.name}`);
      console.error(`  ${e?.message || e}`);
      fail++;
    }
  }

  Date.now = realDateNow;
  console.log(`\nResult: ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => {
  Date.now = realDateNow;
  console.error('Unhandled error:', err);
  process.exit(1);
});
