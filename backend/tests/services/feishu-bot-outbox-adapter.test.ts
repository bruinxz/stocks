import { FeishuBotWebhookService } from '../../src/services/FeishuBotWebhookService';
import { sendProductionFeishuWebhook } from '../../src/services/FeishuNotificationService';

let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function main() {
  const queued: any[] = [];
  const notifications = {
    async enqueueAndDeliver(input: any) {
      queued.push(input);
      return { success: true, status: 'sent', outbox_id: queued.length, attempts: 1 };
    },
  };
  const service = new FeishuBotWebhookService(notifications as any);
  const card = { msg_type: 'interactive', card: { elements: [] } };

  const daily = await service.sendDailyDigestCard(
    { user_id: 9, trade_date: '2026-07-19' },
    'https://open.feishu.cn/open-apis/bot/v2/hook/ignored',
    { buildCard: () => card }
  );
  assert('daily digest enqueued successfully', daily.success === true);
  assert(
    'daily digest routes to user audience',
    queued[0].audience === 'user' && queued[0].recipient_user_id === 9
  );
  assert(
    'daily digest exact-date idempotency',
    queued[0].idempotency_key === 'daily-trading-digest:9:2026-07-19'
  );

  await service.sendEarningsForecastCard(
    { user_id: 9, event_id: 77, symbol: '600519' },
    'https://open.feishu.cn/open-apis/bot/v2/hook/ignored',
    { buildCard: () => card }
  );
  assert('earnings uses event id', queued[1].idempotency_key === 'earnings-forecast:9:77');

  await service.sendRiskAlertCard(
    { alert_id: 88, user_id: 9, symbol: '600519', rule_id: 'stop' },
    'https://open.feishu.cn/open-apis/bot/v2/hook/ignored',
    { buildCard: () => card }
  );
  assert('user risk alert stays user audience', queued[2].audience === 'user');

  await service.sendRiskAlertCard(
    { alert_id: 89, symbol: 'SYSTEM:DB', rule_id: 'db_down' },
    'https://open.feishu.cn/open-apis/bot/v2/hook/ignored',
    { buildCard: () => card }
  );
  assert('system risk alert routes ops', queued[3].audience === 'ops');

  const badBuild = await service.sendRiskAlertCard(
    { alert_id: 90, symbol: '600519' },
    'https://open.feishu.cn/open-apis/bot/v2/hook/ignored',
    {
      buildCard: () => {
        throw new Error('bad card');
      },
    }
  );
  assert('card build error remains fail-open', badBuild.success === false && queued.length === 4);

  const blocked = await sendProductionFeishuWebhook('http://10.0.0.1/internal', {
    msg_type: 'text',
    content: { text: 'x' },
  });
  assert('central sender keeps SSRF guard', blocked.success === false);

  console.log(`[feishu-bot-outbox-adapter] ${6 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
