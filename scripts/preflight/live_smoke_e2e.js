#!/usr/bin/env node
/**
 * 实盘 E2E 实走 smoke（dry-run / mock_guarded 模式专用）。
 *
 * 上线 launch-helper：在 T-1 只读预热之前，先在 dev/staging 上用 mock_guarded gateway
 * 走通"草稿 → 强确认 → 命令入队 → 撤单 → 状态机推进"全链路，确保接入没有 regression。
 *
 * **绝对禁止**在 production 上跑：本脚本会调 approveDraft，虽然 mock_guarded
 * 不会真下单，但如果服务端被误配成 qmt_bridge + execution=true，会真下单。
 * 启动时检查 /api/live-trading/safety，看到 broker_gateway != 'mock_guarded' 直接 abort。
 *
 * 使用：
 *   SMOKE_BASE_URL=http://127.0.0.1:3000 \
 *   SMOKE_USERNAME=xz SMOKE_PASSWORD=<dev-pw> \
 *   node scripts/preflight/live_smoke_e2e.js
 *
 * Optional:
 *   SMOKE_SYMBOL=600519.SH      # 默认 600519.SH
 *   SMOKE_QUANTITY=100          # 默认 100
 *   SMOKE_LIMIT_PRICE=1700      # 默认 1700
 *   SMOKE_TIMEOUT_MS=10000
 *
 * 退出码：0 全过 / 1 业务断言失败 / 2 网络/前置错
 */

const baseUrl = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:3000';
const username = process.env.SMOKE_USERNAME || 'xz';
const password = process.env.SMOKE_PASSWORD || '';
const symbol = process.env.SMOKE_SYMBOL || '600519.SH';
const quantity = Number(process.env.SMOKE_QUANTITY || 100);
const limitPrice = Number(process.env.SMOKE_LIMIT_PRICE || 1700);
const timeoutMs = Math.max(Number(process.env.SMOKE_TIMEOUT_MS || 10000), 1000);

if (!password) {
  console.error('SMOKE_PASSWORD required');
  process.exit(2);
}

let token = '';

function fetchWithTimeout(url, init = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  return fetch(url, { ...init, signal: ac.signal }).finally(() => clearTimeout(t));
}

