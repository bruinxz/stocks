/**
 * EV/TCA DataSource 字段对齐 — 静态契约 + 可选 DB integration smoke.
 *
 * 不依赖 jest, 直接 node 跑:
 *   cd backend && npx ts-node --transpile-only tests/services/ev-tca-datasource-contract.test.ts
 *
 * 测两件事:
 *   (1) 静态契约: import RecommendationTradeOutcome / PaperTradingOrderIntent /
 *       PaperTradingTrade model, 反射 rawAttributes, assert EV/TCA datasource 用到的
 *       attribute name 全部存在. 拦截下次有人把 trade_status 又写回 status / 把
 *       total_pnl_pct 又写回 profit_pct 的 schema drift.
 *   (2) 可选 DB smoke: 当 env DB_HOST/DB_NAME/DB_USER/DB_PASSWORD 都齐时, 真连 Postgres,
 *       跑 loadStrategyRegimeStats + loadClosedTradesForTCA, assert 不抛.
 *       本地无连接则 skip + log.
 *
 * 这是 Sprint 44-D 后的回归 net — 之前升级 EV/TCA 字段对齐时只测了 fake DataSource.
 * 真正生产 DataSource 走的是 PRODUCTION_EV_DECISION_DATA_SOURCE /
 * PRODUCTION_TCA_DATA_SOURCE, 之前完全靠 grep + 人眼 review 兜底.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import { PRODUCTION_EV_DECISION_DATA_SOURCE } from '../../src/services/meta-v2/EVDecisionService';
import { PRODUCTION_TCA_DATA_SOURCE } from '../../src/services/tca/TCAService';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

(async () => {
  // ============================================================================
  // (1) 静态契约: 先 attach model 到 sequelize (require config/database.ts), 再用
  //     Model.rawAttributes 拿真实字段集.
  // ============================================================================
  try {
    require('../../src/config/database');
  } catch (e: any) {
    // database.ts 在没 env 时也能 import (它只构造 Sequelize 实例, 不主动 connect),
    // 但 .authenticate() 是 lazy 的 — 我们只要 attach model 即可.
    console.warn(`[warn] require config/database.ts 警告 (可忽略): ${e?.message || e}`);
  }
  const { RecommendationTradeOutcome } = require('../../src/models/RecommendationTradeOutcome');
  const { PaperTradingOrderIntent } = require('../../src/models/PaperTradingOrderIntent');
  const { PaperTradingTrade } = require('../../src/models/PaperTradingTrade');

  function attrSetOf(model: any): Set<string> {
    const raw = model.rawAttributes || model.tableAttributes;
    if (raw && Object.keys(raw).length) return new Set(Object.keys(raw));
    return new Set<string>();
  }

  const outcomeFields = attrSetOf(RecommendationTradeOutcome);
  const intentFields = attrSetOf(PaperTradingOrderIntent);
  const tradeFields = attrSetOf(PaperTradingTrade);

  if (!outcomeFields.size) {
    console.warn(
      '[skip] RecommendationTradeOutcome rawAttributes 空 — model 未 attach. 静态契约跳过.'
    );
  } else {
    // EV DataSource 必须能找到的字段
    for (const f of ['trade_status', 'exit_date', 'total_pnl_pct', 'metadata']) {
      assert(outcomeFields.has(f), `RecommendationTradeOutcome.${f} 必须存在 (EV datasource)`);
    }
    // TCA DataSource 必须能找到的字段
    for (const f of [
      'id',
      'signal_id',
      'symbol',
      'portfolio_id',
      'total_pnl_pct',
      'entry_trade_id',
      'exit_trade_id',
      'metadata',
      'trade_status',
      'exit_date',
    ]) {
      assert(outcomeFields.has(f), `RecommendationTradeOutcome.${f} 必须存在 (TCA datasource)`);
    }
    // 反向断言: 旧 bug 字段不应再被引用
    for (const f of ['status', 'closed_at', 'profit_pct', 'strategy_key']) {
      assert(
        !outcomeFields.has(f),
        `RecommendationTradeOutcome.${f} 不应作为顶层列 — 旧 bug 残留 (应在 metadata 或对应新字段)`
      );
    }
  }

  if (intentFields.size) {
    for (const f of [
      'signal_id',
      'portfolio_id',
      'side',
      'reference_price',
      'execute_price',
      'metadata',
      'score',
    ]) {
      assert(intentFields.has(f), `PaperTradingOrderIntent.${f} 必须存在 (TCA datasource)`);
    }
  }
  if (tradeFields.size) {
    for (const f of ['id', 'execute_price', 'direction']) {
      assert(tradeFields.has(f), `PaperTradingTrade.${f} 必须存在 (TCA datasource)`);
    }
  }

  // ============================================================================
  // (2) 可选 DB smoke: 真连 Postgres 跑一次 datasource. 无连接则 skip.
  // ============================================================================
  const hasDbEnv =
    process.env.DB_HOST &&
    process.env.DB_NAME &&
    process.env.DB_USER &&
    process.env.DB_PASSWORD;

  if (!hasDbEnv) {
    console.log(
      '\n[skip] DB env 缺失 (DB_HOST/DB_NAME/DB_USER/DB_PASSWORD), 跳过真实 DB smoke.\n' +
        '       要跑此测试请设 env 变量后再 npx ts-node tests/services/ev-tca-datasource-contract.test.ts'
    );
  } else {
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      const evGlobal = await PRODUCTION_EV_DECISION_DATA_SOURCE.loadGlobalStats(180, todayIso);
      assert(
        evGlobal === null || typeof evGlobal === 'object',
        'EV loadGlobalStats 应返回 null 或 stats 对象'
      );
      if (evGlobal) {
        assert(
          typeof evGlobal.sample_count === 'number' && evGlobal.sample_count >= 0,
          `EV loadGlobalStats sample_count 应非负, 实际 ${evGlobal.sample_count}`
        );
        console.log(
          `[smoke] EV loadGlobalStats → n=${evGlobal.sample_count}, avg_win=${(
            evGlobal.avg_win_pct * 100
          ).toFixed(2)}%, avg_loss=${(evGlobal.avg_loss_pct * 100).toFixed(2)}%`
        );
      }

      const evPerStrat = await PRODUCTION_EV_DECISION_DATA_SOURCE.loadStrategyRegimeStats(
        'mean_reversion_strategy',
        'bull',
        180,
        todayIso
      );
      assert(
        evPerStrat === null || typeof evPerStrat === 'object',
        'EV loadStrategyRegimeStats 应返回 null 或 stats 对象'
      );

      const tcaInputs = await PRODUCTION_TCA_DATA_SOURCE.loadClosedTradesForTCA(180, todayIso);
      assert(Array.isArray(tcaInputs), 'TCA loadClosedTradesForTCA 应返回数组');
      console.log(`[smoke] TCA loadClosedTradesForTCA → ${tcaInputs.length} 笔`);
      if (tcaInputs.length > 0) {
        const sample = tcaInputs[0];
        assert(
          typeof sample.symbol === 'string' && sample.symbol.length > 0,
          'TCA sample.symbol 应非空'
        );
        assert(typeof sample.strategy_key === 'string', 'TCA sample.strategy_key 应存在');
        assert(
          typeof sample.buy_execute_price === 'number' && sample.buy_execute_price > 0,
          `TCA sample.buy_execute_price 应是正数, 实际 ${sample.buy_execute_price}`
        );
      }
    } catch (error: any) {
      fail++;
      failures.push(`DB smoke 抛错: ${error?.message || error}`);
      console.error(`✗ DB smoke 抛错: ${error?.message || error}`);
      if (error?.stack) console.error(error.stack.split('\n').slice(0, 5).join('\n'));
    }
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  } else {
    console.log('✓ EV/TCA datasource 契约 + (可选)smoke 通过.');
    process.exit(0);
  }
})();
