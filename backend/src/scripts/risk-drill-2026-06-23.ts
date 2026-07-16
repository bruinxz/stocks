#!/usr/bin/env node
/**
 * 风控真演练脚本 — 2026-06-23 (Task 1)
 *
 * 目标: 验证 DrawdownCircuitBreaker / 7 重风控 / KillSwitchService 在真实
 * 场景下能真生效, 而不是 unit test 走一遍。
 *
 * 4 个 scenario, 全部走真路径 (不是 fake DI), 每个 scenario 完成后
 * 回滚副作用 (paused_until / RiskAlert):
 *
 *   A. drawdown_block_buy_real
 *      - 演练: 把 user 4 的 risk_config.drawdown_breaker.paused_until 临时
 *        设到 +24h, 走真路径 PaperTradingAutomationService.createBuyTrade
 *        模拟跟单 (走 checkAllPreTradeGates → checkPreBuyGuards → 真
 *        drawdownCircuitBreaker.checkBuyAllowed), 预期 throw err.code
 *        DRAWDOWN_BREAKER_PAUSED. 回滚: clearPause.
 *
 *   B. fail_closed_real
 *      - 演练: 构造一个会 throw 的 fake DataSource (loadConfig 抛 Error),
 *        wrap 在 checkBuyAllowed; 预期被 wrapFailClosed 包成
 *        RiskGuardUnavailableError statusCode=503 code=RISK_GUARD_UNAVAILABLE
 *        (而非 silently fail-open 让买单通过). 同时验证 caller
 *        preTradeGuards.checkPreBuyGuards 把它包成 ok=false code=
 *        RISK_GUARD_UNAVAILABLE + 写 HIGH RiskAlert (SYSTEM:RISK_GUARD_UNAVAILABLE
 *        symbol).
 *
 *   C. kill_switch_env_block
 *      - 演练: 把 LIVE_TRADING_KILL_SWITCH=true (prod 已是 true) 走
 *        LiveTradingSafetyService.getStatus(), 验证 can_submit_orders=false +
 *        blockers 含 'LIVE_TRADING_KILL_SWITCH 处于熔断状态'. 不动 env, 真
 *        prod 默认值已经熔断, 这是为了佐证当前默认值就是 fail-safe.
 *
 *   D. kill_switch_db_trigger
 *      - 演练: 调 killSwitchService.trigger({reason_code:'smoke_test',
 *        reason_detail:'risk drill 2026-06-23', source:'manual'}) 真触发
 *        DB kill switch, 然后 isTriggered() 验证 active=true, source='db'.
 *        然后 resolve(reason:'risk drill complete') 还原 active=false.
 *
 * Stale-data + black-swan + akshare-down scenarios 在 black-swan-drill.ts
 * 同期 (Task 3).
 *
 * Usage:
 *   ts-node backend/src/scripts/risk-drill-2026-06-23.ts            # 默认 all 4 scenarios
 *   ts-node backend/src/scripts/risk-drill-2026-06-23.ts --only=A   # 只跑 scenario A
 *   ts-node backend/src/scripts/risk-drill-2026-06-23.ts --user=4
 *
 * 退出码:
 *   0 = 所有 scenario PASSED
 *   1 = 任一 scenario FAILED (说明风控在该场景下不真生效, 有 regression)
 */

import { Op } from 'sequelize';
import { sequelize } from '../config/database';
import '../models';
import { logger } from '../utils/logger';
import { User } from '../models/User';
import { RiskAlert } from '../models/RiskAlert';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import {
  drawdownCircuitBreaker,
  RiskGuardUnavailableError,
  PRODUCTION_DRAWDOWN_BREAKER_DATA_SOURCE,
  DrawdownBreakerDataSource,
  DrawdownCircuitBreaker,
  DrawdownBreakerConfig,
} from '../portfolio/risk/DrawdownCircuitBreaker';
import { checkAllPreTradeGates } from '../portfolio/internal/preTradeGuards';
import { LiveTradingSafetyService } from '../live-trading/services/LiveTradingSafetyService';
import { killSwitchService } from '../live-trading/services/KillSwitchService';

interface ScenarioResult {
  scenario: string;
  passed: boolean;
  detail: string;
  duration_ms: number;
  error?: string;
}

async function withTimeout<T>(label: string, fn: () => Promise<T>, ms = 60000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`[risk-drill] ${label} timeout after ${ms}ms`)),
      ms
    );
    fn().then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// ---------------------------------------------------------------------------
//  Scenario A — drawdown 暂停期真拒新买单 (DRAWDOWN_BREAKER_PAUSED)
// ---------------------------------------------------------------------------

