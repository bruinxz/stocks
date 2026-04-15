// 最终数据同步测试 - 使用修复后的AKShare helper
const { spawn } = require('child_process');
const path = require('path');
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

// 模型定义（与主项目一致）
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

async function main() {
  console.log('=== 最终数据同步测试 ===\n');
  console.log('目标：验证修复后的AKShare helper和数据同步功能\n');

  try {
    // 1. 连接数据库
    console.log('1. 连接数据库...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 选择测试股票 - 使用已知能工作的常见股票
    console.log('2. 选择测试股票...');
    const testStocks = [
      { symbol: 'sz.000001', name: '平安银行' },
      { symbol: 'sh.600000', name: '浦发银行' },
      { symbol: 'sz.000002', name: '万科A' },
    ];

    // 查找这些股票在数据库中的记录
    const stockSymbols = testStocks.map(s => s.symbol);
    const existingStocks = await Stock.findAll({
      where: { symbol: stockSymbols }
    });

    if (existingStocks.length === 0) {
      console.log('数据库中未找到测试股票，需要先同步股票列表');
      console.log('建议先运行股票列表同步');
      return;
    }

    console.log(`找到 ${existingStocks.length} 支测试股票:`);
    for (const stock of existingStocks) {
      console.log(`  ${stock.symbol} (${stock.name})`);
    }

    // 3. 使用实际的交易日范围（2024年3月的工作日）
    console.log('\n3. 设置测试日期范围...');
    const testDateRange = {
      startDate: '2024-03-01',  // 周五（工作日）
      endDate: '2024-03-07'     // 周四（工作日）
    };
    console.log(`   测试日期范围: ${testDateRange.startDate} 到 ${testDateRange.endDate}`);
    console.log('   这是实际的交易日范围（排除周末）\n');

    // 4. 验证AKShare能获取数据
    console.log('4. 验证AKShare数据源...');
    const startDate = new Date(testDateRange.startDate);
    const endDate = new Date(testDateRange.endDate);

    for (const stock of existingStocks) {
      console.log(`   测试 ${stock.symbol}:`);
      try {
        const data = await callAKShare('get_daily_data', stock.symbol, testDateRange.startDate, testDateRange.endDate, '2');
        console.log(`     ✅ 成功获取 ${data.length} 条数据`);
        if (data.length > 0) {
          console.log(`         示例: ${data[0].date} 开盘${data[0].open} 收盘${data[0].close}`);
        }
      } catch (error) {
        console.log(`     ❌ 失败: ${error.message}`);
      }
    }

    // 5. 备份现有数据（如果存在）
    console.log('\n5. 备份现有数据...');
    const backup = [];

    for (const stock of existingStocks) {
      // 查找这个范围内的现有数据
      const existingData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: {
            [Op.between]: [startDate, endDate]
          }
        },
        order: [['time', 'ASC']],
      });

      if (existingData.length > 0) {
        console.log(`   ${stock.symbol}: 找到 ${existingData.length} 条现有数据`);
        backup.push({
          stockId: stock.id,
          symbol: stock.symbol,
          name: stock.name,
          data: existingData.map(r => ({
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
      } else {
        console.log(`   ${stock.symbol}: 没有现有数据，将测试新数据插入`);
      }
    }

    // 6. 删除现有数据（如果存在）
    console.log('\n6. 删除现有数据...');
    let totalDeleted = 0;

    if (backup.length > 0) {
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
        console.log(`   ${item.symbol}: 删除了 ${deleted} 条记录`);
      }
      console.log(`   总计删除: ${totalDeleted} 条记录`);
    } else {
      console.log('   没有现有数据可删除，直接测试数据插入');
    }

    // 等待一下确保删除完成
    await wait(1000);

    // 7. 通过AKShare获取数据并插入（模拟数据同步）
    console.log('\n7. 通过AKShare获取并插入数据...');
    let totalInserted = 0;
    const insertedDetails = [];

    for (const stock of existingStocks) {
      console.log(`   处理 ${stock.symbol}:`);
      try {
        // 从AKShare获取数据
        const data = await callAKShare('get_daily_data', stock.symbol, testDateRange.startDate, testDateRange.endDate, '2');
        console.log(`     获取到 ${data.length} 条数据`);

        // 插入数据
        let stockInserted = 0;
        for (const bar of data) {
          try {
            // 检查是否已存在
            const existing = await DailyBar.findOne({
              where: {
                stockId: stock.id,
                time: new Date(bar.date),
              }
            });

            if (!existing) {
              // 使用所有必要字段
              await DailyBar.create({
                stockId: stock.id,
                time: new Date(bar.date),
                open: bar.open || 0,
                high: bar.high || Math.max(bar.open || 0, bar.close || 0),
                low: bar.low || Math.min(bar.open || 0, bar.close || 0),
                close: bar.close || 0,
                volume: bar.volume || 0,
                turnover: bar.amount || 0, // amount对应turnover
              });
              stockInserted++;
              totalInserted++;
            }
          } catch (insertError) {
            console.log(`     插入 ${bar.date} 失败: ${insertError.message}`);
          }
        }

        insertedDetails.push({
          symbol: stock.symbol,
          fetched: data.length,
          inserted: stockInserted
        });

        console.log(`     成功插入 ${stockInserted}/${data.length} 条`);
      } catch (error) {
        console.log(`     获取数据失败: ${error.message}`);
        insertedDetails.push({
          symbol: stock.symbol,
          fetched: 0,
          inserted: 0,
          error: error.message
        });
      }
    }

    console.log(`   总计插入: ${totalInserted} 条记录`);

    // 8. 验证数据恢复/插入
    console.log('\n8. 验证数据...');
    let totalExpected = 0;
    let totalRecovered = 0;

    for (const stock of existingStocks) {
      const recoveredData = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: {
            [Op.between]: [startDate, endDate]
          }
        },
        order: [['time', 'ASC']],
      });

      // 计算预期数据量：如果有备份，使用备份数量；否则使用实际插入数量
      const backupItem = backup.find(b => b.symbol === stock.symbol);
      const expected = backupItem ? backupItem.data.length :
                      insertedDetails.find(d => d.symbol === stock.symbol)?.inserted || 0;

      const recovered = recoveredData.length;

      totalExpected += expected;
      totalRecovered += recovered;

      const statusIcon = recovered === expected ? '✅' :
                        recovered > 0 ? '⚠️' : '❌';

      console.log(`   ${statusIcon} ${stock.symbol}: ${recovered}/${expected}`);

      if (recovered > 0) {
        console.log(`      日期: ${recoveredData.map(d => d.time.toISOString().split('T')[0]).join(', ')}`);
      }
    }

    // 9. 显示详细结果
    console.log('\n=== 测试结果 ===');
    console.log(`测试股票数: ${existingStocks.length}`);
    console.log(`测试日期范围: ${testDateRange.startDate} 到 ${testDateRange.endDate}`);

    if (backup.length > 0) {
      console.log(`删除记录数: ${totalDeleted}`);
      console.log(`预期恢复数: ${totalExpected}`);
      console.log(`实际恢复数: ${totalRecovered}`);

      if (totalExpected > 0) {
        const recoveryRate = (totalRecovered / totalExpected) * 100;
        console.log(`恢复率: ${recoveryRate.toFixed(1)}%`);
      }
    } else {
      console.log(`新插入记录数: ${totalInserted}`);
      console.log(`验证存在记录数: ${totalRecovered}`);
    }

    console.log('\n详细情况:');
    for (const detail of insertedDetails) {
      console.log(`   ${detail.symbol}: 获取${detail.fetched}条, 插入${detail.inserted}条`);
      if (detail.error) {
        console.log(`       错误: ${detail.error}`);
      }
    }

    // 10. 结论
    console.log('\n=== 结论 ===');

    if (backup.length > 0) {
      // 恢复测试
      if (totalRecovered === totalExpected && totalExpected > 0) {
        console.log('🎉 数据同步测试通过！');
        console.log('说明：');
        console.log('  1. AKShare helper修复成功');
        console.log('  2. 数据备份/删除功能正常');
        console.log('  3. 数据插入功能正常');
        console.log('  4. 外部数据源工作正常');
      } else if (totalRecovered > 0) {
        console.log(`⚠️ 数据同步部分成功（恢复率: ${((totalRecovered / totalExpected) * 100).toFixed(1)}%）`);
        console.log('可能原因：');
        console.log('  1. 某些日期没有交易数据');
        console.log('  2. 数据源某些字段可能不完整');
      } else {
        console.log('❌ 数据同步测试失败');
      }
    } else {
      // 新数据插入测试
      if (totalInserted > 0 && totalRecovered === totalInserted) {
        console.log('🎉 数据插入测试通过！');
        console.log('说明AKShare数据源能正常工作并插入数据');
      } else if (totalInserted > 0) {
        console.log(`⚠️ 数据插入部分成功（插入${totalInserted}条，验证${totalRecovered}条）`);
      } else {
        console.log('❌ 数据插入测试失败');
      }
    }

    // 11. 检查数据完整性
    console.log('\n=== 数据完整性检查 ===');
    for (const stock of existingStocks) {
      const data = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: {
            [Op.between]: [startDate, endDate]
          }
        },
        limit: 1,
      });

      if (data.length > 0) {
        const record = data[0];
        console.log(`   ${stock.symbol}:`);
        console.log(`     日期: ${record.time.toISOString().split('T')[0]}`);
        console.log(`     价格: ${record.open}/${record.high}/${record.low}/${record.close}`);
        console.log(`     成交量: ${record.volume}`);
      }
    }

  } catch (error) {
    console.error('\n❌ 测试失败:', error.message);
    if (error.stack) {
      console.error('堆栈:', error.stack.split('\n').slice(0, 3).join('\n'));
    }
  } finally {
    await sequelize.close();
    console.log('\n=== 测试完成 ===');
  }
}

main();