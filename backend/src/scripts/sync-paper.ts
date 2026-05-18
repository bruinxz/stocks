import { sequelize } from '../config/database';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { logger } from '../utils/logger';

async function sync() {
  try {
    await sequelize.authenticate();
    await PaperTradingSnapshot.sync({ alter: true });
    logger.info('PaperTradingSnapshot synced.');
    process.exit(0);
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
}
sync();