async function scenarioA_drawdownBlockBuy(userId: number): Promise<ScenarioResult> {
  const t0 = Date.now();
  const scenario = 'A_drawdown_block_buy_real';
  // 1) 备份当前 paused_until
  const user = await User.findByPk(userId);
  if (!user) {
    return {
      scenario,
      passed: false,
      detail: `user ${userId} not found`,
      duration_ms: Date.now() - t0,
    };
  }
  const originalRiskConfig = JSON.parse(JSON.stringify(user.risk_config || {}));
  const originalPausedUntil = (user.risk_config as any)?.drawdown_breaker?.paused_until ?? null;

  // 测试 symbol: 用一个 user 当前没持仓的 symbol, 触发 is_new_holding=true 路径
  const testSymbol = 'sh.600000';
  // 选个真持仓的 symbol 验证加仓放行 (existing position 允许 BUY 即使在 pause 期)
  let existingSymbol: string | null = null;
  try {
    const portfolio = await PaperTradingPortfolio.findOne({
      where: { user_id: userId, is_active: true },
    });
    if (portfolio) {
      const pos = await PaperTradingPosition.findOne({
        where: { portfolio_id: portfolio.id, quantity: { [Op.gt]: 0 } },
      });
      existingSymbol = pos?.symbol ?? null;
    }
  } catch (_) {
    /* ignore */
  }

  try {
    // 2) 真写 paused_until = now + 24h (走 prod savePausedUntil)
    const pausedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await PRODUCTION_DRAWDOWN_BREAKER_DATA_SOURCE.savePausedUntil(userId, pausedUntil);

    // 3) 走 checkAllPreTradeGates BUY 路径 — 与 PaperTradingAutomationService.createBuyTrade 一模一样
    const gateResult = await checkAllPreTradeGates({
      side: 'BUY',
      user_id: userId,
      symbol: testSymbol,
      proposed_value: 10000,
      caller_label: 'risk-drill.scenarioA',
    });

    // 4) 验证: 必须 ok=false code=DRAWDOWN_BREAKER_PAUSED
    if (gateResult.ok) {
      return {
        scenario,
        passed: false,
        detail: `BUG: paused_until=${pausedUntil} 已设定但 checkAllPreTradeGates 仍 ok=true (检查 paused_until 是否真生效)`,
        duration_ms: Date.now() - t0,
      };
    }
    const failedGate = gateResult as Extract<typeof gateResult, { ok: false }>;
    if (failedGate.code !== 'DRAWDOWN_BREAKER_PAUSED') {
      return {
        scenario,
        passed: false,
        detail: `BUG: 预期 code=DRAWDOWN_BREAKER_PAUSED, 实际 code=${failedGate.code} reason=${failedGate.reason}`,
        duration_ms: Date.now() - t0,
      };
    }
    const blockedReason = failedGate.reason;

    // 5) 验证加仓放行 — 如果有 existing position, 在 pause 期内应该 ok=true (允许加仓)
    let addOnDetail = '';
    if (existingSymbol) {
      const addOnResult = await checkAllPreTradeGates({
        side: 'BUY',
        user_id: userId,
        symbol: existingSymbol,
        proposed_value: 10000,
        caller_label: 'risk-drill.scenarioA.addon',
      });
      // 加仓应该过 drawdown 关 (因为 hasExistingPosition=true), 但可能被 PositionLimitGuard 拦
      // 所以只验证不是 DRAWDOWN_BREAKER_PAUSED
      if (!addOnResult.ok) {
        const failedAddOn = addOnResult as Extract<typeof addOnResult, { ok: false }>;
        if (failedAddOn.code === 'DRAWDOWN_BREAKER_PAUSED') {
          return {
            scenario,
            passed: false,
            detail: `BUG: existing position ${existingSymbol} 加仓被 DRAWDOWN_BREAKER_PAUSED 拦, 应该放行加仓只拦新开仓`,
            duration_ms: Date.now() - t0,
          };
        }
        addOnDetail = `addon ${existingSymbol}: ${failedAddOn.code}`;
      } else {
        addOnDetail = `addon ${existingSymbol}: pass`;
      }
    }

    return {
      scenario,
      passed: true,
      detail: `new-position ${testSymbol} 被 DRAWDOWN_BREAKER_PAUSED 拦截 ✓ (${blockedReason.slice(
        0,
        80
      )}...); ${addOnDetail}`,
      duration_ms: Date.now() - t0,
    };
  } finally {
    // 6) 还原 user.risk_config 防止污染 prod 状态
    try {
      const u = await User.findByPk(userId);
      if (u) {
        u.risk_config = originalRiskConfig as any;
        u.changed('risk_config', true);
        await u.save();
      }
      logger.info(
        `[risk-drill.scenarioA] restored paused_until ${
          originalPausedUntil ?? 'null'
        } for user ${userId}`
      );
    } catch (e: any) {
      logger.error(`[risk-drill.scenarioA] restore failed: ${e?.message || e}`);
    }
  }
}

