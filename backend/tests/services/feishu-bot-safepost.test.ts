/**
 * FeishuBotWebhookService.safePost regression — Batch BF-0 (2026-06-23)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/feishu-bot-safepost.test.ts
 *
 * 背景: 历史上 (commit 5174f49 Batch AI 引入) safePost 写成了
 *   return this.safePost(url, body)   // 自己调自己 → stack overflow
 * 导致 4 处 caller (sendDailyDigestCard / sendEarningsForecastCard /
 * sendRiskAlertCard / sendRecommendationSummary) 全部 throw 走 fail-OPEN warn,
 * 飞书机器人卡片在 prod 一条都发不出 (combined.log 显示每分钟多次"推送异常").
 *
 * 本测试确认 fix 后:
 *   1. safePost 调一次只走一次 http.post (不是无穷递归)
 *   2. WEBHOOK_URL_INVALID URL 仍 throw (validateWebhookUrl 仍生效)
 *   3. 4 处 caller 在合法 URL + buildCard helper 下都能返回 success=true
 */

import { feishuBotWebhookService } from '../../src/services/FeishuBotWebhookService';

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

async function main() {
  const goodUrl = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-token-for-test';

  // 用 monkey-patch 替换 this.http.post 让测试完全脱网络
  const svc: any = feishuBotWebhookService;
  let postCalls = 0;
  const origPost = svc.http.post.bind(svc.http);
  svc.http.post = async (_url: string, _body: any) => {
    postCalls += 1;
    return { data: { code: 0 } };
  };

  try {
    // ---- (1) sendDailyDigestCard ----
    postCalls = 0;
    const r1 = await feishuBotWebhookService.sendDailyDigestCard(
      { user_id: 1, trade_date: '2026-06-23' },
      goodUrl,
      { buildCard: () => ({ msg_type: 'interactive', card: { elements: [] } }) }
    );
    assert(
      'sendDailyDigestCard - safePost 调 1 次 http.post (不递归)',
      postCalls === 1,
      `postCalls=${postCalls}`
    );
    assert(
      'sendDailyDigestCard - success=true',
      r1.success === true,
      JSON.stringify(r1)
    );

    // ---- (2) sendEarningsForecastCard ----
    postCalls = 0;
    const r2 = await feishuBotWebhookService.sendEarningsForecastCard(
      { user_id: 1, symbol: 'sh.600519' },
      goodUrl,
      { buildCard: () => ({ msg_type: 'interactive', card: { elements: [] } }) }
    );
    assert(
      'sendEarningsForecastCard - safePost 调 1 次 http.post',
      postCalls === 1,
      `postCalls=${postCalls}`
    );
    assert(
      'sendEarningsForecastCard - success=true',
      r2.success === true,
      JSON.stringify(r2)
    );

    // ---- (3) sendRiskAlertCard ----
    postCalls = 0;
    const r3 = await feishuBotWebhookService.sendRiskAlertCard(
      { alert_id_dispatch: 'ALERT-1-20260623-0001', symbol: 'sh.600519' },
      goodUrl,
      { buildCard: () => ({ msg_type: 'interactive', card: { elements: [] } }) }
    );
    assert(
      'sendRiskAlertCard - safePost 调 1 次 http.post',
      postCalls === 1,
      `postCalls=${postCalls}`
    );
    assert(
      'sendRiskAlertCard - success=true',
      r3.success === true,
      JSON.stringify(r3)
    );

    // ---- (4) 非法 URL 仍 throw 走 fail-OPEN ----
    postCalls = 0;
    const r4 = await feishuBotWebhookService.sendRiskAlertCard(
      { alert_id_dispatch: 'ALERT-1-20260623-0002', symbol: 'sh.600519' },
      'http://10.0.0.1/x',
      { buildCard: () => ({ msg_type: 'interactive', card: { elements: [] } }) }
    );
    assert(
      '内网 URL - 不会 fall through 到 http.post',
      postCalls === 0,
      `postCalls=${postCalls}`
    );
    assert('内网 URL - success=false', r4.success === false, JSON.stringify(r4));

    // ---- (5) Lark CN host (open.larkoffice.com) 走通 ----
    postCalls = 0;
    const larkCnUrl =
      'https://open.larkoffice.com/open-apis/bot/v2/hook/fake-token-for-test';
    const r5 = await feishuBotWebhookService.sendRiskAlertCard(
      { alert_id_dispatch: 'ALERT-1-20260623-0003', symbol: 'sh.600519' },
      larkCnUrl,
      { buildCard: () => ({ msg_type: 'interactive', card: { elements: [] } }) }
    );
    assert(
      'open.larkoffice.com host - allowlist 放行',
      postCalls === 1,
      `postCalls=${postCalls}`
    );
    assert(
      'open.larkoffice.com host - success=true',
      r5.success === true,
      JSON.stringify(r5)
    );
  } finally {
    svc.http.post = origPost;
  }

  console.log('========================================');
  console.log(`feishu-bot-safepost test summary: ${passed} ok / ${failed} failed`);
  console.log('========================================');
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('test unexpected error:', err);
  process.exit(1);
});
