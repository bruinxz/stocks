/**
 * TradePostmortemService 单测 — Phase 5+ 自动事后复盘
 *
 * 测 generate() 的纯逻辑（fetch_baseline=false 跳过 DB）
 */
import { TradePostmortemService } from '../../src/services/TradePostmortemService';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function testGenerateReturnsNullForProfit() {
  console.log('\n## generate: profit_take 返回 null (不需要复盘)');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'mfa',
    root_cause: 'profit_take',
    root_cause_label: '止盈出场',
    symbol: 'SH600519',
    total_pnl_pct: 8,
    holding_days: 30,
    fetch_baseline: false,
  });
  assert('profit_take → null', r === null);
}

async function testGenerateReturnsNullForUnknown() {
  console.log('\n## generate: unknown 返回 null');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'mfa',
    root_cause: 'unknown',
    root_cause_label: '未归类',
    symbol: 'SH600519',
    total_pnl_pct: -2,
    holding_days: 15,
    fetch_baseline: false,
  });
  assert('unknown → null', r === null);
}

async function testGenerateStopLossPostmortem() {
  console.log('\n## generate: stop_loss 触发完整复盘');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'multi_factor_alpha',
    root_cause: 'stop_loss',
    root_cause_label: '止损触发',
    symbol: 'SH600519',
    total_pnl_pct: -8.5,
    holding_days: 12,
    entry_price: 100,
    exit_price: 91.5,
    max_drawdown_during_hold_pct: 12.3,
    market_regime_at_entry: 'bull',
    market_regime_at_exit: 'bear',
    signal_catalyst: 'earnings_surprise',
    exit_reason: 'stop_loss_hit',
    signal_score: 0.78,
    fetch_baseline: false,
  });
  assert('非 null', r !== null);
  assert('strategy_key 透传', r?.strategy_key === 'multi_factor_alpha');
  assert('root_cause=stop_loss', r?.root_cause === 'stop_loss');
  assert(
    'bullets 5 个 (入场/持仓/环境/出场，无 baseline)',
    r?.bullets.length === 4,
    `actual=${r?.bullets.length}`
  );
  assert('第 1 bullet=入场判断', r?.bullets[0].title === '入场判断');
  assert('第 1 bullet 含 strategy', r?.bullets[0].detail.includes('multi_factor_alpha'));
  assert('第 1 bullet 含 signal_score', r?.bullets[0].detail.includes('0.78'));
  assert('第 2 bullet=持仓表现', r?.bullets[1].title === '持仓表现');
  assert('第 2 bullet 含 dd', r?.bullets[1].detail.includes('12.30%'));
  assert('第 3 bullet=市场环境', r?.bullets[2].title === '市场环境');
  assert('第 3 bullet 含 bull→bear', r?.bullets[2].detail.includes('bull'));
  assert('第 3 bullet 标识 regime_changed', r?.bullets[2].detail.includes('环境变化'));
  assert('第 4 bullet=触发出场', r?.bullets[3].title === '触发出场');
  assert('stop_loss suggestion 至少 1 条', (r?.suggestions.length || 0) >= 1);
  assert(
    'suggestion 提及 atr_risk 或 trailing',
    r?.suggestions.some(s => s.includes('atr_risk') || s.includes('trailing')) || false
  );
  assert('similar_baseline=undefined (fetch_baseline=false)', r?.similar_baseline === undefined);
}

async function testGenerateWrongRegime() {
  console.log('\n## generate: wrong_regime 触发');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'breakout_strategy',
    root_cause: 'wrong_regime',
    root_cause_label: '市场环境切换',
    symbol: 'SH600036',
    total_pnl_pct: -5,
    holding_days: 8,
    market_regime_at_entry: 'bull',
    market_regime_at_exit: 'bear',
    fetch_baseline: false,
  });
  assert('非 null', r !== null);
  assert(
    'wrong_regime suggestion 提及 environment_policy',
    r?.suggestions.some(s => s.includes('environment_policy') || s.includes('market_regime')) || false
  );
}

async function testGenerateCatalystFailed() {
  console.log('\n## generate: catalyst_failed 触发');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'earnings_surprise',
    root_cause: 'catalyst_failed',
    root_cause_label: '催化兑现失败',
    symbol: 'SH600519',
    total_pnl_pct: -3.2,
    holding_days: 45,
    signal_catalyst: 'earnings_forecast_surprise',
    fetch_baseline: false,
  });
  assert('非 null', r !== null);
  assert(
    'catalyst_failed suggestion 提及多源确认',
    r?.suggestions.some(s => s.includes('多源') || s.includes('确认')) || false
  );
}

async function testRegimeStable() {
  console.log('\n## generate: 同 regime 显示稳定');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'mfa',
    root_cause: 'wrong_entry',
    root_cause_label: '入场时机不佳',
    symbol: 'SH600519',
    total_pnl_pct: -2,
    holding_days: 7,
    market_regime_at_entry: 'range',
    market_regime_at_exit: 'range',
    fetch_baseline: false,
  });
  const envBullet = r?.bullets.find(b => b.title === '市场环境');
  assert('regime 稳定 → 标识环境稳定', envBullet?.detail.includes('稳定') || false);
  assert('regime_changed=false', (envBullet?.data as any)?.regime_changed === false);
}

async function testRiskKillSwitch() {
  console.log('\n## generate: risk_kill_switch 触发');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'mfa',
    root_cause: 'risk_kill_switch',
    root_cause_label: '风控熔断',
    symbol: 'SH600519',
    total_pnl_pct: 1,
    holding_days: 5,
    fetch_baseline: false,
  });
  assert('非 null', r !== null);
  assert(
    'risk_kill_switch suggestion 提及组合级或熔断',
    r?.suggestions.some(s => s.includes('组合级') || s.includes('熔断')) || false
  );
}

async function testTimeStop() {
  console.log('\n## generate: time_stop 触发');
  const svc = new TradePostmortemService();
  const r = await svc.generate({
    strategy_key: 'mfa',
    root_cause: 'time_stop',
    root_cause_label: '持仓超期',
    symbol: 'SH600519',
    total_pnl_pct: 0.5,
    holding_days: 60,
    fetch_baseline: false,
  });
  assert('非 null', r !== null);
  assert(
    'time_stop suggestion 提及 hold_days',
    r?.suggestions.some(s => s.includes('hold_days') || s.includes('超期') || s.includes('trailing')) || false
  );
}

async function main() {
  await testGenerateReturnsNullForProfit();
  await testGenerateReturnsNullForUnknown();
  await testGenerateStopLossPostmortem();
  await testGenerateWrongRegime();
  await testGenerateCatalystFailed();
  await testRegimeStable();
  await testRiskKillSwitch();
  await testTimeStop();

  console.log(`\n========================================`);
  console.log(`TradePostmortemService tests: ${passed} pass / ${failed} fail`);
  console.log(`========================================`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
