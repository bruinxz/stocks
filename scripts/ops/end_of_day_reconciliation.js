#!/usr/bin/env node
/**
 * 收盘对账脚本。
 *
 * 上线 launch-helper：每个交易日收盘后跑一次，把当日 live_orders / live_trades / live_broker_commands
 * 汇总成一张差异表，与 QMT 客户端"今日成交"页面或券商交割单逐项核对。
 *
 * 不替代人工核对，但能把"对得上的部分"用 SQL 跑掉，剩下"对不上的"才需要人盯。
 *
 * 使用：
 *   DB_HOST=... node scripts/ops/end_of_day_reconciliation.js [--date 2026-06-01]
 *
 * 输出：
 *   - 控制台报告
 *   - 当日异常的 audit 行
 *   - 退出码 0=全部对齐 / 1=有异常需人工复核
 */

const path = require('path');

let Client;
try {
  ({ Client } = require(path.resolve(__dirname, '../../backend/node_modules/pg')));
} catch (e) {
  console.error('pg 未安装；请先 cd backend && npm install');
  process.exit(2);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--date') args.date = argv[++i];
    else if (argv[i] === '--account') args.account = argv[++i];
  }
  if (!args.date) {
    const today = new Date();
    args.date = today.toISOString().slice(0, 10);
  }
  return args;
}

async function summarizeCommands(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT status, command_type, count(*) AS n
       FROM live_broker_commands
      WHERE created_at::date = $1::date ${accountSql}
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    args
  );
  return r.rows;
}

async function summarizeOrders(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT bridge_status, count(*) AS n, sum(quantity)::bigint AS total_qty
       FROM live_orders
      WHERE created_at::date = $1::date ${accountSql}
      GROUP BY 1
      ORDER BY 1`,
    args
  );
  return r.rows;
}

async function summarizeTrades(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT side, count(*) AS n,
            sum(quantity)::bigint AS total_qty,
            sum(trade_amount)::numeric(18,2) AS total_amount
       FROM live_trades
      WHERE trade_time::date = $1::date ${accountSql}
      GROUP BY 1
      ORDER BY 1`,
    args
  );
  return r.rows;
}

async function findAnomalies(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT id, event_type, severity, message, account_id, order_id, draft_id, created_at
       FROM live_execution_audit_logs
      WHERE created_at::date = $1::date ${accountSql}
        AND severity IN ('warning', 'error', 'critical')
      ORDER BY created_at DESC
      LIMIT 200`,
    args
  );
  return r.rows;
}

async function findOrdersWithoutCommand(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND lo.account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT lo.id, lo.client_order_id, lo.broker_order_id, lo.bridge_status,
            lo.account_id, lo.symbol, lo.side, lo.quantity
       FROM live_orders lo
       LEFT JOIN live_broker_commands lc
              ON lc.order_id = lo.id AND lc.command_type = 'place_order'
      WHERE lo.created_at::date = $1::date ${accountSql}
        AND lc.id IS NULL
      LIMIT 50`,
    args
  );
  return r.rows;
}

async function findCommandsWithoutFinalEvent(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND lc.account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT lc.id, lc.client_order_id, lc.command_type, lc.status, lc.account_id,
            lc.symbol, lc.created_at, lc.finalized_at
       FROM live_broker_commands lc
      WHERE lc.created_at::date = $1::date ${accountSql}
        AND lc.status NOT IN ('filled', 'cancelled', 'failed', 'expired')
      ORDER BY lc.created_at
      LIMIT 50`,
    args
  );
  return r.rows;
}

async function findTradesWithoutLiveOrder(client, date, accountFilter) {
  const args = [date];
  let accountSql = '';
  if (accountFilter) {
    args.push(accountFilter);
    accountSql = `AND lt.account_id = $${args.length}`;
  }
  const r = await client.query(
    `SELECT lt.id, lt.broker_trade_id, lt.broker_order_id, lt.symbol, lt.side, lt.quantity,
            lt.trade_amount, lt.trade_time
       FROM live_trades lt
       LEFT JOIN live_orders lo ON lo.id = lt.order_id
      WHERE lt.trade_time::date = $1::date ${accountSql}
        AND lo.id IS NULL
      LIMIT 50`,
    args
  );
  return r.rows;
}

function printTable(title, rows) {
  console.log(`\n=== ${title} ===`);
  if (!rows.length) {
    console.log('  (空)');
    return;
  }
  for (const r of rows) {
    console.log('  ' + JSON.stringify(r));
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const config = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'stock_backtest',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
    statement_timeout: 30_000,
  };
  console.log(`[recon] date=${args.date}${args.account ? ` account=${args.account}` : ''}`);
  console.log(`[recon] connecting to ${config.user}@${config.host}:${config.port}/${config.database}`);

  const client = new Client(config);
  await client.connect();
  try {
    const [commands, orders, trades, anomalies, ordersNoCmd, openCommands, tradesNoOrder] = await Promise.all([
      summarizeCommands(client, args.date, args.account),
      summarizeOrders(client, args.date, args.account),
      summarizeTrades(client, args.date, args.account),
      findAnomalies(client, args.date, args.account),
      findOrdersWithoutCommand(client, args.date, args.account),
      findCommandsWithoutFinalEvent(client, args.date, args.account),
      findTradesWithoutLiveOrder(client, args.date, args.account),
    ]);

    printTable('live_broker_commands 当日汇总（status × command_type）', commands);
    printTable('live_orders 当日汇总（bridge_status）', orders);
    printTable('live_trades 当日汇总（side）', trades);

    const issues = [];
    if (ordersNoCmd.length) {
      issues.push(`存在 ${ordersNoCmd.length} 条 LiveOrder 没有对应 place_order command（撤单走不通）`);
      printTable('⚠️ LiveOrder 缺 command', ordersNoCmd);
    }
    if (openCommands.length) {
      issues.push(`存在 ${openCommands.length} 条非终态 command 跨日未结（应已被 expire 但仍在）`);
      printTable('⚠️ command 未终态', openCommands);
    }
    if (tradesNoOrder.length) {
      issues.push(`存在 ${tradesNoOrder.length} 条 trade 没有对应 LiveOrder（孤儿成交）`);
      printTable('⚠️ trade 孤儿', tradesNoOrder);
    }
    if (anomalies.length) {
      issues.push(`存在 ${anomalies.length} 条 warning/error/critical audit`);
      printTable('⚠️ audit 异常事件', anomalies.slice(0, 30));
      if (anomalies.length > 30) console.log(`  ... 还有 ${anomalies.length - 30} 条`);
    }

    console.log('\n=========== summary ===========');
    if (issues.length === 0) {
      console.log('✅ 当日对账：DB 内部一致，无异常 audit');
      console.log('   下一步：人工把 live_trades 总额与 QMT 客户端"今日成交"页面对照。');
      process.exit(0);
    }
    console.error('❌ 当日对账发现异常，需人工复核：');
    for (const i of issues) console.error(`  - ${i}`);
    console.error('\n参考 docs/live_trading_launch_checklist.md §4.4 "真亏了怎么办"。');
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('[recon] error:', err.message || err);
  process.exit(2);
});
