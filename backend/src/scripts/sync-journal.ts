import { sequelize } from '../config/database';
import { TradingJournal } from '../models/TradingJournal';
import { logger } from '../utils/logger';

async function sync() {
  try {
    await sequelize.authenticate();
    await TradingJournal.sync({ alter: true });
    logger.info('TradingJournal synced.');

    // Add mock tags and mood to existing journals
    const journals = await TradingJournal.findAll();
    for (const j of journals) {
      j.tags = ['复盘', '学习'];
      j.mood = '平静';
      await j.save();
    }

    process.exit(0);
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
}
sync();
