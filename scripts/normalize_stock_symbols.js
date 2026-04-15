#!/usr/bin/env node
/**
 * 简化版股票代码格式标准化脚本
 * 将各种格式的股票代码统一为标准格式（带点：sh.600000, sz.000001, bj.830799）
 */

async function normalizeStockSymbols() {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock } = require('../backend/dist/models');
    const { normalizeSymbol, isValidSymbol } = require('../backend/dist/utils/stockSymbol');
    const { Op } = require('../backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 获取所有股票记录
    const allStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'isListed', 'createdAt'],
      order: [['id', 'ASC']]
    });

    console.log(`找到 ${allStocks.length} 只股票记录`);

    // 2. 分析并分类
    const stats = {
      total: allStocks.length,
      alreadyNormalized: 0,
      needNormalization: 0,
      invalid: 0,
      duplicates: 0
    };

    const stocksToUpdate = [];
    const stocksToDelete = [];
    const symbolMap = new Map(); // normalizedSymbol -> stock

    for (const stock of allStocks) {
      const originalSymbol = stock.symbol;
      const normalizedSymbol = normalizeSymbol(originalSymbol);
      const isValid = isValidSymbol(originalSymbol);

      if (!isValid) {
        stats.invalid++;
        stocksToDelete.push({
          id: stock.id,
          symbol: originalSymbol,
          normalizedSymbol,
          reason: '无效股票代码'
        });
        continue;
      }

      if (originalSymbol === normalizedSymbol) {
        stats.alreadyNormalized++;
      } else {
        stats.needNormalization++;
        stocksToUpdate.push({
          id: stock.id,
          originalSymbol,
          normalizedSymbol
        });
      }

      // 检查重复
      if (symbolMap.has(normalizedSymbol)) {
        stats.duplicates++;
      } else {
        symbolMap.set(normalizedSymbol, stock);
      }
    }

    // 3. 显示统计
    console.log('\n=== 统计信息 ===');
    console.log(`总股票记录数: ${stats.total}`);
    console.log(`已为标准格式: ${stats.alreadyNormalized}`);
    console.log(`需要标准化: ${stats.needNormalization}`);
    console.log(`无效代码: ${stats.invalid}`);
    console.log(`重复股票: ${stats.duplicates}`);

    // 4. 显示需要更新的股票
    if (stocksToUpdate.length > 0) {
      console.log(`\n=== 需要更新的股票 (${stocksToUpdate.length} 只，显示前30个) ===`);
      stocksToUpdate.slice(0, 30).forEach((stock, index) => {
        console.log(`${index + 1}. ID: ${stock.id}, 原代码: "${stock.originalSymbol}" -> 新代码: "${stock.normalizedSymbol}"`);
      });
      if (stocksToUpdate.length > 30) {
        console.log(`... 以及另外 ${stocksToUpdate.length - 30} 只股票`);
      }
    }

    // 5. 显示无效股票
    if (stocksToDelete.length > 0) {
      console.log(`\n=== 无效股票 (${stocksToDelete.length} 只，显示前30个) ===`);
      stocksToDelete.slice(0, 30).forEach((stock, index) => {
        console.log(`${index + 1}. ID: ${stock.id}, 代码: "${stock.symbol}" (标准化后: "${stock.normalizedSymbol}"), 原因: ${stock.reason}`);
      });
      if (stocksToDelete.length > 30) {
        console.log(`... 以及另外 ${stocksToDelete.length - 30} 只股票`);
      }
    }

    // 6. 询问确认
    console.log('\n=== 操作说明 ===');
    console.log('本次操作将:');
    console.log(`  1. 更新 ${stocksToUpdate.length} 只股票的代码为标准格式`);
    console.log(`  2. 删除 ${stocksToDelete.length} 只无效股票记录`);

    if (process.argv.includes('--dry-run')) {
      console.log('\n✅ 模拟运行完成，未实际修改数据库（使用 --dry-run 参数）');
      console.log('要实际执行，请移除 --dry-run 参数并添加 --confirm 参数');
      return;
    }

    if (!process.argv.includes('--confirm')) {
      console.log('\n⚠️  未确认执行。要实际执行，请添加 --confirm 参数:');
      console.log('  node scripts/normalize_stock_symbols.js --confirm');
      console.log('\n可选参数:');
      console.log('  --dry-run     模拟运行，不实际修改数据库');
      console.log('  --confirm     确认执行');
      console.log('  --keep-invalid 保留无效股票（不删除）');
      return;
    }

    const keepInvalid = process.argv.includes('--keep-invalid');

    // 7. 执行更新
    console.log('\n开始执行股票代码标准化...');
    let updatedCount = 0;
    let deletedCount = 0;

    // 7.1 更新股票代码
    if (stocksToUpdate.length > 0) {
      console.log(`\n1. 更新股票代码 (${stocksToUpdate.length} 只)...`);
      for (const stock of stocksToUpdate) {
        try {
          await Stock.update(
            { symbol: stock.normalizedSymbol },
            { where: { id: stock.id } }
          );
          updatedCount++;
          if (updatedCount % 100 === 0) {
            console.log(`  已更新 ${updatedCount}/${stocksToUpdate.length}`);
          }
        } catch (error) {
          console.error(`  更新失败 ID ${stock.id}: ${error.message}`);
        }
      }
      console.log(`  完成更新 ${updatedCount} 只股票`);
    }

    // 7.2 删除无效股票
    if (!keepInvalid && stocksToDelete.length > 0) {
      console.log(`\n2. 删除无效股票 (${stocksToDelete.length} 只)...`);
      for (const stock of stocksToDelete) {
        try {
          await Stock.destroy({ where: { id: stock.id } });
          deletedCount++;
          if (deletedCount % 50 === 0) {
            console.log(`  已删除 ${deletedCount}/${stocksToDelete.length}`);
          }
        } catch (error) {
          console.error(`  删除失败 ID ${stock.id}: ${error.message}`);
        }
      }
      console.log(`  完成删除 ${deletedCount} 只无效股票`);
    }

    // 8. 完成
    console.log('\n=== 操作完成 ===');
    console.log(`更新股票代码: ${updatedCount} 只`);
    console.log(`删除无效股票: ${deletedCount} 只`);

    // 验证
    const afterStocks = await Stock.count();
    console.log(`操作后股票总数: ${afterStocks}`);
    console.log(`操作前股票总数: ${stats.total}`);
    console.log(`净变化: ${afterStocks - stats.total}`);

  } catch (error) {
    console.error(`操作失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

// 命令行参数处理
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
股票代码格式标准化工具

用法:
  node scripts/normalize_stock_symbols.js [选项]

选项:
  --dry-run     模拟运行，不实际修改数据库
  --confirm     确认执行
  --keep-invalid 保留无效股票（不删除）
  --help, -h    显示帮助信息

示例:
  node scripts/normalize_stock_symbols.js --dry-run      # 模拟运行
  node scripts/normalize_stock_symbols.js --confirm      # 执行标准化
  `);
  process.exit(0);
}

normalizeStockSymbols().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});