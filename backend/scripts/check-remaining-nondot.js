const { sequelize } = require('../dist/config/database');

async function checkRemaining() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    const query = `
      SELECT COUNT(*) as count
      FROM stocks
      WHERE symbol NOT LIKE '%.%'
    `;
    const result = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });
    const count = parseInt(result[0].count);
    console.log(`不带点号的股票数量: ${count}`);

    if (count > 0) {
      const sampleQuery = `
        SELECT symbol, name
        FROM stocks
        WHERE symbol NOT LIKE '%.%'
        LIMIT 5
      `;
      const samples = await sequelize.query(sampleQuery, { type: sequelize.QueryTypes.SELECT });
      console.log('\n示例:');
      samples.forEach(row => {
        console.log(`  ${row.symbol} - ${row.name}`);
      });
    }
  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

checkRemaining();