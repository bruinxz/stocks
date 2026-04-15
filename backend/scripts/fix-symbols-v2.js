const { sequelize } = require('../dist/config/database');

async function fixStockSymbolsV2() {
  let transaction;
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 开始事务
    transaction = await sequelize.transaction();
    console.log('开始统一股票代码格式 (版本2)...\n');

    // 1. 分析当前格式
    const analysisQuery = `
      SELECT
        CASE
          WHEN symbol ~ '^[a-z]{2}\.[0-9]+$' THEN '标准格式(带点)'
          WHEN symbol ~ '^[a-z]{2}[0-9]+$' THEN '前缀无点号'
          WHEN symbol ~ '^[0-9]+$' THEN '纯数字'
          ELSE '其他格式'
        END as format_type,
        COUNT(*) as count,
        ARRAY_AGG(DISTINCT LEFT(symbol, 5)) as prefixes
      FROM stocks
      GROUP BY format_type
      ORDER BY count DESC
    `;

    const analysis = await sequelize.query(analysisQuery, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log('格式分析:');
    analysis.forEach(row => {
      console.log(`  ${row.format_type.padEnd(20)}: ${row.count} 只`);
      if (row.prefixes) {
        console.log(`    前缀示例: ${row.prefixes.slice(0, 5).join(', ')}`);
      }
    });

    // 2. 识别需要更新的股票（非标准格式）
    const stocksToUpdate = await sequelize.query(`
      SELECT id, symbol
      FROM stocks
      WHERE symbol !~ '^[a-z]{2}\.[0-9]+$'
      ORDER BY symbol
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log(`\n需要标准化的股票: ${stocksToUpdate.length} 只\n`);

    if (stocksToUpdate.length === 0) {
      console.log('所有股票已是标准格式');
      await transaction.commit();
      return;
    }

    // 3. 显示示例
    console.log('示例转换:');
    const samples = stocksToUpdate.slice(0, 10);
    const updateMap = new Map();

    for (const stock of samples) {
      const newSymbol = standardizeSymbol(stock.symbol);
      console.log(`  ${stock.symbol.padEnd(15)} -> ${newSymbol}`);
      updateMap.set(stock.id, newSymbol);
    }

    if (stocksToUpdate.length > 10) {
      console.log(`  ... 还有 ${stocksToUpdate.length - 10} 只股票`);
    }

    // 4. 执行更新（分批进行，避免内存问题）
    console.log('\n开始批量更新...');
    const batchSize = 100;
    let updatedCount = 0;
    let conflictCount = 0;

    for (let i = 0; i < stocksToUpdate.length; i += batchSize) {
      const batch = stocksToUpdate.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(stocksToUpdate.length / batchSize);

      console.log(`\n处理批次 ${batchNum}/${totalBatches} (${batch.length} 只股票)`);

      for (const stock of batch) {
        const newSymbol = standardizeSymbol(stock.symbol);

        // 检查新代码是否已存在
        const existing = await sequelize.query(`
          SELECT id FROM stocks WHERE symbol = :newSymbol AND id != :id
        `, {
          replacements: { newSymbol, id: stock.id },
          transaction,
          type: sequelize.QueryTypes.SELECT
        });

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
      }

      // 保存进度
      await transaction.commit();
      console.log(`    批次 ${batchNum} 完成，提交事务`);

      // 开始新事务（除了最后一个批次）
      if (i + batchSize < stocksToUpdate.length) {
        transaction = await sequelize.transaction();
        console.log(`    开始新事务，等待2秒...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 5. 最终验证
    console.log('\n=== 最终验证 ===\n');

    const finalStats = await sequelize.query(`
      SELECT
        CASE
          WHEN symbol ~ '^[a-z]{2}\.[0-9]+$' THEN '标准格式'
          ELSE '非标准格式'
        END as format_type,
        COUNT(*) as count
      FROM stocks
      GROUP BY format_type
    `, { type: sequelize.QueryTypes.SELECT });

    console.log('标准化结果:');
    finalStats.forEach(row => {
      console.log(`  ${row.format_type}: ${row.count} 只`);
    });

    // 市场分布
    const marketStats = await sequelize.query(`
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他'
        END as market,
        COUNT(*) as count
      FROM stocks
      GROUP BY market
      ORDER BY count DESC
    `, { type: sequelize.QueryTypes.SELECT });

    console.log('\n市场分布:');
    marketStats.forEach(row => {
      console.log(`  ${row.market}: ${row.count} 只`);
    });

    console.log(`\n✅ 标准化完成:`);
    console.log(`  总更新: ${updatedCount} 只股票`);
    console.log(`  冲突跳过: ${conflictCount} 只股票`);
    console.log(`  标准化率: ${((updatedCount / stocksToUpdate.length) * 100).toFixed(2)}%`);

    if (conflictCount > 0) {
      console.log(`\n⚠️  有 ${conflictCount} 只股票因代码冲突被跳过`);
      console.log(`  需要手动处理这些冲突`);
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

// 测试标准化函数
function testStandardize() {
  const testCases = [
    'sh.600000',    // 标准格式，应保持不变
    'sz.000001',    // 标准格式，应保持不变
    'bj.920000',    // 标准格式，应保持不变
    'sh600000',     // 前缀无点号
    'sz000001',     // 前缀无点号
    'bj920000',     // 前缀无点号
    '600000',       // 纯数字
    '000001',       // 纯数字
    '300000',       // 纯数字（创业板）
    '830000',       // 纯数字（北交所）
    'SH600000',     // 大写前缀（应转为小写）
    '600000.SH',    // 后缀格式
    '000001.SZ',    // 后缀格式
  ];

  console.log('标准化函数测试:');
  testCases.forEach(tc => {
    console.log(`  ${tc.padEnd(15)} -> ${standardizeSymbol(tc)}`);
  });
}

// 运行
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'test') {
    testStandardize();
  } else {
    await fixStockSymbolsV2();
  }
}

main().catch(console.error);