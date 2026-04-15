const { sequelize } = require('../dist/config/database');

async function addDataStatusColumn() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 检查dataStatus列是否存在
    const checkColumnQuery = `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'stocks' AND column_name = 'dataStatus'
    `;
    const columnExists = await sequelize.query(checkColumnQuery, { type: sequelize.QueryTypes.SELECT });

    if (columnExists.length > 0) {
      console.log('✅ dataStatus列已存在');
    } else {
      console.log('正在添加dataStatus列...');
      const addColumnQuery = `
        ALTER TABLE stocks
        ADD COLUMN "dataStatus" VARCHAR(20)
      `;
      await sequelize.query(addColumnQuery);
      console.log('✅ dataStatus列添加成功');
    }

    // 显示当前列信息
    const columnsQuery = `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'stocks'
      ORDER BY ordinal_position
    `;
    const columns = await sequelize.query(columnsQuery, { type: sequelize.QueryTypes.SELECT });

    console.log('\nstocks表当前列结构:');
    console.log('='.repeat(50));
    columns.forEach(col => {
      console.log(`  ${col.column_name.padEnd(20)} ${col.data_type.padEnd(20)} ${col.is_nullable}`);
    });

  } catch (error) {
    console.error('操作失败:', error);
    console.error('错误详情:', error.message);
  } finally {
    await sequelize.close();
  }
}

addDataStatusColumn();