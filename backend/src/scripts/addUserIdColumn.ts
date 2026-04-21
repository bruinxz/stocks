import { sequelize } from '../config/database';
import fs from 'fs';
import path from 'path';

async function addUserIdColumn() {
  try {
    console.log('正在添加user_id列到backtest_results表...');

    // 读取SQL文件
    const sqlPath = path.join(__dirname, 'add-user-id-to-backtest.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    // 执行SQL
    await sequelize.query(sql);

    console.log('✅ user_id列添加成功');
  } catch (error) {
    console.error('❌ 添加user_id列失败:', error);
  } finally {
    await sequelize.close();
  }
}

// 执行脚本
addUserIdColumn();
