/**
 * phase2_run_consolidation.ts — Phase 2 (2026-06-27)
 *
 * "21 个模拟盘 → 1 个综合主盘" 的 ops 节点脚本.
 * 同等于运行 backend/scripts/ops/phase2_create_master_portfolio.sql +
 * phase2_close_legacy_portfolios.sql, 但走 sequelize, 因为 prod 的 deploy/ops
 * 账号无 psql 权限.
 *
 * 步骤:
 *   1. 校验 "综合策略主盘" 未存在 (幂等保护)
 *   2. INSERT 综合主盘 (user=stock, 200K, 10 strategies, 22 factors, 风控)
 *   3. UPDATE 所有 is_active=true && name != '综合策略主盘' → is_active=false +
 *      auto_trade_enabled=false (软关, 保留 trades/snapshots/positions 作历史)
 *   4. 打印新主盘 id + 被关闭的旧盘清单
 *
 * 使用:
 *   # dry-run (默认, 不写库, 只打印 plan)
 *   node backend/dist/scripts/ops/phase2_run_consolidation.js
 *   # or
 *   node backend/dist/scripts/ops/phase2_run_consolidation.js --dry-run
 *
 *   # 真改 (写库, 整个步骤在 1 个事务里, 失败自动 rollback)
 *   node backend/dist/scripts/ops/phase2_run_consolidation.js --apply
 *
 * 回滚 (如发现问题, 1 小时内):
 *   1. 删新主盘:    DELETE FROM paper_trading_portfolios WHERE name = '综合策略主盘';
 *      (or run backend/scripts/ops/phase2_create_master_portfolio_rollback.sql)
 *   2. 恢复旧盘:    UPDATE paper_trading_portfolios SET is_active=true WHERE id IN (25..40,61..64);
 *      (or run backend/scripts/ops/phase2_close_legacy_portfolios_rollback.sql)
 *
 * 数据来源: docs/audit/portfolio_consolidation_2026_06_26.md (DA-0 勘探报告)
 */
import { sequelize } from '../../src/config/database';
import { PaperTradingPortfolio } from '../../src/models/PaperTradingPortfolio';
import { Op, QueryTypes } from 'sequelize';

const MASTER_NAME = '综合策略主盘';
const MASTER_DESCRIPTION =
  'Phase 2 (2026-06-27) 单盘整合 — 融合 16 个 active 盘的最优 10 策略 + 全 22 因子 + DA-0 数据驱动的风控升级 (trailing 4% + DD 熔断 3% + 止损放宽到 6%).';
const MASTER_USER_ID = 4; // 'stock' — prod 实际跑 PaperTradingAutomation 的系统账号
const INITIAL_CAPITAL = 200000;

// DA-0 推荐 10 策略 (4 均值回归 + 4 动量 + 1 量价 + 1 龙头)
const MASTER_STRATEGIES = [
  'bollinger_reversion',
  'rsi_reversion',
  'left_side_reversal',
  'trend_pullback_reentry',
  'dual_momentum_rotation',
  'cta100_momentum',
  'sector_rotation_leader',
  'relative_strength_momentum',
  'volume_price_confirmation',
  'dragon_head_momentum',
];

// 全 22 因子 (DA-0 证实 17 盘共享同一集, 因子是 ranking 输入不直接产 trade, 不裁剪)
const MASTER_FACTORS = [
  'value',
  'quality',
  'quality_high',
  'growth',
  'momentum',
  'momentum_reversal',
  'low_vol',
  'liquidity',
  'money_flow',
  'northbound',
  'dragon_tiger',
  'analyst_consensus',
  'earnings_surprise',
  'fund_consensus',
  'industry_momentum',
  'gradual_breakout',
  'insider_trade',
  'margin_flow',
  'east_money_qa',
  'shareholder_concentration',
  'block_trade_signal',
  'concept_heat',
];

