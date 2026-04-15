import { sequelize } from '../src/config/database';
import { Stock } from '../src/models';

async function checkStockCount() {
  try {
    await sequelize.authenticate();
    console.log('Database connected successfully');

    const count = await Stock.count();
    console.log(`Total stocks in database: ${count}`);

    // Also check some sample stocks
    const sampleStocks = await Stock.findAll({
      limit: 5,
      attributes: ['symbol', 'name', 'market', 'isListed']
    });

    console.log('\nSample stocks:');
    sampleStocks.forEach(stock => {
      console.log(`  ${stock.symbol} - ${stock.name} (${stock.market}) - Listed: ${stock.isListed}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('Error checking stock count:', error);
    process.exit(1);
  }
}

checkStockCount();