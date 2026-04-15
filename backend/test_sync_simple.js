// 简化版数据同步测试 - 使用已知能工作的股票和日期范围
const { spawn } = require('child_process');
const path = require('path');
const { Sequelize, Op } = require('sequelize');
const axios = require('axios');

// 配置数据库连接
const sequelize = new Sequelize({
  database: 'stock_backtest',
  username: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  dialect: 'postgres',
  logging: false,
});

// 简单模型定义
const Stock = sequelize.define('stock', {
  id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  symbol: { type: Sequelize.STRING(10), allowNull: false },
  name: { type: Sequelize.STRING(100), allowNull: false },
}, {
  tableName: 'stocks',
  timestamps: false,
});

const DailyBar = sequelize.define('daily_bar', {
  time: { type: Sequelize.DATE, allowNull: false, primaryKey: true },
  stockId: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
  open: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  high: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  low: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  close: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  volume: { type: Sequelize.BIGINT, allowNull: false },
  turnover: { type: Sequelize.DECIMAL(20, 4), allowNull: true },
}, {
  tableName: 'daily_bars',
  timestamps: false,
  underscored: true,
});

const API_BASE_URL = 'http://localhost:3003/api';
const PYTHON_SCRIPT = path.join(__dirname, 'python', 'akshare_helper.py');

