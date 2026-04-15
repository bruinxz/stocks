const { Sequelize } = require('sequelize');

const sequelize = new Sequelize({
  database: 'stock_backtest',
  username: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  dialect: 'postgres',
  logging: false,
});

const Stock = sequelize.define('stock', {
  id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  symbol: { type: Sequelize.STRING(10), allowNull: false },
  name: { type: Sequelize.STRING(100), allowNull: false },
}, {
  tableName: 'stocks',
  timestamps: false,
});

async function main() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功');

    const stocks = await Stock.findAll({
      limit: 20,
    });

    console.log(`共 ${stocks.length} 支股票`);
    console.log('前20支股票:');
    stocks.forEach((stock, i) => {
      console.log(`  ${i+1}. ID: ${stock.id}, 符号: "${stock.symbol}", 名称: "${stock.name}"`);
    });

    // 检查是否有符号为null或undefined的股票
    const nullSymbolStocks = stocks.filter(s => !s.symbol || s.symbol.trim() === '');
    console.log(`\n符号为空的股票: ${nullSymbolStocks.length}`);
    nullSymbolStocks.forEach(s => console.log(`  ID: ${s.id}, 名称: "${s.name}"`));

    // 检查符号格式
    console.log('\n符号格式检查:');
    stocks.forEach(s => {
      if (s.symbol) {
        if (!s.symbol.includes('.')) {
          console.log(`  ${s.symbol} - 缺少市场前缀`);
        }
      }
    });

  } catch (error) {
    console.error('错误:', error);
  } finally {
    await sequelize.close();
  }
}

main();