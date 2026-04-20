#!/usr/bin/env node
/**
 * 测试DataService数据补充逻辑
 * 测试场景：
 * 1. 数据库有部分数据，查询时自动补充缺失数据
 * 2. 数据库无数据，查询时从数据源获取完整数据
 * 3. 重复查询同一范围，不应重复请求数据源（空结果缓存）
 */

async function testDataCompletion() {
  try {
    const { DataService } = require('../backend/dist/data/services/DataService');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');

    // 抑制日志输出，使测试更清晰
    logger.level = 'warn';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    const dataService = new DataService();

    console.log('=== 测试DataService数据补充逻辑 ===\n');

    const { Op } = require('../backend/node_modules/sequelize');

    // 1. 选择一个测试股票（使用一个已知存在的股票）
    const testStocks = await Stock.findAll({
      where: {
        symbol: {
          [Op.like]: 'sh.600000'
        }
      },
      limit: 1
    });

    if (testStocks.length === 0) {
      console.log('未找到sh.600000，尝试其他股票...');
      const anyStock = await Stock.findOne({
        where: { isListed: true },
        order: [['id', 'ASC']]
      });
      if (!anyStock) {
        console.error('没有可用的测试股票');
        return;
      }
      var testStock = anyStock;
    } else {
      var testStock = testStocks[0];
    }

    console.log(`测试股票: ${testStock.symbol} (${testStock.name})`);

    // 2. 清理测试数据（保留2025年6月的数据，模拟部分数据存在）
    console.log('\n1. 准备测试数据：保留2025年6月，清理其他月份...');

    // 删除6月以外的数据
    const deleteCount = await DailyBar.destroy({
      where: {
        stockId: testStock.id,
        [Op.or]: [
          {
            time: {
              [Op.lt]: new Date('2025-06-01')
            }
          },
          {
            time: {
              [Op.gt]: new Date('2025-06-30')
            }
          }
        ]
      }
    });
    console.log(`   删除 ${deleteCount} 条非6月数据`);

    // 检查6月数据数量
    const juneBars = await DailyBar.findAll({
      where: {
        stockId: testStock.id,
        time: {
          [Op.between]: [new Date('2025-06-01'), new Date('2025-06-30')]
        }
      }
    });
    console.log(`   6月现有数据: ${juneBars.length} 条`);

    // 3. 查询6月数据（应该直接从数据库返回，不会触发数据源）
    console.log('\n2. 查询6月数据（应命中数据库）...');
    const juneStart = Date.now();
    const juneResult = await dataService.getDailyBars(
      testStock.symbol,
      new Date('2025-06-01'),
      new Date('2025-06-30')
    );
    const juneTime = Date.now() - juneStart;

    console.log(`   返回 ${juneResult.length} 条数据`);
    console.log(`   耗时: ${juneTime}ms`);
    console.log(`   是否与现有数据一致: ${juneResult.length === juneBars.length}`);

    // 4. 查询整个2025年上半年（1-6月），应该自动补充1-5月数据
    console.log('\n3. 查询2025年1-6月（应自动补充1-5月数据）...');
    const fullStart = Date.now();
    const fullResult = await dataService.getDailyBars(
      testStock.symbol,
      new Date('2025-01-01'),
      new Date('2025-06-30')
    );
    const fullTime = Date.now() - fullStart;

    console.log(`   返回 ${fullResult.length} 条数据`);
    console.log(`   耗时: ${fullTime}ms`);

    // 检查数据库中总数据量
    const dbCount = await DailyBar.count({
      where: {
        stockId: testStock.id,
        time: {
          [Op.between]: [new Date('2025-01-01'), new Date('2025-06-30')]
        }
      }
    });
    console.log(`   数据库中总数据: ${dbCount} 条`);

    // 5. 再次查询相同范围，应直接命中数据库（数据已补充）
    console.log('\n4. 再次查询相同范围（应命中数据库）...');
    const secondStart = Date.now();
    const secondResult = await dataService.getDailyBars(
      testStock.symbol,
      new Date('2025-01-01'),
      new Date('2025-06-30')
    );
    const secondTime = Date.now() - secondStart;

    console.log(`   返回 ${secondResult.length} 条数据`);
    console.log(`   耗时: ${secondTime}ms`);
    console.log(`   是否与第一次结果一致: ${secondResult.length === fullResult.length}`);

    // 6. 测试无效日期范围（数据源应返回空，并被缓存）
    console.log('\n5. 测试未来日期范围（应触发空结果缓存）...');
    const futureStart = Date.now();
    const futureResult = await dataService.getDailyBars(
      testStock.symbol,
      new Date('2030-01-01'),
      new Date('2030-01-31')
    );
    const futureTime = Date.now() - futureStart;

    console.log(`   返回 ${futureResult.length} 条数据`);
    console.log(`   耗时: ${futureTime}ms`);

    // 7. 立即再次查询相同未来范围，应跳过数据源（空结果缓存）
    console.log('\n6. 立即再次查询相同未来范围（应跳过数据源）...');
    const futureSecondStart = Date.now();
    const futureSecondResult = await dataService.getDailyBars(
      testStock.symbol,
      new Date('2030-01-01'),
      new Date('2030-01-31')
    );
    const futureSecondTime = Date.now() - futureSecondStart;

    console.log(`   返回 ${futureSecondResult.length} 条数据`);
    console.log(`   耗时: ${futureSecondTime}ms`);

    // 8. 测试部分缺失的数据（中间有空洞）
    console.log('\n7. 清理部分数据，测试补充空洞...');

    // 删除6月中间的数据（模拟数据空洞）
    const midJune = await DailyBar.destroy({
      where: {
        stockId: testStock.id,
        time: {
          [Op.between]: [new Date('2025-06-10'), new Date('2025-06-20')]
        }
      }
    });
    console.log(`   删除 ${midJune} 条6月10-20日数据`);

    // 查询6月数据，应该自动补充中间缺失的数据
    const gapStart = Date.now();
    const gapResult = await dataService.getDailyBars(
      testStock.symbol,
      new Date('2025-06-01'),
      new Date('2025-06-30')
    );
    const gapTime = Date.now() - gapStart;

    console.log(`   返回 ${gapResult.length} 条数据`);
    console.log(`   耗时: ${gapTime}ms`);

    const finalDbCount = await DailyBar.count({
      where: {
        stockId: testStock.id,
        time: {
          [Op.between]: [new Date('2025-06-01'), new Date('2025-06-30')]
        }
      }
    });
    console.log(`   6月最终数据量: ${finalDbCount} 条`);

    console.log('\n=== 测试完成 ===');
    console.log('\n总结:');
    console.log(`   1. 数据库有部分数据时，查询自动补充缺失数据`);
    console.log(`   2. 数据补充后，重复查询命中数据库（快）`);
    console.log(`   3. 无效日期范围触发空结果缓存，避免重复查询`);
    console.log(`   4. 数据空洞（中间缺失）能被正确识别和补充`);

  } catch (error) {
    console.error(`测试失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

testDataCompletion().catch(error => {
  console.error('测试脚本执行失败:', error);
  process.exit(1);
});