const { Sequelize } = require('sequelize');

const sequelize = new Sequelize('stock_backtest', 'stock_admin', 'x8Vq$9pL2#mK7@nW1cF5^jY3!bH4*gD', {
  host: '103.242.3.87',
  port: 5432,
  dialect: 'postgres',
  logging: false,
});

async function run() {
  try {
    const [results] = await sequelize.query(`
      SELECT id, symbol, name FROM stocks 
      WHERE symbol NOT LIKE 'sh.%' AND symbol NOT LIKE 'sz.%' AND symbol NOT LIKE 'bj.%';
    `);
    console.log('Found duplicate/unformatted stocks:', results.length);
    
    if (results.length > 0) {
      console.log('Sample:', results.slice(0, 5));
      
      // Delete them
      await sequelize.query(`
        DELETE FROM stocks 
        WHERE symbol NOT LIKE 'sh.%' AND symbol NOT LIKE 'sz.%' AND symbol NOT LIKE 'bj.%';
      `);
      console.log('Deleted successfully.');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await sequelize.close();
  }
}
run();
