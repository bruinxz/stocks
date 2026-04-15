#!/usr/bin/env node
/**
 * 测试AKShare股票列表获取
 */

async function testAKShareStocks() {
  try {
    const { AKShareClient } = require('../backend/src/data/sources/AKShareClient');
    const client = new AKShareClient();

    console.log('Testing AKShareClient.getAllStocks()...');
    const stocks = await client.getAllStocks();

    console.log(`Total stocks: ${stocks.length}`);

    if (stocks.length > 0) {
      console.log('\nFirst 5 stocks:');
      stocks.slice(0, 5).forEach((stock, index) => {
        console.log(`${index + 1}. Code: "${stock.code}", Name: "${stock.code_name}", IPO: ${stock.ipoDate}, Type: ${stock.type}, Status: ${stock.status}`);
      });

      // Check for undefined values
      const undefinedCodes = stocks.filter(s => s.code === 'undefined' || s.code.includes('undefined'));
      const undefinedNames = stocks.filter(s => s.code_name === 'undefined' || s.code_name.includes('undefined'));

      console.log(`\nStocks with undefined code: ${undefinedCodes.length}`);
      console.log(`Stocks with undefined name: ${undefinedNames.length}`);

      if (undefinedCodes.length > 0) {
        console.log('\nExample of undefined stock:');
        console.log(undefinedCodes[0]);
      }
    } else {
      console.log('No stocks returned');
    }

  } catch (error) {
    console.error(`Test failed: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    process.exit(1);
  }
}

testAKShareStocks().catch(error => {
  console.error('Script execution failed:', error);
  process.exit(1);
});