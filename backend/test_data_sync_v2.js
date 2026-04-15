// 测试数据同步功能 v2
// 使用手动同步强制更新

const axios = require('axios');
const { Sequelize, Op } = require('sequelize');

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

// 定义模型
const Stock = sequelize.define('stock', {
  id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
  symbol: { type: Sequelize.STRING(10), allowNull: false },
  name: { type: Sequelize.STRING(100), allowNull: false },
  market: { type: Sequelize.STRING(10) },
  dataStatus: { type: Sequelize.STRING(20) },
}, {
  tableName: 'stocks',
  timestamps: true,
});

const DailyBar = sequelize.define('daily_bar', {
  time: { type: Sequelize.DATE, allowNull: false, primaryKey: true },
  stockId: { type: Sequelize.INTEGER, allowNull: false, primaryKey: true },
  open: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  high: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  low: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  close: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
  volume: { type: Sequelize.BIGINT, allowNull: false },
}, {
  tableName: 'daily_bars',
  timestamps: true,
  underscored: true,
});

// API配置
const API_BASE_URL = 'http://localhost:3003/api';

// 等待函数
async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 等待任务完成
async function waitForJobCompletion(logId, maxWaitSeconds = 120) {
  console.log(`等待任务 ${logId} 完成...`);
  const startTime = Date.now();
  const maxWaitMs = maxWaitSeconds * 1000;

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      if (response.data.success) {
        const logs = response.data.data.logs || [];
        const targetLog = logs.find(log => log.id === logId);

        if (targetLog) {
          if (targetLog.status === 'completed') {
            console.log(`任务 ${logId} 已完成`);
            return targetLog;
          } else if (targetLog.status === 'failed') {
            console.log(`任务 ${logId} 失败: ${targetLog.error || '未知错误'}`);
            return targetLog;
          }
          // 还在进行中
        }
      }
    } catch (error) {
      console.log(`检查任务状态时出错: ${error.message}`);
    }

    // 等待5秒再检查
    await wait(5000);
    console.log(`等待中... (已等待 ${Math.round((Date.now() - startTime) / 1000)} 秒)`);
  }

  throw new Error(`等待任务完成超时 (${maxWaitSeconds} 秒)`);
}

