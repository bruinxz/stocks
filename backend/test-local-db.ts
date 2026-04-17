import { DataService } from './src/data/services/DataService';
import { logger } from './src/utils/logger';

async function run() {
  const dataService = new DataService();

  logger.info('Fetching from DataService');
  const bars = await dataService.getDailyBars('sh.600000', new Date('2023-01-01'), new Date('2023-01-10'));
  logger.info(`Got ${bars.length} bars`);
  if (bars.length > 0) {
    logger.info(`First bar: ${JSON.stringify(bars[0])}`);
  }
}

run().catch(console.error);
