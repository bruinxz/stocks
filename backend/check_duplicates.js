const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');

async function checkDuplicates() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    // Find sh.600000 stock
    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (!stock) {
      console.log('Stock not found');
      return;
    }

    console.log(`Stock ID: ${stock.id}`);

    // Check for duplicate daily bars
    const bars = await DailyBar.findAll({
      where: { stockId: stock.id },
      order: [['time', 'ASC']],
      limit: 100
    });

    console.log(`Total bars: ${bars.length}`);

    const dateMap = {};
    bars.forEach(bar => {
      const dateStr = bar.time.toISOString().split('T')[0];
      if (!dateMap[dateStr]) {
        dateMap[dateStr] = [];
      }
      dateMap[dateStr].push(bar);
    });

    console.log('\nDate groups:');
    Object.keys(dateMap).forEach(date => {
      const barsForDate = dateMap[date];
      if (barsForDate.length > 1) {
        console.log(`\n${date}: ${barsForDate.length} records`);
        barsForDate.forEach((bar, i) => {
          console.log(`  ${i+1}: open=${bar.open}, close=${bar.close}, volume=${bar.volume}, adjustflag=${bar.adjustflag}`);
        });
      }
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

checkDuplicates();