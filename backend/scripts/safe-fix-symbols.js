const { sequelize } = require('../dist/config/database');

async function safeFixSymbols() {
  let transaction;
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 开始事务
    transaction = await sequelize.transaction();
    console.log('开始安全修复股票代码格式...\n');

    // 1. 统计需要更新的股票（无冲突）
    const countQuery = `
      SELECT COUNT(*) as count
      FROM stocks s1
      WHERE s1.symbol NOT LIKE '%.%'
        AND s1.symbol ~ '^[a-z]{2}[0-9]+$'
        AND NOT EXISTS (
          SELECT 1 FROM stocks s2
          WHERE s2.symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
            AND s2.id != s1.id
        )
    `;
    const countResult = await sequelize.query(countQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    const updateCount = parseInt(countResult[0].count);
    console.log(`可安全更新的股票数量: ${updateCount}`);

    // 2. 统计冲突的股票
    const conflictQuery = `
      SELECT COUNT(*) as count
      FROM stocks s1
      WHERE s1.symbol NOT LIKE '%.%'
        AND s1.symbol ~ '^[a-z]{2}[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM stocks s2
          WHERE s2.symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
            AND s2.id != s1.id
        )
    `;
    const conflictResult = await sequelize.query(conflictQuery, { transaction, type: sequelize.QueryTypes.SELECT });
    const conflictCount = parseInt(conflictResult[0].count);
    console.log(`冲突股票数量: ${conflictCount}`);

    if (conflictCount > 0) {
      console.log('\n冲突股票示例:');
      const conflictSampleQuery = `
        SELECT s1.symbol, s1.name, s2.symbol as existing_symbol, s2.name as existing_name
        FROM stocks s1
        JOIN stocks s2 ON s2.symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
          AND s2.id != s1.id
        WHERE s1.symbol NOT LIKE '%.%'
          AND s1.symbol ~ '^[a-z]{2}[0-9]+$'
        LIMIT 5
      `;
      const conflictSamples = await sequelize.query(conflictSampleQuery, { transaction, type: sequelize.QueryTypes.SELECT });
      conflictSamples.forEach(row => {
        console.log(`  ${row.symbol} (${row.name}) -> 冲突: ${row.existing_symbol} (${row.existing_name})`);
      });
    }

    if (updateCount === 0) {
      console.log('没有可安全更新的股票');
      await transaction.commit();
      return;
    }

    // 3. 执行更新（只更新无冲突的）
    console.log('\n执行安全更新...');
    const updateQuery = `
      UPDATE stocks s1
      SET symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
      WHERE s1.symbol NOT LIKE '%.%'
        AND s1.symbol ~ '^[a-z]{2}[0-9]+$'
        AND NOT EXISTS (
          SELECT 1 FROM stocks s2
          WHERE s2.symbol = LEFT(s1.symbol, 2) || '.' || SUBSTRING(s1.symbol FROM 3)
            AND s2.id != s1.id
        )
    `;
    const updateResult = await sequelize.query(updateQuery, { transaction });
    console.log(`安全更新完成，影响行数: ${updateResult[1]}`);

    // 4. 验证
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

    // 5. 市场分布
    const marketQuery = `
      SELECT
        market,
        COUNT(*) as count
      FROM (
        SELECT
          CASE
            WHEN symbol LIKE 'sh.%' THEN '上海'
            WHEN symbol LIKE 'sz.%' THEN '深圳'
            WHEN symbol LIKE 'bj.%' THEN '北京'
            ELSE '其他格式'
          END as market
        FROM stocks
      ) as subquery
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
    console.log('\n✅ 安全修复完成');
    console.log(`  更新了 ${updateResult[1]} 只股票`);
    console.log(`  跳过了 ${conflictCount} 只冲突股票`);

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

safeFixSymbols().catch(console.error);