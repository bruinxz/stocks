const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');
const { Op } = require('sequelize');

async function checkAdjClose() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (!stock) return;

    // Get duplicate dates
    const bars = await DailyBar.findAll({
      where: {
        stockId: stock.id,
        time: {
          [Op.between]: [new Date('2025-04-05'), new Date('2026-04-05')]
        }
      },
      order: [['time', 'ASC']],
      limit: 20
    });

    const dateMap = {};
    bars.forEach(bar => {
      const dateStr = bar.time.toISOString().split('T')[0];
      if (!dateMap[dateStr]) dateMap[dateStr] = [];
      dateMap[dateStr].push(bar);
    });

    console.log('Duplicate dates found:');
    Object.keys(dateMap).forEach(date => {
      const barsForDate = dateMap[date];
      if (barsForDate.length > 1) {
        console.log(`\n${date}: ${barsForDate.length} records`);
        barsForDate.forEach((bar, i) => {
          console.log(`  ${i+1}: open=${bar.open}, close=${bar.close}, adjClose=${bar.adjClose}, volume=${bar.volume}, adjustflag=${bar.adjustflag}`);
        });
      }
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

checkAdjClose();