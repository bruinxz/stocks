/**
 * 一次性维护脚本：清空 paper_trading 所有数据 + 确保 stock 用户和默认 portfolio 就绪
 *
 * Batch W (2026-06-17): 加 ALLOW_DESTRUCTIVE_RESET guard + --i-know-what-im-doing flag.
 * 之前任何人 node reset_paper_trading_to_stock.js 直接 DELETE 7 张表 + 覆盖 stock 密码.
 *
 * 使用：
 *   ALLOW_DESTRUCTIVE_RESET=true NODE_PATH=/opt/stocks/current/backend/node_modules \
 *     node scripts/maintenance/reset_paper_trading_to_stock.js --i-know-what-im-doing
 *
 * 历史上下文：US 之前各用户 (xz/lym) 模拟盘混杂 23 个 portfolio / 1360 条 order_intent，
 * 决定统一收敛到单 stock 系统观测账号。本脚本：
 *   1. 清空 7 张 paper_trading_* 表（全用户）
 *   2. 创建 stock/666 admin 用户（如果不存在），配置好飞书 webhook
 *   3. 创建默认 portfolio "系统观测盘" ¥200,000 cash
 *
 * 后续：从交易日 15:30 PAPER_TRADING_DAILY_DIGEST 开始自动跟单。
 */

// Batch W: 双层 guard 防误跑
if (process.env.ALLOW_DESTRUCTIVE_RESET !== 'true') {
  console.error('[SAFE-GUARD] reset_paper_trading_to_stock.js 会清空 7 张 paper_trading 表 (全用户).');
  console.error('[SAFE-GUARD] 如确认请: ALLOW_DESTRUCTIVE_RESET=true node ... --i-know-what-im-doing');
  process.exit(1);
}
if (!process.argv.includes('--i-know-what-im-doing')) {
  console.error('[SAFE-GUARD] 缺少 --i-know-what-im-doing flag. 这是 prod 数据销毁脚本.');
  process.exit(1);
}

require('dotenv').config({ path: '/opt/stocks/current/backend/.env' });
const { sequelize } = require('/opt/stocks/current/backend/dist/config/database');
const bcrypt = require('/opt/stocks/current/backend/node_modules/bcrypt');

(async () => {
  const t = await sequelize.transaction();
  try {
    const tables = [
      'paper_trading_canary_review_snapshots',
      'paper_trading_order_intent_outcomes',
      'paper_trading_order_intents',
      'paper_trading_snapshots',
      'paper_trading_trades',
      'paper_trading_positions',
      'paper_trading_portfolios',
    ];
    for (const tb of tables) {
      await sequelize.query(`DELETE FROM ${tb}`, { transaction: t });
      console.log(`  cleared ${tb}`);
    }

    const [[exist]] = await sequelize.query("SELECT id FROM users WHERE username='stock'", { transaction: t });
    let userId;
    if (exist) {
      userId = exist.id;
      console.log(`  user stock already exists id=${userId}`);
    } else {
      const passwordHash = await bcrypt.hash('666', 10);
      const [r] = await sequelize.query(
        `INSERT INTO users (username, password_hash, email, role, is_active, risk_config, created_at, updated_at)
         VALUES ('stock', :hash, 'stock@system.local', 'admin', true, :risk_config::jsonb, NOW(), NOW())
         RETURNING id`,
        {
          transaction: t,
          replacements: {
            hash: passwordHash,
            risk_config: JSON.stringify({
              enableVolumeAlert: true,
              stop_loss_percent: 5,
              take_profit_percent: 10,
              enableTechnicalAlert: true,
              notification_channels: {
                feishu: {
                  enabled: true,
                  webhook_url: 'https://open.larkoffice.com/open-apis/bot/v2/hook/f77a6f3b-e37f-48bc-9820-305cbaf4310b',
                  daily_digest: true,
                  morning_brief: true,
                  earnings_forecast_alert: true,
                  risk_alert: true,
                  autonomous_trading: false,
                },
                email: { enabled: false },
                wechat: { enabled: false },
                sms: { enabled: false },
              },
            }),
          },
        }
      );
      userId = r[0].id;
      console.log(`  ✓ created user stock id=${userId}`);
    }

    await sequelize.query(
      `INSERT INTO paper_trading_portfolios (user_id, name, initial_capital, current_cash, total_value, is_active, created_at, updated_at)
       VALUES (:user_id, '系统观测盘', 200000, 200000, 200000, true, NOW(), NOW())`,
      { transaction: t, replacements: { user_id: userId } }
    );
    console.log(`  ✓ created portfolio "系统观测盘" for user_id=${userId} initial=¥200,000`);

    await t.commit();
    console.log('\n✅ stock setup complete');
  } catch (e) {
    await t.rollback();
    console.error('❌ failed:', e.message);
    process.exit(1);
  }
  await sequelize.close();
})();
