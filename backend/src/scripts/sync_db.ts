import { sequelize } from '../config/database';
import '../models';

async function sync() {
  await sequelize.authenticate();
  console.log('Syncing database...');
  await sequelize.sync({ alter: true });
  console.log('Database synced!');
  process.exit(0);
}

sync().catch(console.error);
