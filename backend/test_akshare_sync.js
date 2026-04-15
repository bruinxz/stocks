// 使用AKShare的数据同步测试
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
  close: { type: Sequelize.DECIMAL(12, 4), allowNull: false },
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

// 测试AKShare是否能获取数据
async function testAKShareDirect() {
  console.log('直接测试AKShare API...\n');

  try {
    // 1. 获取股票列表
    console.log('1. 测试获取股票列表...');
    const stocks = await callAKShare('get_all_stocks');
    console.log(`   获取到 ${stocks.length} 支股票`);
    if (stocks.length > 0) {
      console.log(`   示例: ${stocks[0].code} - ${stocks[0].code_name}`);
    }

    // 2. 测试获取日线数据 - 使用一个常见的股票和实际的日期范围
    console.log('\n2. 测试获取日线数据...');

    // 选择上证指数或一个常见股票
    const testSymbol = 'sh.000001'; // 上证指数
    const endDate = '2024-03-31'; // 使用过去的日期，确保有数据
    const startDate = '2024-03-01'; // 一个月的数据

    console.log(`   测试股票: ${testSymbol}, 日期: ${startDate} 到 ${endDate}`);

    const dailyData = await callAKShare('get_daily_data', testSymbol, startDate, endDate, '3');
    console.log(`   获取到 ${dailyData.length} 条日线数据`);

    if (dailyData.length > 0) {
      console.log('   示例数据:');
      for (let i = 0; i < Math.min(3, dailyData.length); i++) {
        const d = dailyData[i];
        console.log(`     ${d.date}: 开盘${d.open}, 收盘${d.close}, 成交量${d.volume}`);
      }
    }

    return { stocks, dailyData };
  } catch (error) {
    console.error(`AKShare测试失败: ${error.message}`);
    throw error;
  }
}

// 从数据库中选择有数据的股票
async function selectTestStocks() {
  console.log('\n从数据库选择测试股票...');

  // 查询有2024年数据的股票
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
    HAVING COUNT(db.time) >= 20
    ORDER BY RANDOM()
    LIMIT 3
  `);

  if (stocksWithData.length === 0) {
    // 如果没有2024年数据，使用任意有数据的股票
    const [anyStocks] = await sequelize.query(`
      SELECT
        s.id, s.symbol, s.name,
        MIN(db.time) as earliest_date,
        MAX(db.time) as latest_date,
        COUNT(db.time) as data_count
      FROM stocks s
      JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name
      HAVING COUNT(db.time) >= 10
      ORDER BY RANDOM()
      LIMIT 3
    `);

    return anyStocks;
  }

  return stocksWithData;
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== 使用AKShare的数据同步测试 ===\n');

  try {
    // 1. 连接数据库
    console.log('1. 连接数据库...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 直接测试AKShare
    const akShareResult = await testAKShareDirect();
    if (akShareResult.dailyData.length === 0) {
      console.log('\n⚠️ AKShare返回空数据，可能今天不是交易日或数据源有问题');
      console.log('尝试使用数据库中的现有数据进行测试...');
    }

    // 3. 选择测试股票
    const testStocks = await selectTestStocks();

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

    // 4. 备份和删除数据 - 使用实际的日期范围
    console.log('\n4. 备份和删除数据...');
    const backup = [];

    for (const stock of testStocks) {
      // 查找最近3条数据（避免未来日期）
      const recentData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: { [Op.lte]: new Date('2024-12-31') } // 只使用2024年之前的数据
        },
        order: [['time', 'DESC']],
        limit: 3,
      });

      if (recentData.length === 0) {
        console.log(`  警告：股票 ${stock.symbol} 没有找到2024年的数据，跳过`);
        continue;
      }

      // 获取日期范围
      const dates = recentData.map(r => r.time);
      const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
      const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));

      console.log(`  ${stock.symbol}: 找到 ${recentData.length} 条数据`);
      console.log(`    日期范围: ${minDate.toISOString().split('T')[0]} 到 ${maxDate.toISOString().split('T')[0]}`);

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

    // 5. 删除数据
    console.log('\n5. 删除数据...');
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
      console.log(`  ${item.symbol}: 删除了 ${deleted} 条记录`);
    }

    console.log(`总计删除: ${totalDeleted} 条记录\n`);

    if (totalDeleted === 0) {
      console.log('没有数据可删除，跳过同步测试');
      return;
    }

    // 6. 通过API触发同步
    console.log('6. 通过API触发数据同步...');

    // 清理队列
    try {
      await axios.post(`${API_BASE_URL}/market/clean-queue`);
      console.log('  队列已清理');
    } catch (e) {
      console.log(`  清理队列失败: ${e.message}`);
    }

    // 触发手动同步 - 使用实际的日期范围
    const allMinDates = backup.map(item => item.minDate);
    const allMaxDates = backup.map(item => item.maxDate);
    const syncStartDate = new Date(Math.min(...allMinDates.map(d => d.getTime())));
    const syncEndDate = new Date(Math.max(...allMaxDates.map(d => d.getTime())));

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
    console.log('\n7. 等待同步完成...');

    let syncCompleted = false;
    let finalStatus = 'unknown';

    for (let i = 0; i < 12; i++) { // 2分钟
      await wait(10000);

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
            break;
          }
          console.log(`  等待中... (${i+1}/12) - 活动任务: ${activeJobs}`);
        }
      } catch (e) {
        console.log(`  检查状态失败: ${e.message}`);
      }
    }

    // 8. 验证数据恢复
    console.log('\n8. 验证数据恢复...');

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
      console.log('说明AKShare数据源工作正常');
    } else if (totalRecovered > 0) {
      console.log(`\n⚠️ 数据同步部分成功（恢复率: ${((totalRecovered / totalExpected) * 100).toFixed(1)}%）`);
    } else {
      console.log('\n❌ 数据同步测试失败');
      console.log('可能原因:');
      console.log('  - AKShare数据源不可用');
      console.log('  - 网络连接问题');
      console.log('  - Python环境缺少akshare库');
    }

    // 10. 检查最新日志
    console.log('\n10. 检查最新更新日志...');
    try {
      const response = await axios.get(`${API_BASE_URL}/market/update-status`);
      if (response.data.success) {
        const logs = response.data.data.logs || [];
        if (logs.length > 0) {
          const log = logs[0];
          console.log(`  类型: ${log.type}, 状态: ${log.status}, 日期: ${log.date}`);
          if (log.result) {
            console.log(`  结果: ${JSON.stringify(log.result, null, 2)}`);
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