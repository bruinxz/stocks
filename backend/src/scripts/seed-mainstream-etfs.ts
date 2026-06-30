#!/usr/bin/env node
/**
 * Seed mainstream ETFs into `stocks` table (PR-F 2026-06-29).
 *
 * 系统原本不覆盖 ETF (stocks 表只有 5500 A 股, 0 只 ETF). 这导致:
 *   - universe-based 任何遍历 (daily_bar 同步 / factor 计算 / 推荐) 都跳过 ETF
 *   - 用户问 "通信 ETF 买哪个" 系统答不出
 *
 * 本脚本把 `constants/etfIndustry.ts` 白名单 70+ 只主流 ETF 注入 stocks 表,
 * 让 universe 覆盖 ETF, daily_bar / factor 等下游 pipeline 自然覆盖.
 *
 * 行约定:
 *   - symbol: 'sh.515050' / 'sz.159995' 格式 (上交所 5xx/588 = sh; 深交所 159 = sz);
 *     部分宽基 / 港股 ETF 用 'sh.510300' 等具体规则.
 *   - name: ETF_PROFILES[i].name (白名单维护; 实际入库时若 AKShare 后续给更准的名,
 *     由 ETFFlow / sync-history 二次更新)
 *   - market: 'SH' or 'SZ'
 *   - industry: 'ETF' (区分于 A 股的 "电子" / "医药" 等中信一级行业)
 *   - type: 'fund' (现有 Stock model 已定义此字段, comment="stock, index, fund, bond")
 *   - listing_date: null (不必要; ETF 是基金, 上市日不影响推荐)
 *   - is_listed: true
 *
 * 幂等: 按 symbol findOrCreate; 已存在则跳过 (不覆盖已有 name / type / industry,
 * 避免冲掉运营手工调整).
 *
 * Usage:
 *   cd backend && node dist/scripts/seed-mainstream-etfs.js
 *   cd backend && node dist/scripts/seed-mainstream-etfs.js --force  (覆盖 type/industry)
 */

import { Command } from 'commander';
import sequelize from '../config/database';
import '../models';
import { Stock } from '../models/Stock';
import { logger } from '../utils/logger';
import { ETF_PROFILES, ETFProfile } from '../constants/etfIndustry';

/**
 * 6 位代码 → "sh.XXXXXX" / "sz.XXXXXX" symbol 转换.
 *
 * 规则 (A 股 ETF 命名约定):
 *   - 上交所基金 (5xx, 6xx, 588): sh. 前缀
 *   - 深交所基金 (159 开头): sz. 前缀
 *   - 其他 (理论上不应出现在 ETF 白名单): 默认 sh.
 */
export function codeToSymbol(code: string, market: 'SH' | 'SZ'): string {
  return `${market.toLowerCase()}.${code}`;
}

/**
 * 6 位 ETF code 推断交易所.
 *
 * 上交所 ETF: 5xx 或 588xx 开头.
 * 深交所 ETF: 159 开头.
 *
 * AKShare 当前白名单 (PR-F 70+ 只) 覆盖率 100%.
 */
export function inferMarket(code: string): 'SH' | 'SZ' {
  if (/^159/.test(code)) return 'SZ';
  if (/^5/.test(code)) return 'SH';
  if (/^588/.test(code)) return 'SH';
  return 'SH';
}

interface SeedResult {
  total: number;
  created: number;
  existed: number;
  updated: number;
  failed: number;
}

async function seedMainstreamEtfs(force: boolean): Promise<SeedResult> {
  const result: SeedResult = { total: 0, created: 0, existed: 0, updated: 0, failed: 0 };
  for (const profile of ETF_PROFILES) {
    result.total += 1;
    const market = inferMarket(profile.code);
    const symbol = codeToSymbol(profile.code, market);
    try {
      const [row, created] = await Stock.findOrCreate({
        where: { symbol },
        defaults: {
          symbol,
          name: profile.name,
          market,
          industry: 'ETF',
          type: 'fund',
          is_listed: true,
          data_status: 'complete',
        } as any,
      });
      if (created) {
        result.created += 1;
        logger.info(`[seed-mainstream-etfs] created ${symbol} (${profile.name})`);
      } else if (force) {
        const patch: any = {};
        if (row.industry !== 'ETF') patch.industry = 'ETF';
        if (row.type !== 'fund') patch.type = 'fund';
        if (!row.name) patch.name = profile.name;
        if (!row.market) patch.market = market;
        if (Object.keys(patch).length > 0) {
          await row.update(patch);
          result.updated += 1;
          logger.info(`[seed-mainstream-etfs] updated ${symbol} -> ${JSON.stringify(patch)}`);
        } else {
          result.existed += 1;
        }
      } else {
        result.existed += 1;
      }
    } catch (e) {
      result.failed += 1;
      logger.error(`[seed-mainstream-etfs] FAIL ${symbol}: ${(e as Error).message}`);
    }
  }
  return result;
}

const program = new Command();

program
  .name('seed-mainstream-etfs')
  .description('PR-F: seed mainstream ETFs into stocks table (universe coverage)')
  .option('--force', '覆盖已存在 ETF 行的 industry/type/name (默认只插不更新)', false)
  .action(async opts => {
    try {
      await sequelize.authenticate();
      logger.info(`[seed-mainstream-etfs] DB connected. force=${!!opts.force}`);
      const r = await seedMainstreamEtfs(!!opts.force);
      logger.info(
        `[seed-mainstream-etfs] done total=${r.total} created=${r.created} existed=${r.existed} updated=${r.updated} failed=${r.failed}`
      );
      // 任何 failed 都标失败让 cron / ops 注意
      process.exit(r.failed > 0 ? 1 : 0);
    } catch (e) {
      logger.error(`[seed-mainstream-etfs] FATAL: ${(e as Error).message}`);
      process.exit(1);
    }
  });

// 仅在直接运行时启动 CLI; import (e.g. 单元测试) 时不触发 DB connect.
if (require.main === module) {
  program.parseAsync(process.argv);
}

export { seedMainstreamEtfs };
