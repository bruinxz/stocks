const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');

async function checkBars() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (!stock) {
      console.log('Stock not found');
      return;
    }

    console.log(`Stock ID: ${stock.id}`);

    // Get first 10 bars
    const bars = await DailyBar.findAll({
      where: { stockId: stock.id },
      order: [['time', 'ASC']],
      limit: 10
    });

    console.log('\nFirst 10 daily bars:');
    bars.forEach((bar, i) => {
      console.log(`\n${i+1}. ${bar.time.toISOString().split('T')[0]}:`);
      console.log(`   open=${bar.open}, close=${bar.close}, adjClose=${bar.adjClose}`);
      console.log(`   volume=${bar.volume}, turnover=${bar.turnover}`);
      console.log(`   changePercent=${bar.changePercent}, isTradingDay=${bar.isTradingDay}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

checkBars();