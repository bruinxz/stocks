/**
 * backfill_position_stop_loss.ts — CB-1 (2026/06/25)
 *
 * 把所有 stop_loss_price IS NULL OR take_profit_price IS NULL 的活跃持仓回填:
 *   stop_loss_price  = avg_cost * (1 - user.risk_config.stop_loss_percent / 100)
 *   take_profit_price = avg_cost * (1 + user.risk_config.take_profit_percent / 100)
 *
 * user.risk_config 缺失 → 默认 5% / 10% (与 User.risk_config defaultValue 同步).
 *
 * 使用:
 *   # dry-run (默认, 不写库)
 *   node backend/dist/scripts/ops/backfill_position_stop_loss.js
 *   # or
 *   node backend/dist/scripts/ops/backfill_position_stop_loss.js --dry-run
 *
 *   # 真改 (写库)
 *   node backend/dist/scripts/ops/backfill_position_stop_loss.js --apply
 *
 * 输出: 每行打印 (portfolio_id, symbol, avg_cost) → (stop_loss, take_profit),
 * 末尾打印汇总 "X rows scanned, Y rows ${dryRun ? 'would update' : 'updated'}".
 */
import { sequelize } from '../../config/database';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { User } from '../../models/User';
import { Op } from 'sequelize';
import { deriveProtectionPrices } from '../../portfolio/internal/positionProtectionDefaults';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;

  console.log(`[backfill_position_stop_loss] mode=${dryRun ? 'DRY-RUN' : 'APPLY (写库)'}`);

  await sequelize.authenticate();
  console.log('[backfill_position_stop_loss] DB connected');

  // 1. 取所有需要 backfill 的活跃持仓
  const positions = await PaperTradingPosition.findAll({
    where: {
      quantity: { [Op.gt]: 0 },
      [Op.or]: [{ stop_loss_price: null as any }, { take_profit_price: null as any }],
    },
  });
  console.log(`[backfill] found ${positions.length} positions with NULL stop_loss / take_profit`);

  if (positions.length === 0) {
    console.log('[backfill] nothing to do, exit.');
    process.exit(0);
  }

  // 2. 取 portfolio_id → user_id 映射
  const portfolioIds = [...new Set(positions.map(p => p.portfolio_id))];
  const portfolios = await PaperTradingPortfolio.findAll({
    where: { id: { [Op.in]: portfolioIds } },
    attributes: ['id', 'user_id', 'name'],
  });
  const portfolioById = new Map(portfolios.map(p => [p.id, p]));

  // 3. 取所有 user_id → risk_config 映射 (一次性 fetch 减少 DB call)
  const userIds = [...new Set(portfolios.map(p => p.user_id))];
  const users = await User.findAll({
    where: { id: { [Op.in]: userIds } },
    attributes: ['id', 'username', 'risk_config'],
  });
  const userById = new Map(users.map(u => [u.id, u]));

  // 4. 逐行 backfill (or print)
  let updateCount = 0;
  let skipCount = 0;
  for (const pos of positions) {
    const portfolio = portfolioById.get(pos.portfolio_id);
    if (!portfolio) {
      console.warn(`[backfill] skip position ${pos.id}: portfolio ${pos.portfolio_id} not found`);
      skipCount++;
      continue;
    }
    const user = userById.get(portfolio.user_id);
    if (!user) {
      console.warn(`[backfill] skip position ${pos.id}: user ${portfolio.user_id} not found`);
      skipCount++;
      continue;
    }
    const avgCost = Number(pos.avg_cost);
    if (!Number.isFinite(avgCost) || avgCost <= 0) {
      console.warn(`[backfill] skip position ${pos.id}: invalid avg_cost ${pos.avg_cost}`);
      skipCount++;
      continue;
    }

    const protection = deriveProtectionPrices(avgCost, user.risk_config);
    const newStopLoss = pos.stop_loss_price === null ? protection.stop_loss_price : pos.stop_loss_price;
    const newTakeProfit =
      pos.take_profit_price === null ? protection.take_profit_price : pos.take_profit_price;

    console.log(
      `[backfill] pid=${portfolio.id} ${portfolio.name} user=${user.username} symbol=${pos.symbol} ` +
        `avg_cost=${avgCost} → stop=${newStopLoss} take=${newTakeProfit} ` +
        `(pct sl=${protection.stop_loss_percent}% tp=${protection.take_profit_percent}%)`
    );

    if (!dryRun) {
      await pos.update({
        stop_loss_price: newStopLoss,
        take_profit_price: newTakeProfit,
      });
    }
    updateCount++;
  }

  console.log(
    `[backfill_position_stop_loss] done: ${positions.length} scanned, ` +
      `${updateCount} ${dryRun ? 'would update' : 'updated'}, ${skipCount} skipped`
  );

  if (dryRun) {
    console.log('[backfill] DRY-RUN — re-run with --apply to write to DB.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[backfill_position_stop_loss] FATAL:', err);
  process.exit(1);
});
