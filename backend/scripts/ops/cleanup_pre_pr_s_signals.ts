/**
 * cleanup_pre_pr_s_signals.ts — PR-U (2026/06/30)
 *
 * 背景:
 *   PR-S (commit ab59ca8 @ 14:20 BJ, prod 部署 ~14:30 BJ) 把
 *   IntradayPriceVolumeAnomalyDetector 的 source_id 从
 *     `pv_anomaly::TYPE::SYMBOL::DATE::SLOT`          (5 段, 含 30min slot 序号)
 *   改成
 *     `pv_anomaly::TYPE::SYMBOL::DATE`                (4 段, 一日一稳定 ID)
 *   并改用 findOrCreate UPSERT, 使一天最多写 1 条 / (symbol, anomaly_type).
 *
 *   PR-S 上线前 (11:00 ~ 14:00 BJ) 每 30 min cron 都写了一行新 row, 留下 ~21
 *   条 5-段旧格式 row. V3 dedup (PR-S B3) 已让用户端只看到 1 张卡 / symbol, 但
 *   DB 里这些重复 row 还在.
 *
 * 安全约束 (P0 — 别误删 audit 历史):
 *   - 用户硬约束: "绝不删跌票被 PR-S filter 后已不会复现的 row" (audit 历史).
 *     例: sh.600160 -7.51% / sh.600707 -7.50% 这俩跌票被 PR-S B2 价格方向 guard
 *     直接 reject, PR-S 上线后不会再有新 row. 它们的旧 row 必须保留作 bug audit.
 *   - 安全锚: **只删那些 (symbol, anomaly_type) 在 14:30 后已经被 PR-S 重写过一遍
 *     "新 4 段" canonical row 的旧 row**. 没有新 canonical → 不动 (要么是 audit
 *     历史, 要么是 universe 漂移没复现, 任一情况都安全保留).
 *
 * 删除条件 (AND):
 *   1. source_type = 'intraday_price_volume_anomaly'
 *   2. created_at::date = CURRENT_DATE (北京时区)
 *   3. created_at < 2026-06-30 14:30:00 北京 (PR-S 部署时刻)
 *   4. source_id 匹配 5-段旧格式 (`pv_anomaly::T::S::D::N` 结尾是数字 slot)
 *   5. 存在同一 (symbol, anomaly_type) 的 4-段新格式 row, 证明 PR-S filter 已放行
 *
 * 使用:
 *   # dry-run (默认, 只查不删, 打印计数 + 样例)
 *   ./node_modules/.bin/ts-node --transpile-only scripts/ops/cleanup_pre_pr_s_signals.ts
 *   ./node_modules/.bin/ts-node --transpile-only scripts/ops/cleanup_pre_pr_s_signals.ts --dry-run
 *
 *   # 真删
 *   ./node_modules/.bin/ts-node --transpile-only scripts/ops/cleanup_pre_pr_s_signals.ts --apply
 */
import { sequelize } from '../../src/config/database';
import { QueryTypes } from 'sequelize';

// 5-段旧格式: pv_anomaly::TYPE::SYMBOL::YYYY-MM-DD::SLOT(数字)
const OLD_FORMAT_REGEX = '^pv_anomaly::[^:]+::[^:]+::[0-9]{4}-[0-9]{2}-[0-9]{2}::[0-9]+$';
// 4-段新格式: pv_anomaly::TYPE::SYMBOL::YYYY-MM-DD
const NEW_FORMAT_REGEX = '^pv_anomaly::[^:]+::[^:]+::[0-9]{4}-[0-9]{2}-[0-9]{2}$';
// PR-S 部署时刻 (北京时区) — commit ab59ca8 @ 14:20, prod 第一条新格式 row @ 14:30:08
const PR_S_DEPLOY_BJ = '2026-06-30 14:30:00';

interface SignalRow {
  id: number;
  symbol: string;
  source_id: string;
  decision: string;
  confidence_score: string | null;
  created_local: string;
  anomaly_type: string;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;

  console.log(`[cleanup_pre_pr_s_signals] mode=${dryRun ? 'DRY-RUN' : 'APPLY (真删)'}`);
  console.log(`[cleanup_pre_pr_s_signals] PR_S_DEPLOY_BJ=${PR_S_DEPLOY_BJ}`);

  await sequelize.authenticate();
  console.log('[cleanup] DB connected');

