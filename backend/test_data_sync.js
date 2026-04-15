// 测试数据同步功能
// 1. 随机选择10支股票
// 2. 备份它们最近一周的数据
// 3. 删除这些数据
// 4. 触发数据同步
// 5. 验证数据恢复

const axios = require('axios');
const { Sequelize, Op } = require('sequelize');
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

// 定义模型（简化版）
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

async function main() {
  try {
    console.log('=== 开始测试数据同步功能 ===\n');

    // 1. 测试连接
    console.log('1. 测试数据库连接...');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 2. 随机选择10支股票
    console.log('2. 随机选择10支股票...');
    const stocks = await Stock.findAll({
      order: sequelize.random(),
      limit: 10,
    });

    console.log(`选择了 ${stocks.length} 支股票:`);
    stocks.forEach((stock, index) => {
      console.log(`  ${index + 1}. ${stock.symbol} - ${stock.name}`);
    });
    console.log();

    // 3. 获取最近一周的数据（假设最近7天）
    console.log('3. 获取最近一周的数据...');
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

    const stockDataMap = new Map();

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
    }
    console.log();

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
    fs.writeFileSync('backup_data.json', JSON.stringify(backupData, null, 2));
    console.log(`备份保存到 backup_data.json (${backupData.length} 支股票)`);
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

    // 6. 触发数据同步
    console.log('6. 触发数据同步...');
    try {
      const response = await axios.post(`${API_BASE_URL}/market/update-data`);
      console.log(`API响应: ${response.data.data.message}`);
      console.log(`今日已更新: ${response.data.data.updatedToday}`);
      console.log(`日志ID: ${response.data.data.logId}`);
    } catch (error) {
      console.log(`触发数据同步失败: ${error.message}`);
      if (error.response) {
        console.log(`状态码: ${error.response.status}`);
        console.log(`响应数据: ${JSON.stringify(error.response.data)}`);
      }
    }
    console.log();

    // 7. 等待一段时间让数据同步完成
    console.log('7. 等待10秒让数据同步完成...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log('等待完成\n');

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

      console.log(`  ${backupItem.stock.symbol}: 恢复了 ${recoveredCount}/${expectedCount} 条记录`);
    }

    console.log(`\n总计: 恢复了 ${totalRecovered}/${totalExpected} 条记录`);

    if (totalRecovered === totalExpected) {
      console.log('✅ 数据同步功能测试通过！');
    } else if (totalRecovered > 0) {
      console.log(`⚠️ 数据同步部分成功，恢复了 ${totalRecovered}/${totalExpected} 条记录`);
    } else {
      console.log('❌ 数据同步功能测试失败！');
    }

    // 9. 清理：恢复备份的数据（可选）
    console.log('\n=== 测试完成 ===');

  } catch (error) {
    console.error('测试失败:', error);
  } finally {
    await sequelize.close();
  }
}

main();