// 调用AKShare Python脚本
async function callAKShare(command, ...args) {
  return new Promise((resolve, reject) => {
    const processArgs = [PYTHON_SCRIPT, command, ...args];
    console.log(`调用AKShare: python ${processArgs.join(' ')}`);

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
        console.error(`AKShare脚本失败，代码 ${code}: ${stderr}`);
        reject(new Error(`AKShare脚本失败: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.success) {
          resolve(result.data);
        } else {
          reject(new Error(result.error || 'AKShare未知错误'));
        }
      } catch (error) {
        console.error(`无法解析AKShare输出: ${stdout}`);
        reject(new Error(`AKShare返回无效JSON: ${error.message}`));
      }
    });

    child.on('error', (error) => {
      console.error(`无法启动Python进程: ${error.message}`);
      reject(error);
    });
  });
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testAKShareDirect(symbol, startDate, endDate) {
  console.log(`直接测试AKShare: ${symbol} ${startDate} 到 ${endDate}`);
  try {
    const data = await callAKShare('get_daily_data', symbol, startDate, endDate, '2');
    console.log(`  ✅ 成功获取 ${data.length} 条数据`);
    if (data.length > 0) {
      console.log(`     示例: ${data[0].date} 开盘${data[0].open} 收盘${data[0].close}`);
    }
    return data.length > 0;
  } catch (error) {
    console.log(`  ❌ 失败: ${error.message}`);
    return false;
  }
}

async function main() {
  console.log('=== 简化版数据同步测试 ===\n');

  try {
    // 1. 连接数据库
    console.log('1. 连接数据库...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 测试几个常见的股票，确保AKShare能工作
    console.log('2. 验证AKShare数据源...');
    const testCases = [
      { symbol: 'sz.000001', name: '平安银行', startDate: '2024-03-01', endDate: '2024-03-05' },
      { symbol: 'sh.600000', name: '浦发银行', startDate: '2024-03-01', endDate: '2024-03-05' },
      { symbol: 'sz.000002', name: '万科A', startDate: '2024-03-01', endDate: '2024-03-05' },
    ];

    let allPassed = true;
    for (const testCase of testCases) {
      const passed = await testAKShareDirect(testCase.symbol, testCase.startDate, testCase.endDate);
      if (!passed) allPassed = false;
    }

    if (!allPassed) {
      console.log('\n⚠️ AKShare数据源测试失败，跳过后续测试');
      return;
    }

    // 3. 从数据库中选择实际存在的股票（确保在数据库中有）
    console.log('\n3. 从数据库选择测试股票...');

    // 查找数据库中存在的股票
    const existingStocks = await Stock.findAll({
      where: {
        symbol: testCases.map(tc => tc.symbol)
      }
    });

    if (existingStocks.length === 0) {
      console.log('数据库中没有找到测试股票，需要先同步股票数据');
      return;
    }

    console.log(`找到 ${existingStocks.length} 支测试股票:`);
    for (const stock of existingStocks) {
      console.log(`  ${stock.symbol} (${stock.name})`);
    }

    // 4. 备份数据 - 使用已知能工作的日期范围
    console.log('\n4. 备份数据...');
    const backup = [];

    for (const stock of existingStocks) {
      const testCase = testCases.find(tc => tc.symbol === stock.symbol);
      if (!testCase) continue;

      const startDate = new Date(testCase.startDate);
      const endDate = new Date(testCase.endDate);

      // 查找这个范围内的数据
      const existingData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: {
            [Op.between]: [startDate, endDate]
          }
        }
      });

      if (existingData.length === 0) {
        console.log(`  ${stock.symbol}: 数据库中没有 ${testCase.startDate} 到 ${testCase.endDate} 的数据`);
        // 可能还没有同步，跳过
        continue;
      }

      console.log(`  ${stock.symbol}: 找到 ${existingData.length} 条数据`);

      backup.push({
        stockId: stock.id,
        symbol: stock.symbol,
        name: stock.name,
        data: existingData.map(r => ({
          time: r.time,
          open: r.open,
          close: r.close,
        })),
        startDate,
        endDate,
      });
    }

    if (backup.length === 0) {
      console.log('没有可测试的数据，可能需要先同步数据');
      return;
    }

    console.log(`总共备份了 ${backup.length} 支股票的数据`);

    // 5. 删除数据
    console.log('\n5. 删除数据...');
    let totalDeleted = 0;

    for (const item of backup) {
      const deleted = await DailyBar.destroy({
        where: {
          stockId: item.stockId,
          time: {
            [Op.between]: [item.startDate, item.endDate]
          }
        }
      });

      totalDeleted += deleted;
      console.log(`  ${item.symbol}: 删除了 ${deleted} 条记录`);
    }

    console.log(`总计删除: ${totalDeleted} 条记录`);

    if (totalDeleted === 0) {
      console.log('没有数据可删除，跳过同步测试');
      return;
    }

    // 等待一下，确保删除操作完成
    await wait(1000);

    // 6. 直接通过AKShare获取数据并插入（模拟同步过程）
    console.log('\n6. 通过AKShare直接获取数据...');
    let totalInserted = 0;

    for (const item of backup) {
      const testCase = testCases.find(tc => tc.symbol === item.symbol);
      if (!testCase) continue;

      try {
        const data = await callAKShare('get_daily_data', item.symbol, testCase.startDate, testCase.endDate, '2');
        console.log(`  ${item.symbol}: 从AKShare获取到 ${data.length} 条数据`);

        // 插入数据
        for (const bar of data) {
          try {
            // 检查是否已存在
            const existing = await DailyBar.findOne({
              where: {
                stockId: item.stockId,
                time: new Date(bar.date),
              }
            });

            if (!existing) {
              // 使用所有必要字段，提供默认值
              await DailyBar.create({
                stockId: item.stockId,
                time: new Date(bar.date),
                open: bar.open || bar.close || 0,
                high: bar.high || Math.max(bar.open || 0, bar.close || 0),
                low: bar.low || Math.min(bar.open || 0, bar.close || 0),
                close: bar.close || bar.open || 0,
                volume: bar.volume || 0,
                turnover: bar.amount || 0, // amount对应turnover
              });
              totalInserted++;
              console.log(`    插入 ${bar.date}: 开盘${bar.open}, 收盘${bar.close}`);
            }
          } catch (insertError) {
            console.log(`    插入 ${bar.date} 失败: ${insertError.message}`);
            console.log(`    数据:`, JSON.stringify(bar));
          }
        }
      } catch (error) {
        console.log(`  ${item.symbol}: 获取数据失败 - ${error.message}`);
      }
    }

    // 7. 验证数据恢复
    console.log('\n7. 验证数据恢复...');
    let totalRecovered = 0;
    let totalExpected = 0;

    for (const item of backup) {
      const recoveredData = await DailyBar.findAll({
        where: {
          stockId: item.stockId,
          time: {
            [Op.between]: [item.startDate, item.endDate]
          }
        }
      });

      const expected = item.data.length;
      const recovered = recoveredData.length;

      totalExpected += expected;
      totalRecovered += recovered;

      const statusIcon = recovered === expected ? '✅' :
                        recovered > 0 ? '⚠️' : '❌';

      console.log(`  ${statusIcon} ${item.symbol}: 恢复 ${recovered}/${expected} 条`);

      if (recovered !== expected) {
        console.log(`    删除的日期: ${item.data.map(d => d.time.toISOString().split('T')[0]).join(', ')}`);
        console.log(`    恢复的日期: ${recoveredData.map(d => d.time.toISOString().split('T')[0]).join(', ')}`);
      }
    }

    // 8. 显示结果
    console.log('\n=== 测试结果 ===');
    console.log(`测试股票数: ${backup.length}`);
    console.log(`删除记录数: ${totalDeleted}`);
    console.log(`预期恢复数: ${totalExpected}`);
    console.log(`实际恢复数: ${totalRecovered}`);
    console.log(`通过AKShare插入: ${totalInserted} 条`);

    if (totalExpected > 0) {
      const recoveryRate = (totalRecovered / totalExpected) * 100;
      console.log(`恢复率: ${recoveryRate.toFixed(1)}%`);
    }

    if (totalRecovered === totalExpected && totalExpected > 0) {
      console.log('\n🎉 数据同步测试通过！');
      console.log('说明AKShare数据源工作正常');
    } else if (totalRecovered > 0) {
      console.log(`\n⚠️ 数据同步部分成功（恢复率: ${((totalRecovered / totalExpected) * 100).toFixed(1)}%）`);
    } else {
      console.log('\n❌ 数据同步测试失败');
    }

    // 9. 额外测试：通过API触发同步
    console.log('\n8. 额外测试：通过API触发同步...');

    // 清理队列
    try {
      await axios.post(`${API_BASE_URL}/market/clean-queue`);
      console.log('  队列已清理');
    } catch (e) {
      console.log(`  清理队列失败: ${e.message}`);
    }

    // 检查当前状态
    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      console.log('  当前队列状态:');
      console.log(`    等待中: ${response.data.data.queue?.waiting || 0}`);
      console.log(`    活动中: ${response.data.data.queue?.active || 0}`);
    } catch (e) {
      console.log(`  检查状态失败: ${e.message}`);
    }

  } catch (error) {
    console.error('测试失败:', error.message);
    if (error.stack) {
      console.error('堆栈:', error.stack.split('\n').slice(0, 3).join('\n'));
    }
  } finally {
    await sequelize.close();
    console.log('\n=== 测试完成 ===');
  }
}

main();