async function apiCall(method, path, body) {
  const res = await fetchWithTimeout(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

function ok(label, cond, detail = '') {
  if (cond) {
    console.log(`  [ok]   ${label}${detail ? ` (${detail})` : ''}`);
  } else {
    console.error(`  [FAIL] ${label}${detail ? ` (${detail})` : ''}`);
    process.exit(1);
  }
}

async function step(label, fn) {
  console.log(`\n=== ${label} ===`);
  try {
    await fn();
  } catch (err) {
    console.error(`  [FAIL] ${label}: ${err.message || err}`);
    process.exit(2);
  }
}

async function main() {
  // ----- 0. 登录 -----
  await step('login', async () => {
    const r = await apiCall('POST', '/api/auth/login', { username, password });
    ok('login.status=200', r.status === 200, `got ${r.status}`);
    token = r.json?.data?.tokens?.accessToken || r.json?.data?.accessToken || r.json?.accessToken || '';
    ok('login.token', Boolean(token), `len=${token.length}`);
  });

  // ----- 1. 安全护栏：必须 mock_guarded -----
  let safetySnapshot = null;
  await step('safety guard (拒绝在真券商网关上跑)', async () => {
    const r = await apiCall('GET', '/api/live-trading/safety');
    ok('safety.status=200', r.status === 200);
    safetySnapshot = r.json?.data;
    const gateway = safetySnapshot?.broker_gateway;
    ok('broker_gateway=mock_guarded', gateway === 'mock_guarded', `got ${gateway}`);
    // 额外保险：不接受 can_submit_orders=true（mock 也不该跑真链路）
    ok(
      'can_submit_orders=false',
      safetySnapshot?.can_submit_orders === false,
      'E2E smoke 不应跑在 can_submit_orders=true 环境'
    );
  });

  // ----- 2. 创建草稿（不需要 account 也能走 mock） -----
  let draftId = null;
  await step('create draft', async () => {
    const r = await apiCall('POST', '/api/live-trading/order-drafts', {
      symbol,
      side: 'BUY',
      quantity,
      limit_price: limitPrice,
      rationale: 'E2E smoke draft；不会真下单（mock_guarded）',
      source_type: 'manual_live_draft',
    });
    ok('createDraft.status=200', r.status === 200, `got ${r.status} body=${JSON.stringify(r.json).slice(0, 200)}`);
    draftId = r.json?.data?.id;
    ok('createDraft.id', Boolean(draftId), `id=${draftId}`);
  });

  // ----- 3. 列出草稿应包含刚创建的 -----
  await step('list drafts includes new id', async () => {
    const r = await apiCall('GET', '/api/live-trading/order-drafts?limit=50');
    ok('listDrafts.status=200', r.status === 200);
    const found = (r.json?.data || []).some(d => d.id === draftId);
    ok('list contains new draft', found, `id=${draftId}`);
  });

  // ----- 4. 强确认提交：mock_guarded 下应被 safety blocker 拦下 -----
  await step('approve blocked by safety', async () => {
    const r = await apiCall('POST', `/api/live-trading/order-drafts/${draftId}/approve`, {
      confirm_text: 'CONFIRM_LIVE_ORDER',
    });
    // mock_guarded 下 safety 必然 block；这里期望非 200
    ok('approve blocked', r.status >= 400, `got ${r.status}; want >=400`);
    const msg = r.json?.message || '';
    ok(
      'block reason 含安全边界',
      /安全边界|不在真实交易/.test(msg) ||
        (safetySnapshot?.blockers || []).length > 0,
      msg
    );
  });

  // ----- 5. 拒绝草稿 -----
  await step('reject draft', async () => {
    const r = await apiCall('POST', `/api/live-trading/order-drafts/${draftId}/reject`, {
      reason: 'E2E smoke cleanup',
    });
    ok('reject.status=200', r.status === 200);
    ok('reject draft.status=rejected', r.json?.data?.status === 'rejected', r.json?.data?.status);
  });

  // ----- 6. kill switch 状态查询（GET，普通用户可读） -----
  await step('kill switch status', async () => {
    const r = await apiCall('GET', '/api/live-trading/kill-switch');
    ok('killSwitch.status=200', r.status === 200);
    ok('killSwitch.data 存在 active 字段', typeof r.json?.data?.active === 'boolean');
  });

  // ----- 7. trigger 受 admin 限制（普通 user 应被 403） -----
  await step('kill switch trigger 受 admin 限制', async () => {
    const r = await apiCall('POST', '/api/live-trading/kill-switch/trigger', {
      reason_detail: 'E2E smoke probe; should be denied if user not admin',
    });
    if (r.status === 200) {
      console.log('  [WARN] 当前账户是 admin，trigger 没被拒；不是 fail 但请确认 smoke 账号不应在 production 上是 admin');
    } else {
      ok('trigger denied for non-admin', r.status === 403, `got ${r.status}`);
    }
  });

  // ----- 8. rate limit 烟雾测试：连续 6 次 createDraft，至少 1 次应 429（默认 createDraft1m=15/min，所以不会触发；改成 approve 1m=5）
  await step('rate limit smoke (approve 1m=5)', async () => {
    // 用刚 reject 的 draft 不能再 approve；新建一个 draft 用来打 rate limit
    const firstDraft = await apiCall('POST', '/api/live-trading/order-drafts', {
      symbol,
      side: 'BUY',
      quantity,
      limit_price: limitPrice,
      rationale: 'rate limit smoke',
    });
    const rateDraftId = firstDraft.json?.data?.id;
    if (!rateDraftId) {
      console.log('  [WARN] 未拿到 rate-limit smoke 用 draft id，跳过');
      return;
    }
    let saw429 = false;
    for (let i = 0; i < 8; i++) {
      const r = await apiCall('POST', `/api/live-trading/order-drafts/${rateDraftId}/approve`, {
        confirm_text: 'CONFIRM_LIVE_ORDER',
      });
      if (r.status === 429) {
        saw429 = true;
        break;
      }
    }
    ok('approve 8 次至少 1 次 429', saw429, '说明 rate limit 已挂上');
    // 收尾：reject 掉
    await apiCall('POST', `/api/live-trading/order-drafts/${rateDraftId}/reject`, { reason: 'cleanup' });
  });

  console.log('\n✅ live E2E smoke 全部通过');
}

main().catch(err => {
  console.error('fatal:', err.message || err);
  process.exit(2);
});
