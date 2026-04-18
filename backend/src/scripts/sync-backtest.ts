import { sequelize } from '../config/database';
import { BacktestResult } from '../models/BacktestResult';
import { logger } from '../utils/logger';

async function sync() {
  try {
    await sequelize.authenticate();
    await BacktestResult.sync({ alter: true });
    logger.info('BacktestResult synced.');
    process.exit(0);
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
}
sync();
