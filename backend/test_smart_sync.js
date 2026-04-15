// 智能数据同步测试 - 使用实际存在的日期范围
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

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== 智能数据同步功能测试 ===\n');

  try {
    // 1. 连接数据库
    console.log('1. 连接数据库...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 选择3支有足够数据的股票
    console.log('2. 选择测试股票...');

    // 查询有最近数据的股票
    const [stocksWithRecentData] = await sequelize.query(`
      SELECT
        s.id, s.symbol, s.name,
        MAX(db.time) as latest_date,
        MIN(db.time) as earliest_date,
        COUNT(db.time) as data_count
      FROM stocks s
      JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time >= '2026-03-01'
      GROUP BY s.id, s.symbol, s.name
      HAVING COUNT(db.time) >= 20  -- 至少有20条3月份的数据
      ORDER BY MAX(db.time) DESC
      LIMIT 3
    `);

    if (stocksWithRecentData.length === 0) {
      console.log('错误：没有找到3月份有足够数据的股票');
      return;
    }

    console.log('选择的测试股票:');
    const testStocks = [];
    for (const stock of stocksWithRecentData) {
      console.log(`  ${stock.symbol} (${stock.name}):`);
      console.log(`    数据量: ${stock.data_count}`);
      console.log(`    日期范围: ${stock.earliest_date.toISOString().split('T')[0]} 到 ${stock.latest_date.toISOString().split('T')[0]}`);
      testStocks.push(stock);
    }
    console.log();

    // 3. 备份和删除最近5个交易日的数据
    console.log('3. 备份和删除最近5个交易日的数据...');
    const backup = [];

    for (const stock of testStocks) {
      // 查找最近5个交易日的数据
      const recentData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
        },
        order: [['time', 'DESC']],
        limit: 5,
      });

      if (recentData.length === 0) {
        console.log(`  警告：股票 ${stock.symbol} 没有找到最近的数据，跳过`);
        continue;
      }

      // 获取日期范围
      const dates = recentData.map(r => r.time);
      const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
      const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));

      console.log(`  ${stock.symbol}: 找到 ${recentData.length} 条最近数据`);
      console.log(`    日期范围: ${minDate.toISOString().split('T')[0]} 到 ${maxDate.toISOString().split('T')[0]}`);

      // 备份数据
      backup.push({
        stockId: stock.id,
        symbol: stock.symbol,
        data: recentData.map(r => ({
          time: r.time,
          open: r.open,
          close: r.close,
        })),
        minDate,
        maxDate,
      });
    }

    if (backup.length === 0) {
      console.log('错误：没有可测试的数据');
      return;
    }

    // 4. 删除数据
    console.log('\n4. 删除数据...');
    let totalDeleted = 0;

    for (const item of backup) {
      const deleted = await DailyBar.destroy({
        where: {
          stockId: item.stockId,
          time: {
            [Op.between]: [item.minDate, item.maxDate]
          }
        }
      });

      totalDeleted += deleted;
      console.log(`  ${item.symbol}: 删除了 ${deleted} 条记录 (${item.minDate.toISOString().split('T')[0]} 到 ${item.maxDate.toISOString().split('T')[0]})`);
    }

    console.log(`总计删除: ${totalDeleted} 条记录\n`);

    if (totalDeleted === 0) {
      console.log('没有数据可删除，跳过同步测试');
      return;
    }

    // 5. 清理队列并触发手动同步
    console.log('5. 准备数据同步...');

    // 清理队列
    try {
      await axios.post(`${API_BASE_URL}/market/clean-queue`);
      console.log('  队列已清理');
    } catch (e) {
      console.log(`  清理队列失败: ${e.message}`);
    }

    // 触发手动同步 - 使用实际日期范围
    console.log('  触发手动同步...');
    let jobId = null;

    // 使用最早的minDate作为开始日期，最晚的maxDate作为结束日期
    const allMinDates = backup.map(item => item.minDate);
    const allMaxDates = backup.map(item => item.maxDate);
    const syncStartDate = new Date(Math.min(...allMinDates.map(d => d.getTime())));
    const syncEndDate = new Date(Math.max(...allMaxDates.map(d => d.getTime())));

    // 格式化为YYYY-MM-DD
    const startDateStr = syncStartDate.toISOString().split('T')[0];
    const endDateStr = syncEndDate.toISOString().split('T')[0];

    console.log(`  同步日期范围: ${startDateStr} 到 ${endDateStr}`);

    try {
      const response = await axios.post(`${API_BASE_URL}/market/manual-sync`, {
        type: 'daily_update',
        force: true,
        startDate: startDateStr,
        endDate: endDateStr,
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

    // 6. 等待同步完成
    console.log('\n6. 等待同步完成（最多3分钟）...');

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

    // 7. 验证数据恢复
    console.log('\n7. 验证数据恢复...');

    let totalRecovered = 0;
    let totalExpected = 0;

    for (const item of backup) {
      const recoveredData = await DailyBar.findAll({
        where: {
          stockId: item.stockId,
          time: {
            [Op.between]: [item.minDate, item.maxDate]
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
      }
    }

    // 8. 显示结果
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

    // 9. 显示最新更新日志
    console.log('\n9. 最新更新日志:');
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