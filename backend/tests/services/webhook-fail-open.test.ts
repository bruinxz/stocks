/**
 * webhookFailOpen — [OPS-006 / US-095] 飞书 webhook fail-open 兜底 单元测试
 *
 * 跑法:
 *   cd backend && npm test -- --filter=webhook-fail-open
 *   cd backend && npx ts-node --transpile-only tests/services/webhook-fail-open.test.ts
 *
 * 覆盖维度 (AC: mock feishu 504 → 主流程仍完成 + fallback_log + 5min retry):
 *   [1] 常量冻结 / 默认值边界 (MAX_ATTEMPTS / FIRST_BACKOFF / MAX_BACKOFF / SCENARIOS)
 *   [2] computeNextBackoffMs 指数阶梯 + clamp + 非法输入兜底
 *   [3] extractErrorInfo 从 SendResult / Error 抽 last_error+status_code
 *   [4] isSkippedResult 边界
 *   [5] wrapFeishuWebhookFailOpen 主入口 — AC 主验收:
 *        (a) sender success=true → 不落 log, 透传 result
 *        (b) sender success=false (mock 504) → INSERT 一行 status='pending',
 *             **主流程仍拿到原 result 不抛**
 *        (c) sender throw → 同样 INSERT, 转 {success:false,message} 不抛
 *        (d) sender skipped=true → 不落 log (webhook 未配置不算失败)
 *        (e) DB INSERT 自身失败 → 主流程不抛, logger.warn 吞错, 返原 sender result
 *        (f) max_attempts override 透传
 *   [6] retryPendingFallbacks cron 主入口:
 *        (a) loadPending 0 行 → summary 全 0, 不抛
 *        (b) row.scenario 在 dispatchers → sender 成功 → markSent
 *        (c) sender 失败 + attempts < max → markRetryFailed + 指数 backoff
 *        (d) sender 失败 + attempts+1 >= max → markDead
 *        (e) row.scenario 不在 dispatchers → skipped_unknown_scenario (不消耗 retry)
 *        (f) sender throw → 等价于 success=false (不传染)
 *        (g) loadPending throw → 顶层 catch 返空 summary
 *        (h) markSent/markRetryFailed/markDead throw → 仅 logger.warn 不传染
 *   [7] PRODUCTION DataSource smoke — 工厂返对象, DB-less 环境调 method 不挂
 */

import {
  DEFAULT_FIRST_BACKOFF_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_BATCH_SIZE,
  MAX_BACKOFF_MS,
  RetryPendingFallbacksSummary,
  SenderThunk,
  WEBHOOK_SCENARIOS,
  WebhookFallbackLogDataSource,
  WebhookFallbackLogRow,
  WebhookSendResult,
  computeNextBackoffMs,
  createProductionWebhookFallbackLogDataSource,
  extractErrorInfo,
  isSkippedResult,
  retryPendingFallbacks,
  wrapFeishuWebhookFailOpen,
} from '../../src/services/webhookFailOpen';

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

// ============================================================================
// Test fake DataSource — 用 Map 记 row + 各 method 的 spy
// ============================================================================
function makeFakeDataSource(): {
  ds: WebhookFallbackLogDataSource;
  state: {
    rows: WebhookFallbackLogRow[];
    insertCalls: number;
    markSentCalls: number[];
    markRetryFailedCalls: any[];
    markDeadCalls: any[];
    pendingRows: WebhookFallbackLogRow[]; // returned by loadPending
    insertShouldThrow: Error | null;
    loadPendingShouldThrow: Error | null;
    markSentShouldThrow: Error | null;
    markRetryFailedShouldThrow: Error | null;
    markDeadShouldThrow: Error | null;
  };
} {
  const state = {
    rows: [] as WebhookFallbackLogRow[],
    insertCalls: 0,
    markSentCalls: [] as number[],
    markRetryFailedCalls: [] as any[],
    markDeadCalls: [] as any[],
    pendingRows: [] as WebhookFallbackLogRow[],
    insertShouldThrow: null as Error | null,
    loadPendingShouldThrow: null as Error | null,
    markSentShouldThrow: null as Error | null,
    markRetryFailedShouldThrow: null as Error | null,
    markDeadShouldThrow: null as Error | null,
  };
  let idSeq = 100;
  const ds: WebhookFallbackLogDataSource = {
    async insertFallback(input) {
      state.insertCalls += 1;
      if (state.insertShouldThrow) throw state.insertShouldThrow;
      const row: WebhookFallbackLogRow = {
        id: idSeq++,
        channel: input.channel,
        scenario: input.scenario,
        webhook_url: input.webhook_url,
        payload: input.payload,
        last_error: input.last_error,
        last_status_code: input.last_status_code,
        attempts: input.attempts,
        max_attempts: input.max_attempts,
        status: 'pending',
        next_retry_at: input.next_retry_at,
        last_attempt_at: null,
        sent_at: null,
        dead_at: null,
        metadata: input.metadata,
      };
      state.rows.push(row);
      return row;
    },
    async loadPending(_now, _limit) {
      if (state.loadPendingShouldThrow) throw state.loadPendingShouldThrow;
      return state.pendingRows.slice(0, _limit);
    },
    async markSent(id, _now) {
      if (state.markSentShouldThrow) throw state.markSentShouldThrow;
      state.markSentCalls.push(id);
    },
    async markRetryFailed(input) {
      if (state.markRetryFailedShouldThrow) throw state.markRetryFailedShouldThrow;
      state.markRetryFailedCalls.push(input);
    },
    async markDead(input) {
      if (state.markDeadShouldThrow) throw state.markDeadShouldThrow;
      state.markDeadCalls.push(input);
    },
  };
  return { ds, state };
}

