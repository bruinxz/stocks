import { sequelize } from '../config/database';
import fs from 'fs';
import path from 'path';

async function addTradeDates() {
  try {
    console.log('正在添加entry_date和exit_date列到trades表...');

    // 读取SQL文件
    const sqlPath = path.join(__dirname, 'add-trade-dates.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // 执行SQL
    await sequelize.query(sql);

    console.log('✅ entry_date和exit_date列添加成功');
  } catch (error) {
    console.error('❌ 添加列失败:', error);
  } finally {
    await sequelize.close();
  }
}

// 执行脚本
addTradeDates();