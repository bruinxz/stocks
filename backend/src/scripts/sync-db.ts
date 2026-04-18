import { sequelize } from '../config/database';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { logger } from '../utils/logger';

async function sync() {
  try {
    await sequelize.authenticate();
    logger.info('Database connected.');
    await PaperTradingTrade.sync({ alter: true });
    await PaperTradingPortfolio.sync({ alter: true });
    logger.info('Models synced.');
    process.exit(0);
  } catch (e) {
    logger.error('Error syncing:', e);
    process.exit(1);
  }
}
sync();
