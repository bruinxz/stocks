// 最终版数据同步测试
// 简单直接地测试数据同步功能

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
  console.log('=== 数据同步功能测试 ===\n');

  try {
    // 1. 连接数据库
    await sequelize.authenticate();
    console.log('1. 数据库连接成功\n');

    // 2. 选择3支股票（简单起见）
    console.log('2. 随机选择3支股票...');
    const stocks = await Stock.findAll({
      order: sequelize.random(),
      limit: 3,
    });

    if (stocks.length === 0) {
      console.log('错误：数据库中没有股票！');
      return;
    }

    console.log('选择的股票:');
    stocks.forEach((s, i) => console.log(`  ${i+1}. ${s.symbol} - ${s.name}`));
    console.log();

    // 3. 检查并备份最近3天的数据
    console.log('3. 检查最近3天的数据...');
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

    const backup = [];

    for (const stock of stocks) {
      const recentData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: { [Op.gte]: threeDaysAgo }
        },
        order: [['time', 'DESC']],
        limit: 3 // 最多3条
      });

      console.log(`  ${stock.symbol}: 找到 ${recentData.length} 条最近3天的数据`);

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
      }
    }

    if (backup.length === 0) {
      console.log('警告：没有找到最近3天的数据，测试可能不准确\n');
      // 继续测试，但期望可能为0
    }

    // 4. 删除数据
    console.log('\n4. 删除数据...');
    let totalDeleted = 0;

    for (const item of backup) {
      const deleted = await DailyBar.destroy({
        where: {
          stockId: item.stockId,
          time: { [Op.gte]: threeDaysAgo }
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

    // 5. 清理队列并触发手动同步
    console.log('5. 准备数据同步...');

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
    }

    // 6. 等待同步完成
    console.log('\n6. 等待同步完成（最多2分钟）...');

    let syncCompleted = false;
    let finalStatus = 'unknown';

    for (let i = 0; i < 12; i++) { // 12 * 10秒 = 2分钟
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
              finalStatus = logs[0].status;
              console.log(`  同步状态: ${finalStatus}`);
            }
            break;
          }

          console.log(`  等待中... (${i+1}/12) - 活动任务: ${activeJobs}`);
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
          time: { [Op.gte]: threeDaysAgo }
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

    // 8. 显示结果
    console.log('\n=== 测试结果 ===');
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
      console.log(`\n⚠️ 数据同步部分成功`);
    } else {
      console.log('\n❌ 数据同步测试失败');
      console.log('可能原因:');
      console.log('  - 数据源不可用');
      console.log('  - 数据更新任务失败');
      console.log('  - 测试期间没有新数据');
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