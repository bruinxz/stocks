#!/usr/bin/env node
/**
 * RSS 财经新闻同步 CLI (§6.1 主渠道 RSS)
 *
 * 拉合规 RSS 源 (新浪财经 / 财联社 …) → 关键词题材兜底 → market_news 表。
 * 定时建议: 交易日每 30-60 分钟一次 (盘中 news 时效性强)。
 *
 * Usage:
 *   npm run sync:rss-news                       # 默认源, 写库 + 清理 30 天前
 *   npm run sync:rss-news -- --dry-run          # 只解析看命中, 不写库
 *   npm run sync:rss-news -- --retention=30     # 自定义保留天数 (0=不清理)
 *   npm run sync:rss-news -- --timeout=20000
 *
 * feed 列表可用环境变量 RSS_NEWS_FEEDS (JSON 数组) 覆盖, 不改代码切换源。
 *
 * 退出码: 0=成功 · 2=致命错误
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { rssNewsIngestService } from '../services/news/RssNewsIngestService';

async function main() {
  const program = new Command();
  program
    .name('sync-rss-news')
    .description('同步合规 RSS 财经新闻 → market_news (§6.1)')
    .option('--dry-run', '只解析不写库', false)
    .option('--retention <n>', '保留天数 (0=不清理)', '30')
    .option('--timeout <ms>', 'HTTP 超时 ms', '15000');
  program.parse(process.argv);
  const opts = program.opts();

  const result = await rssNewsIngestService.run({
    dryRun: Boolean(opts.dryRun),
    retentionDays: Number(opts.retention),
    timeoutMs: Number(opts.timeout),
  });

  console.log('');
  console.log('============ RSS 财经新闻同步 (§6.1) ============');
  console.log(`模式: ${result.dry_run ? 'dry-run (不写库)' : '写库'}`);
  for (const f of result.feeds) {
    const tag = f.error ? `❌ ${f.error}` : `抓${f.fetched} 新增${f.created} 更新${f.updated} 命中题材${f.matched_theme}`;
    console.log(`  [${f.source}] ${f.name}: ${tag}`);
  }
  console.log('------------------------------------------------');
  console.log(`合计: 抓 ${result.total_fetched} · 新增 ${result.total_created} · 更新 ${result.total_updated} · 命中题材 ${result.total_matched_theme} · 清理 ${result.purged}`);
  console.log('================================================');
  console.log('');

  await sequelize.close();
  process.exit(0);
}

main().catch(async err => {
  logger.error(`sync-rss-news 致命错误: ${err?.stack || err}`);
  try { await sequelize.close(); } catch { /* noop */ }
  process.exit(2);
});
