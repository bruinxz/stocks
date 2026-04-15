const { sequelize } = require('../dist/config/database');

async function fixSymbolsFinal() {
  let transaction;
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 开始事务
    transaction = await sequelize.transaction();
    console.log('开始最终股票代码标准化...\n');

    // 1. 获取所有股票
    const stocks = await sequelize.query(
      'SELECT id, symbol FROM stocks ORDER BY symbol',
      { transaction, type: sequelize.QueryTypes.SELECT }
    );

    console.log(`总股票数: ${stocks.length}`);

    // 2. 识别需要更新的股票
    const stocksToUpdate = [];
    const updateMap = new Map();

    for (const stock of stocks) {
      const newSymbol = standardizeSymbol(stock.symbol);
      if (newSymbol !== stock.symbol) {
        stocksToUpdate.push(stock);
        updateMap.set(stock.id, newSymbol);
      }
    }

    console.log(`需要标准化的股票: ${stocksToUpdate.length} 只\n`);

    if (stocksToUpdate.length === 0) {
      console.log('所有股票已是标准格式');
      await transaction.commit();
      return;
    }

    // 3. 显示示例
    console.log('示例转换 (前10只):');
    const samples = stocksToUpdate.slice(0, 10);
    for (const stock of samples) {
      console.log(`  ${stock.symbol.padEnd(15)} -> ${updateMap.get(stock.id)}`);
    }
    if (stocksToUpdate.length > 10) {
      console.log(`  ... 还有 ${stocksToUpdate.length - 10} 只股票`);
    }

    // 4. 执行更新（分批进行）
    console.log('\n开始批量更新...');
    const batchSize = 100;
    let updatedCount = 0;
    let conflictCount = 0;
    let errorCount = 0;

    for (let i = 0; i < stocksToUpdate.length; i += batchSize) {
      const batch = stocksToUpdate.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(stocksToUpdate.length / batchSize);

      console.log(`\n处理批次 ${batchNum}/${totalBatches} (${batch.length} 只股票)`);

      for (const stock of batch) {
        const newSymbol = updateMap.get(stock.id);

        try {
          // 检查新代码是否已存在
          const existing = await sequelize.query(
            'SELECT id FROM stocks WHERE symbol = :newSymbol AND id != :id',
            {
              replacements: { newSymbol, id: stock.id },
              transaction,
              type: sequelize.QueryTypes.SELECT
            }
          );

          if (existing.length > 0) {
            console.warn(`    冲突: ${stock.symbol} -> ${newSymbol} (已存在)`);
            conflictCount++;
            continue;
          }

          // 更新
          await sequelize.query(
            'UPDATE stocks SET symbol = :newSymbol WHERE id = :id',
            {
              replacements: { newSymbol, id: stock.id },
              transaction
            }
          );

          updatedCount++;

          // 每100只显示一次进度
          if (updatedCount % 100 === 0) {
            console.log(`    已更新 ${updatedCount} 只股票`);
          }
        } catch (error) {
          console.error(`    错误更新 ${stock.symbol}: ${error.message}`);
          errorCount++;
        }
      }

      // 提交当前批次的事务
      await transaction.commit();
      console.log(`    批次 ${batchNum} 完成，提交事务`);

      // 开始新事务（除了最后一个批次）
      if (i + batchSize < stocksToUpdate.length) {
        transaction = await sequelize.transaction();
        console.log(`    开始新事务，等待1秒...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 5. 最终验证
    console.log('\n=== 最终验证 ===\n');

    const finalStats = await sequelize.query(
      `SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他格式'
        END as format_type,
        COUNT(*) as count
      FROM stocks
      GROUP BY format_type
      ORDER BY count DESC`,
      { type: sequelize.QueryTypes.SELECT }
    );

    console.log('标准化结果:');
    finalStats.forEach(row => {
      console.log(`  ${row.format_type}: ${row.count} 只`);
    });

    console.log(`\n✅ 标准化完成:`);
    console.log(`  总更新: ${updatedCount} 只股票`);
    console.log(`  冲突跳过: ${conflictCount} 只股票`);
    console.log(`  错误: ${errorCount} 只股票`);

    if (conflictCount > 0) {
      console.log(`\n⚠️  有 ${conflictCount} 只股票因代码冲突被跳过`);
      console.log(`  需要手动处理这些冲突`);
    }

    if (errorCount > 0) {
      console.log(`\n⚠️  有 ${errorCount} 只股票更新出错`);
    }

  } catch (error) {
    console.error('❌ 标准化失败:', error);
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
 * 标准化股票代码格式
 * 目标格式: [市场].[代码]，如 sh.600000, sz.000001, bj.920000
 */
function standardizeSymbol(symbol) {
  // 如果已经是标准格式，直接返回
  if (/^[a-z]{2}\.[0-9]+$/.test(symbol)) {
    return symbol;
  }

  // 处理前缀无点号的情况: sh600000 -> sh.600000
  const prefixMatch = symbol.match(/^([a-z]{2})([0-9].*)$/);
  if (prefixMatch) {
    const [, prefix, code] = prefixMatch;
    return `${prefix}.${code}`;
  }

  // 处理纯数字的情况: 600000 -> 需要根据代码判断市场
  if (/^[0-9]+$/.test(symbol)) {
    const code = symbol;

    // 上海市场
    if (/^6[0-9]{5}$/.test(code) || /^5[0-9]{5}$/.test(code) || /^9[0-9]{5}$/.test(code)) {
      return `sh.${code}`;
    }

    // 深圳主板
    if (/^0[0-9]{5}$/.test(code) || /^001[0-9]{3}$/.test(code)) {
      return `sz.${code}`;
    }

    // 创业板
    if (/^3[0-9]{5}$/.test(code)) {
      return `sz.${code}`;
    }

    // 北京交易所
    if (/^8[0-9]{5}$/.test(code) || /^4[0-9]{5}$/.test(code) || /^9[0-9]{5}$/.test(code)) {
      return `bj.${code}`;
    }

    console.warn(`无法确定市场的纯数字代码: ${symbol}`);
    return symbol; // 保持原样
  }

  // 其他格式，尝试智能处理
  console.warn(`无法处理的股票代码格式: ${symbol}`);
  return symbol;
}

// 运行
fixSymbolsFinal().catch(console.error);