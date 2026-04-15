// 聚焦测试数据同步功能
// 选择一支股票，删除最近7天的数据，然后手动同步该股票，验证恢复

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
  console.log('=== 聚焦数据同步功能测试 ===\n');

  try {
    // 1. 连接数据库
    await sequelize.authenticate();
    console.log('1. 数据库连接成功\n');

    // 2. 查找一支最近7天有数据的股票
    console.log('2. 查找最近7天有数据的股票...');

    // 使用原始SQL查询找到最近7天有数据的股票
    const sql = `
      SELECT s.id, s.symbol, s.name, COUNT(*) as data_count
      FROM stocks s
      JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY s.id, s.symbol, s.name
      HAVING COUNT(*) >= 3  -- 至少有3天数据
      ORDER BY RANDOM()
      LIMIT 1
    `;

    const stocks = await sequelize.query(sql, {
      type: sequelize.QueryTypes.SELECT
    });

    if (stocks.length === 0) {
      console.log('错误：最近7天没有找到有数据的股票！');
      return;
    }

    const targetStock = stocks[0];
    console.log(`选择的股票: ${targetStock.symbol} - ${targetStock.name} (ID: ${targetStock.id})`);
    console.log(`最近7天数据条数: ${targetStock.data_count}\n`);

    // 3. 获取最近7天的详细数据
    console.log('3. 获取最近7天的详细数据...');
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentData = await DailyBar.findAll({
      where: {
        stockId: targetStock.id,
        time: { [Op.gte]: sevenDaysAgo }
      },
      order: [['time', 'DESC']],
    });

    console.log(`  找到 ${recentData.length} 条记录`);

    if (recentData.length === 0) {
      console.log('错误：该股票最近7天没有数据！');
      return;
    }

    // 显示数据日期范围
    const dates = recentData.map(r => r.time.toISOString().split('T')[0]);
    console.log(`  日期范围: ${dates[dates.length-1]} 至 ${dates[0]}\n`);

    // 4. 备份数据
    console.log('4. 备份数据...');
    const backup = recentData.map(r => ({
      time: r.time,
      open: r.open,
      close: r.close,
    }));

    console.log(`  备份了 ${backup.length} 条记录\n`);

    // 5. 删除最近7天的数据
    console.log('5. 删除最近7天的数据...');
    const deletedCount = await DailyBar.destroy({
      where: {
        stockId: targetStock.id,
        time: { [Op.gte]: sevenDaysAgo }
      }
    });

    console.log(`  删除了 ${deletedCount} 条记录\n`);

    // 6. 验证数据已删除
    console.log('6. 验证数据已删除...');
    const afterDelete = await DailyBar.findAll({
      where: {
        stockId: targetStock.id,
        time: { [Op.gte]: sevenDaysAgo }
      }
    });

    console.log(`  删除后剩余记录: ${afterDelete.length}`);
    if (afterDelete.length > 0) {
      console.log('  警告：数据未完全删除！');
    }
    console.log();

    // 7. 清理队列并触发手动同步
    console.log('7. 准备数据同步...');

    // 清理队列
    try {
      await axios.post(`${API_BASE_URL}/market/clean-queue`);
      console.log('  队列已清理');
    } catch (e) {
      console.log(`  清理队列失败: ${e.message}`);
    }

    // 触发手动同步（daily_update类型）
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
        console.log(`  响应状态: ${error.response.status}`);
        console.log(`  响应数据: ${JSON.stringify(error.response.data)}`);
      }
    }

    // 8. 等待同步完成
    console.log('\n8. 等待同步完成（最多3分钟）...');

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
    console.log();

    // 9. 验证数据恢复
    console.log('9. 验证数据恢复...');

    const recoveredData = await DailyBar.findAll({
      where: {
        stockId: targetStock.id,
        time: { [Op.gte]: sevenDaysAgo }
      },
      order: [['time', 'DESC']],
    });

    const recoveredCount = recoveredData.length;
    const expectedCount = backup.length;

    console.log(`  预期恢复: ${expectedCount} 条记录`);
    console.log(`  实际恢复: ${recoveredCount} 条记录`);

    if (recoveredCount === expectedCount) {
      console.log('  ✅ 数据完全恢复！');
    } else if (recoveredCount > 0) {
      console.log(`  ⚠️ 数据部分恢复 (${recoveredCount}/${expectedCount})`);
    } else {
      console.log('  ❌ 数据未恢复');
    }
    console.log();

    // 10. 显示详细结果
    console.log('=== 测试结果 ===');
    console.log(`测试股票: ${targetStock.symbol} - ${targetStock.name}`);
    console.log(`删除记录数: ${deletedCount}`);
    console.log(`预期恢复数: ${expectedCount}`);
    console.log(`实际恢复数: ${recoveredCount}`);

    if (expectedCount > 0) {
      const recoveryRate = (recoveredCount / expectedCount) * 100;
      console.log(`恢复率: ${recoveryRate.toFixed(1)}%`);
    }

    console.log(`同步完成: ${syncCompleted ? '是' : '否'}`);
    console.log(`最终状态: ${finalStatus}`);

    if (finalResult) {
      console.log(`同步结果: ${JSON.stringify(finalResult, null, 2)}`);
    }

    if (recoveredCount === expectedCount && expectedCount > 0) {
      console.log('\n🎉 数据同步测试通过！');
    } else if (recoveredCount > 0) {
      console.log(`\n⚠️ 数据同步部分成功`);
    } else {
      console.log('\n❌ 数据同步测试失败');
      console.log('可能原因:');
      console.log('  - 数据源不可用 (Baostock)');
      console.log('  - 数据更新任务失败');
      console.log('  - 测试期间没有新数据');
      console.log('  - 股票可能已被退市或停牌');
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