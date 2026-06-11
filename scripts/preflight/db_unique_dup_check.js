#!/usr/bin/env node
/**
 * Production DB unique-key preflight.
 *
 * 上线 launch-helper：在 ensureLiveTradingRuntimeSchema 创建 partial unique
 * (account_id, broker_order_id) 等索引之前，先在生产 PG 上跑一遍重复 key 检查。
 * 如果有重复行，索引创建会失败，server 启动也会被自己的 sync 路径阻塞。
 *
 * 使用：
 *   DB_HOST=... DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
 *     node scripts/preflight/db_unique_dup_check.js
 *
 * 退出码：
 *   0 = 全部通过
 *   1 = 有重复行，禁止上线
 *   2 = 连接 / SQL 错误
 *
 * 不依赖项目其它代码，纯 pg 客户端；可在任何能连到生产 DB 的跳板机上跑。
 */

const { Client } = require('pg');

function envOr(key, fallback) {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

const config = {
  host: envOr('DB_HOST', 'localhost'),
  port: Number(envOr('DB_PORT', 5432)),
  database: envOr('DB_NAME', 'stock_backtest'),
  user: envOr('DB_USER', 'postgres'),
  password: envOr('DB_PASSWORD', ''),
  ssl: envOr('DB_SSL', 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
  // 只读一次性脚本，不需要 keep-alive
  statement_timeout: 60_000,
};

const CHECKS = [
  {
    name: 'live_orders (account_id, broker_order_id)',
    sql: `
      SELECT account_id, broker_order_id, count(*) AS dup_count
      FROM live_orders
      WHERE broker_order_id IS NOT NULL
      GROUP BY 1, 2
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `,
    fix: 'partial unique idx_live_orders_account_broker_order_id_unique 创建会失败。先合并/删除重复 LiveOrder 行。',
  },
  {
    name: 'live_orders (client_order_id)',
    sql: `
      SELECT client_order_id, count(*) AS dup_count
      FROM live_orders
      WHERE client_order_id IS NOT NULL
      GROUP BY 1
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `,
    fix: '现有 partial unique idx_live_orders_client_order_id_unique 已存在，重复说明 ensureLiveTradingRuntimeSchema 未生效或被删过。',
  },
  {
    name: 'live_broker_commands (client_order_id)',
    sql: `
      SELECT client_order_id, count(*) AS dup_count
      FROM live_broker_commands
      GROUP BY 1
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `,
    fix: 'unique idx_live_broker_commands_client_order_id_unique 创建会失败。',
  },
  {
    name: 'live_broker_events (command_id, event_seq)',
    sql: `
      SELECT command_id, event_seq, count(*) AS dup_count
      FROM live_broker_events
      GROUP BY 1, 2
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `,
    fix: 'unique idx_live_broker_events_command_seq_unique 创建会失败。',
  },
  {
    name: 'live_trades (broker_trade_id)',
    sql: `
      SELECT broker_trade_id, count(*) AS dup_count
      FROM live_trades
      WHERE broker_trade_id IS NOT NULL
      GROUP BY 1
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `,
    fix: 'unique idx_live_trades_broker_trade_id_unique 创建会失败。',
  },
  {
    name: 'live_bridge_nonces (bridge_key, nonce)',
    sql: `
      SELECT bridge_key, nonce, count(*) AS dup_count
      FROM live_bridge_nonces
      GROUP BY 1, 2
      HAVING count(*) > 1
      ORDER BY count(*) DESC
      LIMIT 20
    `,
    fix: '复合 PK 应该天然不可能重复；如果有就是 schema 被改坏了。',
  },
  {
    name: 'live_broker_accounts active=true 不应该多于一条 bridge_key 共享',
    sql: `
      SELECT bridge_key, count(*) AS dup_count
      FROM live_broker_accounts
      WHERE bridge_key IS NOT NULL AND is_active = true
      GROUP BY 1
      HAVING count(*) > 1
    `,
    fix: 'partial unique idx_live_broker_accounts_bridge_key_unique 创建会失败；一个 bridge_key 只允许绑定一个 active 账户。',
  },
  {
    name: 'live_kill_switch_states active=true 不应多于一条',
    sql: `
      SELECT count(*) AS active_count
      FROM live_kill_switch_states
      WHERE active = true
      HAVING count(*) > 1
    `,
    fix: 'partial unique idx_live_kill_switch_states_active_unique 创建会失败；只允许一条 active 熔断。',
  },
];

async function tableExists(client, table) {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  return r.rowCount > 0;
}

async function main() {
  console.log(`[preflight] connecting to ${config.user}@${config.host}:${config.port}/${config.database}`);
  const client = new Client(config);
  await client.connect();
  let dupTotal = 0;
  const summary = [];
  try {
    for (const check of CHECKS) {
      const table = check.sql.match(/FROM\s+(\w+)/i)[1];
      const exists = await tableExists(client, table);
      if (!exists) {
        console.log(`[skip] ${check.name} (table ${table} 不存在)`);
        summary.push({ name: check.name, status: 'skipped (table missing)' });
        continue;
      }
      const r = await client.query(check.sql);
      if (r.rowCount === 0) {
        console.log(`[ok]   ${check.name}`);
        summary.push({ name: check.name, status: 'ok' });
      } else {
        dupTotal += r.rowCount;
        console.error(`[FAIL] ${check.name}: ${r.rowCount} 个重复 key`);
        console.error(`       fix: ${check.fix}`);
        for (const row of r.rows.slice(0, 10)) {
          console.error('       ', JSON.stringify(row));
        }
        summary.push({ name: check.name, status: 'fail', dup_count: r.rowCount });
      }
    }
  } finally {
    await client.end();
  }

  console.log('\n=========== preflight summary ===========');
  for (const s of summary) console.log(`  - ${s.name}: ${s.status}${s.dup_count ? ` (${s.dup_count})` : ''}`);
  if (dupTotal > 0) {
    console.error(`\n❌ DB preflight 失败，发现 ${dupTotal} 处重复。必须先清理脏数据再上线。`);
    process.exit(1);
  }
  console.log('\n✅ DB preflight 通过');
}

main().catch(err => {
  console.error('[preflight] error:', err.message || err);
  process.exit(2);
});
