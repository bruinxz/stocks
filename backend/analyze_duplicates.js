const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');
const { Op } = require('sequelize');

async function analyzeDuplicates() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    // 检查表结构
    console.log('\n=== 检查daily_bars表结构 ===');
    const tableInfo = await sequelize.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'daily_bars'
      ORDER BY ordinal_position;
    `);
    console.log('表列信息:');
    tableInfo[0].forEach(col => {
      console.log(`  ${col.column_name}: ${col.data_type} ${col.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    });

    // 检查约束和索引
    console.log('\n=== 检查约束和索引 ===');
    const constraints = await sequelize.query(`
      SELECT conname, contype, conkey, pg_get_constraintdef(c.oid) as definition
      FROM pg_constraint c
      JOIN pg_class t ON c.conrelid = t.oid
      WHERE t.relname = 'daily_bars';
    `);
    console.log('约束:');
    constraints[0].forEach(constraint => {
      console.log(`  ${constraint.conname}: ${constraint.contype} - ${constraint.definition}`);
    });

    const indexes = await sequelize.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'daily_bars';
    `);
    console.log('索引:');
    indexes[0].forEach(index => {
      console.log(`  ${index.indexname}: ${index.indexdef}`);
    });

    // 检查sh.600000的重复情况
    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (!stock) {
      console.log('Stock sh.600000 not found');
      return;
    }

    console.log(`\n=== 分析股票 ${stock.symbol} (ID: ${stock.id}) 的重复数据 ===`);

    // 查找重复日期
    const duplicateDates = await sequelize.query(`
      SELECT time::date as date, COUNT(*) as count
      FROM daily_bars
      WHERE stock_id = :stockId
      GROUP BY time::date
      HAVING COUNT(*) > 1
      ORDER BY date;
    `, {
      replacements: { stockId: stock.id },
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`发现 ${duplicateDates.length} 个有重复记录的日期`);

    if (duplicateDates.length > 0) {
      console.log('\n重复日期列表:');
      duplicateDates.slice(0, 10).forEach(row => {
        console.log(`  ${row.date}: ${row.count} 条记录`);
      });

      if (duplicateDates.length > 10) {
        console.log(`  ... 还有 ${duplicateDates.length - 10} 个日期`);
      }

      // 查看第一个重复日期的详细记录
      const sampleDate = duplicateDates[0].date;
      console.log(`\n=== 示例日期 ${sampleDate} 的详细记录 ===`);

      const bars = await DailyBar.findAll({
        where: {
          stockId: stock.id,
          time: {
            [Op.between]: [new Date(sampleDate), new Date(sampleDate + 'T23:59:59')]
          }
        },
        order: [['time', 'ASC']]
      });

      bars.forEach((bar, i) => {
        console.log(`\n记录 ${i+1}:`);
        console.log(`  ID: ${bar.id}`);
        console.log(`  时间: ${bar.time}`);
        console.log(`  价格: open=${bar.open}, close=${bar.close}, adjClose=${bar.adjClose}`);
        console.log(`  成交量: ${bar.volume}`);
        console.log(`  成交额: ${bar.turnover}`);
        console.log(`  涨跌幅: ${bar.changePercent}%`);
        console.log(`  CreatedAt: ${bar.createdAt}`);
      });

      // 检查数据差异
      console.log('\n=== 数据差异分析 ===');
      if (bars.length >= 2) {
        const bar1 = bars[0];
        const bar2 = bars[1];

        console.log(`价格比例 (bar2/bar1): ${(bar2.close / bar1.close).toFixed(4)}`);
        console.log(`成交量比例 (bar2/bar1): ${(bar2.volume / bar1.volume).toFixed(4)}`);

        // 检查是否是复权数据
        if (bar1.adjClose && bar2.adjClose) {
          console.log(`复权收盘价比例 (bar2/bar1): ${(bar2.adjClose / bar1.adjClose).toFixed(4)}`);
        }
      }
    }

    // 检查所有股票的重复情况
    console.log('\n=== 所有股票重复统计 ===');
    const allDuplicates = await sequelize.query(`
      SELECT s.symbol, COUNT(DISTINCT db.time::date) as duplicate_dates
      FROM daily_bars db
      JOIN stocks s ON s.id = db.stock_id
      WHERE db.time::date IN (
        SELECT time::date
        FROM daily_bars
        WHERE stock_id = db.stock_id
        GROUP BY time::date
        HAVING COUNT(*) > 1
      )
      GROUP BY s.symbol
      ORDER BY duplicate_dates DESC
      LIMIT 20;
    `, { type: sequelize.QueryTypes.SELECT });

    console.log(`有重复数据的股票数量: ${allDuplicates.length}`);
    if (allDuplicates.length > 0) {
      console.log('重复最多的股票:');
      allDuplicates.forEach(row => {
        console.log(`  ${row.symbol}: ${row.duplicate_dates} 个重复日期`);
      });
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

analyzeDuplicates();