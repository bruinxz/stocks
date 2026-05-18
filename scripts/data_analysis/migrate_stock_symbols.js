#!/usr/bin/env node
/**
 * 数据库迁移脚本：统一股票代码格式
 * 将各种格式的股票代码统一为标准格式（带点：sh.600000, sz.000001, bj.830799）
 */

async function migrateStockSymbols() {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { normalizeSymbol, isValidSymbol } = require('../backend/dist/utils/stockSymbol');
    const { Op } = require('../backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 获取所有股票记录
    const allStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'isListed', 'createdAt']
    });

    console.log(`找到 ${allStocks.length} 只股票记录`);

    // 2. 分析并分类股票代码
    const stats = {
      total: allStocks.length,
      alreadyNormalized: 0,
      needNormalization: 0,
      invalid: 0,
      duplicates: 0,
      withDailyBars: 0,
      withoutDailyBars: 0
    };

    const stockMap = new Map(); // normalizedSymbol -> [stock1, stock2, ...] 用于检测重复
    const stocksToUpdate = []; // 需要更新的股票记录
    const stocksToDelete = []; // 需要删除的无效记录
    const duplicateGroups = []; // 重复的股票组

    for (const stock of allStocks) {
      const originalSymbol = stock.symbol;
      const normalizedSymbol = normalizeSymbol(originalSymbol);
      const isValid = isValidSymbol(originalSymbol);

      // 统计日线数据
      const barCount = stock.dailyBars ? stock.dailyBars.length : 0;
      if (barCount > 0) {
        stats.withDailyBars++;
      } else {
        stats.withoutDailyBars++;
      }

      if (!isValid) {
        stats.invalid++;
        stocksToDelete.push({
          id: stock.id,
          symbol: originalSymbol,
          normalizedSymbol,
          barCount,
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
          normalizedSymbol,
          barCount
        });
      }

      // 检查重复
      if (!stockMap.has(normalizedSymbol)) {
        stockMap.set(normalizedSymbol, []);
      }
      stockMap.get(normalizedSymbol).push({
        id: stock.id,
        originalSymbol,
        normalizedSymbol,
        barCount,
        createdAt: stock.createdAt
      });
    }

    // 找出重复的股票
    for (const [normalizedSymbol, stocks] of stockMap.entries()) {
      if (stocks.length > 1) {
        stats.duplicates += stocks.length;
        duplicateGroups.push({
          normalizedSymbol,
          stocks: stocks.sort((a, b) => a.createdAt - b.createdAt) // 按创建时间排序
        });
      }
    }

    // 3. 显示统计信息
    console.log('\n=== 统计信息 ===');
    console.log(`总股票记录数: ${stats.total}`);
    console.log(`已为标准格式: ${stats.alreadyNormalized}`);
    console.log(`需要标准化: ${stats.needNormalization}`);
    console.log(`无效代码: ${stats.invalid}`);
    console.log(`重复股票: ${stats.duplicates} (${duplicateGroups.length} 组)`);
    console.log(`有日线数据的股票: ${stats.withDailyBars}`);
    console.log(`无日线数据的股票: ${stats.withoutDailyBars}`);

    // 4. 显示需要更新的股票（前20个）
    if (stocksToUpdate.length > 0) {
      console.log(`\n=== 需要更新的股票 (${stocksToUpdate.length} 只，显示前20个) ===`);
      stocksToUpdate.slice(0, 20).forEach((stock, index) => {
        console.log(`${index + 1}. ID: ${stock.id}, 原代码: "${stock.originalSymbol}" -> 新代码: "${stock.normalizedSymbol}", 日线数据: ${stock.barCount} 条`);
      });
      if (stocksToUpdate.length > 20) {
        console.log(`... 以及另外 ${stocksToUpdate.length - 20} 只股票`);
      }
    }

    // 5. 显示无效股票（前20个）
    if (stocksToDelete.length > 0) {
      console.log(`\n=== 无效股票 (${stocksToDelete.length} 只，显示前20个) ===`);
      stocksToDelete.slice(0, 20).forEach((stock, index) => {
        console.log(`${index + 1}. ID: ${stock.id}, 代码: "${stock.symbol}" (标准化后: "${stock.normalizedSymbol}"), 日线数据: ${stock.barCount} 条, 原因: ${stock.reason}`);
      });
      if (stocksToDelete.length > 20) {
        console.log(`... 以及另外 ${stocksToDelete.length - 20} 只股票`);
      }
    }

    // 6. 显示重复股票组
    if (duplicateGroups.length > 0) {
      console.log(`\n=== 重复股票组 (${duplicateGroups.length} 组) ===`);
      duplicateGroups.slice(0, 10).forEach((group, groupIndex) => {
        console.log(`\n组 ${groupIndex + 1}: 标准化代码 "${group.normalizedSymbol}" 有 ${group.stocks.length} 个重复记录:`);
        group.stocks.forEach((stock, stockIndex) => {
          console.log(`  ${stockIndex + 1}. ID: ${stock.id}, 原代码: "${stock.originalSymbol}", 日线数据: ${stock.barCount} 条, 创建时间: ${stock.createdAt}`);
        });
      });
      if (duplicateGroups.length > 10) {
        console.log(`\n... 以及另外 ${duplicateGroups.length - 10} 组重复股票`);
      }
    }

    // 7. 询问用户是否执行迁移
    console.log('\n=== 迁移操作 ===');
    console.log('本次迁移将执行以下操作:');
    console.log(`  1. 更新 ${stocksToUpdate.length} 只股票的代码为标准格式`);
    console.log(`  2. 删除 ${stocksToDelete.length} 只无效股票记录`);
    console.log(`  3. 处理 ${duplicateGroups.length} 组重复股票（需要手动决定保留哪个）`);

    if (process.argv.includes('--dry-run')) {
      console.log('\n✅ 模拟运行完成，未实际修改数据库（使用 --dry-run 参数）');
      console.log('要实际执行迁移，请移除 --dry-run 参数并添加 --confirm 参数');
      return;
    }

    if (!process.argv.includes('--confirm')) {
      console.log('\n⚠️  未确认执行迁移。要实际执行，请添加 --confirm 参数:');
      console.log('  node scripts/migrate_stock_symbols.js --confirm');
      console.log('\n可选参数:');
      console.log('  --dry-run     模拟运行，不实际修改数据库');
      console.log('  --confirm     确认执行迁移');
      console.log('  --skip-dupes  跳过重复股票处理（保留所有重复记录）');
      console.log('  --force-delete 强制删除无效股票（即使有日线数据）');
      return;
    }

    const skipDupes = process.argv.includes('--skip-dupes');
    const forceDelete = process.argv.includes('--force-delete');

    // 8. 开始执行迁移
    console.log('\n开始执行迁移...');
    let updatedCount = 0;
    let deletedCount = 0;
    let mergedCount = 0;

    // 8.1 更新股票代码
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

    // 8.2 处理重复股票（如果不跳过）
    if (!skipDupes && duplicateGroups.length > 0) {
      console.log(`\n2. 处理重复股票 (${duplicateGroups.length} 组)...`);
      console.log('  注意：重复股票处理需要手动决策，当前版本跳过');
      console.log('  建议手动检查重复股票并决定保留哪个记录');
    }

    // 8.3 删除无效股票
    if (stocksToDelete.length > 0) {
      console.log(`\n3. 删除无效股票 (${stocksToDelete.length} 只)...`);
      for (const stock of stocksToDelete) {
        // 如果有日线数据且未强制删除，跳过
        if (stock.barCount > 0 && !forceDelete) {
          console.log(`  跳过 ID ${stock.id}: 有 ${stock.barCount} 条日线数据，使用 --force-delete 强制删除`);
          continue;
        }

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

    // 9. 迁移完成
    console.log('\n=== 迁移完成 ===');
    console.log(`更新股票代码: ${updatedCount} 只`);
    console.log(`删除无效股票: ${deletedCount} 只`);
    console.log(`合并重复股票: ${mergedCount} 组`);

    // 10. 验证迁移结果
    console.log('\n=== 验证迁移结果 ===');
    const afterStocks = await Stock.count();
    console.log(`迁移后股票总数: ${afterStocks}`);
    console.log(`迁移前股票总数: ${stats.total}`);
    console.log(`净变化: ${afterStocks - stats.total} (删除 ${deletedCount} - 合并 ${mergedCount})`);

    // 检查是否还有无效代码
    const invalidAfter = await Stock.count({
      where: {
        symbol: {
          [Op.or]: [
            { [Op.eq]: null },
            { [Op.eq]: '' },
            { [Op.eq]: 'undefined' },
            { [Op.eq]: 'null' },
            { [Op.like]: '%undefined%' },
            { [Op.like]: '%null%' }
          ]
        }
      }
    });
    console.log(`迁移后无效代码数量: ${invalidAfter}`);

  } catch (error) {
    console.error(`迁移失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

// 命令行参数处理
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
股票代码格式迁移工具

用法:
  node scripts/migrate_stock_symbols.js [选项]

选项:
  --dry-run      模拟运行，不实际修改数据库
  --confirm      确认执行迁移
  --skip-dupes   跳过重复股票处理
  --force-delete 强制删除无效股票（即使有日线数据）
  --help, -h     显示帮助信息

示例:
  node scripts/migrate_stock_symbols.js --dry-run      # 模拟运行
  node scripts/migrate_stock_symbols.js --confirm      # 执行迁移
  node scripts/migrate_stock_symbols.js --confirm --force-delete  # 强制删除无效股票
  `);
  process.exit(0);
}

migrateStockSymbols().catch(error => {
  console.error('迁移脚本执行失败:', error);
  process.exit(1);
});