  // 1. 找出"今日 PR-S 部署前 + 旧 5-段格式 + (symbol, anomaly_type) 在新 4-段
  //    canonical 里有对应 row"的所有 id.
  //    用 split_part(source_id,'::',2) 取 anomaly_type, split_part(source_id,'::',3) 取 symbol —
  //    跟 IntradayPriceVolumeAnomalyDetector.buildAnomalySourceId 的 schema 一致.
  const targets = await sequelize.query<SignalRow>(
    `
    SELECT
      a.id,
      a.symbol,
      a.source_id,
      a.decision,
      a.confidence_score,
      to_char(a.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS created_local,
      split_part(a.source_id, '::', 2) AS anomaly_type
    FROM ai_investment_signals a
    WHERE a.source_type = 'intraday_price_volume_anomaly'
      AND (a.created_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
      AND (a.created_at AT TIME ZONE 'Asia/Shanghai') < :prSDeploy::timestamp
      AND a.source_id ~ :oldRegex
      AND EXISTS (
        SELECT 1
        FROM ai_investment_signals b
        WHERE b.source_type = 'intraday_price_volume_anomaly'
          AND (b.created_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
          AND b.symbol = a.symbol
          AND b.source_id ~ :newRegex
          AND split_part(b.source_id, '::', 2) = split_part(a.source_id, '::', 2)
      )
    ORDER BY a.created_at ASC, a.id ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: {
        prSDeploy: PR_S_DEPLOY_BJ,
        oldRegex: OLD_FORMAT_REGEX,
        newRegex: NEW_FORMAT_REGEX,
      },
    }
  );

  console.log(`[cleanup] 命中删除候选: ${targets.length} 条`);

  // 2. 按 (symbol, anomaly_type) 分组打印, 让 ops 一眼看清在删什么
  const bySymbolType = new Map<string, SignalRow[]>();
  for (const r of targets) {
    const key = `${r.symbol}::${r.anomaly_type}`;
    if (!bySymbolType.has(key)) bySymbolType.set(key, []);
    bySymbolType.get(key)!.push(r);
  }
  for (const [key, rows] of bySymbolType) {
    console.log(`  ${key} → ${rows.length} 条:`);
    for (const r of rows) {
      console.log(
        `    id=${r.id} created_local=${r.created_local} source_id=${r.source_id} conf=${r.confidence_score}`
      );
    }
  }

  // 3. (audit 历史观测) 顺便打印今日所有"没新 canonical"的旧 row
  //    — 这些是 KEEP 的, 用户能在日志里直接读到证据
  const kept = await sequelize.query<SignalRow>(
    `
    SELECT
      a.id,
      a.symbol,
      a.source_id,
      a.decision,
      a.confidence_score,
      to_char(a.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD HH24:MI:SS') AS created_local,
      split_part(a.source_id, '::', 2) AS anomaly_type
    FROM ai_investment_signals a
    WHERE a.source_type = 'intraday_price_volume_anomaly'
      AND (a.created_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
      AND a.source_id ~ :oldRegex
      AND NOT EXISTS (
        SELECT 1
        FROM ai_investment_signals b
        WHERE b.source_type = 'intraday_price_volume_anomaly'
          AND (b.created_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
          AND b.symbol = a.symbol
          AND b.source_id ~ :newRegex
          AND split_part(b.source_id, '::', 2) = split_part(a.source_id, '::', 2)
      )
    ORDER BY a.symbol ASC, a.created_at ASC
    `,
    {
      type: QueryTypes.SELECT,
      replacements: { oldRegex: OLD_FORMAT_REGEX, newRegex: NEW_FORMAT_REGEX },
    }
  );
  console.log(`[cleanup] 保留 (audit / no canonical) ${kept.length} 条旧 row:`);
  const keptBy = new Map<string, number>();
  for (const r of kept) {
    const key = `${r.symbol}::${r.anomaly_type}`;
    keptBy.set(key, (keptBy.get(key) ?? 0) + 1);
  }
  for (const [k, c] of [...keptBy.entries()].sort()) {
    console.log(`  KEEP ${k} → ${c} 条`);
  }

  // 4. dry-run 出口
  if (dryRun || targets.length === 0) {
    if (dryRun) console.log('[cleanup] DRY-RUN — 重跑加 --apply 才真删.');
    else console.log('[cleanup] nothing to delete.');
    await sequelize.close();
    process.exit(0);
  }

  // 5. 真删 (事务, 用 id IN (...) 圈死)
  const idsToDelete = targets.map(r => r.id);
  console.log(`[cleanup] APPLY: 准备删除 ${idsToDelete.length} 条 row...`);

  const tx = await sequelize.transaction();
  try {
    const [, affectedCount] = await sequelize.query(
      `DELETE FROM ai_investment_signals WHERE id IN (:ids) RETURNING id`,
      {
        replacements: { ids: idsToDelete },
        transaction: tx,
      }
    );
    await tx.commit();
    // PG: query() 返回 [rows, rowCount] 对 DELETE; 第二个 element 上有 rowCount
    const deletedCount = Array.isArray(affectedCount)
      ? (affectedCount as any).length
      : (affectedCount as any)?.rowCount ?? idsToDelete.length;
    console.log(`[cleanup] APPLY done: 实际删除 ${deletedCount} 条 row.`);
  } catch (err) {
    await tx.rollback();
    console.error('[cleanup] APPLY 失败, 已回滚:', err);
    process.exit(2);
  }

  // 6. 删后复查 (sanity)
  const post = await sequelize.query<{ symbol: string; cnt: string }>(
    `
    SELECT symbol, COUNT(*)::text AS cnt
    FROM ai_investment_signals
    WHERE source_type = 'intraday_price_volume_anomaly'
      AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
    GROUP BY symbol
    ORDER BY symbol ASC
    `,
    { type: QueryTypes.SELECT }
  );
  console.log('[cleanup] 删后今日各 symbol 计数:');
  for (const r of post) {
    console.log(`  ${r.symbol} → ${r.cnt}`);
  }

  await sequelize.close();
  process.exit(0);
}

main().catch(err => {
  console.error('[cleanup_pre_pr_s_signals] FATAL:', err);
  process.exit(1);
});
