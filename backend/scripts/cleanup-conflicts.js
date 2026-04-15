const { sequelize } = require('../dist/config/database');

async function cleanupConflicts() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 1. 获取所有不带点号的股票（冲突股票）
    const noDotQuery = `
      SELECT id, symbol, name
      FROM stocks
      WHERE symbol NOT LIKE '%.%'
      ORDER BY symbol
    `;
    const noDotStocks = await sequelize.query(noDotQuery, { type: sequelize.QueryTypes.SELECT });

    console.log(`不带点号的股票: ${noDotStocks.length} 只`);

    if (noDotStocks.length === 0) {
      console.log('没有发现不带点号的股票，无需清理。');
      return;
    }

    // 2. 对于每只不带点号的股票，查找对应的带点号股票
    for (const stock of noDotStocks) {
      // 构建带点号的symbol
      let dottedSymbol;
      if (stock.symbol.startsWith('sh') || stock.symbol.startsWith('sz') || stock.symbol.startsWith('bj')) {
        dottedSymbol = stock.symbol.substring(0, 2) + '.' + stock.symbol.substring(2);
      } else {
        console.log(`  跳过 ${stock.symbol}: 无法识别的市场前缀`);
        continue;
      }

      // 查找带点号的股票
      const dottedQuery = `
        SELECT id, symbol, name
        FROM stocks
        WHERE symbol = :symbol
      `;
      const dottedStocks = await sequelize.query(dottedQuery, {
        replacements: { symbol: dottedSymbol },
        type: sequelize.QueryTypes.SELECT
      });

      if (dottedStocks.length === 0) {
        console.log(`  ${stock.symbol}: 未找到对应的带点号股票 ${dottedSymbol}`);
        continue;
      }

      const dottedStock = dottedStocks[0];
      console.log(`\n处理冲突对: ${stock.symbol} (${stock.name}) <-> ${dottedStock.symbol} (${dottedStock.name})`);

      // 3. 检查不带点号股票是否有日线数据
      const checkDataQuery = `
        SELECT COUNT(*) as count
        FROM daily_bars
        WHERE stock_id = :stockId
      `;
      const noDotData = await sequelize.query(checkDataQuery, {
        replacements: { stockId: stock.id },
        type: sequelize.QueryTypes.SELECT
      });
      const noDotDataCount = parseInt(noDotData[0].count);

      // 检查带点号股票是否有日线数据
      const dottedData = await sequelize.query(checkDataQuery, {
        replacements: { stockId: dottedStock.id },
        type: sequelize.QueryTypes.SELECT
      });
      const dottedDataCount = parseInt(dottedData[0].count);

      console.log(`  数据统计: ${stock.symbol}有${noDotDataCount}条数据, ${dottedStock.symbol}有${dottedDataCount}条数据`);

      // 4. 如果数据需要迁移
      if (noDotDataCount > 0 && dottedDataCount === 0) {
        console.log(`  正在迁移数据从 ${stock.symbol} 到 ${dottedStock.symbol}...`);
        const transferQuery = `
          UPDATE daily_bars
          SET stock_id = :newStockId
          WHERE stock_id = :oldStockId
        `;
        await sequelize.query(transferQuery, {
          replacements: { newStockId: dottedStock.id, oldStockId: stock.id },
          type: sequelize.QueryTypes.UPDATE
        });
        console.log(`  数据迁移完成`);
      } else if (noDotDataCount > 0 && dottedDataCount > 0) {
        console.log(`  警告: 两个股票都有数据，删除 ${stock.symbol} 的数据...`);
        const deleteQuery = `
          DELETE FROM daily_bars
          WHERE stock_id = :stockId
        `;
        await sequelize.query(deleteQuery, {
          replacements: { stockId: stock.id },
          type: sequelize.QueryTypes.DELETE
        });
        console.log(`  已删除 ${stock.symbol} 的数据`);
      }

      // 5. 删除不带点号的股票
      console.log(`  删除股票: ${stock.symbol}`);
      const deleteStockQuery = `
        DELETE FROM stocks
        WHERE id = :stockId
      `;
      await sequelize.query(deleteStockQuery, {
        replacements: { stockId: stock.id },
        type: sequelize.QueryTypes.DELETE
      });

      // 6. 更新带点号股票的dataStatus
      const updateStatusQuery = `
        UPDATE stocks
        SET "dataStatus" = 'complete'
        WHERE id = :stockId
      `;
      await sequelize.query(updateStatusQuery, {
        replacements: { stockId: dottedStock.id },
        type: sequelize.QueryTypes.UPDATE
      });
      console.log(`  已更新 ${dottedStock.symbol} 的dataStatus为 'complete'`);
    }

    // 7. 验证清理结果
    console.log('\n=== 清理完成 ===');
    const remainingNoDot = await sequelize.query(noDotQuery, { type: sequelize.QueryTypes.SELECT });
    console.log(`剩余不带点号的股票: ${remainingNoDot.length} 只`);

    if (remainingNoDot.length === 0) {
      console.log('✅ 所有冲突股票已清理完成');
    } else {
      console.log('⚠️  仍有不带点号的股票存在');
      remainingNoDot.forEach(row => {
        console.log(`  ${row.symbol} - ${row.name}`);
      });
    }

  } catch (error) {
    console.error('清理失败:', error);
    console.error('错误详情:', error.message);
  } finally {
    await sequelize.close();
  }
}

cleanupConflicts();