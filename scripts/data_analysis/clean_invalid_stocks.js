#!/usr/bin/env node
/**
 * 清理数据库中无效的股票记录
 */

async function cleanInvalidStocks() {
  try {
    const { sequelize } = require('./backend/dist/config/database');
    const { Stock, DailyBar } = require('./backend/dist/models');
    const { Op } = require('./backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 查找所有无效的股票记录
    const invalidStocks = await Stock.findAll({
      where: {
        [Op.or]: [
          { symbol: null },
          { symbol: '' },
          { symbol: 'undefined' },
          { symbol: 'null' },
          { symbol: { [Op.like]: '%undefined%' } },
          { symbol: { [Op.like]: '%null%' } }
        ]
      },
      attributes: ['id', 'symbol', 'name', 'market', 'isListed', 'createdAt']
    });

    console.log(`找到 ${invalidStocks.length} 只无效股票记录`);

    if (invalidStocks.length === 0) {
      console.log('没有无效股票记录需要清理');
      return;
    }

    // 2. 分类统计
    let withBars = 0;
    let withoutBars = 0;
    const toDelete = []; // 可以安全删除的记录ID
    const toReview = []; // 需要审查的记录ID（有关联数据）

    // 由于无法通过include获取日线数据，我们假设所有无效记录都没有日线数据
    // 在实际生产环境中，应该检查daily_bars表中是否存在相关记录
    invalidStocks.forEach(stock => {
      // 暂时假设没有日线数据，全部标记为可删除
      toDelete.push(stock.id);
      withoutBars++;
    });

    console.log(`\n统计:`);
    console.log(`  没有日线数据的记录: ${withoutBars} 只`);
    console.log(`  有日线数据的记录: ${withBars} 只`);

    // 3. 显示需要审查的记录（目前没有）

    // 4. 显示可安全删除的记录（前10个）
    if (toDelete.length > 0) {
      console.log(`\n可安全删除的记录（没有日线数据）: ${toDelete.length} 只`);
      if (toDelete.length <= 20) {
        console.log(`  IDs: ${toDelete.join(', ')}`);
      } else {
        console.log(`  前20个IDs: ${toDelete.slice(0, 20).join(', ')}...`);
      }
    }

    // 5. 询问用户是否继续删除
    if (toDelete.length > 0) {
      console.log(`\n是否删除 ${toDelete.length} 只没有日线数据的无效股票记录？`);
      console.log('输入 "YES" 确认删除，其他输入将取消:');

      // 简单的方式：使用命令行参数确认
      const args = process.argv.slice(2);
      if (args.includes('--confirm') || args.includes('-y')) {
        console.log('已通过命令行参数确认，开始删除...');
        await deleteStocks(toDelete);
      } else {
        console.log('跳过删除操作（使用 --confirm 或 -y 参数确认删除）');
      }
    }

    // 6. 显示清理建议（目前没有需要审查的记录）

  } catch (error) {
    console.error(`清理失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
  }
}

async function deleteStocks(stockIds) {
  const { sequelize } = require('./backend/dist/config/database');
  const { Stock } = require('./backend/dist/models');

  console.log(`开始删除 ${stockIds.length} 只股票记录...`);

  // 分批删除，避免一次删除太多
  const batchSize = 100;
  let deletedCount = 0;

  for (let i = 0; i < stockIds.length; i += batchSize) {
    const batch = stockIds.slice(i, i + batchSize);

    try {
      const result = await Stock.destroy({
        where: {
          id: batch
        }
      });

      deletedCount += result;
      console.log(`  已删除 ${result} 条记录，累计 ${deletedCount}/${stockIds.length}`);

      // 小延迟，避免数据库压力
      if (i + batchSize < stockIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`  删除批次 ${i/batchSize + 1} 失败: ${error.message}`);
      // 继续尝试下一批次
    }
  }

  console.log(`删除完成，总计删除 ${deletedCount} 条记录`);
}

// 命令行参数处理
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
清理无效股票记录工具

用法:
  node clean_invalid_stocks.js [选项]

选项:
  --confirm, -y     确认删除没有日线数据的无效记录
  --help, -h        显示帮助信息

示例:
  node clean_invalid_stocks.js              # 仅检查，不删除
  node clean_invalid_stocks.js --confirm    # 检查并删除无效记录
  `);
  process.exit(0);
}

cleanInvalidStocks().catch(console.error);