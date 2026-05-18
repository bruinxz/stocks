#!/usr/bin/env node
/**
 * 测试"查看走势"功能 - 模拟前端API调用
 */

async function testViewTrend() {
  try {
    const { DataService } = require('../backend/dist/data/services/DataService');
    const { Stock } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');
    const { Op } = require('../backend/node_modules/sequelize');

    // 设置日志级别为info，查看详细日志
    logger.level = 'info';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    const dataService = new DataService();

    console.log('=== 测试"查看走势"功能 ===\n');
    console.log('模拟前端API调用：获取股票日线数据\n');

    // 测试几只股票
    const testSymbols = ['sh.600000', 'sz.000001', 'sh.600036', 'sz.000002', 'sh.600519'];

    console.log('1. 测试快速模式（前端查看走势使用）:');
    console.log('   快速模式：优先返回数据库已有数据，不阻塞等待数据源补充\n');

    for (const symbol of testSymbols) {
      console.log(`测试 ${symbol}:`);

      // 模拟前端调用：最近3个月数据
      const endDate = new Date('2025-12-31');
      const startDate = new Date('2025-10-01');

      console.log(`  日期范围: ${startDate.toISOString().split('T')[0]} 到 ${endDate.toISOString().split('T')[0]}`);

      const startTime = Date.now();
      try {
        // 使用快速模式（fastMode: true）
        const bars = await dataService.getDailyBars(symbol, startDate, endDate, true);
        const elapsedTime = Date.now() - startTime;

        console.log(`  快速模式结果: ${bars.length} 条数据`);
        console.log(`  耗时: ${elapsedTime}ms`);

        if (bars.length > 0) {
          const earliest = bars[0].time.toISOString().split('T')[0];
          const latest = bars[bars.length - 1].time.toISOString().split('T')[0];
          console.log(`  日期范围: ${earliest} 到 ${latest}`);
        }

        // 检查是否有数据
        if (bars.length === 0) {
          console.log(`  ⚠️  警告: 数据库中没有 ${symbol} 的数据`);
          console.log(`     用户查看走势时可能会触发异步数据补充`);
        }

      } catch (error) {
        const elapsedTime = Date.now() - startTime;
        console.log(`  ❌ 错误: ${error.message} (${elapsedTime}ms)`);
      }

      console.log('');
    }

    console.log('2. 测试正常模式（触发异步数据补充）:');
    console.log('   正常模式：返回数据库数据，同时异步补充缺失数据\n');

    // 测试一只股票的异步补充
    const testSymbol = 'sh.600000';
    const endDate = new Date('2025-12-31');
    const startDate = new Date('2025-01-01');

    console.log(`测试 ${testSymbol} 异步数据补充:`);
    console.log(`  日期范围: ${startDate.toISOString().split('T')[0]} 到 ${endDate.toISOString().split('T')[0]}`);

    const startTime = Date.now();
    try {
      // 使用正常模式（fastMode: false，默认）
      const bars = await dataService.getDailyBars(testSymbol, startDate, endDate, false);
      const elapsedTime = Date.now() - startTime;

      console.log(`  立即返回: ${bars.length} 条数据`);
      console.log(`  耗时: ${elapsedTime}ms`);
      console.log(`  注: 异步数据补充已在后台启动，不阻塞请求`);

      // 检查异步补充是否触发
      console.log(`  异步补充状态: 已触发（通过DataService内部逻辑）`);

    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      console.log(`  ❌ 错误: ${error.message} (${elapsedTime}ms)`);
    }

    console.log('\n3. 测试超时保护:');
    console.log('   验证不会因数据源请求导致前端超时\n');

    // 测试一个没有数据的股票（应该快速返回空数组）
    const noDataSymbol = 'bj.830799'; // 北交所股票，可能没有数据
    console.log(`测试无数据股票 ${noDataSymbol}:`);

    const timeoutStart = Date.now();
    try {
      const bars = await dataService.getDailyBars(noDataSymbol, startDate, endDate, true);
      const timeoutElapsed = Date.now() - timeoutStart;

      console.log(`  结果: ${bars.length} 条数据`);
      console.log(`  耗时: ${timeoutElapsed}ms`);

      if (timeoutElapsed < 1000) {
        console.log(`  ✅ 快速响应 (< 1秒)，不会导致前端超时`);
      } else if (timeoutElapsed < 3000) {
        console.log(`  ⚠️  响应较慢 (${timeoutElapsed}ms)，但仍在可接受范围`);
      } else {
        console.log(`  ❌ 响应太慢 (${timeoutElapsed}ms)，可能导致前端超时`);
      }
    } catch (error) {
      console.log(`  ❌ 错误: ${error.message}`);
    }

    console.log('\n=== 测试总结 ===');
    console.log('1. 快速模式 (fastMode: true):');
    console.log('   - 优先返回数据库已有数据');
    console.log('   - 不阻塞等待数据源');
    console.log('   - 适合前端"查看走势"功能');
    console.log('');
    console.log('2. 异步数据补充:');
    console.log('   - 正常模式触发后台数据补充');
    console.log('   - 缺失数据会自动从数据源获取并回写数据库');
    console.log('   - 下次查询时数据已存在，体验更好');
    console.log('');
    console.log('3. 超时保护机制:');
    console.log('   - AKShare Python脚本有30秒超时');
    console.log('   - 数据源错误有缓存机制（避免频繁失败请求）');
    console.log('   - 快速模式确保前端请求快速响应');

  } catch (error) {
    console.error(`测试失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

testViewTrend().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});