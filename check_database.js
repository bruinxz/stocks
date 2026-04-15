#!/usr/bin/env node
/**
 * 检查数据库中的数据状态
 */

async function checkDatabase() {
  try {
    const { sequelize } = require('./backend/dist/config/database');
    const { Stock, DailyBar } = require('./backend/dist/models');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 检查股票数量
    const stockCount = await Stock.count();
    console.log(`\n1. 股票总数: ${stockCount}`);

    // 2. 检查平安银行
    const pingan = await Stock.findOne({
      where: { symbol: 'sz.000001' },
      attributes: ['id', 'symbol', 'name', 'market', 'isListed']
    });

    if (!pingan) {
      console.log('平安银行(sz.000001)不存在');
      return;
    }

    console.log(`\n2. 平安银行信息:`);
    console.log(`   ID: ${pingan.id}, 代码: ${pingan.symbol}, 名称: ${pingan.name}`);

    // 3. 检查平安银行的日线数据
    const barCount = await DailyBar.count({ where: { stockId: pingan.id } });
    console.log(`\n3. 平安银行日线数据总数: ${barCount}`);

    // 4. 检查最近的10条数据
    const recentBars = await DailyBar.findAll({
      where: { stockId: pingan.id },
      order: [['time', 'DESC']],
      limit: 10,
      attributes: ['time', 'open', 'high', 'low', 'close', 'volume']
    });

    console.log(`\n4. 平安银行最近10条数据:`);
    recentBars.forEach(bar => {
      const date = bar.time.toISOString().split('T')[0];
      console.log(`   ${date}: 开${bar.open.toFixed(2)} 高${bar.high.toFixed(2)} 低${bar.low.toFixed(2)} 收${bar.close.toFixed(2)} 量${bar.volume}`);
    });

    // 5. 检查特定日期是否存在（2026-04-07）
    const checkDate = new Date('2026-04-07');
    const exists = await DailyBar.findOne({
      where: {
        stockId: pingan.id,
        time: checkDate
      }
    });

    console.log(`\n5. 2026-04-07数据是否存在: ${exists ? '是' : '否'}`);

    // 6. 检查整个数据库的最新数据日期
    const latestBarOverall = await DailyBar.findOne({
      order: [['time', 'DESC']],
      limit: 1,
      include: [{ model: Stock, attributes: ['symbol', 'name'] }]
    });

    if (latestBarOverall) {
      const date = latestBarOverall.time.toISOString().split('T')[0];
      console.log(`\n6. 全库最新数据:`);
      console.log(`   股票: ${latestBarOverall.Stock.symbol} - ${latestBarOverall.Stock.name}`);
      console.log(`   日期: ${date}`);
      console.log(`   价格: ${latestBarOverall.close.toFixed(2)}`);
    }

    // 7. 检查数据更新日志
    try {
      const { DataUpdateLog } = require('./backend/dist/models/DataUpdateLog');
      const logs = await DataUpdateLog.findAll({
        order: [['createdAt', 'DESC']],
        limit: 5,
        attributes: ['id', 'type', 'status', 'date', 'affectedStocks', 'insertedRecords', 'createdAt']
      });

      console.log(`\n7. 最近5次数据更新日志:`);
      logs.forEach(log => {
        console.log(`   ${log.createdAt.toISOString().split('T')[0]} - ${log.type}: ${log.status}, 影响股票: ${log.affectedStocks}, 插入记录: ${log.insertedRecords}`);
      });
    } catch (error) {
      console.log(`\n7. 数据更新日志表可能不存在: ${error.message}`);
    }

  } catch (error) {
    console.error(`检查数据库失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
  }
}

checkDatabase().catch(console.error);