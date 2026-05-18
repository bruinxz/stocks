import { sequelize } from '../config/database';
import { User } from '../models/User';
import { logger } from '../utils/logger';

async function sync() {
  try {
    await sequelize.authenticate();
    await User.sync({ alter: true });
    logger.info('User synced.');
    process.exit(0);
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
}
sync();
