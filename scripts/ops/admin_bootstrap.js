#!/usr/bin/env node
/**
 * Admin bootstrap helper.
 *
 * 上线 launch-helper：production 启动时禁止默认 admin 密码（'666' 已经被拒），
 * 但生产 DB 第一次起仍需要至少一个 admin 用户。本脚本两种模式：
 *
 *   1. dry-run（默认）：bcrypt 哈希密码 → 打印一条可执行的 INSERT SQL
 *      运维拷到 psql 里执行即可，**密码不会随 shell 历史/git 落地**。
 *
 *   2. --apply：直连 DB 自动 upsert（用 DB_* 环境变量）。
 *      仅在你完全清楚 DB 当前状态时使用；脚本会先查同名用户是否存在。
 *
 * 使用：
 *   # 仅生成 SQL，不动 DB
 *   node scripts/ops/admin_bootstrap.js --username lym --email lym@example.com
 *
 *   # 直接写入 DB
 *   DB_HOST=... DB_USER=... DB_PASSWORD=... \
 *     node scripts/ops/admin_bootstrap.js --username lym --email lym@example.com --apply
 *
 * 密码来源（按优先级）：
 *   - --password <value>      显式指定
 *   - LIVE_ADMIN_BOOTSTRAP_PASSWORD env
 *   - 交互式 stdin（隐藏输入）
 *
 * 安全提示：
 *   - 不要把密码写进 shell history；优先用 env 或交互式
 *   - bcrypt 强度 12 round（与 User 模型 beforeCreate 钩子保持一致）
 *   - 如果你已经手动登入 PG 用了示例里 '666' 密码的 INSERT，请立即跑 --apply 模式覆盖
 */

const path = require('path');
const readline = require('readline');

let bcrypt;
try {
  bcrypt = require(path.resolve(__dirname, '../../backend/node_modules/bcrypt'));
} catch (e) {
  // bcrypt 是 native module；跨平台 binding 缺失（比如本地 mac 编译后到 Linux 跑）会 ELF 错。
  // 这种情况说明本机上 backend 还没 npm install 过；按提示重新安装即可。
  console.error('bcrypt 加载失败：' + (e.message || e));
  console.error('解决：在当前机器执行 `cd backend && npm rebuild bcrypt`（或 npm install）。');
  process.exit(2);
}

function loadPg() {
  try {
    return require(path.resolve(__dirname, '../../backend/node_modules/pg'));
  } catch (e) {
    console.error('pg 未安装；请先 cd backend && npm install');
    process.exit(2);
  }
}

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--username') args.username = argv[++i];
    else if (arg === '--email') args.email = argv[++i];
    else if (arg === '--password') args.password = argv[++i];
    else if (arg === '--role') args.role = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function help() {
  console.log(
    `Usage: node scripts/ops/admin_bootstrap.js --username <name> [--email <email>] [--password <pwd>] [--role admin|user] [--apply]\n\n` +
      `  默认 dry-run 只打印 SQL；--apply 会直连 DB upsert。\n` +
      `  密码源：--password / LIVE_ADMIN_BOOTSTRAP_PASSWORD env / 交互式 stdin\n`
  );
}

function readPasswordFromStdin() {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      let buffer = '';
      rl.on('line', line => {
        buffer = line;
        rl.close();
      });
      rl.on('close', () => resolve(buffer));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // 简化版隐藏输入：依赖 TTY 自带掩码，避免引入新依赖
    process.stdout.write('密码（输入不可见）：');
    rl.stdoutMuted = true;
    rl._writeToOutput = function (str) {
      if (str.match(/\r|\n/)) rl.output.write(str);
    };
    rl.question('', value => {
      rl.close();
      process.stdout.write('\n');
      resolve(value);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) return help();
  if (!args.username) {
    console.error('error: --username 必填');
    help();
    process.exit(1);
  }
  const email = args.email || `${args.username}@example.com`;
  const role = args.role || 'admin';
  if (!['admin', 'user'].includes(role)) {
    console.error(`error: --role 必须是 admin / user，当前 ${role}`);
    process.exit(1);
  }

  let password = args.password || process.env.LIVE_ADMIN_BOOTSTRAP_PASSWORD || '';
  if (!password) {
    password = await readPasswordFromStdin();
  }
  password = (password || '').trim();
  if (!password) {
    console.error('error: 密码不能为空');
    process.exit(1);
  }
  if (password.length < 12) {
    console.error(`error: 密码长度 ${password.length} < 12，admin 账户必须 ≥12 位`);
    process.exit(1);
  }
  const WEAK = new Set(['password', '123456', '12345678', 'admin', 'qwerty', '666666']);
  if (WEAK.has(password.toLowerCase())) {
    console.error('error: 密码是常见弱口令');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);

  if (!args.apply) {
    const sql = `-- 在生产 PG 中执行以下 SQL（密码已 bcrypt 哈希；明文不在 SQL 中）
INSERT INTO users (username, email, password_hash, role, is_active, created_at, updated_at)
VALUES (
  ${pgQuote(args.username)},
  ${pgQuote(email)},
  ${pgQuote(hash)},
  ${pgQuote(role)},
  true,
  NOW(),
  NOW()
)
ON CONFLICT (username) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    email = EXCLUDED.email,
    role = EXCLUDED.role,
    is_active = true,
    updated_at = NOW();
`;
    console.log(sql);
    console.log(`\n# bcrypt hash (长度 ${hash.length})：${hash}`);
    console.log(`# 用法提示：保存到一次性文件 → psql -f admin.sql → 立即 shred -u admin.sql`);
    return;
  }

  const pg = loadPg();
  const client = new pg.Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'stock_backtest',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: String(process.env.DB_SSL || 'false').toLowerCase() === 'true' ? { rejectUnauthorized: false } : false,
    statement_timeout: 15000,
  });
  await client.connect();
  try {
    const existing = await client.query('SELECT id, role FROM users WHERE username = $1', [args.username]);
    const result = await client.query(
      `INSERT INTO users (username, email, password_hash, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, NOW(), NOW())
       ON CONFLICT (username) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             email = EXCLUDED.email,
             role = EXCLUDED.role,
             is_active = true,
             updated_at = NOW()
       RETURNING id, username, email, role`,
      [args.username, email, hash, role]
    );
    if (existing.rowCount > 0) {
      console.log(`✅ updated user ${args.username} (id=${result.rows[0].id})；旧 role=${existing.rows[0].role} → ${role}`);
    } else {
      console.log(`✅ created user ${args.username} (id=${result.rows[0].id}, role=${role})`);
    }
  } finally {
    await client.end();
  }
}

function pgQuote(value) {
  return `'${String(value).replace(/'/g, `''`)}'`;
}

main().catch(err => {
  console.error('error:', err.message || err);
  process.exit(2);
});
