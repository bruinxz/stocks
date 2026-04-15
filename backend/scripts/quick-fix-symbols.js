const { sequelize } = require('../dist/config/database');

async function quickFixSymbols() {
  let transaction;
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 开始事务
    transaction = await sequelize.transaction();
    console.log('开始快速修复股票代码格式...\n');

    // 1. 检查冲突
    const conflictQuery = `
      SELECT COUNT(*) as conflict_count
      FROM stocks s1
      JOIN stocks s2 ON s1.id != s2.id
      WHERE s1.symbol NOT LIKE '%.%'
        AND s2.symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
        AND s1.symbol ~ '^[a-z]{2}[0-9]+$'
    `;
    const conflictResult = await sequelize.query(conflictQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    const conflictCount = parseInt(conflictResult[0].conflict_count);
    console.log(`检测到冲突数量: ${conflictCount}`);

    if (conflictCount > 0) {
      console.log('⚠️  存在冲突，无法继续。请手动处理冲突。');
      await transaction.rollback();
      return;
    }

    // 2. 统计需要更新的股票
    const countQuery = `
      SELECT COUNT(*) as count
      FROM stocks
      WHERE symbol NOT LIKE '%.%'
        AND symbol ~ '^[a-z]{2}[0-9]+$'
    `;
    const countResult = await sequelize.query(countQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    const updateCount = parseInt(countResult[0].count);
    console.log(`需要更新的股票数量: ${updateCount}`);

    if (updateCount === 0) {
      console.log('无需更新');
      await transaction.commit();
      return;
    }

    // 3. 显示示例
    const sampleQuery = `
      SELECT symbol, name
      FROM stocks
      WHERE symbol NOT LIKE '%.%'
        AND symbol ~ '^[a-z]{2}[0-9]+$'
      ORDER BY symbol
      LIMIT 5
    `;
    const samples = await sequelize.query(sampleQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    console.log('示例转换:');
    samples.forEach(row => {
      const newSymbol = row.symbol.substring(0, 2) + '.' + row.symbol.substring(2);
      console.log(`  ${row.symbol} -> ${newSymbol}`);
    });

    // 4. 执行更新
    console.log('\n执行更新...');
    const updateQuery = `
      UPDATE stocks
      SET symbol = LEFT(symbol, 2) || '.' || SUBSTRING(symbol FROM 3)
      WHERE symbol NOT LIKE '%.%'
        AND symbol ~ '^[a-z]{2}[0-9]+$'
    `;
    const updateResult = await sequelize.query(updateQuery, { transaction });
    console.log(`更新完成，影响行数: ${updateResult[1]}`);

    // 5. 验证
    const verifyQuery = `
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN symbol LIKE '%.%' THEN 1 END) as with_dot,
        COUNT(CASE WHEN symbol NOT LIKE '%.%' THEN 1 END) as without_dot
      FROM stocks
    `;
    const verifyResult = await sequelize.query(verifyQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    console.log('\n验证结果:');
    console.log(`  总股票数: ${verifyResult[0].total}`);
    console.log(`  带点号: ${verifyResult[0].with_dot}`);
    console.log(`  不带点号: ${verifyResult[0].without_dot}`);

    // 6. 市场分布
    const marketQuery = `
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他格式'
        END as market,
        COUNT(*) as count
      FROM stocks
      GROUP BY market
      ORDER BY count DESC
    `;
    const marketResults = await sequelize.query(marketQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    console.log('\n市场分布:');
    marketResults.forEach(row => {
      console.log(`  ${row.market}: ${row.count} 只`);
    });

    // 提交事务
    await transaction.commit();
    console.log('\n✅ 快速修复完成');

  } catch (error) {
    console.error('❌ 修复失败:', error);
    if (transaction) {
      try {
        await transaction.rollback();
        console.log('事务已回滚');
      } catch (rollbackError) {
        console.error('回滚失败:', rollbackError);
      }
    }
    throw error;
  } finally {
    await sequelize.close();
  }
}

quickFixSymbols().catch(console.error);