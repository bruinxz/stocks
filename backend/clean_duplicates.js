const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');
const { Op } = require('sequelize');

async function cleanDuplicates() {
  try {
    await sequelize.authenticate();
    console.log('Database connected');

    const stock = await Stock.findOne({ where: { symbol: 'sh.600000' } });
    if (!stock) {
      console.log('Stock not found');
      return;
    }

    console.log(`Stock ID: ${stock.id}`);

    // Get all bars for this stock
    const bars = await DailyBar.findAll({
      where: { stockId: stock.id },
      order: [['time', 'ASC'], ['created_at', 'ASC']],
      attributes: ['id', 'time', 'open', 'close', 'volume', 'created_at']
    });

    console.log(`Total bars: ${bars.length}`);

    const dateMap = {};
    const toDelete = [];

    // Find duplicates
    bars.forEach(bar => {
      const dateStr = bar.time.toISOString().split('T')[0];
      if (!dateMap[dateStr]) {
        dateMap[dateStr] = [bar];
      } else {
        dateMap[dateStr].push(bar);
      }
    });

    // Decide which to keep (keep the first one for each date)
    Object.keys(dateMap).forEach(date => {
      const barsForDate = dateMap[date];
      if (barsForDate.length > 1) {
        console.log(`${date}: ${barsForDate.length} records`);

        // Keep the first one (by createdAt), delete others
        const [keep, ...deleteList] = barsForDate.sort((a, b) =>
          new Date(a.createdAt) - new Date(b.createdAt)
        );

        console.log(`  Keeping: id=${keep.id}, open=${keep.open}, close=${keep.close}, volume=${keep.volume}`);
        deleteList.forEach(bar => {
          console.log(`  Deleting: id=${bar.id}, open=${bar.open}, close=${bar.close}, volume=${bar.volume}`);
          toDelete.push(bar.id);
        });
      }
    });

    // Delete duplicates
    if (toDelete.length > 0) {
      console.log(`\nDeleting ${toDelete.length} duplicate records...`);
      const deletedCount = await DailyBar.destroy({
        where: { id: { [Op.in]: toDelete } }
      });
      console.log(`Deleted ${deletedCount} records`);
    } else {
      console.log('No duplicates found');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}

cleanDuplicates();