#!/usr/bin/env node

import moment from 'moment-timezone';
import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { User } from '../models/User';
import { quantFusionService } from '../quant/engine/internal/QuantFusionService';
import { paperTradingDashboardService } from '../portfolio/internal/PaperTradingDashboardService';

function argValue(name: string, fallback?: string) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(item => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function boolArg(name: string, fallback = false) {
  const value = argValue(name);
  if (value === undefined) return fallback;
  return ['true', '1', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

async function resetPaperTrading() {
  await sequelize.query(`
    UPDATE ai_investment_signals
    SET metadata = metadata - 'paper_trading' - 'paper_trading_by_portfolio',
        updated_at = NOW()
    WHERE metadata ? 'paper_trading' OR metadata ? 'paper_trading_by_portfolio';

    TRUNCATE TABLE
      paper_trading_order_intent_outcomes,
      paper_trading_canary_review_snapshots,
      paper_trading_order_intents,
      recommendation_trade_outcomes,
      paper_trading_snapshots,
      paper_trading_trades,
      paper_trading_positions,
      paper_trading_portfolios
    RESTART IDENTITY CASCADE;
  `);
}

async function main() {
  const username = argValue('username', process.env.RESET_PAPER_USERNAME || 'stock') || 'stock';
  const trade_date =
    argValue('trade-date', process.env.RESET_PAPER_TRADE_DATE) ||
    moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
  const candidate_limit = Number(
    argValue('candidate-limit', process.env.RESET_PAPER_CANDIDATE_LIMIT || '360')
  );
  const archive_limit = Number(
    argValue('archive-limit', process.env.RESET_PAPER_ARCHIVE_LIMIT || '60')
  );
  const dry_run = boolArg('dry-run', false);

  await sequelize.authenticate();
  await sequelize.sync();

  const user = await User.findOne({ where: { username } });
  if (!user) {
    throw new Error(`未找到用户: ${username}`);
  }

  console.log(`[reset-paper] clearing all paper trading portfolios for a clean race...`);
  await resetPaperTrading();
  console.log(`[reset-paper] cleared. starting quant pipeline for ${trade_date} as ${username}`);

  const result = await quantFusionService.runDailyPipeline({
    user_id: user.id,
    username: user.username,
    trade_date,
    target_date: trade_date,
    universe: 'market',
    candidate_limit,
    archive_limit,
    min_score: Number(argValue('min-score', '55')),
    agent_min_score: Number(argValue('agent-min-score', '72')),
    agent_max_count: Number(argValue('agent-max-count', '6')),
    submit_agent_analysis: !boolArg('skip-agent', false),
    agent_auto_paper_trade: true,
    run_paper_trading: true,
    run_strategy_portfolio_experiments: true,
    dry_run,
    refresh_realtime_quotes: true,
    quote_sync_limit: Number(argValue('quote-sync-limit', String(candidate_limit))),
    sync_factors_before_scan: true,
    factor_sync_scope: 'market',
    factor_sync_limit: Number(argValue('factor-sync-limit', String(candidate_limit))),
    report_to_feishu: !boolArg('skip-feishu', false),
    notify_to_feishu_bot: !boolArg('skip-feishu-bot', false),
    paper_trade_limit: Number(argValue('paper-trade-limit', '4')),
    paper_trade_scan_limit: Number(argValue('paper-trade-scan-limit', '180')),
    max_positions: Number(argValue('max-positions', '10')),
    max_daily_new_positions: Number(argValue('max-daily-new-positions', '4')),
    default_position_pct: Number(argValue('default-position-pct', '4')),
    max_position_pct: Number(argValue('max-position-pct', '8')),
    min_trade_amount: Number(argValue('min-trade-amount', '3000')),
    min_cash_reserve_pct: Number(argValue('min-cash-reserve-pct', '12')),
    max_total_exposure_pct: Number(argValue('max-total-exposure-pct', '55')),
    max_industry_exposure_pct: Number(argValue('max-industry-exposure-pct', '22')),
    max_portfolio_drawdown_pct: Number(argValue('max-portfolio-drawdown-pct', '10')),
    max_position_correlation: Number(argValue('max-position-correlation', '0.82')),
    max_portfolio_var_pct: Number(argValue('max-portfolio-var-pct', '8')),
    min_avg_turnover_yuan: Number(argValue('min-avg-turnover-yuan', '20000000')),
    block_limit_up: true,
    block_limit_down: true,
    block_suspended: true,
    task_label: '模拟盘统一起跑-策略族对照',
    agent_session: 'close',
  });

  const dashboard = await paperTradingDashboardService.getAutonomousDashboard({
    user_id: user.id,
    username: user.username,
  });
  const familySummary = dashboard.portfolio_family_summary;
  const resultAny: any = result;
  const overview = {
    trade_date,
    dry_run,
    generated: result.generated,
    archive: result.archive,
    paper_trading: {
      portfolio_id: resultAny.paper_trading?.portfolio_id,
      executed: resultAny.paper_trading?.executed,
      skipped: resultAny.paper_trading?.skipped,
    },
    strategy_portfolio_experiments: (resultAny.strategy_portfolio_experiments || []).map(
      (item: any) => ({
        key: item.key,
        label: item.label,
        portfolio_id: item.result?.portfolio_id,
        executed: item.result?.executed,
        planned: item.result?.planned,
        skipped: item.result?.skipped,
        matched: item.result?.strategy_filter_policy?.matched,
        error: item.result?.error,
      })
    ),
    family_summary: familySummary?.summary,
  };
  console.log(JSON.stringify(overview, null, 2));

  const counts = await sequelize.query(
    `SELECT name, current_cash, total_value, created_at
     FROM paper_trading_portfolios
     ORDER BY id ASC`,
    { type: QueryTypes.SELECT }
  );
  console.log(JSON.stringify({ portfolios: counts }, null, 2));
  await sequelize.close();
}

main().catch(async error => {
  console.error(error?.stack || error?.message || String(error));
  await sequelize.close().catch(() => undefined);
  process.exit(1);
});
