const { sequelize } = require('../dist/config/database');

async function checkSymbolsSample() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 查看不带点号的股票代码示例
    const query = `
      SELECT symbol, name
      FROM stocks
      WHERE symbol NOT LIKE '%.%'
      ORDER BY symbol
      LIMIT 20
    `;

    const results = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });

    console.log('不带点号的股票代码示例 (前20只):');
    results.forEach((row, i) => {
      console.log(`  ${i+1}. ${row.symbol} - ${row.name}`);
    });

    // 分析格式
    console.log('\n格式分析:');
    results.forEach(row => {
      const sym = row.symbol;
      if (/^[a-z]{2}[0-9]+$/.test(sym)) {
        const prefix = sym.substring(0, 2);
        const code = sym.substring(2);
        console.log(`  ${sym}: 前缀 "${prefix}", 代码 "${code}"`);
      } else if (/^[0-9]+$/.test(sym)) {
        console.log(`  ${sym}: 纯数字`);
      } else {
        console.log(`  ${sym}: 其他格式`);
      }
    });

  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

checkSymbolsSample();