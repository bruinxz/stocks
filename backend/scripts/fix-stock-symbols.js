const { sequelize } = require('../dist/config/database');

async function fixStockSymbols() {
  let transaction;
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 开始事务
    transaction = await sequelize.transaction();
    console.log('开始统一股票代码格式...\n');

    // 1. 统计当前格式
    const formatStats = await sequelize.query(`
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '带点号-上海'
          WHEN symbol LIKE 'sz.%' THEN '带点号-深圳'
          WHEN symbol LIKE 'bj.%' THEN '带点号-北京'
          WHEN symbol ~ '^6[0-9]{5}$' THEN '无点号-上海'
          WHEN symbol ~ '^0[0-9]{5}$' THEN '无点号-深圳主板'
          WHEN symbol ~ '^3[0-9]{5}$' THEN '无点号-创业板'
          WHEN symbol ~ '^8[0-9]{5}$' THEN '无点号-北京'
          WHEN symbol ~ '^4[0-9]{5}$' THEN '无点号-北京'
          ELSE '其他格式'
        END as format_type,
        COUNT(*) as count,
        STRING_AGG(symbol, ', ') as examples
      FROM stocks
      GROUP BY format_type
      ORDER BY count DESC
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log('当前格式统计:');
    formatStats.forEach(row => {
      console.log(`  ${row.format_type.padEnd(20)}: ${row.count} 只`);
      if (row.examples && row.examples.split(', ').length <= 5) {
        console.log(`    示例: ${row.examples}`);
      }
    });

    // 2. 识别需要更新的股票（没有点号的）
    const stocksToUpdate = await sequelize.query(`
      SELECT id, symbol
      FROM stocks
      WHERE symbol NOT LIKE '%.%'
      ORDER BY symbol
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log(`\n需要更新的股票: ${stocksToUpdate.length} 只\n`);

    if (stocksToUpdate.length === 0) {
      console.log('无需更新');
      await transaction.commit();
      return;
    }

    // 3. 显示更新计划
    console.log('更新计划 (前10只):');
    const updateMap = new Map();

    for (const stock of stocksToUpdate.slice(0, 10)) {
      const newSymbol = formatSymbol(stock.symbol);
      console.log(`  ${stock.symbol} -> ${newSymbol}`);
      updateMap.set(stock.id, newSymbol);
    }

    if (stocksToUpdate.length > 10) {
      console.log(`  ... 还有 ${stocksToUpdate.length - 10} 只股票`);
    }

    // 4. 确认更新
    console.log(`\n是否继续更新 ${stocksToUpdate.length} 只股票？(y/n)`);
    // 在实际环境中，这里应该有用户确认，但为了脚本自动化，我们继续
    const shouldContinue = true; // 假设继续

    if (!shouldContinue) {
      console.log('取消更新');
      await transaction.rollback();
      return;
    }

    // 5. 执行更新
    console.log('\n开始更新...');
    let updatedCount = 0;

    for (const stock of stocksToUpdate) {
      const newSymbol = formatSymbol(stock.symbol);

      // 检查新代码是否已存在（避免冲突）
      const existing = await sequelize.query(`
        SELECT id FROM stocks WHERE symbol = :newSymbol AND id != :id
      `, {
        replacements: { newSymbol, id: stock.id },
        transaction,
        type: sequelize.QueryTypes.SELECT
      });

      if (existing.length > 0) {
        console.warn(`  冲突: ${stock.symbol} -> ${newSymbol} 已存在，跳过`);
        continue;
      }

      await sequelize.query(
        'UPDATE stocks SET symbol = :newSymbol WHERE id = :id',
        {
          replacements: { newSymbol, id: stock.id },
          transaction
        }
      );

      updatedCount++;

      if (updatedCount % 100 === 0) {
        console.log(`  已更新 ${updatedCount}/${stocksToUpdate.length} 只股票`);
      }
    }

    // 6. 验证更新
    console.log('\n验证更新结果...');
    const afterStats = await sequelize.query(`
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '带点号-上海'
          WHEN symbol LIKE 'sz.%' THEN '带点号-深圳'
          WHEN symbol LIKE 'bj.%' THEN '带点号-北京'
          ELSE '其他格式'
        END as format_type,
        COUNT(*) as count
      FROM stocks
      GROUP BY format_type
      ORDER BY count DESC
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log('\n更新后格式统计:');
    afterStats.forEach(row => {
      console.log(`  ${row.format_type.padEnd(20)}: ${row.count} 只`);
    });

    // 7. 检查日线数据关联
    console.log('\n检查日线数据关联...');
    const dataCheck = await sequelize.query(`
      SELECT
        COUNT(*) as total_stocks,
        COUNT(DISTINCT db.stock_id) as stocks_with_data,
        COUNT(DISTINCT s.id) as stocks_without_data
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log(`  总股票数: ${dataCheck[0].total_stocks}`);
    console.log(`  有数据的股票: ${dataCheck[0].stocks_with_data}`);
    console.log(`  无数据的股票: ${dataCheck[0].stocks_without_data}`);

    // 提交事务
    await transaction.commit();
    console.log(`\n✅ 更新完成: 更新了 ${updatedCount} 只股票`);

    // 8. 建议后续操作
    console.log('\n建议后续操作:');
    console.log('  1. 运行数据同步脚本，为所有股票获取日线数据');
    console.log('  2. 检查回测功能是否正常工作');

  } catch (error) {
    console.error('❌ 更新失败:', error);
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

/**
 * 格式化股票代码，添加点号
 * @param {string} symbol 原始股票代码
 * @returns {string} 格式化后的股票代码
 */
function formatSymbol(symbol) {
  // 如果已经有点号，直接返回
  if (symbol.includes('.')) {
    return symbol;
  }

  // 根据代码前缀确定市场
  if (symbol.startsWith('6') || symbol.startsWith('5')) {
    // 上海市场：6开头（主板、科创板），5开头（基金、权证等）
    return `sh.${symbol}`;
  } else if (symbol.startsWith('0') || symbol.startsWith('3')) {
    // 深圳市场：0开头（主板、中小板），3开头（创业板）
    return `sz.${symbol}`;
  } else if (symbol.startsWith('8') || symbol.startsWith('4') || symbol.startsWith('9')) {
    // 北京交易所：8、4、9开头
    return `bj.${symbol}`;
  } else {
    // 未知格式，保留原样
    console.warn(`未知格式的股票代码: ${symbol}`);
    return symbol;
  }
}

// 运行
fixStockSymbols();