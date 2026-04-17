const { CombinedDataSource } = require('./dist/data/sources/CombinedDataSource');

async function test() {
  const ds = new CombinedDataSource();
  const stocks = await ds.getAllStocks();
  console.log(`Got ${stocks.length} stocks!`);
  console.log(stocks.slice(0, 3));
}
test().catch(console.error);
