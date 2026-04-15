// 简单测试数据同步功能
// 1. 随机选择5支股票（确保有数据）
// 2. 备份并删除它们今天的交易数据
// 3. 触发手动同步
// 4. 验证数据恢复

const axios = require('axios');
const { Sequelize, Op, QueryTypes } = require('sequelize');

// 配置数据库连接
const sequelize = new Sequelize({
  database: 'stock_backtest',
  username: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  dialect: 'postgres',
  logging: console.log,
});

// API配置
const API_BASE_URL = 'http://localhost:3003/api';

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getStocksWithRecentData(limit = 5) {
  // 使用原始SQL查询找到最近有数据的股票
  const sql = `
    SELECT s.id, s.symbol, s.name, COUNT(db.id) as data_count
    FROM stocks s
    JOIN daily_bars db ON s.id = db.stock_id
    WHERE db.time >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY s.id, s.symbol, s.name
    HAVING COUNT(db.id) > 0
    ORDER BY RANDOM()
    LIMIT ?
  `;

  const stocks = await sequelize.query(sql, {
    replacements: [limit],
    type: QueryTypes.SELECT
  });

  return stocks;
}

async function getRecentDataForStock(stockId, days = 7) {
  const data = await sequelize.query(
    `SELECT * FROM daily_bars
     WHERE stock_id = ? AND time >= CURRENT_DATE - INTERVAL '? days'
     ORDER BY time DESC`,
    {
      replacements: [stockId, days],
      type: QueryTypes.SELECT
    }
  );

  return data;
}

async function deleteRecentDataForStock(stockId, days = 7) {
  const result = await sequelize.query(
    `DELETE FROM daily_bars
     WHERE stock_id = ? AND time >= CURRENT_DATE - INTERVAL '? days'
     RETURNING id`,
    {
      replacements: [stockId, days],
      type: QueryTypes.DELETE
    }
  );

  return result[1]; // 删除的行数
}

async function checkDataRecovery(stockId, originalDataCount, days = 7) {
  const recoveredData = await sequelize.query(
    `SELECT COUNT(*) as count FROM daily_bars
     WHERE stock_id = ? AND time >= CURRENT_DATE - INTERVAL '? days'`,
    {
      replacements: [stockId, days],
      type: QueryTypes.SELECT
    }
  );

  return parseInt(recoveredData[0].count);
}

async function triggerManualSync() {
  try {
    const response = await axios.post(`${API_BASE_URL}/market/manual-sync`, {
      type: 'daily_update',
      force: true,
    });

    if (response.data.success) {
      console.log(`手动同步任务已排队: ${response.data.data.jobId}`);
      return response.data.data.jobId;
    } else {
      console.log(`手动同步失败: ${response.data.error}`);
      return null;
    }
  } catch (error) {
    console.log(`触发手动同步失败: ${error.message}`);
    return null;
  }
}

async function waitForSyncCompletion(timeoutSeconds = 180) {
  console.log(`等待数据同步完成，最多等待 ${timeoutSeconds} 秒...`);
  const startTime = Date.now();
  const timeoutMs = timeoutSeconds * 1000;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      if (response.data.success) {
        const queue = response.data.data.queue;
        const activeJobs = queue.active || 0;

        if (activeJobs === 0) {
          console.log('所有任务已完成');
          return true;
        }

        console.log(`仍有 ${activeJobs} 个活动任务...`);
      }
    } catch (error) {
      console.log(`检查状态失败: ${error.message}`);
    }

    await wait(10000); // 每10秒检查一次
  }

  console.log(`等待超时 (${timeoutSeconds} 秒)`);
  return false;
}

