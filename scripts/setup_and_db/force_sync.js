// Batch W (2026-06-17): 加 ALLOW_FORCE_SYNC guard. 旧脚本 sequelize.sync({alter:true})
// 任何人 node force_sync.js 就 ALTER prod schema, 把 Sequelize 模型与 DB 列不匹配
// 的部分强改, 高风险.
if (process.env.ALLOW_FORCE_SYNC !== 'true') {
  console.error('[SAFE-GUARD] force_sync.js 会调 sequelize.sync({alter:true}) 改 prod schema.');
  console.error('[SAFE-GUARD] 如确认请: ALLOW_FORCE_SYNC=true node force_sync.js');
  process.exit(1);
}

const { sequelize } = require('./dist/config/database');

async function sync() {
  try {
    await sequelize.authenticate();
    console.log('Connection has been established successfully.');
    await sequelize.sync({ force: false, alter: true });
    console.log('Database synced.');
  } catch (error) {
    console.error('Unable to connect to the database:', error);
  } finally {
    await sequelize.close();
  }
}

sync();
