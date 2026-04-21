const fs = require('fs');
const path = require('path');

const replacements = {
  "userId": "user_id",
  "strategyConfig": "strategy_config",
  "startDate": "start_date",
  "endDate": "end_date",
  "initialCapital": "initial_capital",
  "finalCapital": "final_capital",
  "totalReturn": "total_return",
  "annualizedReturn": "annualized_return",
  "sharpeRatio": "sharpe_ratio",
  "sortinoRatio": "sortino_ratio",
  "maxDrawdown": "max_drawdown",
  "winRate": "win_rate",
  "profitLossRatio": "profit_loss_ratio",
  "totalTrades": "total_trades",
  "profitTrades": "profit_trades",
  "lossTrades": "loss_trades",
  "errorMessage": "error_message",
  "detailedMetrics": "detailed_metrics",
  "annualizedVolatility": "annualized_volatility",
  "informationRatio": "information_ratio",
  "calmarRatio": "calmar_ratio",
  "equityCurve": "equity_curve",
  "dailyReturns": "daily_returns",
  "createdAt": "created_at",
  "updatedAt": "updated_at",
  "stockId": "stock_id",
  "adjClose": "adj_close",
  "turnoverRate": "turnover_rate",
  "changePercent": "change_percent",
  "marketCap": "market_cap",
  "isTradingDay": "is_trading_day",
  "isSuspended": "is_suspended",
  "affectedStocks": "affected_stocks",
  "insertedRecords": "inserted_records",
  "startedAt": "started_at",
  "completedAt": "completed_at",
  "groupId": "group_id",
  "sortOrder": "sort_order",
  "currentCash": "current_cash",
  "totalValue": "total_value",
  "isActive": "is_active",
  "portfolioId": "portfolio_id",
  "avgCost": "avg_cost",
  "currentPrice": "current_price",
  "marketValue": "market_value",
  "unrealizedPnl": "unrealized_pnl",
  "positionValue": "position_value",
  "executePrice": "execute_price",
  "realizedPnl": "realized_pnl",
  "isRead": "is_read",
  "cronExpression": "cron_expression",
  "lastRunAt": "last_run_at",
  "lastRunStatus": "last_run_status",
  "listingDate": "listing_date",
  "delistingDate": "delisting_date",
  "isListed": "is_listed",
  "dataStatus": "data_status",
  "totalMarketCap": "total_market_cap",
  "circulatingMarketCap": "circulating_market_cap",
  "peDynamic": "pe_dynamic",
  "dailyBars": "daily_bars",
  "backtestId": "backtest_id",
  "entryDate": "entry_date",
  "exitDate": "exit_date",
  "entryPrice": "entry_price",
  "exitPrice": "exit_price",
  "pnlPercent": "pnl_percent",
  "holdingDays": "holding_days",
  "entryValue": "entry_value",
  "exitValue": "exit_value",
  "stampDuty": "stamp_duty",
  "transferFee": "transfer_fee",
  "totalFee": "total_fee",
  "netPnl": "net_pnl",
  "entrySignal": "entry_signal",
  "exitSignal": "exit_signal",
  "marketSummary": "market_summary",
  "portfolioAnalysis": "portfolio_analysis",
  "actionPlan": "action_plan",
  "avatarUrl": "avatar_url",
  "passwordHash": "password_hash",
  "riskConfig": "risk_config",
  "backtestResults": "backtest_results",
  "riskAlerts": "risk_alerts",
  "tradingJournals": "trading_journals",
  "stopLossPercent": "stop_loss_percent",
  "takeProfitPercent": "take_profit_percent",
  "maxPositions": "max_positions",
  "maxPositionSizePercent": "max_position_size_percent",
  "allowMargin": "allow_margin",
  "allowShort": "allow_short"
};

function walk(dir) {
  let results = [];
  const list = fs.readdirSync(dir);
  list.forEach(file => {
    file = path.join(dir, file);
    const stat = fs.statSync(file);
    if (stat && stat.isDirectory()) {
      results = results.concat(walk(file));
    } else {
      if (file.endsWith('.ts')) {
        results.push(file);
      }
    }
  });
  return results;
}

const files = walk(path.join(__dirname, 'src'));

let changedFiles = 0;
files.forEach(file => {
  let content = fs.readFileSync(file, 'utf8');
  let original = content;
  
  // For each key, replace occurrences of the key that are standalone properties or variables
  // We use regex with word boundaries
  for (const [camel, snake] of Object.entries(replacements)) {
    const regex = new RegExp(`\\b${camel}\\b`, 'g');
    content = content.replace(regex, snake);
  }
  
  if (content !== original) {
    fs.writeFileSync(file, content, 'utf8');
    changedFiles++;
  }
});

console.log(`Updated ${changedFiles} files in backend`);