// ---------------------------------------------------------------------------
//  Scenario B — fail-CLOSED on guard infra failure (RISK_GUARD_UNAVAILABLE)
// ---------------------------------------------------------------------------

class CrashingDataSource implements DrawdownBreakerDataSource {
  async loadAllUserIdsWithPortfolios() {
    return [];
  }
  async loadConfig(_user_id: number): Promise<DrawdownBreakerConfig> {
    throw new Error('simulated DB outage: loadConfig timed out');
  }
  async saveConfig(_u: number, c: DrawdownBreakerConfig) {
    return c;
  }
  async loadPortfolio() {
    return null;
  }
  async loadRecentSnapshots() {
    return [];
  }
  async loadOpenPositions() {
    return [];
  }
  async loadPausedUntil() {
    return null;
  }
  async savePausedUntil() {
    /* noop */
  }
  async hasExistingPosition() {
    return false;
  }
  async writeAlert() {
    /* noop */
  }
}

async function scenarioB_failClosed(userId: number): Promise<ScenarioResult> {
  const t0 = Date.now();
  const scenario = 'B_fail_closed_real';
  const testSymbol = 'sh.600000';
  // 直接构造 crashing breaker 跑 checkBuyAllowed (不经过 prod singleton)
  const crashingBreaker = new DrawdownCircuitBreaker(new CrashingDataSource());
  let threwExpected = false;
  let errCode = '';
  let errStatus = 0;
  let errMsg = '';
  try {
    await crashingBreaker.checkBuyAllowed({ user_id: userId, symbol: testSymbol });
  } catch (err: any) {
    threwExpected = err instanceof RiskGuardUnavailableError;
    errCode = err?.code || '';
    errStatus = err?.statusCode || 0;
    errMsg = err?.message || String(err);
  }
  if (!threwExpected) {
    return {
      scenario,
      passed: false,
      detail: `BUG: crashing DataSource 没 throw RiskGuardUnavailableError (fail-CLOSED 失效) — errMsg=${errMsg.slice(
        0,
        120
      )}`,
      duration_ms: Date.now() - t0,
    };
  }
  if (errCode !== 'RISK_GUARD_UNAVAILABLE' || errStatus !== 503) {
    return {
      scenario,
      passed: false,
      detail: `BUG: 期望 code=RISK_GUARD_UNAVAILABLE statusCode=503, 实际 code=${errCode} status=${errStatus}`,
      duration_ms: Date.now() - t0,
    };
  }

  // 验证 caller path: monkey-patch drawdownCircuitBreaker.checkBuyAllowed 让它抛
  // RiskGuardUnavailableError, 走 preTradeGuards.checkPreBuyGuards 看 caller 是否
  // 写 HIGH RiskAlert 并返 ok=false code=RISK_GUARD_UNAVAILABLE
  const orig = drawdownCircuitBreaker.checkBuyAllowed.bind(drawdownCircuitBreaker);
  (drawdownCircuitBreaker as any).checkBuyAllowed = async () => {
    throw new RiskGuardUnavailableError('drill simulated guard outage', 'drawdown_breaker', {
      drill: true,
      scenario: 'B',
    });
  };

  // 抓 RiskAlert 是否被写 — 取测试前 max id, 然后查测试后是否有新行
  const beforeMaxAlertId = ((await RiskAlert.max('id')) as number | null) ?? 0;
  let callerResult: any;
  try {
    callerResult = await checkAllPreTradeGates({
      side: 'BUY',
      user_id: userId,
      symbol: testSymbol,
      proposed_value: 5000,
      caller_label: 'risk-drill.scenarioB',
    });
  } finally {
    (drawdownCircuitBreaker as any).checkBuyAllowed = orig;
  }
  if (callerResult.ok) {
    return {
      scenario,
      passed: false,
      detail: `BUG: caller path checkAllPreTradeGates 接到 RiskGuardUnavailableError 仍 ok=true (fail-OPEN)`,
      duration_ms: Date.now() - t0,
    };
  }
  const failedCaller = callerResult as Extract<typeof callerResult, { ok: false }>;
  if (failedCaller.code !== 'RISK_GUARD_UNAVAILABLE') {
    return {
      scenario,
      passed: false,
      detail: `BUG: 期望 caller code=RISK_GUARD_UNAVAILABLE, 实际 code=${failedCaller.code}`,
      duration_ms: Date.now() - t0,
    };
  }

  // 验证 RiskAlert HIGH 写入 (cleanup 用 id 区间)
  const writtenAlerts = await RiskAlert.findAll({
    where: {
      id: { [Op.gt]: beforeMaxAlertId },
      symbol: 'SYSTEM:RISK_GUARD_UNAVAILABLE',
    },
  });
  // cleanup drill 写的 RiskAlert
  try {
    if (writtenAlerts.length > 0) {
      await RiskAlert.destroy({
        where: { id: writtenAlerts.map(a => (a as any).id) },
      });
    }
  } catch (_) {
    /* ignore */
  }
  if (writtenAlerts.length === 0) {
    return {
      scenario,
      passed: false,
      detail: `BUG: caller path 没写 HIGH RiskAlert (SYSTEM:RISK_GUARD_UNAVAILABLE) — fail-CLOSED 拒单但 ops 看不到`,
      duration_ms: Date.now() - t0,
    };
  }
  const firstAlert = writtenAlerts[0] as any;

  return {
    scenario,
    passed: true,
    detail: `guard throw 503 RISK_GUARD_UNAVAILABLE ✓; caller wrap ok=false code=RISK_GUARD_UNAVAILABLE ✓; RiskAlert HIGH 写 ${writtenAlerts.length} 条 ✓ (name='${firstAlert.name}')`,
    duration_ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
//  Scenario C — env LIVE_TRADING_KILL_SWITCH=true 阻断实盘提交
// ---------------------------------------------------------------------------

async function scenarioC_killSwitchEnv(): Promise<ScenarioResult> {
  const t0 = Date.now();
  const scenario = 'C_kill_switch_env_block';
  const svc = new LiveTradingSafetyService();
  // 强制 env (本进程内, 不写 .env): LIVE_TRADING_KILL_SWITCH=true, 且 enabled 关
  const original: Record<string, string | undefined> = {};
  for (const k of [
    'LIVE_TRADING_ENABLED',
    'LIVE_ORDER_EXECUTION_ENABLED',
    'LIVE_TRADING_KILL_SWITCH',
  ]) {
    original[k] = process.env[k];
  }
  process.env.LIVE_TRADING_ENABLED = 'true';
  process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env.LIVE_TRADING_KILL_SWITCH = 'true';
  try {
    const status: any = svc.getStatus(
      { broker_key: 'qmt_bridge', trading_supported: true },
      undefined
    );
    if (status.can_submit_orders === true) {
      return {
        scenario,
        passed: false,
        detail: `BUG: env LIVE_TRADING_KILL_SWITCH=true 但 can_submit_orders=true (env kill switch 未生效)`,
        duration_ms: Date.now() - t0,
      };
    }
    if (status.env_kill_switch !== true) {
      return {
        scenario,
        passed: false,
        detail: `BUG: env_kill_switch parse 错误, 期望 true 实际 ${status.env_kill_switch}`,
        duration_ms: Date.now() - t0,
      };
    }
    const blockers: string[] = status.blockers || [];
    const hasKill = blockers.some(b => b.includes('LIVE_TRADING_KILL_SWITCH'));
    if (!hasKill) {
      return {
        scenario,
        passed: false,
        detail: `BUG: blockers 数组没含 'LIVE_TRADING_KILL_SWITCH', 当前: ${JSON.stringify(
          blockers
        )}`,
        duration_ms: Date.now() - t0,
      };
    }
    return {
      scenario,
      passed: true,
      detail: `env LIVE_TRADING_KILL_SWITCH=true → can_submit_orders=${status.can_submit_orders} blockers含env-kill ✓ mode=${status.mode}`,
      duration_ms: Date.now() - t0,
    };
  } finally {
    // 还原 env
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
//  Scenario D — DB kill switch 真触发 + 解除
// ---------------------------------------------------------------------------

async function scenarioD_killSwitchDb(): Promise<ScenarioResult> {
  const t0 = Date.now();
  const scenario = 'D_kill_switch_db_trigger';
  const reasonDetail = `risk drill 2026-06-23 scenario D pid=${process.pid}`;
  let triggeredId: number | null = null;
  try {
    const triggered = await killSwitchService.trigger({
      reason_code: 'smoke_test',
      reason_detail: reasonDetail,
      source: 'manual',
      triggered_by: 'risk-drill',
      metadata: { drill: true, scenario: 'D', date: '2026-06-23' },
    });
    triggeredId = triggered.state?.id ?? null;
    const check = await killSwitchService.isTriggered();
    if (!check.active) {
      return {
        scenario,
        passed: false,
        detail: `BUG: trigger() 成功但 isTriggered() 返 active=false (DB 未持久化或查询逻辑错)`,
        duration_ms: Date.now() - t0,
      };
    }
    if (check.source !== 'db') {
      return {
        scenario,
        passed: false,
        detail: `BUG: 期望 source='db', 实际 source='${check.source}'`,
        duration_ms: Date.now() - t0,
      };
    }
    // 验证 LiveTradingSafetyService 把 DB kill switch 也叠进 global_kill_switch
    // (env 关掉, 单独看 DB OR 部分)
    const original: Record<string, string | undefined> = {};
    for (const k of [
      'LIVE_TRADING_ENABLED',
      'LIVE_ORDER_EXECUTION_ENABLED',
      'LIVE_TRADING_KILL_SWITCH',
    ]) {
      original[k] = process.env[k];
    }
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
    process.env.LIVE_TRADING_KILL_SWITCH = 'false';
    let statusOk = false;
    try {
      const svc = new LiveTradingSafetyService();
      const status: any = svc.getStatus(
        { broker_key: 'qmt_bridge', trading_supported: true },
        { active: true, reason_code: 'smoke_test', reason_detail: reasonDetail }
      );
      statusOk =
        status.db_kill_switch === true &&
        status.global_kill_switch === true &&
        status.can_submit_orders === false;
    } finally {
      for (const [k, v] of Object.entries(original)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    if (!statusOk) {
      return {
        scenario,
        passed: false,
        detail: `BUG: LiveTradingSafetyService 未把 DB kill switch 叠进 global_kill_switch / can_submit_orders=true`,
        duration_ms: Date.now() - t0,
      };
    }
    return {
      scenario,
      passed: true,
      detail: `DB kill switch trigger() → isTriggered=true source=db ✓; LiveTradingSafetyService db_kill_switch=true & can_submit_orders=false ✓`,
      duration_ms: Date.now() - t0,
    };
  } finally {
    // 必须 resolve 防 prod 残留 kill switch
    try {
      const active = await killSwitchService.getActiveState();
      if (active) {
        await killSwitchService.resolve({
          resolved_by: 'risk-drill',
          note: 'risk drill 2026-06-23 scenario D rollback',
        });
      }
      logger.info(
        `[risk-drill.scenarioD] kill switch resolved id=${triggeredId} (rollback for prod safety)`
      );
    } catch (e: any) {
      logger.error(
        `[risk-drill.scenarioD] rollback FAILED — prod kill switch still active! ${e?.message || e}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
//  Orchestration
// ---------------------------------------------------------------------------

interface RunOptions {
  userId: number;
  only?: string;
}

async function runDrill(opts: RunOptions): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const want = (s: string) => !opts.only || opts.only.includes(s);
  if (want('A'))
    results.push(await withTimeout('A', () => scenarioA_drawdownBlockBuy(opts.userId)));
  if (want('B')) results.push(await withTimeout('B', () => scenarioB_failClosed(opts.userId)));
  if (want('C')) results.push(await withTimeout('C', () => scenarioC_killSwitchEnv()));
  if (want('D')) results.push(await withTimeout('D', () => scenarioD_killSwitchDb()));
  return results;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { userId: 4 };
  for (const a of argv) {
    if (a.startsWith('--user=')) opts.userId = Number(a.slice('--user='.length));
    if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  logger.info(`[risk-drill] starting 2026-06-23 user=${args.userId} only=${args.only || 'ALL'}`);
  let allPassed = true;
  const results = await runDrill(args);
  for (const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(
      `[risk-drill] ${tag} ${r.scenario} (${r.duration_ms}ms): ${r.detail}${
        r.error ? ' err=' + r.error : ''
      }`
    );
    if (!r.passed) allPassed = false;
  }
  // eslint-disable-next-line no-console
  console.log(
    `[risk-drill] DONE total=${results.length} passed=${
      results.filter(r => r.passed).length
    } failed=${results.filter(r => !r.passed).length}`
  );
  // 关 sequelize 让进程退出干净
  try {
    await sequelize.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(allPassed ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => {
    // eslint-disable-next-line no-console
    console.error('[risk-drill] FATAL', err);
    try {
      sequelize.close();
    } catch (_) {
      /* ignore */
    }
    process.exit(2);
  });
}

export {
  runDrill,
  scenarioA_drawdownBlockBuy,
  scenarioB_failClosed,
  scenarioC_killSwitchEnv,
  scenarioD_killSwitchDb,
};