async function main() {
  try {
    console.log('=== 简单数据同步测试 ===\n');

    // 1. 查找有最近数据的股票
    console.log('1. 查找最近一周有数据的股票...');
    const stocks = await getStocksWithRecentData(5);

    if (stocks.length === 0) {
      console.log('未找到最近有数据的股票，尝试查找任何有数据的股票...');
      // 查找任何有数据的股票
      const anyStocks = await sequelize.query(
        `SELECT s.id, s.symbol, s.name FROM stocks s
         WHERE EXISTS (SELECT 1 FROM daily_bars db WHERE db.stock_id = s.id LIMIT 1)
         ORDER BY RANDOM() LIMIT 5`,
        { type: QueryTypes.SELECT }
      );

      if (anyStocks.length === 0) {
        console.log('数据库中没有任何股票数据！');
        return;
      }

      stocks.push(...anyStocks);
    }

    console.log(`选择了 ${stocks.length} 支股票:`);
    stocks.forEach((stock, index) => {
      console.log(`  ${index + 1}. ${stock.symbol} - ${stock.name} (ID: ${stock.id})`);
    });
    console.log();

    // 2. 备份数据
    console.log('2. 备份数据...');
    const backup = [];

    for (const stock of stocks) {
      const data = await getRecentDataForStock(stock.id, 3); // 最近3天
      backup.push({
        stockId: stock.id,
        symbol: stock.symbol,
        originalCount: data.length,
        data: data.slice(0, 5), // 只备份前5条，用于验证
      });

      console.log(`  ${stock.symbol}: 备份了 ${data.length} 条最近3天的数据`);
    }
    console.log();

    // 3. 删除数据
    console.log('3. 删除最近3天的数据...');
    let totalDeleted = 0;

    for (const item of backup) {
      if (item.originalCount > 0) {
        const deletedCount = await deleteRecentDataForStock(item.stockId, 3);
        totalDeleted += deletedCount;
        console.log(`  ${item.symbol}: 删除了 ${deletedCount} 条记录`);
      }
    }
    console.log(`总共删除了 ${totalDeleted} 条记录\n`);

    // 4. 触发数据同步
    console.log('4. 触发数据同步...');
    const jobId = await triggerManualSync();

    if (!jobId) {
      console.log('无法触发数据同步，测试终止');
      return;
    }
    console.log();

    // 5. 等待同步完成
    console.log('5. 等待同步完成...');
    const syncCompleted = await waitForSyncCompletion(180);

    if (!syncCompleted) {
      console.log('同步未在预期时间内完成，继续测试...');
    }
    console.log();

    // 6. 验证数据恢复
    console.log('6. 验证数据恢复...');
    let totalRecovered = 0;
    let totalExpected = 0;

    for (const item of backup) {
      const recoveredCount = await checkDataRecovery(item.stockId, item.originalCount, 3);
      totalRecovered += recoveredCount;
      totalExpected += item.originalCount;

      const status = recoveredCount === item.originalCount ? '✅' :
                     recoveredCount > 0 ? '⚠️' : '❌';
      console.log(`  ${status} ${item.symbol}: 恢复了 ${recoveredCount}/${item.originalCount} 条记录`);
    }

    console.log(`\n总计: 恢复了 ${totalRecovered}/${totalExpected} 条记录`);

    // 7. 结果分析
    console.log('\n=== 测试结果 ===');
    if (totalRecovered === totalExpected) {
      console.log('🎉 数据同步功能测试通过！');
    } else if (totalRecovered > totalExpected * 0.5) {
      console.log(`⚠️ 数据同步部分成功，恢复了 ${totalRecovered}/${totalExpected} 条记录 (${Math.round(totalRecovered/totalExpected*100)}%)`);
      console.log('可能原因:');
      console.log('  - 数据源可能没有最新数据');
      console.log('  - 某些日期可能不是交易日');
    } else if (totalRecovered > 0) {
      console.log(`❓ 数据同步效果有限，仅恢复了 ${totalRecovered}/${totalExpected} 条记录`);
    } else {
      console.log('❌ 数据同步功能测试失败！');
      console.log('可能原因:');
      console.log('  - 数据更新任务失败');
      console.log('  - 数据源不可用');
      console.log('  - 数据库连接问题');
    }

    // 8. 检查更新日志
    console.log('\n8. 检查更新日志...');
    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      if (response.data.success) {
        const logs = response.data.data.logs || [];
        if (logs.length > 0) {
          const latestLog = logs[0];
          console.log(`最新日志 ID: ${latestLog.id}`);
          console.log(`状态: ${latestLog.status}`);
          console.log(`类型: ${latestLog.type}`);
          if (latestLog.result) {
            console.log(`结果: ${JSON.stringify(latestLog.result, null, 2)}`);
          }
          if (latestLog.error) {
            console.log(`错误: ${latestLog.error}`);
          }
        }
      }
    } catch (error) {
      console.log(`获取更新日志失败: ${error.message}`);
    }

  } catch (error) {
    console.error('测试失败:', error);
    console.error('堆栈:', error.stack);
  } finally {
    await sequelize.close();
    console.log('\n=== 测试完成 ===');
  }
}

main();