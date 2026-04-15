// 使用修复后的AKShare helper进行数据同步测试
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
  timestamps: true,
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

// 测试AKShare helper修复
async function testAKShareHelperFix() {
  console.log('=== 测试AKShare helper修复 ===\n');

  try {
    // 测试几个常见的股票代码
    const testSymbols = [
      'sz.000001',  // 平安银行
      'sh.600000',  // 浦发银行
      'sz.000002',  // 万科A
    ];

    for (const symbol of testSymbols) {
      console.log(`测试 ${symbol}:`);
      try {
        const data = await callAKShare('get_daily_data', symbol, '2024-03-01', '2024-03-05', '2');
        console.log(`  ✅ 成功获取 ${data.length} 条数据`);
        if (data.length > 0) {
          console.log(`     示例: ${data[0].date} 开盘${data[0].open} 收盘${data[0].close}`);
        }
      } catch (error) {
        console.log(`  ❌ 失败: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`测试失败: ${error.message}`);
  }
}

// 从数据库随机选择10支股票
async function selectRandomStocks(count = 10) {
  console.log(`\n从数据库随机选择 ${count} 支股票...`);

  // 查询有数据的股票
  const [stocksWithData] = await sequelize.query(`
    SELECT
      s.id, s.symbol, s.name,
      MIN(db.time) as earliest_date,
      MAX(db.time) as latest_date,
      COUNT(db.time) as data_count
    FROM stocks s
    JOIN daily_bars db ON s.id = db.stock_id
    WHERE EXTRACT(YEAR FROM db.time) = 2024
    GROUP BY s.id, s.symbol, s.name
    HAVING COUNT(db.time) >= 10
    ORDER BY RANDOM()
    LIMIT ${count}
  `);

  if (stocksWithData.length === 0) {
    console.log('没有找到2024年的数据，尝试任意有数据的股票...');

    const [anyStocks] = await sequelize.query(`
      SELECT
        s.id, s.symbol, s.name,
        MIN(db.time) as earliest_date,
        MAX(db.time) as latest_date,
        COUNT(db.time) as data_count
      FROM stocks s
      JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name
      HAVING COUNT(db.time) >= 5
      ORDER BY RANDOM()
      LIMIT ${count}
    `);

    return anyStocks;
  }

  return stocksWithData;
}

// 备份股票最近一周的数据
async function backupRecentData(stocks, days = 7) {
  console.log(`\n备份最近 ${days} 天的数据...`);
  const backup = [];

  for (const stock of stocks) {
    // 计算日期范围：最近days天
    const endDate = new Date('2024-12-31'); // 使用实际存在的日期
    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - days);

    // 查找这个范围内的数据
    const recentData = await DailyBar.findAll({
      where: {
        stockId: stock.id,
        time: {
          [Op.between]: [startDate, endDate]
        }
      },
      order: [['time', 'ASC']],
    });

    if (recentData.length === 0) {
      console.log(`  ${stock.symbol}: 没有找到 ${startDate.toISOString().split('T')[0]} 到 ${endDate.toISOString().split('T')[0]} 的数据`);
      continue;
    }

    console.log(`  ${stock.symbol}: 找到 ${recentData.length} 条数据`);

    backup.push({
      stockId: stock.id,
      symbol: stock.symbol,
      name: stock.name,
      data: recentData.map(r => ({
        time: r.time,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        turnover: r.turnover,
      })),
      startDate,
      endDate,
    });
  }

  return backup;
}

// 删除备份的数据
async function deleteBackupData(backup) {
  console.log('\n删除备份的数据...');
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
  return totalDeleted;
}

// 通过API触发数据同步
async function triggerDataSync(backup) {
  console.log('\n通过API触发数据同步...');

  // 清理队列
  try {
    await axios.post(`${API_BASE_URL}/market/clean-queue`);
    console.log('  队列已清理');
  } catch (e) {
    console.log(`  清理队列失败: ${e.message}`);
  }

  // 计算所有备份数据的日期范围
  const allStartDates = backup.map(item => item.startDate);
  const allEndDates = backup.map(item => item.endDate);
  const syncStartDate = new Date(Math.min(...allStartDates.map(d => d.getTime())));
  const syncEndDate = new Date(Math.max(...allEndDates.map(d => d.getTime())));

  const startDateStr = syncStartDate.toISOString().split('T')[0];
  const endDateStr = syncEndDate.toISOString().split('T')[0];

  console.log(`  同步日期范围: ${startDateStr} 到 ${endDateStr}`);

  let jobId = null;
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
      return jobId;
    } else {
      console.log(`  同步失败: ${response.data.error}`);
      return null;
    }
  } catch (error) {
    console.log(`  触发同步失败: ${error.message}`);
    if (error.response) {
      console.log(`  状态码: ${error.response.status}`);
      console.log(`  响应数据: ${JSON.stringify(error.response.data)}`);
    }
    return null;
  }
}

// 等待同步完成
async function waitForSyncCompletion(jobId, timeoutMinutes = 3) {
  console.log('\n等待同步完成...');

  const checkInterval = 10000; // 10秒
  const maxChecks = (timeoutMinutes * 60 * 1000) / checkInterval;

  let syncCompleted = false;
  let finalStatus = 'unknown';

  for (let i = 0; i < maxChecks; i++) {
    await wait(checkInterval);

    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      if (response.data.success) {
        const queue = response.data.data.queue;
        const activeJobs = queue.active || 0;

        if (activeJobs === 0) {
          syncCompleted = true;
          const logs = response.data.data.logs || [];
          if (logs.length > 0) {
            finalStatus = logs[0].status;
          }
          console.log(`  同步完成，状态: ${finalStatus}`);
          break;
        }
        console.log(`  等待中... (${i+1}/${maxChecks}) - 活动任务: ${activeJobs}`);
      }
    } catch (e) {
      console.log(`  检查状态失败: ${e.message}`);
    }
  }

  return { syncCompleted, finalStatus };
}

// 验证数据恢复
async function verifyDataRecovery(backup) {
  console.log('\n验证数据恢复...');

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
      console.log(`    删除的日期范围: ${item.startDate.toISOString().split('T')[0]} 到 ${item.endDate.toISOString().split('T')[0]}`);
    }
  }

  return { totalRecovered, totalExpected };
}

async function main() {
  console.log('=== 使用修复后的AKShare helper进行数据同步测试 ===\n');

  try {
    // 1. 连接数据库
    console.log('1. 连接数据库...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 测试AKShare helper修复
    await testAKShareHelperFix();

    // 3. 随机选择10支股票
    const testStocks = await selectRandomStocks(10);

    if (testStocks.length === 0) {
      console.log('错误：数据库中没有找到有足够数据的股票');
      return;
    }

    console.log('\n选择的测试股票:');
    for (const stock of testStocks) {
      console.log(`  ${stock.symbol} (${stock.name}):`);
      console.log(`    数据量: ${stock.data_count}`);
      console.log(`    日期范围: ${stock.earliest_date.toISOString().split('T')[0]} 到 ${stock.latest_date.toISOString().split('T')[0]}`);
    }

    // 4. 备份最近一周的数据
    const backup = await backupRecentData(testStocks, 7);

    if (backup.length === 0) {
      console.log('错误：没有可测试的数据');
      return;
    }

    console.log(`\n总共备份了 ${backup.length} 支股票的数据`);

    // 5. 删除备份的数据
    const totalDeleted = await deleteBackupData(backup);

    if (totalDeleted === 0) {
      console.log('没有数据可删除，跳过同步测试');
      return;
    }

    // 6. 通过API触发数据同步
    const jobId = await triggerDataSync(backup);

    if (!jobId) {
      console.log('无法触发同步，跳过等待');
      // 继续验证，可能数据已经存在
    } else {
      // 7. 等待同步完成
      const { syncCompleted, finalStatus } = await waitForSyncCompletion(jobId, 2);
      console.log(`同步完成: ${syncCompleted ? '是' : '否'}, 最终状态: ${finalStatus}`);
    }

    // 8. 验证数据恢复
    const { totalRecovered, totalExpected } = await verifyDataRecovery(backup);

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

    if (totalRecovered === totalExpected && totalExpected > 0) {
      console.log('\n🎉 数据同步测试通过！');
      console.log('说明：');
      console.log('  1. AKShare helper修复成功');
      console.log('  2. 数据备份/删除功能正常');
      console.log('  3. 数据同步API工作正常');
      console.log('  4. 外部数据源可用');
    } else if (totalRecovered > 0) {
      console.log(`\n⚠️ 数据同步部分成功（恢复率: ${((totalRecovered / totalExpected) * 100).toFixed(1)}%）`);
      console.log('可能原因:');
      console.log('  1. 部分日期没有交易数据');
      console.log('  2. 数据源某些股票数据不完整');
      console.log('  3. 网络问题导致部分数据获取失败');
    } else {
      console.log('\n❌ 数据同步测试失败');
      console.log('可能原因:');
      console.log('  1. AKShare数据源不可用');
      console.log('  2. 网络连接问题');
      console.log('  3. Python环境问题');
    }

    // 10. 显示详细恢复情况
    console.log('\n详细恢复情况:');
    for (const item of backup) {
      const recoveredData = await DailyBar.findAll({
        where: {
          stockId: item.stockId,
          time: {
            [Op.between]: [item.startDate, item.endDate]
          }
        }
      });

      const recovered = recoveredData.length;
      const expected = item.data.length;

      if (recovered !== expected) {
        console.log(`  ${item.symbol}: 恢复 ${recovered}/${expected}`);
        if (recovered > 0) {
          console.log(`    恢复的日期: ${recoveredData.map(d => d.time.toISOString().split('T')[0]).join(', ')}`);
        }
      }
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