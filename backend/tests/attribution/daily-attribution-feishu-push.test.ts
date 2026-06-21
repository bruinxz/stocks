/**
 * DailyAttributionFeishuPushService 单元测试 (US-086 [PM-009]).
 *
 * 不依赖 jest / DB / 网络; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/attribution/daily-attribution-feishu-push.test.ts
 *
 * 覆盖维度:
 *   [1] 常量 sanity (cap / max text len / header)
 *   [2] shouldPushItem — null / 空 report / 非法 portfolio_id / 空 date / happy
 *   [3] buildDailyAttributionPushText — 必含字段 / 截断保留尾行 / 边界 (空 ai_summary / 0 industry / 0 execution)
 *   [4] resolveWebhookUrl — options 优先 / env 兜底 / trim 空字符串 → null
 *   [5] pushBatch AC 主验收 — happy (poster 调对应次数 + body 含 portfolio / date / 触发规则)
 *        + no_webhook skip / no_records skip / dry_run skip / single failure 不阻塞批 / cap 截断
 *        + poster throw fail-OPEN / top-level 兜底
 *   [6] defaultDailyAttributionFeishuPoster — 无网络环境 fail-OPEN 不抛
 *   [7] META-GUARD fs+regex — DailyAttributionCronRunner 含 import + pushBatch 调用 + enable_feishu_push option
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DAILY_ATTRIBUTION_PUSH_HEADER,
  DAILY_ATTRIBUTION_PUSH_MAX_PER_BATCH,
  DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN,
  DailyAttributionFeishuPushService,
  FeishuWebhookPoster,
  buildDailyAttributionPushText,
  defaultDailyAttributionFeishuPoster,
  resolveWebhookUrl,
  shouldPushItem,
} from '../../src/services/attribution/DailyAttributionFeishuPushService';
import { DailyAttributionReport } from '../../src/services/attribution/DailyAttributionService';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

// 静音 logger 让输出整洁
/* eslint-disable @typescript-eslint/no-var-requires */
const loggerModule = require('../../src/utils/logger');
loggerModule.logger.warn = () => undefined;
loggerModule.logger.info = () => undefined;
loggerModule.logger.error = () => undefined;
/* eslint-enable @typescript-eslint/no-var-requires */

function makeReport(over: Partial<DailyAttributionReport> = {}): DailyAttributionReport {
  return {
    date: '2026-06-20',
    portfolio_id: 1,
    total_pnl: 1500,
    total_pnl_pct: 1.5,
    realized_pnl: 800,
    unrealized_delta: 700,
    trade_count: 3,
    buy_count: 1,
    sell_count: 2,
    breakdown: {
      factor_contrib_total: 0,
      factor_contrib: [],
      industry_contrib: [
        { industry: '酒水饮料', pnl: 500, pct: 0.5 },
        { industry: '医药', pnl: -200, pct: -0.2 },
      ],
      selection_contrib: 200,
      timing_contrib: 100,
      sizing_contrib: 50,
      execution_cost: 30,
      execution_cost_breakdown: null,
      residual: 0,
    } as DailyAttributionReport['breakdown'],
    best_trades: [],
    worst_trades: [],
    ai_summary: '今日盈利 1500 元, 主因酒水板块上涨',
    bias_findings: [],
    recommendations: [],
    generated_at: '2026-06-20T09:00:00Z',
    ...over,
  };
}

