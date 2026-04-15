// 改进的数据同步功能测试
// 从昨天的成功同步结果中选择股票进行测试

const axios = require('axios');
const { Sequelize, Op } = require('sequelize');
const fs = require('fs');
const path = require('path');

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
  close: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
}, {
  tableName: 'daily_bars',
  timestamps: false,
  underscored: true,
});

const API_BASE_URL = 'http://localhost:3003/api';
const SYNC_RESULTS_FILE = path.join(__dirname, 'logs', 'sync-results.json');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 从昨天的同步结果中读取成功同步的股票
function getSuccessfulStocksFromYesterday(results, limit = 3) {
  const successfulStocks = [];

  for (const [symbol, data] of Object.entries(results.detailedResults)) {
    if (data.count > 0) {
      successfulStocks.push({
        symbol: symbol,
        count: data.count,
        timestamp: data.timestamp
      });
    }
  }

  // 按count降序排序，选择数据量多的股票
  successfulStocks.sort((a, b) => b.count - a.count);

  return successfulStocks.slice(0, limit);
}

async function main() {
  console.log('=== 改进的数据同步功能测试 ===\n');

  try {
    // 1. 读取昨天的同步结果
    console.log('1. 读取昨天的同步结果...');
    if (!fs.existsSync(SYNC_RESULTS_FILE)) {
      console.log(`错误：找不到同步结果文件 ${SYNC_RESULTS_FILE}`);
      return;
    }

    const syncResults = JSON.parse(fs.readFileSync(SYNC_RESULTS_FILE, 'utf8'));
    console.log(`  昨天同步了 ${syncResults.totalStocks} 支股票`);
    console.log(`  成功: ${syncResults.successCount}, 失败: ${syncResults.failCount}\n`);

    // 2. 选择成功同步的股票
    console.log('2. 选择成功同步的股票...');
    const successfulStocks = getSuccessfulStocksFromYesterday(syncResults, 3);

    if (successfulStocks.length === 0) {
      console.log('错误：昨天没有成功同步的股票');
      return;
    }

    console.log('选择的股票:');
    successfulStocks.forEach((stock, i) => {
      console.log(`  ${i+1}. ${stock.symbol} (数据量: ${stock.count} 条)`);
    });
    console.log();

    // 3. 连接数据库
    console.log('3. 连接数据库...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 4. 检查并备份最近7天的数据
    console.log('4. 检查并备份最近7天的数据...');
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const backup = [];

    for (const stockData of successfulStocks) {
      // 查找股票ID
      const stock = await Stock.findOne({
        where: { symbol: stockData.symbol },
      });

      if (!stock) {
        console.log(`  警告：数据库中没有找到股票 ${stockData.symbol}，跳过`);
        continue;
      }

      const recentData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: { [Op.gte]: sevenDaysAgo }
        },
        order: [['time', 'DESC']],
      });

      console.log(`  ${stockData.symbol}: 找到 ${recentData.length} 条最近7天的数据`);

      if (recentData.length > 0) {
        backup.push({
          stockId: stock.id,
          symbol: stockData.symbol,
          data: recentData.map(r => ({
            time: r.time,
            open: r.open,
            close: r.close,
          })),
        });
      }
    }

    if (backup.length === 0) {
      console.log('警告：没有找到最近7天的数据，测试可能不准确\n');
      console.log('尝试获取股票列表重新选择...');

      // 尝试随机选择其他股票
      const randomStocks = await Stock.findAll({
        order: sequelize.random(),
        limit: 3,
      });

      for (const stock of randomStocks) {
        const recentData = await DailyBar.findAll({
          where: {
            stockId: stock.id,
            time: { [Op.gte]: sevenDaysAgo }
          },
          order: [['time', 'DESC']],
          limit: 10
        });

        if (recentData.length > 0) {
          backup.push({
            stockId: stock.id,
            symbol: stock.symbol,
            data: recentData.map(r => ({
              time: r.time,
              open: r.open,
              close: r.close,
            })),
          });
          console.log(`  ${stock.symbol}: 找到 ${recentData.length} 条最近7天的数据`);
        }
      }

      if (backup.length === 0) {
        console.log('仍然没有找到数据，跳过删除/恢复测试');
        return;
      }
    }

    // 5. 删除数据
    console.log('\n5. 删除最近7天的数据...');
    let totalDeleted = 0;

    for (const item of backup) {
      const deleted = await DailyBar.destroy({
        where: {
          stockId: item.stockId,
          time: { [Op.gte]: sevenDaysAgo }
        }
      });

      totalDeleted += deleted;
      console.log(`  ${item.symbol}: 删除了 ${deleted} 条记录`);
    }

    console.log(`总计删除: ${totalDeleted} 条记录\n`);

    if (totalDeleted === 0) {
      console.log('没有数据可删除，跳过同步测试');
      return;
    }

    // 6. 清理队列并触发手动同步
    console.log('6. 准备数据同步...');

    // 清理队列
    try {
      await axios.post(`${API_BASE_URL}/market/clean-queue`);
      console.log('  队列已清理');
    } catch (e) {
      console.log(`  清理队列失败: ${e.message}`);
    }

    // 触发手动同步
    console.log('  触发手动同步...');
    let jobId = null;

    try {
      const response = await axios.post(`${API_BASE_URL}/market/manual-sync`, {
        type: 'daily_update',
        force: true,
      });

      if (response.data.success) {
        jobId = response.data.data.jobId;
        console.log(`  任务已排队: ${jobId}`);
      } else {
        console.log(`  同步失败: ${response.data.error}`);
      }
    } catch (error) {
      console.log(`  触发同步失败: ${error.message}`);
      if (error.response) {
        console.log(`  状态码: ${error.response.status}`);
        console.log(`  响应数据: ${JSON.stringify(error.response.data)}`);
      }
    }

    // 7. 等待同步完成
    console.log('\n7. 等待同步完成（最多3分钟）...');

    let syncCompleted = false;
    let finalStatus = 'unknown';
    let finalResult = null;

    for (let i = 0; i < 18; i++) { // 18 * 10秒 = 3分钟
      await wait(10000);

      try {
        const response = await axios.get(`${API_BASE_URL}/market/update-status`);
        if (response.data.success) {
          const queue = response.data.data.queue;
          const activeJobs = queue.active || 0;

          if (activeJobs === 0) {
            syncCompleted = true;

            // 检查最新日志状态
            const logs = response.data.data.logs || [];
            if (logs.length > 0) {
              const latestLog = logs[0];
              finalStatus = latestLog.status;
              finalResult = latestLog.result;
              console.log(`  同步状态: ${finalStatus}`);
            }
            break;
          }

          console.log(`  等待中... (${i+1}/18) - 活动任务: ${activeJobs}`);
        }
      } catch (e) {
        console.log(`  检查状态失败: ${e.message}`);
      }
    }

    if (!syncCompleted) {
      console.log('  同步未在预期时间内完成');
    }

    // 8. 验证数据恢复
    console.log('\n8. 验证数据恢复...');

    let totalRecovered = 0;
    let totalExpected = 0;

    for (const item of backup) {
      const recoveredData = await DailyBar.findAll({
        where: {
          stockId: item.stockId,
          time: { [Op.gte]: sevenDaysAgo }
        }
      });

      const expected = item.data.length;
      const recovered = recoveredData.length;

      totalExpected += expected;
      totalRecovered += recovered;

      const statusIcon = recovered === expected ? '✅' :
                        recovered > 0 ? '⚠️' : '❌';

      console.log(`  ${statusIcon} ${item.symbol}: 恢复 ${recovered}/${expected} 条`);
    }

    // 9. 显示结果
    console.log('\n=== 测试结果 ===');
    console.log(`测试股票数: ${backup.length}`);
    console.log(`删除记录数: ${totalDeleted}`);
    console.log(`预期恢复数: ${totalExpected}`);
    console.log(`实际恢复数: ${totalRecovered}`);

    if (totalExpected > 0) {
      const recoveryRate = (totalRecovered / totalExpected) * 100;
      console.log(`恢复率: ${recoveryRate.toFixed(1)}%`);
    }

    console.log(`同步完成: ${syncCompleted ? '是' : '否'}`);
    console.log(`最终状态: ${finalStatus}`);

    if (totalRecovered === totalExpected && totalExpected > 0) {
      console.log('\n🎉 数据同步测试通过！');
    } else if (totalRecovered > 0) {
      console.log(`\n⚠️ 数据同步部分成功（恢复率: ${((totalRecovered / totalExpected) * 100).toFixed(1)}%）`);
      console.log('可能原因:');
      console.log('  - 部分日期可能不是交易日');
      console.log('  - 数据源可能没有某些日期的数据');
    } else {
      console.log('\n❌ 数据同步测试失败');
      console.log('可能原因:');
      console.log('  - 数据源不可用');
      console.log('  - 数据更新任务失败');
      console.log('  - 网络连接问题');
    }

    // 10. 显示最新更新日志
    console.log('\n10. 最新更新日志:');
    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      if (response.data.success) {
        const logs = response.data.data.logs || [];
        if (logs.length > 0) {
          const log = logs[0];
          console.log(`  ID: ${log.id}`);
          console.log(`  类型: ${log.type}`);
          console.log(`  状态: ${log.status}`);
          console.log(`  日期: ${log.date}`);

          if (log.result) {
            console.log(`  结果: ${JSON.stringify(log.result, null, 2)}`);
          }
          if (log.error) {
            console.log(`  错误: ${log.error}`);
          }
        }
      }
    } catch (e) {
      console.log(`  获取日志失败: ${e.message}`);
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