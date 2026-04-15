const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');
const { Op } = require('sequelize');

async function checkDateRange() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (!stock) {
      console.log('Stock not found');
      return;
    }

    console.log(`Stock ID: ${stock.id}`);

    // Total count
    const totalCount = await DailyBar.count({ where: { stockId: stock.id } });
    console.log(`Total daily bars: ${totalCount}`);

    // Count for 2025-04-05 to 2026-04-05
    const startDate = new Date('2025-04-05');
    const endDate = new Date('2026-04-05');

    const rangeCount = await DailyBar.count({
      where: {
        stockId: stock.id,
        time: {
          [Op.between]: [startDate, endDate]
        }
      }
    });

    console.log(`Bars in range 2025-04-05 to 2026-04-05: ${rangeCount}`);

    // Get some bars in this range
    const bars = await DailyBar.findAll({
      where: {
        stockId: stock.id,
        time: {
          [Op.between]: [startDate, endDate]
        }
      },
      order: [['time', 'ASC']],
      limit: 5
    });

    console.log('\nFirst 5 bars in range:');
    bars.forEach((bar, i) => {
      console.log(`${i+1}. ${bar.time.toISOString().split('T')[0]}: open=${bar.open}, close=${bar.close}, volume=${bar.volume}`);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

checkDateRange();