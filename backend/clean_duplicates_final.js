const { sequelize } = require('./dist/config/database');
const { Stock } = require('./dist/models');

async function cleanDuplicates() {
  let transaction;
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    // 开始事务
    transaction = await sequelize.transaction();
    console.log('Transaction started');

    // 第一步：识别要删除的重复记录
    console.log('\n=== 识别重复记录 ===');
    const duplicateStats = await sequelize.query(`
      WITH ranked_bars AS (
        SELECT
          time,
          stock_id,
          close,
          ROW_NUMBER() OVER (
            PARTITION BY stock_id, time::date
            ORDER BY
              CASE
                WHEN EXTRACT(HOUR FROM time) = 8 AND EXTRACT(MINUTE FROM time) = 0 THEN 1
                ELSE 2
              END,
              close ASC,  -- 选择价格较低的记录（原始价格）
              time ASC    -- 最后按时间排序
          ) as rn
        FROM daily_bars
      )
      SELECT stock_id, COUNT(*) as total_duplicates
      FROM ranked_bars
      WHERE rn > 1
      GROUP BY stock_id
      ORDER BY total_duplicates DESC;
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log('重复记录统计:');
    duplicateStats.forEach(stat => {
      console.log(`  股票ID ${stat.stock_id}: ${stat.total_duplicates} 条重复记录`);
    });

    // 第二步：删除重复记录
    console.log('\n=== 删除重复记录 ===');
    const deleteResult = await sequelize.query(`
      WITH ranked_bars AS (
        SELECT
          time,
          stock_id,
          ROW_NUMBER() OVER (
            PARTITION BY stock_id, time::date
            ORDER BY
              CASE
                WHEN EXTRACT(HOUR FROM time) = 8 AND EXTRACT(MINUTE FROM time) = 0 THEN 1
                ELSE 2
              END,
              close ASC,  -- 选择价格较低的记录（原始价格）
              time ASC    -- 最后按时间排序
          ) as rn
        FROM daily_bars
      )
      DELETE FROM daily_bars
      WHERE (time, stock_id) IN (
        SELECT time, stock_id
        FROM ranked_bars
        WHERE rn > 1
      )
      RETURNING stock_id, time::date as date;
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    console.log(`已删除 ${deleteResult.length} 条重复记录`);

    // 按股票分组显示
    const byStock = deleteResult.reduce((acc, row) => {
      acc[row.stock_id] = (acc[row.stock_id] || 0) + 1;
      return acc;
    }, {});

    console.log('按股票删除统计:');
    Object.entries(byStock).forEach(([stockId, count]) => {
      console.log(`  股票ID ${stockId}: ${count} 条记录`);
    });

    // 第三步：验证删除后每个股票-日期只有一条记录
    console.log('\n=== 验证删除结果 ===');
    const remainingDuplicates = await sequelize.query(`
      SELECT stock_id, COUNT(*) as remaining_duplicates
      FROM (
        SELECT stock_id, time::date as date
        FROM daily_bars
        GROUP BY stock_id, time::date
        HAVING COUNT(*) > 1
      ) dup_groups
      GROUP BY stock_id;
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    if (remainingDuplicates.length === 0) {
      console.log('✓ 所有重复记录已清理，每个股票-日期只有一条记录');
    } else {
      console.log('✗ 仍有重复记录:');
      remainingDuplicates.forEach(row => {
        console.log(`  股票ID ${row.stock_id}: ${row.remaining_duplicates} 个重复日期`);
      });
    }

    // 第四步：可选 - 标准化时间戳为00:00:00
    console.log('\n=== 标准化时间戳 ===');
    // 首先获取需要更新的记录数
    const countResult = await sequelize.query(`
      SELECT COUNT(*) as count
      FROM daily_bars
      WHERE EXTRACT(HOUR FROM time) != 0
         OR EXTRACT(MINUTE FROM time) != 0
         OR EXTRACT(SECOND FROM time) != 0;
    `, { transaction, type: sequelize.QueryTypes.SELECT });

    const countToUpdate = parseInt(countResult[0].count);

    if (countToUpdate > 0) {
      // 执行更新
      await sequelize.query(`
        UPDATE daily_bars
        SET time = DATE_TRUNC('day', time)
        WHERE EXTRACT(HOUR FROM time) != 0
           OR EXTRACT(MINUTE FROM time) != 0
           OR EXTRACT(SECOND FROM time) != 0;
      `, { transaction });
      console.log(`已标准化 ${countToUpdate} 条记录的时间戳为00:00:00`);
    } else {
      console.log('所有时间戳已标准化');
    }

    // 提交事务
    await transaction.commit();
    console.log('\n✓ 事务提交成功');

    // 最终验证
    console.log('\n=== 最终验证 ===');

    // 检查sh.600000的重复情况
    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (stock) {
      const finalCheck = await sequelize.query(`
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

      if (finalCheck.length === 0) {
        console.log(`✓ 股票 ${stock.symbol} 无重复记录`);

        // 显示一些样本数据
        const sampleBars = await sequelize.query(`
          SELECT time::date as date, open, close, volume
          FROM daily_bars
          WHERE stock_id = :stockId
          ORDER BY time
          LIMIT 5;
        `, {
          replacements: { stockId: stock.id },
          type: sequelize.QueryTypes.SELECT
        });

        console.log('\n样本数据（前5条）:');
        sampleBars.forEach(bar => {
          console.log(`  ${bar.date}: open=${bar.open}, close=${bar.close}, volume=${bar.volume}`);
        });
      } else {
        console.log(`✗ 股票 ${stock.symbol} 仍有 ${finalCheck.length} 个重复日期`);
      }
    }

    console.log('\n✅ 清理完成');

  } catch (error) {
    console.error('❌ 错误:', error);
    if (transaction) {
      try {
        await transaction.rollback();
        console.log('事务已回滚');
      } catch (rollbackError) {
        console.error('回滚失败:', rollbackError);
      }
    }
  } finally {
    await sequelize.close();
  }
}

cleanDuplicates();