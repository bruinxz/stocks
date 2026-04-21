const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('stock_backtest', 'stock_admin', 'x8Vq$9pL2#mK7@nW1cF5^jY3!bH4*gD', {
  host: '103.242.3.87',
  port: 5432,
  dialect: 'postgres',
  logging: false,
});

async function run() {
  try {
    await sequelize.query("INSERT INTO stocks (symbol, name, market, industry, is_listed, price, change_percent, created_at, updated_at) VALUES ('sh.000001', '上证指数', 'sh', '指数', true, 0, 0, NOW(), NOW()) ON CONFLICT (symbol) DO NOTHING;");
    await sequelize.query("INSERT INTO stocks (symbol, name, market, industry, is_listed, price, change_percent, created_at, updated_at) VALUES ('sh.000300', '沪深300', 'sh', '指数', true, 0, 0, NOW(), NOW()) ON CONFLICT (symbol) DO NOTHING;");
    await sequelize.query("INSERT INTO stocks (symbol, name, market, industry, is_listed, price, change_percent, created_at, updated_at) VALUES ('sz.399001', '深证成指', 'sz', '指数', true, 0, 0, NOW(), NOW()) ON CONFLICT (symbol) DO NOTHING;");
    await sequelize.query("INSERT INTO stocks (symbol, name, market, industry, is_listed, price, change_percent, created_at, updated_at) VALUES ('sz.399006', '创业板指', 'sz', '指数', true, 0, 0, NOW(), NOW()) ON CONFLICT (symbol) DO NOTHING;");
    console.log('Indices inserted successfully.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}
run();