// DA-0 风控升级 (硬止损 5→6 / 止盈 10→12 / +trailing 4 / +DD 熔断 3% / max_positions 8 / 单股 10% / 行业 30%)
const MASTER_RISK_OVERRIDES = {
  stop_loss_percent: 6,
  take_profit_percent: 12,
  trailing_stop_pct: 4,
  single_stock_max_weight: 0.1,
  max_industry_weight: 0.3,
  max_positions: 8,
  drawdown_breaker: {
    threshold_pct: 3,
    cooldown_days: 2,
  },
};

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;

  console.log(
    `[phase2_run_consolidation] mode=${dryRun ? 'DRY-RUN' : 'APPLY (写库, 1 事务)'}`
  );

  await sequelize.authenticate();
  console.log('[phase2] DB connected');

  // 1. 当前状态 snapshot
  const before = await PaperTradingPortfolio.findAll({
    attributes: ['id', 'name', 'user_id', 'is_active', 'auto_trade_enabled', 'total_value'],
    order: [['id', 'ASC']],
  });
  const activeBefore = before.filter(p => p.is_active);
  console.log(`[phase2] BEFORE: ${before.length} portfolios total, ${activeBefore.length} active`);

  // 2. 幂等保护: 不能已存在 MASTER_NAME
  const existing = before.find(p => p.name === MASTER_NAME);
  if (existing) {
    console.error(
      `[phase2] ABORT: 已存在 "${MASTER_NAME}" (id=${existing.id}). ` +
        `若需重建, 先 DELETE 该行 (或运行 phase2_create_master_portfolio_rollback.sql) 再重跑.`
    );
    process.exit(2);
  }

  // 3. plan (无论 dry-run / apply 都打印)
  console.log('[phase2] PLAN:');
  console.log(`  (a) INSERT '${MASTER_NAME}' user_id=${MASTER_USER_ID} initial=${INITIAL_CAPITAL}`);
  console.log(`      strategies(${MASTER_STRATEGIES.length}) = ${MASTER_STRATEGIES.join(', ')}`);
  console.log(`      factors(${MASTER_FACTORS.length}) = ${MASTER_FACTORS.length} 个`);
  console.log(`      risk_overrides = ${JSON.stringify(MASTER_RISK_OVERRIDES)}`);
  console.log(`  (b) UPDATE ${activeBefore.length} active portfolios → is_active=false + auto_trade_enabled=false`);
  for (const p of activeBefore) {
    console.log(
      `      - close id=${p.id} '${p.name}' (user=${p.user_id}, total=${p.total_value})`
    );
  }

  if (dryRun) {
    console.log('[phase2] DRY-RUN finished, no DB writes. Re-run with --apply.');
    process.exit(0);
  }

  // 4. APPLY: 1 个事务
  const tx = await sequelize.transaction();
  let newId: number;
  try {
    const created = await PaperTradingPortfolio.create(
      {
        user_id: MASTER_USER_ID,
        name: MASTER_NAME,
        description: MASTER_DESCRIPTION,
        initial_capital: INITIAL_CAPITAL,
        current_cash: INITIAL_CAPITAL,
        total_value: INITIAL_CAPITAL,
        is_active: true,
        auto_trade_enabled: true,
        strategy_keys: MASTER_STRATEGIES,
        enabled_factors: MASTER_FACTORS,
        risk_profile_overrides: MASTER_RISK_OVERRIDES,
      } as any,
      { transaction: tx }
    );
    newId = created.id;
    console.log(`[phase2] (a) INSERT OK — new master id=${newId}`);

    // 关闭所有其他 active 盘
    const [closeRows] = await sequelize.query(
      `UPDATE paper_trading_portfolios
       SET is_active = false, auto_trade_enabled = false, updated_at = NOW()
       WHERE is_active = true AND id != :newId`,
      {
        replacements: { newId },
        transaction: tx,
        type: QueryTypes.UPDATE,
      }
    );
    const closeCount = Array.isArray(closeRows) ? closeRows.length : (closeRows as any);
    console.log(`[phase2] (b) UPDATE OK — closed ${closeCount} legacy portfolios`);

    await tx.commit();
    console.log('[phase2] COMMIT OK');
  } catch (err) {
    await tx.rollback();
    console.error('[phase2] FAIL — transaction rolled back:', err);
    throw err;
  }

  // 5. AFTER snapshot
  const after = await PaperTradingPortfolio.findAll({
    attributes: ['id', 'name', 'user_id', 'is_active'],
    where: { is_active: true },
    order: [['id', 'ASC']],
  });
  console.log(`[phase2] AFTER: ${after.length} active portfolio(s):`);
  for (const p of after) {
    console.log(`  - id=${p.id} '${p.name}' user=${p.user_id}`);
  }
  if (after.length !== 1 || after[0].name !== MASTER_NAME) {
    console.error(`[phase2] WARNING: expected exactly 1 active portfolio (${MASTER_NAME})`);
  }

  console.log(`[phase2_run_consolidation] DONE. master_portfolio_id=${newId}`);
  process.exit(0);
}

main().catch(err => {
  console.error('[phase2_run_consolidation] FATAL:', err);
  process.exit(1);
});