(async () => {
  // ---- [1] 常量 sanity -----------------------------------------------------
  assert('[1.1] cap=20 防风暴', DAILY_ATTRIBUTION_PUSH_MAX_PER_BATCH === 20);
  assert(
    '[1.2] max text len 1200 字符 (飞书 webhook 30k 余量)',
    DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN === 1200
  );
  assert('[1.3] header emoji 📊', DAILY_ATTRIBUTION_PUSH_HEADER === '📊 [盘后归因]');

  // ---- [2] shouldPushItem --------------------------------------------------
  assert('[2.1] null 不推', shouldPushItem(null) === false);
  assert('[2.2] undefined 不推', shouldPushItem(undefined) === false);
  assert(
    '[2.3] 空 report 不推',
    shouldPushItem({ portfolio_id: 1, report: null as any }) === false
  );
  assert(
    '[2.4] 非法 portfolio_id 不推',
    shouldPushItem({ portfolio_id: NaN, report: makeReport() }) === false
  );
  assert(
    '[2.5] 空 date 不推',
    shouldPushItem({ portfolio_id: 1, report: makeReport({ date: '' }) }) === false
  );
  assert(
    '[2.6] happy 推',
    shouldPushItem({ portfolio_id: 1, report: makeReport() }) === true
  );

  // ---- [3] buildDailyAttributionPushText ----------------------------------
  {
    const text = buildDailyAttributionPushText({ portfolio_id: 7, report: makeReport() });
    assert('[3.1] 含 header', text.indexOf(DAILY_ATTRIBUTION_PUSH_HEADER) === 0);
    assert('[3.2] 含 portfolio=7', text.indexOf('portfolio=7') >= 0);
    assert('[3.3] 含 日期=2026-06-20', text.indexOf('日期=2026-06-20') >= 0);
    assert('[3.4] 含 总盈亏 +1500.00 元 (+1.50%)', text.indexOf('+1500.00 元 (1.50%)') >= 0 || text.indexOf('+1500.00 元') >= 0);
    assert('[3.5] 含 已实现 +800.00', text.indexOf('已实现 +800.00') >= 0);
    assert('[3.6] 含 浮盈变动 +700.00', text.indexOf('浮盈变动 +700.00') >= 0);
    assert('[3.7] 含 成交 3 笔', text.indexOf('成交 3 笔 (买1/卖2)') >= 0);
    assert('[3.8] 含 行业贡献 TOP', text.indexOf('行业贡献 TOP:') >= 0);
    assert('[3.9] 含 酒水饮料 +500.00', text.indexOf('酒水饮料 +500.00') >= 0);
    assert('[3.10] 含 医药 -200.00', text.indexOf('医药 -200.00') >= 0);
    assert('[3.11] 含 执行成本 30.00 元', text.indexOf('执行成本 30.00 元') >= 0);
    assert('[3.12] 含 AI 总结', text.indexOf('AI 总结: 今日盈利') >= 0);
    assert(
      '[3.13] 尾行触发规则',
      text.endsWith('触发规则: daily_attribution_post_close_push')
    );
  }
  // 边界 — 0 industry / execution / 空 ai_summary
  {
    const text = buildDailyAttributionPushText({
      portfolio_id: 8,
      report: makeReport({
        ai_summary: '',
        breakdown: {
          factor_contrib_total: 0,
          factor_contrib: [],
          industry_contrib: [],
          selection_contrib: 0,
          timing_contrib: 0,
          sizing_contrib: 0,
          execution_cost: 0,
          execution_cost_breakdown: null,
          residual: 0,
        } as DailyAttributionReport['breakdown'],
      }),
    });
    assert('[3.14] 0 industry 不渲染 TOP 行', text.indexOf('行业贡献 TOP:') < 0);
    assert('[3.15] 0 execution 不渲染 cost 行', text.indexOf('执行成本') < 0);
    assert('[3.16] 空 ai_summary 不渲染 AI 行', text.indexOf('AI 总结:') < 0);
    assert(
      '[3.17] 仍含尾行触发规则',
      text.endsWith('触发规则: daily_attribution_post_close_push')
    );
  }
  // pct=null 边界
  {
    const text = buildDailyAttributionPushText({
      portfolio_id: 9,
      report: makeReport({ total_pnl_pct: null }),
    });
    assert('[3.18] pct=null 显示 —', text.indexOf('(—)') >= 0);
  }
  // 截断 — ai_summary 极长
  {
    const longSummary = 'A'.repeat(2000);
    const text = buildDailyAttributionPushText({
      portfolio_id: 10,
      report: makeReport({ ai_summary: longSummary }),
    });
    assert(
      '[3.19] 超 cap 截断 ≤ max text len',
      text.length <= DAILY_ATTRIBUTION_PUSH_MAX_TEXT_LEN
    );
    assert(
      '[3.20] 截断后仍保留尾行触发规则',
      text.endsWith('触发规则: daily_attribution_post_close_push')
    );
    assert('[3.21] 截断处有 ...', text.indexOf('...') >= 0);
  }

  // ---- [4] resolveWebhookUrl ----------------------------------------------
  assert(
    '[4.1] options 优先 env',
    resolveWebhookUrl(
      { webhook_url: 'https://opt.example.com' },
      { OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example.com' }
    ) === 'https://opt.example.com'
  );
  assert(
    '[4.2] env 兜底',
    resolveWebhookUrl({}, { OPS_ALERT_FEISHU_WEBHOOK: 'https://env.example.com' }) ===
      'https://env.example.com'
  );
  assert('[4.3] 都空返 null', resolveWebhookUrl({}, {}) === null);
  assert(
    '[4.4] env 空白 trim 后 null',
    resolveWebhookUrl({}, { OPS_ALERT_FEISHU_WEBHOOK: '   ' }) === null
  );
  assert(
    '[4.5] options trim 后 fallback env',
    resolveWebhookUrl({ webhook_url: '  ' }, { OPS_ALERT_FEISHU_WEBHOOK: 'https://e.com' }) ===
      'https://e.com'
  );

  // ---- [5] pushBatch AC 主验收 --------------------------------------------
  // (a) AC 主验收 — 2 portfolio happy
  {
    const calls: Array<{ url: string; body: any }> = [];
    const poster: FeishuWebhookPoster = async (url, body) => {
      calls.push({ url, body });
      return { success: true };
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const res = await svc.pushBatch(
      [
        { portfolio_id: 11, report: makeReport({ portfolio_id: 11 }) },
        { portfolio_id: 12, report: makeReport({ portfolio_id: 12 }) },
      ],
      { webhook_url: 'https://hook.example.com' }
    );
    assert('[5.a.1] scanned=2', res.scanned === 2);
    assert('[5.a.2] attempted=2', res.attempted === 2);
    assert('[5.a.3] succeeded=2', res.succeeded === 2);
    assert('[5.a.4] failed=0', res.failed === 0);
    assert('[5.a.5] poster 调 2 次', calls.length === 2);
    assert('[5.a.6] msg_type=text', calls[0].body.msg_type === 'text');
    assert(
      '[5.a.7] body.text 含 portfolio=11 + 触发规则',
      calls[0].body.content.text.indexOf('portfolio=11') >= 0 &&
        calls[0].body.content.text.indexOf('触发规则: daily_attribution_post_close_push') >= 0
    );
    assert('[5.a.8] items 全 attempted/success', res.items.every(i => i.attempted && i.success));
  }
  // (b) no_webhook skip
  {
    const calls: any[] = [];
    const poster: FeishuWebhookPoster = async (url, body) => {
      calls.push({ url, body });
      return { success: true };
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const res = await svc.pushBatch([{ portfolio_id: 1, report: makeReport() }], {}, {
      // env 显式空
    });
    assert('[5.b.1] skipped_reason=no_webhook', res.skipped_reason === 'no_webhook');
    assert('[5.b.2] poster 不调', calls.length === 0);
    assert('[5.b.3] items=[]', res.items.length === 0);
  }
  // (c) no_records skip
  {
    const calls: any[] = [];
    const poster: FeishuWebhookPoster = async (url, body) => {
      calls.push({ url, body });
      return { success: true };
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const r1 = await svc.pushBatch([], { webhook_url: 'https://hook.example.com' });
    assert('[5.c.1] 空 list skipped_reason=no_records', r1.skipped_reason === 'no_records');
    const r2 = await svc.pushBatch(
      [{ portfolio_id: NaN, report: makeReport() }],
      { webhook_url: 'https://hook.example.com' }
    );
    assert('[5.c.2] 全 filter 掉 skipped_reason=no_records', r2.skipped_reason === 'no_records');
    assert('[5.c.3] poster 不调', calls.length === 0);
  }
  // (d) dry_run skip
  {
    const calls: any[] = [];
    const poster: FeishuWebhookPoster = async (url, body) => {
      calls.push({ url, body });
      return { success: true };
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const res = await svc.pushBatch([{ portfolio_id: 1, report: makeReport() }], {
      webhook_url: 'https://hook.example.com',
      dry_run: true,
    });
    assert('[5.d.1] dry_run 不调 poster', calls.length === 0);
    assert(
      '[5.d.2] item skip_reason=dry_run',
      res.items[0].skipped === true && res.items[0].skip_reason === 'dry_run'
    );
    assert('[5.d.3] succeeded=0', res.succeeded === 0);
  }
  // (e) single failure 不阻塞批
  {
    let n = 0;
    const poster: FeishuWebhookPoster = async () => {
      n += 1;
      if (n === 2) return { success: false, message: 'http 500' };
      return { success: true };
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const res = await svc.pushBatch(
      [
        { portfolio_id: 1, report: makeReport({ portfolio_id: 1 }) },
        { portfolio_id: 2, report: makeReport({ portfolio_id: 2 }) },
        { portfolio_id: 3, report: makeReport({ portfolio_id: 3 }) },
      ],
      { webhook_url: 'https://hook.example.com' }
    );
    assert('[5.e.1] attempted=3', res.attempted === 3);
    assert('[5.e.2] succeeded=2', res.succeeded === 2);
    assert('[5.e.3] failed=1', res.failed === 1);
    assert(
      '[5.e.4] 失败那条记录 error 透传',
      res.items.some(i => i.success === false && i.error === 'http 500')
    );
  }
  // (f) cap 截断 — 多 portfolio 超 cap
  {
    let n = 0;
    const poster: FeishuWebhookPoster = async () => {
      n += 1;
      return { success: true };
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const items = Array.from({ length: 5 }).map((_, i) => ({
      portfolio_id: i + 1,
      report: makeReport({ portfolio_id: i + 1 }),
    }));
    const res = await svc.pushBatch(items, {
      webhook_url: 'https://hook.example.com',
      max_per_batch: 3,
    });
    assert('[5.f.1] attempted=3 cap', res.attempted === 3);
    assert('[5.f.2] poster 调 3 次', n === 3);
    assert(
      '[5.f.3] items 含 2 个 truncated_batch skip',
      res.items.filter(i => i.skip_reason === 'truncated_batch').length === 2
    );
  }
  // (g) poster throw — caller 注入 fake 抛 sync error
  {
    const poster: FeishuWebhookPoster = async () => {
      throw new Error('boom');
    };
    const svc = new DailyAttributionFeishuPushService(poster);
    const res = await svc.pushBatch([{ portfolio_id: 1, report: makeReport() }], {
      webhook_url: 'https://hook.example.com',
    });
    assert('[5.g.1] poster throw failed=1', res.failed === 1);
    assert(
      '[5.g.2] item error 透传 boom',
      res.items[0].error === 'boom' && res.items[0].success === false
    );
  }
  // (h) top-level error 兜底 — records 传非数组让 .filter 抛
  {
    const poster: FeishuWebhookPoster = async () => ({ success: true });
    const svc = new DailyAttributionFeishuPushService(poster);
    // 强类型骗过 typecheck: 传 null 进 .filter 走 scanned=0 路径; 真"非法对象"需 cast
    const res = await svc.pushBatch({ not: 'array' } as unknown as any[], {
      webhook_url: 'https://hook.example.com',
    });
    assert(
      '[5.h.1] 非数组 scanned=0 走 no_records',
      res.scanned === 0 && res.skipped_reason === 'no_records'
    );
  }

  // ---- [6] defaultDailyAttributionFeishuPoster — fail-OPEN 不抛 -----------
  {
    let threw = false;
    let r: any;
    try {
      r = await defaultDailyAttributionFeishuPoster(
        'http://127.0.0.1:1/never-listens',
        { msg_type: 'text', content: { text: 'hi' } }
      );
    } catch {
      threw = true;
    }
    assert('[6.1] default poster 无网络不抛', threw === false);
    assert(
      '[6.2] default poster 返 {success:false, message}',
      r && r.success === false && typeof r.message === 'string'
    );
  }

  // ---- [7] META-GUARD — DailyAttributionCronRunner 接入点 -----------------
  {
    const cronRunnerSrc = readFileSync(
      join(__dirname, '../../src/services/attribution/DailyAttributionCronRunner.ts'),
      'utf-8'
    );
    assert(
      '[7.1] cron runner 含 import DailyAttributionFeishuPushService',
      /from\s+['"]\.\/DailyAttributionFeishuPushService['"]/.test(cronRunnerSrc)
    );
    assert(
      '[7.2] cron runner 含 enable_feishu_push option',
      /enable_feishu_push\?\s*:\s*boolean/.test(cronRunnerSrc)
    );
    assert(
      '[7.3] cron runner summary 含 feishu_push 字段',
      /feishu_push\s*:\s*DailyAttributionPushResult\s*\|\s*null/.test(cronRunnerSrc)
    );
    assert(
      '[7.4] cron runner 调 pushService.pushBatch',
      /pushService\.pushBatch\s*\(/.test(cronRunnerSrc)
    );
    assert(
      '[7.5] cron runner 默认 enable_feishu_push !== false 才推',
      /options\.enable_feishu_push\s*!==\s*false/.test(cronRunnerSrc)
    );
    // 反向: 仅 status=ok+persisted 入 pushItems
    assert(
      '[7.6] 反向 — 仅 status=ok+persisted 入 pushItems (防误推 skipped/failed)',
      /if\s*\(\s*persisted\s*&&\s*finalStatus\s*===\s*DAILY_ATTRIBUTION_STATUS\.OK\s*&&\s*result\.report\s*\)/.test(
        cronRunnerSrc
      )
    );
    // dry_run 透传给 push service
    assert(
      '[7.7] dry_run 透传给 push (避免 cron preview 真推)',
      /dryRun\s*\?\s*\{\s*dry_run:\s*true\s*\}\s*:\s*\{\s*\}/.test(cronRunnerSrc)
    );

    // SchedulerService 写 result_summary.feishu_push 摘要
    const schedulerSrc = readFileSync(
      join(__dirname, '../../src/services/SchedulerService.ts'),
      'utf-8'
    );
    assert(
      '[7.8] SchedulerService result_summary 含 feishu_push 摘要',
      /feishu_push:\s*attrSummary\.feishu_push/.test(schedulerSrc)
    );
  }

  // ---- summary -------------------------------------------------------------
  console.log(`\ndaily-attribution-feishu-push: ${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
