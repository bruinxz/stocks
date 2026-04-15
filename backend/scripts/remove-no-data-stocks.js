const { sequelize } = require('../dist/config/database');

async function removeNoDataStocks() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 1. 获取总股票数
    const totalQuery = 'SELECT COUNT(*) as total FROM stocks';
    const totalResult = await sequelize.query(totalQuery, { type: sequelize.QueryTypes.SELECT });
    const totalStocks = parseInt(totalResult[0].total);
    console.log(`总股票数: ${totalStocks}`);

    // 2. 获取无日线数据的股票
    const noDataQuery = `
      SELECT s.id, s.symbol, s.name, s."listingDate"
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
      ORDER BY s.symbol
    `;
    const noDataStocks = await sequelize.query(noDataQuery, { type: sequelize.QueryTypes.SELECT });

    console.log(`无日线数据的股票: ${noDataStocks.length} 只 (${(noDataStocks.length/totalStocks*100).toFixed(2)}%)`);

    if (noDataStocks.length === 0) {
      console.log('没有发现无数据的股票。');
      return;
    }

    // 3. 显示示例
    console.log('\n无数据股票示例 (前20只):');
    noDataStocks.slice(0, 20).forEach((stock, i) => {
      console.log(`  ${i+1}. ${stock.symbol} - ${stock.name} (上市: ${stock.listingDate || '未知'})`);
    });

    // 4. 确认删除
    console.log(`\n⚠️  即将删除 ${noDataStocks.length} 只无数据股票。`);
    console.log('这些股票可能已退市或数据源中不存在。');
    console.log('按 Ctrl+C 取消，或等待5秒后继续...');

    // 等待5秒
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 5. 批量删除（使用更高效的方式）
    console.log('\n正在删除无数据股票...');

    // 方法1：使用子查询一次性删除（更高效）
    const deleteQuery = `
      DELETE FROM stocks
      WHERE id IN (
        SELECT s.id
        FROM stocks s
        LEFT JOIN daily_bars db ON s.id = db.stock_id
        WHERE db.time IS NULL
      )
    `;

    const deleteResult = await sequelize.query(deleteQuery, { type: sequelize.QueryTypes.DELETE });
    console.log(`✅ 已删除 ${noDataStocks.length} 只无数据股票`);

    // 6. 验证删除结果
    const remainingTotal = await sequelize.query(totalQuery, { type: sequelize.QueryTypes.SELECT });
    const newTotal = parseInt(remainingTotal[0].total);
    console.log(`\n删除后总股票数: ${newTotal}`);
    console.log(`减少了 ${totalStocks - newTotal} 只股票`);

    // 7. 检查剩余的无数据股票
    const remainingNoData = await sequelize.query(noDataQuery, { type: sequelize.QueryTypes.SELECT });
    console.log(`剩余无数据股票: ${remainingNoData.length} 只`);

    if (remainingNoData.length > 0) {
      console.log('警告: 仍有未删除的无数据股票:');
      remainingNoData.slice(0, 10).forEach(stock => {
        console.log(`  ${stock.symbol} - ${stock.name}`);
      });
    }

    // 8. 更新有数据股票的dataStatus为'complete'
    console.log('\n正在更新有数据股票的dataStatus...');
    const updateQuery = `
      UPDATE stocks
      SET "dataStatus" = 'complete'
      WHERE id IN (
        SELECT DISTINCT stock_id
        FROM daily_bars
      )
    `;
    const updateResult = await sequelize.query(updateQuery, { type: sequelize.QueryTypes.UPDATE });
    console.log(`✅ 已更新有数据股票的dataStatus为'complete'`);

    // 9. 统计dataStatus分布
    const statusQuery = `
      SELECT "dataStatus", COUNT(*) as count
      FROM stocks
      GROUP BY "dataStatus"
      ORDER BY "dataStatus"
    `;
    const statusStats = await sequelize.query(statusQuery, { type: sequelize.QueryTypes.SELECT });

    console.log('\ndataStatus分布:');
    statusStats.forEach(stat => {
      const status = stat.dataStatus || '(空)';
      console.log(`  ${status}: ${stat.count} 只`);
    });

  } catch (error) {
    console.error('操作失败:', error);
    console.error('错误详情:', error.message);
  } finally {
    await sequelize.close();
  }
}

removeNoDataStocks();