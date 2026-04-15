#!/usr/bin/env node
/**
 * 测试数据同步功能的脚本
 * 直接测试AKShare数据源是否工作
 */

const { spawn } = require('child_process');
const path = require('path');

const pythonScript = path.join(__dirname, 'backend/python/akshare_helper.py');

async function testAKShareDirectly() {
  console.log('=== 直接测试AKShare Python脚本 ===');

  // 测试平安银行（sz.000001）的历史数据
  const testCases = [
    {
      code: 'sz.000001',
      startDate: '2024-03-01',
      endDate: '2024-03-07',
      description: '平安银行 - 历史数据（应成功）'
    },
    {
      code: 'sh.600000',
      startDate: '2024-03-01',
      endDate: '2024-03-07',
      description: '浦发银行 - 历史数据（应成功）'
    },
    {
      code: 'sz.000001',
      startDate: '2026-04-04',
      endDate: '2026-04-11',
      description: '平安银行 - 未来数据（应失败）'
    }
  ];

  for (const testCase of testCases) {
    console.log(`\n测试: ${testCase.description}`);
    console.log(`代码: ${testCase.code}, 日期: ${testCase.startDate} 到 ${testCase.endDate}`);

    try {
      const result = await callPythonScript('get_daily_data',
        testCase.code, testCase.startDate, testCase.endDate, '3');

      console.log(`  结果: 获取到 ${result.length} 条记录`);
      if (result.length > 0) {
        console.log(`  第一条记录: ${JSON.stringify(result[0], null, 2)}`);
      }
    } catch (error) {
      console.log(`  错误: ${error.message}`);
    }
  }
}

async function callPythonScript(command, ...args) {
  return new Promise((resolve, reject) => {
    const processArgs = [pythonScript, command, ...args];
    console.log(`  执行: python ${processArgs.join(' ')}`);

    const child = spawn('python', processArgs);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`  Python脚本退出码 ${code}: ${stderr}`);
        reject(new Error(`Python脚本失败: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.success) {
          resolve(result.data);
        } else {
          reject(new Error(result.error || 'Python脚本返回错误'));
        }
      } catch (error) {
        console.error(`  解析JSON失败: ${stdout}`);
        reject(new Error(`无效的JSON响应: ${error.message}`));
      }
    });

    child.on('error', (error) => {
      console.error(`  启动Python进程失败: ${error.message}`);
      reject(error);
    });
  });
}

async function testDatabaseConnection() {
  console.log('\n=== 测试数据库连接和现有数据 ===');

  try {
    // 动态加载数据库模块
    const { sequelize } = require('./backend/dist/config/database');
    const { Stock, DailyBar } = require('./backend/dist/models');

    await sequelize.authenticate();
    console.log('  数据库连接成功');

    // 检查股票数量
    const stockCount = await Stock.count();
    console.log(`  数据库中有 ${stockCount} 只股票`);

    // 检查最近的数据
    const recentBar = await DailyBar.findOne({
      order: [['time', 'DESC']],
      limit: 1,
      include: [{ model: Stock, attributes: ['symbol', 'name'] }]
    });

    if (recentBar) {
      console.log(`  最新数据: ${recentBar.Stock.symbol} - ${recentBar.time.toISOString().split('T')[0]}`);
    } else {
      console.log('  数据库中没有日线数据');
    }

    // 检查具体股票的数据
    const testStock = await Stock.findOne({ where: { symbol: 'sz.000001' } });
    if (testStock) {
      const barCount = await DailyBar.count({ where: { stockId: testStock.id } });
      console.log(`  平安银行(sz.000001)有 ${barCount} 条日线数据`);

      const latestBar = await DailyBar.findOne({
        where: { stockId: testStock.id },
        order: [['time', 'DESC']],
        limit: 1
      });

      if (latestBar) {
        console.log(`  平安银行最新数据日期: ${latestBar.time.toISOString().split('T')[0]}`);
      }
    }

  } catch (error) {
    console.error(`  数据库测试失败: ${error.message}`);
  }
}

async function testDataSyncService() {
  console.log('\n=== 测试DataSyncService ===');

  try {
    // 动态加载DataSyncService
    const { DataSyncService } = require('./backend/dist/data/services/DataSyncService');
    const service = new DataSyncService();

    // 测试单只股票同步（使用历史日期）
    console.log('  测试同步平安银行(sz.000001)的历史数据...');
    const inserted = await service.syncStockHistory(
      'sz.000001',
      '2024-03-01',
      '2024-03-07'
    );

    console.log(`  插入 ${inserted} 条新记录`);

    // 测试数据源状态
    const status = service.getStatus();
    console.log('  数据源状态:', JSON.stringify(status, null, 2));

  } catch (error) {
    console.error(`  DataSyncService测试失败: ${error.message}`);
    console.error(`  堆栈: ${error.stack}`);
  }
}

async function main() {
  console.log('开始数据同步功能测试...');
  console.log('当前时间:', new Date().toISOString());
  console.log('系统日期:', new Date().toISOString().split('T')[0]);

  await testAKShareDirectly();
  await testDatabaseConnection();
  await testDataSyncService();

  console.log('\n=== 测试完成 ===');
}

main().catch(console.error);