(async () => {
  console.log('\n[1] 常量冻结 + 默认值边界...');
  assertEqual('DEFAULT_MAX_ATTEMPTS=5', DEFAULT_MAX_ATTEMPTS, 5);
  assertEqual('DEFAULT_FIRST_BACKOFF_MS=5min', DEFAULT_FIRST_BACKOFF_MS, 5 * 60 * 1000);
  assertEqual('MAX_BACKOFF_MS=4h', MAX_BACKOFF_MS, 4 * 60 * 60 * 1000);
  assertEqual('DEFAULT_RETRY_BATCH_SIZE=50', DEFAULT_RETRY_BATCH_SIZE, 50);
  assert('WEBHOOK_SCENARIOS frozen', Object.isFrozen(WEBHOOK_SCENARIOS));
  assert('WEBHOOK_SCENARIOS 含 sendDailyDigestCard', WEBHOOK_SCENARIOS.includes('sendDailyDigestCard' as any));
  assert('WEBHOOK_SCENARIOS 含 sendRiskAlertCard', WEBHOOK_SCENARIOS.includes('sendRiskAlertCard' as any));

  console.log('\n[2] computeNextBackoffMs 指数阶梯 + clamp...');
  assertEqual('attempts=1 → 5min', computeNextBackoffMs(1), 5 * 60 * 1000);
  assertEqual('attempts=2 → 10min', computeNextBackoffMs(2), 10 * 60 * 1000);
  assertEqual('attempts=3 → 20min', computeNextBackoffMs(3), 20 * 60 * 1000);
  assertEqual('attempts=4 → 40min', computeNextBackoffMs(4), 40 * 60 * 1000);
  assertEqual('attempts=5 → 80min', computeNextBackoffMs(5), 80 * 60 * 1000);
  // 6 → 160min > 240min(4h cap), 5 → 80min < 240min ⇒ 5 不 cap, 6→160 不 cap, 7→320 cap → 240
  assertEqual('attempts=6 → 160min (still < 4h cap)', computeNextBackoffMs(6), 160 * 60 * 1000);
  assertEqual('attempts=7 → cap 4h', computeNextBackoffMs(7), MAX_BACKOFF_MS);
  assertEqual('attempts=100 → cap 4h', computeNextBackoffMs(100), MAX_BACKOFF_MS);
  // 非法输入兜底
  assertEqual('attempts=0 → first backoff', computeNextBackoffMs(0), DEFAULT_FIRST_BACKOFF_MS);
  assertEqual('attempts=-5 → first backoff', computeNextBackoffMs(-5), DEFAULT_FIRST_BACKOFF_MS);
  assertEqual('attempts=NaN → first backoff', computeNextBackoffMs(NaN), DEFAULT_FIRST_BACKOFF_MS);
  assertEqual('attempts=Infinity → cap 4h', computeNextBackoffMs(Infinity), DEFAULT_FIRST_BACKOFF_MS);

  console.log('\n[3] extractErrorInfo 从 SendResult / Error 抽 last_error + status_code...');
  {
    const r: WebhookSendResult = { success: false, message: '飞书机器人返回失败' };
    const info = extractErrorInfo(r);
    assertEqual('SendResult: last_error 取 message', info.last_error, '飞书机器人返回失败');
    assertEqual('SendResult: last_status_code 缺省 null', info.last_status_code, null);
  }
  {
    const r: WebhookSendResult = { success: false, message: '504 gateway timeout', status_code: 504 };
    const info = extractErrorInfo(r);
    assertEqual('SendResult: last_status_code=504', info.last_status_code, 504);
  }
  {
    const err: any = new Error('connect ETIMEDOUT');
    err.response = { status: 504 };
    const info = extractErrorInfo(err);
    assertEqual('Error: 取 message', info.last_error, 'connect ETIMEDOUT');
    assertEqual('Error: 从 response.status 抽 status_code', info.last_status_code, 504);
  }
  {
    const err: any = new Error('no http context');
    const info = extractErrorInfo(err);
    assertEqual('Error 无 response → status_code=null', info.last_status_code, null);
  }
  {
    const info = extractErrorInfo({} as WebhookSendResult);
    assertEqual('空 result → default message', info.last_error, 'webhook send failed');
  }

  console.log('\n[4] isSkippedResult 边界...');
  assert('skipped:true success:false → true', isSkippedResult({ success: false, skipped: true }));
  assert('success:true → false', !isSkippedResult({ success: true }));
  assert('success:false skipped:undefined → false', !isSkippedResult({ success: false, message: 'oops' }));
  assert('null → false', !isSkippedResult(null));
  assert('undefined → false', !isSkippedResult(undefined));

  console.log('\n[5] wrapFeishuWebhookFailOpen 主入口 (AC 主验收)...');
  // [5a] sender success=true → 不落 log
  {
    const { ds, state } = makeFakeDataSource();
    const sender: SenderThunk = async () => ({ success: true, data: { code: 0 } });
    const result = await wrapFeishuWebhookFailOpen(
      { channel: 'feishu', scenario: 'sendDailyDigestCard', webhookUrl: 'https://example.com/hook', payload: {} },
      sender,
      ds
    );
    assertEqual('[5a] success=true 透传', result.success, true);
    assertEqual('[5a] 不落 log', state.insertCalls, 0);
  }

  // [5b] sender success=false (mock 504) → INSERT pending + 主流程拿到原 result
  {
    const { ds, state } = makeFakeDataSource();
    const sender: SenderThunk = async () => ({
      success: false,
      message: '飞书机器人返回失败 (504)',
      status_code: 504,
    });
    const result = await wrapFeishuWebhookFailOpen(
      {
        channel: 'feishu',
        scenario: 'sendDailyDigestCard',
        webhookUrl: 'https://example.com/hook',
        payload: { user_id: 42 },
        metadata: { caller_module: 'DailyTradingDigestService' },
      },
      sender,
      ds
    );
    assertEqual('[5b] AC 主验收: 主流程仍拿到 success=false (不抛)', result.success, false);
    assertEqual('[5b] AC 主验收: insertCalls=1', state.insertCalls, 1);
    assertEqual('[5b] row.status=pending', state.rows[0].status, 'pending');
    assertEqual('[5b] row.attempts=1', state.rows[0].attempts, 1);
    assertEqual('[5b] row.max_attempts=DEFAULT', state.rows[0].max_attempts, DEFAULT_MAX_ATTEMPTS);
    assertEqual('[5b] row.last_status_code=504', state.rows[0].last_status_code, 504);
    assertEqual('[5b] row.last_error 透传', state.rows[0].last_error, '飞书机器人返回失败 (504)');
    assertEqual('[5b] row.scenario 透传', state.rows[0].scenario, 'sendDailyDigestCard');
    assertEqual('[5b] row.webhook_url 透传', state.rows[0].webhook_url, 'https://example.com/hook');
    assertEqual('[5b] row.payload 透传', state.rows[0].payload, { user_id: 42 });
    assertEqual('[5b] row.metadata 透传', state.rows[0].metadata, { caller_module: 'DailyTradingDigestService' });
    // next_retry_at 应该是大约 5min 后
    const drift = Math.abs(state.rows[0].next_retry_at.getTime() - (Date.now() + DEFAULT_FIRST_BACKOFF_MS));
    assert('[5b] next_retry_at ≈ now + 5min (drift < 5s)', drift < 5000, `drift=${drift}ms`);
  }

  // [5c] sender throw → INSERT + 不抛
  {
    const { ds, state } = makeFakeDataSource();
    const sender: SenderThunk = async () => {
      const err: any = new Error('ECONNREFUSED');
      err.response = { status: 0 };
      throw err;
    };
    const result = await wrapFeishuWebhookFailOpen(
      { channel: 'feishu_ops', scenario: 'sendRiskAlertCard', webhookUrl: 'https://ops.example.com/hook', payload: {} },
      sender,
      ds
    );
    assertEqual('[5c] sender throw → 主流程拿 fail-OPEN result', result.success, false);
    assertEqual('[5c] sender throw → message 含 error', result.message, 'ECONNREFUSED');
    assertEqual('[5c] insertCalls=1', state.insertCalls, 1);
    assertEqual('[5c] row.last_status_code=0', state.rows[0].last_status_code, 0);
    assertEqual('[5c] row.channel=feishu_ops', state.rows[0].channel, 'feishu_ops');
  }

  // [5d] sender skipped=true → 不落 log
  {
    const { ds, state } = makeFakeDataSource();
    const sender: SenderThunk = async () => ({
      success: false,
      skipped: true,
      message: '飞书机器人 webhook 未配置',
    });
    const result = await wrapFeishuWebhookFailOpen(
      { channel: 'feishu', scenario: 'sendDailyDigestCard', webhookUrl: '', payload: {} },
      sender,
      ds
    );
    assertEqual('[5d] skipped:true 透传', result.skipped, true);
    assertEqual('[5d] skipped 不落 log', state.insertCalls, 0);
  }

  // [5e] DB INSERT 自身失败 → logger.warn 吞错, 返原 sender result
  {
    const { ds, state } = makeFakeDataSource();
    state.insertShouldThrow = new Error('DB connection lost');
    const sender: SenderThunk = async () => ({ success: false, message: '504' });
    const result = await wrapFeishuWebhookFailOpen(
      { channel: 'feishu', scenario: 'sendDailyDigestCard', webhookUrl: 'x', payload: {} },
      sender,
      ds
    );
    assertEqual('[5e] DB throw 不传染, 主流程仍拿原 result', result.success, false);
    assertEqual('[5e] insertCalls=1 (调了但 throw)', state.insertCalls, 1);
    assertEqual('[5e] rows=0 (插入失败)', state.rows.length, 0);
  }

  // [5f] max_attempts override 透传
  {
    const { ds, state } = makeFakeDataSource();
    const sender: SenderThunk = async () => ({ success: false, message: 'x' });
    await wrapFeishuWebhookFailOpen(
      {
        channel: 'feishu',
        scenario: 'sendDailyDigestCard',
        webhookUrl: 'x',
        payload: {},
        maxAttempts: 3,
      },
      sender,
      ds
    );
    assertEqual('[5f] max_attempts override=3', state.rows[0].max_attempts, 3);
  }

  console.log('\n[6] retryPendingFallbacks cron 主入口...');
  // [6a] loadPending 0 行 → summary 全 0
  {
    const { ds, state } = makeFakeDataSource();
    state.pendingRows = [];
    const sum = await retryPendingFallbacks({ dispatchers: {}, source: ds });
    assertEqual('[6a] total=0', sum.total, 0);
    assertEqual('[6a] sent=0', sum.sent_count, 0);
  }

  // [6b] sender 成功 → markSent
  {
    const { ds, state } = makeFakeDataSource();
    const row: WebhookFallbackLogRow = {
      id: 1,
      channel: 'feishu',
      scenario: 'sendDailyDigestCard',
      webhook_url: 'https://x',
      payload: { foo: 'bar' },
      last_error: '504',
      last_status_code: 504,
      attempts: 1,
      max_attempts: 5,
      status: 'pending',
      next_retry_at: new Date(),
      last_attempt_at: null,
      sent_at: null,
      dead_at: null,
      metadata: {},
    };
    state.pendingRows = [row];
    let senderCalled = 0;
    const sum = await retryPendingFallbacks({
      source: ds,
      dispatchers: {
        sendDailyDigestCard: async (payload, r) => {
          senderCalled += 1;
          assertEqual('[6b] sender 收到 payload', payload, { foo: 'bar' });
          assertEqual('[6b] sender 收到 row.id', r.id, 1);
          return { success: true };
        },
      },
    });
    assertEqual('[6b] sender 调 1 次', senderCalled, 1);
    assertEqual('[6b] sent_count=1', sum.sent_count, 1);
    assertEqual('[6b] markSent.id=1', state.markSentCalls, [1]);
    assertEqual('[6b] markRetryFailed 不调', state.markRetryFailedCalls.length, 0);
  }

  // [6c] sender 失败 + attempts < max → markRetryFailed + 指数 backoff
  {
    const { ds, state } = makeFakeDataSource();
    const now = new Date('2026-06-20T10:00:00Z');
    const row: WebhookFallbackLogRow = {
      id: 2,
      channel: 'feishu',
      scenario: 'sendDailyDigestCard',
      webhook_url: 'https://x',
      payload: {},
      last_error: '504',
      last_status_code: 504,
      attempts: 1,
      max_attempts: 5,
      status: 'pending',
      next_retry_at: now,
      last_attempt_at: null,
      sent_at: null,
      dead_at: null,
      metadata: {},
    };
    state.pendingRows = [row];
    const sum = await retryPendingFallbacks({
      source: ds,
      now,
      dispatchers: {
        sendDailyDigestCard: async () => ({ success: false, message: '504', status_code: 504 }),
      },
    });
    assertEqual('[6c] retry_failed_count=1', sum.retry_failed_count, 1);
    assertEqual('[6c] markRetryFailed 调 1 次', state.markRetryFailedCalls.length, 1);
    const mrf = state.markRetryFailedCalls[0];
    assertEqual('[6c] attempts +=1 → 2', mrf.attempts, 2);
    assertEqual('[6c] last_status_code 透传', mrf.last_status_code, 504);
    // next_retry_at = now + computeNextBackoffMs(2) = now + 10min
    assertEqual('[6c] next_retry_at = now + 10min', mrf.next_retry_at.getTime(), now.getTime() + 10 * 60 * 1000);
    assertEqual('[6c] markDead 不调', state.markDeadCalls.length, 0);
    assertEqual('[6c] markSent 不调', state.markSentCalls.length, 0);
  }

  // [6d] sender 失败 + attempts+1 >= max → markDead
  {
    const { ds, state } = makeFakeDataSource();
    const now = new Date('2026-06-20T10:00:00Z');
    const row: WebhookFallbackLogRow = {
      id: 3,
      channel: 'feishu',
      scenario: 'sendDailyDigestCard',
      webhook_url: 'https://x',
      payload: {},
      last_error: '504',
      last_status_code: 504,
      attempts: 4,
      max_attempts: 5, // attempts+1 = 5 >= 5 → dead
      status: 'pending',
      next_retry_at: now,
      last_attempt_at: null,
      sent_at: null,
      dead_at: null,
      metadata: {},
    };
    state.pendingRows = [row];
    const sum = await retryPendingFallbacks({
      source: ds,
      now,
      dispatchers: {
        sendDailyDigestCard: async () => ({ success: false, message: 'still 504', status_code: 504 }),
      },
    });
    assertEqual('[6d] dead_count=1', sum.dead_count, 1);
    assertEqual('[6d] markDead 调 1 次', state.markDeadCalls.length, 1);
    const md = state.markDeadCalls[0];
    assertEqual('[6d] markDead.id=3', md.id, 3);
    assertEqual('[6d] markDead.last_error', md.last_error, 'still 504');
    assertEqual('[6d] markRetryFailed 不调', state.markRetryFailedCalls.length, 0);
  }

  // [6e] row.scenario 不在 dispatchers → skipped_unknown_scenario
  {
    const { ds, state } = makeFakeDataSource();
    const row: WebhookFallbackLogRow = {
      id: 4,
      channel: 'feishu',
      scenario: 'sendUnknown' as any,
      webhook_url: 'https://x',
      payload: {},
      last_error: '',
      last_status_code: null,
      attempts: 1,
      max_attempts: 5,
      status: 'pending',
      next_retry_at: new Date(),
      last_attempt_at: null,
      sent_at: null,
      dead_at: null,
      metadata: {},
    };
    state.pendingRows = [row];
    const sum = await retryPendingFallbacks({ source: ds, dispatchers: {} });
    assertEqual('[6e] skipped_unknown_scenario_count=1', sum.skipped_unknown_scenario_count, 1);
    assertEqual('[6e] markSent 不调', state.markSentCalls.length, 0);
    assertEqual('[6e] markRetryFailed 不调', state.markRetryFailedCalls.length, 0);
    assertEqual('[6e] markDead 不调', state.markDeadCalls.length, 0);
  }

  // [6f] sender throw → 等价于 success=false (不传染)
  {
    const { ds, state } = makeFakeDataSource();
    const now = new Date();
    const row: WebhookFallbackLogRow = {
      id: 5,
      channel: 'feishu',
      scenario: 'sendDailyDigestCard',
      webhook_url: 'https://x',
      payload: {},
      last_error: 'prev',
      last_status_code: null,
      attempts: 1,
      max_attempts: 5,
      status: 'pending',
      next_retry_at: now,
      last_attempt_at: null,
      sent_at: null,
      dead_at: null,
      metadata: {},
    };
    state.pendingRows = [row];
    const sum = await retryPendingFallbacks({
      source: ds,
      now,
      dispatchers: {
        sendDailyDigestCard: async () => {
          throw new Error('boom');
        },
      },
    });
    assertEqual('[6f] sender throw → retry_failed_count=1', sum.retry_failed_count, 1);
    assertEqual('[6f] sender throw 不传染, 整体 summary.total=1', sum.total, 1);
  }

  // [6g] loadPending throw → 顶层 catch 返空 summary
  {
    const { ds, state } = makeFakeDataSource();
    state.loadPendingShouldThrow = new Error('DB down');
    const sum = await retryPendingFallbacks({ source: ds, dispatchers: {} });
    assertEqual('[6g] DB down → total=0', sum.total, 0);
    assertEqual('[6g] DB down → 不抛', sum.sent_count, 0);
  }

  // [6h] markSent throw → 仅 logger.warn (sent_count 仍 +=1, retry 不传染)
  {
    const { ds, state } = makeFakeDataSource();
    const row: WebhookFallbackLogRow = {
      id: 6,
      channel: 'feishu',
      scenario: 'sendDailyDigestCard',
      webhook_url: 'https://x',
      payload: {},
      last_error: '',
      last_status_code: null,
      attempts: 1,
      max_attempts: 5,
      status: 'pending',
      next_retry_at: new Date(),
      last_attempt_at: null,
      sent_at: null,
      dead_at: null,
      metadata: {},
    };
    state.pendingRows = [row];
    state.markSentShouldThrow = new Error('DB update failed');
    const sum = await retryPendingFallbacks({
      source: ds,
      dispatchers: {
        sendDailyDigestCard: async () => ({ success: true }),
      },
    });
    assertEqual('[6h] markSent throw → sent_count 仍 +=1', sum.sent_count, 1);
  }

  console.log('\n[7] PRODUCTION DataSource smoke...');
  {
    const ds = createProductionWebhookFallbackLogDataSource();
    assert('[7] 工厂返非空对象', !!ds);
    assert('[7] insertFallback 是 function', typeof ds.insertFallback === 'function');
    assert('[7] loadPending 是 function', typeof ds.loadPending === 'function');
    assert('[7] markSent 是 function', typeof ds.markSent === 'function');
    assert('[7] markRetryFailed 是 function', typeof ds.markRetryFailed === 'function');
    assert('[7] markDead 是 function', typeof ds.markDead === 'function');
    // 调一次 insertFallback 在 DB-less 环境 — production 实现 try/catch 返 null 不抛
    const r = await ds.insertFallback({
      channel: 'feishu',
      scenario: 'sendDailyDigestCard',
      webhook_url: 'x',
      payload: {},
      last_error: 'x',
      last_status_code: null,
      attempts: 1,
      max_attempts: 5,
      next_retry_at: new Date(),
      metadata: {},
    });
    assertEqual('[7] DB-less insertFallback → null (not throw)', r, null);
    // loadPending DB-less → []
    const rows = await ds.loadPending(new Date(), 10);
    assertEqual('[7] DB-less loadPending → []', rows, []);
  }

  // =========================================================================
  // Summary
  // =========================================================================
  setTimeout(() => {
    console.log(`\n========================================`);
    console.log(`webhookFailOpen test summary: ${passed} ok / ${failed} failed`);
    console.log(`========================================`);
    process.exit(failed > 0 ? 1 : 0);
  }, 200);
})().catch(err => {
  console.error('unexpected test runner crash:', err);
  process.exit(2);
});