async function main() {
  try {
    console.log('=== 开始测试数据同步功能 v2 ===\n');

    // 1. 测试连接
    console.log('1. 测试数据库连接...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 随机选择10支股票（选择有数据的股票）
    console.log('2. 随机选择10支有数据的股票...');

    // 首先找到有数据的股票
    const stocksWithData = await Stock.findAll({
      include: [{
        model: DailyBar,
        required: true,
        where: {
          time: {
            [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 最近7天
          },
        },
        limit: 1,
      }],
      order: sequelize.random(),
      limit: 10,
    });

    // 如果找不到足够的有数据股票，使用所有股票
    let stocks;
    if (stocksWithData.length >= 5) {
      stocks = stocksWithData;
      console.log(`找到 ${stocks.length} 支最近一周有数据的股票`);
    } else {
      console.log('最近一周有数据的股票不足，随机选择10支股票...');
      stocks = await Stock.findAll({
        order: sequelize.random(),
        limit: 10,
      });
    }

    console.log(`选择了 ${stocks.length} 支股票:`);
    stocks.forEach((stock, index) => {
      console.log(`  ${index + 1}. ${stock.symbol} - ${stock.name}`);
    });
    console.log();

    // 3. 获取最近一周的数据（最近7天）
    console.log('3. 获取最近一周的数据...');
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const stockDataMap = new Map();
    let totalRecords = 0;

    for (const stock of stocks) {
      const recentData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: {
            [Op.gte]: oneWeekAgo,
          },
        },
        order: [['time', 'DESC']],
      });

      stockDataMap.set(stock.id, {
        stock,
        data: recentData,
      });

      console.log(`  ${stock.symbol}: 找到 ${recentData.length} 条最近一周的数据`);
      totalRecords += recentData.length;
    }
    console.log(`总计找到 ${totalRecords} 条记录\n`);

    if (totalRecords === 0) {
      console.log('⚠️ 警告：没有找到最近一周的数据，测试可能不准确');
      console.log('建议：确保数据库中有股票数据\n');
    }

    // 4. 备份数据到文件
    console.log('4. 备份数据到文件...');
    const backupData = [];
    for (const [stockId, item] of stockDataMap) {
      backupData.push({
        stock: {
          id: item.stock.id,
          symbol: item.stock.symbol,
          name: item.stock.name,
        },
        data: item.data.map(record => ({
          time: record.time,
          open: record.open,
          high: record.high,
          low: record.low,
          close: record.close,
          volume: record.volume,
        })),
      });
    }

    const fs = require('fs');
    fs.writeFileSync('backup_data_v2.json', JSON.stringify(backupData, null, 2));
    console.log(`备份保存到 backup_data_v2.json (${backupData.length} 支股票)`);
    console.log();

    // 5. 删除最近一周的数据
    console.log('5. 删除最近一周的数据...');
    let totalDeleted = 0;

    for (const [stockId, item] of stockDataMap) {
      if (item.data.length > 0) {
        const deletedCount = await DailyBar.destroy({
          where: {
            stockId: stockId,
            time: {
              [Op.gte]: oneWeekAgo,
            },
          },
        });
        totalDeleted += deletedCount;
        console.log(`  ${item.stock.symbol}: 删除了 ${deletedCount} 条记录`);
      }
    }
    console.log(`总共删除了 ${totalDeleted} 条记录\n`);

    // 6. 触发手动数据同步（强制更新）
    console.log('6. 触发手动数据同步（强制更新）...');
    try {
      const response = await axios.post(`${API_BASE_URL}/market/manual-sync`, {
        type: 'daily_update',
        force: true,
      });

      if (response.data.success) {
        const jobId = response.data.data.jobId;
        console.log(`手动同步任务已排队: ${jobId}`);
        console.log(`类型: ${response.data.data.type}`);
        console.log(`日期: ${response.data.data.date}`);

        // 7. 等待任务完成
        console.log('\n7. 等待任务完成...');

        // 获取最新的日志ID
        const statusResponse = await axios.get(`${API_BASE_URL}/market/update-status`);
        if (statusResponse.data.success) {
          const logs = statusResponse.data.data.logs || [];
          const latestLog = logs[0]; // 最新的日志在最前面

          if (latestLog) {
            const completedLog = await waitForJobCompletion(latestLog.id, 180); // 最多等待3分钟
            console.log(`\n任务完成状态: ${completedLog.status}`);
            if (completedLog.result) {
              console.log(`结果: ${JSON.stringify(completedLog.result, null, 2)}`);
            }
            if (completedLog.error) {
              console.log(`错误: ${completedLog.error}`);
            }
          } else {
            console.log('未找到任务日志');
          }
        }
      } else {
        console.log(`手动同步失败: ${response.data.error}`);
      }
    } catch (error) {
      console.log(`触发手动数据同步失败: ${error.message}`);
      if (error.response) {
        console.log(`状态码: ${error.response.status}`);
        console.log(`响应数据: ${JSON.stringify(error.response.data)}`);
      }
    }
    console.log();

    // 8. 验证数据是否恢复
    console.log('8. 验证数据是否恢复...');
    let totalRecovered = 0;
    let totalExpected = 0;

    for (const backupItem of backupData) {
      const stockId = backupItem.stock.id;
      const expectedCount = backupItem.data.length;
      totalExpected += expectedCount;

      const recoveredData = await DailyBar.findAll({
        where: {
          stockId: stockId,
          time: {
            [Op.gte]: oneWeekAgo,
          },
        },
        order: [['time', 'DESC']],
      });

      const recoveredCount = recoveredData.length;
      totalRecovered += recoveredCount;

      const status = recoveredCount === expectedCount ? '✅' :
                     recoveredCount > 0 ? '⚠️' : '❌';
      console.log(`  ${status} ${backupItem.stock.symbol}: 恢复了 ${recoveredCount}/${expectedCount} 条记录`);
    }

    console.log(`\n总计: 恢复了 ${totalRecovered}/${totalExpected} 条记录`);

    if (totalRecovered === totalExpected) {
      console.log('\n🎉 数据同步功能测试通过！');
    } else if (totalRecovered > 0) {
      console.log(`\n⚠️ 数据同步部分成功，恢复了 ${totalRecovered}/${totalExpected} 条记录`);
    } else {
      console.log('\n❌ 数据同步功能测试失败！');
    }

    // 9. 显示详细统计
    console.log('\n=== 详细统计 ===');
    console.log(`选择股票数: ${stocks.length}`);
    console.log(`删除记录数: ${totalDeleted}`);
    console.log(`预期恢复数: ${totalExpected}`);
    console.log(`实际恢复数: ${totalRecovered}`);
    console.log(`恢复率: ${totalExpected > 0 ? ((totalRecovered / totalExpected) * 100).toFixed(1) : 0}%`);

  } catch (error) {
    console.error('测试失败:', error);
    console.error('堆栈:', error.stack);
  } finally {
    await sequelize.close();
    console.log('\n=== 测试完成 ===');
  }
}

main();