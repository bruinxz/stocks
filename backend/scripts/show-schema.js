const { sequelize } = require('../dist/config/database');

async function showSchema() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 获取所有表
    const tablesQuery = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tables = await sequelize.query(tablesQuery, { type: sequelize.QueryTypes.SELECT });

    console.log('📊 数据库表结构\n');

    for (const table of tables) {
      const tableName = table.table_name;

      // 获取表信息
      const columnsQuery = `
        SELECT
          column_name,
          data_type,
          is_nullable,
          column_default
        FROM information_schema.columns
        WHERE table_name = :tableName
        ORDER BY ordinal_position
      `;
      const columns = await sequelize.query(columnsQuery, {
        replacements: { tableName: tableName },
        type: sequelize.QueryTypes.SELECT
      });

      console.log(`=== ${tableName.toUpperCase()} ===`);
      console.log('字段名'.padEnd(25) + '类型'.padEnd(25) + '可为空'.padEnd(10) + '默认值');
      console.log('-'.repeat(80));

      columns.forEach(col => {
        const name = col.column_name.padEnd(25);
        const type = col.data_type.padEnd(25);
        const nullable = col.is_nullable.padEnd(10);
        const defaultValue = col.column_default || '(无)';
        console.log(`${name}${type}${nullable}${defaultValue}`);
      });

      // 获取索引信息
      const indexesQuery = `
        SELECT
          indexname,
          indexdef
        FROM pg_indexes
        WHERE tablename = :tableName
          AND schemaname = 'public'
        ORDER BY indexname
      `;
      const indexes = await sequelize.query(indexesQuery, {
        replacements: { tableName: tableName },
        type: sequelize.QueryTypes.SELECT
      });

      if (indexes.length > 0) {
        console.log('\n索引:');
        indexes.forEach(idx => {
          console.log(`  ${idx.indexname}`);
          // 简化索引定义，移除多余的括号
          const simpleDef = idx.indexdef.replace(/CREATE\s+(UNIQUE\s+)?INDEX\s+\w+\s+ON\s+\w+\s+USING\s+\w+\s+/i, '');
          console.log(`    ${simpleDef}`);
        });
      }

      // 获取外键信息
      const foreignKeysQuery = `
        SELECT
          tc.constraint_name,
          kcu.column_name,
          ccu.table_name AS foreign_table_name,
          ccu.column_name AS foreign_column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = :tableName
          AND tc.constraint_type = 'FOREIGN KEY'
        ORDER BY tc.constraint_name
      `;
      const foreignKeys = await sequelize.query(foreignKeysQuery, {
        replacements: { tableName: tableName },
        type: sequelize.QueryTypes.SELECT
      });

      if (foreignKeys.length > 0) {
        console.log('\n外键约束:');
        foreignKeys.forEach(fk => {
          console.log(`  ${fk.constraint_name}:`);
          console.log(`    ${tableName}.${fk.column_name} → ${fk.foreign_table_name}.${fk.foreign_column_name}`);
        });
      }

      console.log('\n');
    }

    // 表统计
    console.log('📈 表统计信息\n');
    for (const table of tables) {
      const tableName = table.table_name;
      const countQuery = `SELECT COUNT(*) as count FROM ${tableName}`;
      try {
        const countResult = await sequelize.query(countQuery, { type: sequelize.QueryTypes.SELECT });
        const count = countResult[0].count;
        console.log(`  ${tableName}: ${count} 条记录`);
      } catch (error) {
        console.log(`  ${tableName}: (无法获取记录数)`);
      }
    }

    // stocks表详细统计
    console.log('\n📊 STOCKS表详细统计\n');

    // dataStatus分布
    const statusQuery = `SELECT "dataStatus", COUNT(*) as count FROM stocks GROUP BY "dataStatus" ORDER BY "dataStatus"`;
    const statusStats = await sequelize.query(statusQuery, { type: sequelize.QueryTypes.SELECT });

    console.log('dataStatus分布:');
    statusStats.forEach(stat => {
      const status = stat.dataStatus || '(空)';
      console.log(`  ${status}: ${stat.count} 只股票`);
    });

    // 市场分布
    const marketQuery = `
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他'
        END as market,
        COUNT(*) as count
      FROM stocks
      GROUP BY
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他'
        END
      ORDER BY count DESC
    `;
    const marketStats = await sequelize.query(marketQuery, { type: sequelize.QueryTypes.SELECT });

    console.log('\n市场分布:');
    marketStats.forEach(stat => {
      console.log(`  ${stat.market}: ${stat.count} 只股票`);
    });

  } catch (error) {
    console.error('获取schema失败:', error);
    console.error('错误详情:', error.message);
  } finally {
    await sequelize.close();
  }
}

showSchema();