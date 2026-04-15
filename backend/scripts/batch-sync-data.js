const { sequelize } = require('../dist/config/database');
const { DataSyncService } = require('../dist/data/services/DataSyncService');
const fs = require('fs');
const path = require('path');

// 配置
const CONFIG = {
  // 数据时间范围
  START_DATE: '2020-01-01',
  END_DATE: '2026-04-06', // 当前日期

  // 分批配置
  BATCH_SIZE: 20, // 每批同步的股票数量
  BATCH_DELAY_MS: 5000, // 批次间延迟（毫秒，增加以避免资源问题）

  // 错误处理
  MAX_RETRIES: 3, // 最大重试次数
  RETRY_DELAY_MS: 10000, // 重试延迟（增加以避免API限制）

  // 优先级配置
  PRIORITY_CATEGORIES: [
    {
      name: 'SH主板',
      filter: (symbol) => symbol.startsWith('sh.6') && !symbol.startsWith('sh.688'),
      priority: 1
    },
    {
      name: 'SZ主板',
      filter: (symbol) => symbol.startsWith('sz.0'),
      priority: 2
    },
    {
      name: '科创板',
      filter: (symbol) => symbol.startsWith('sh.688'),
      priority: 3
    },
    {
      name: '创业板',
      filter: (symbol) => symbol.startsWith('sz.3'),
      priority: 4
    },
    {
      name: '北交所',
      filter: (symbol) => symbol.startsWith('bj.'),
      priority: 5
    },
    {
      name: '其他',
      filter: () => true,
      priority: 6
    }
  ],

  // 日志文件
  LOG_DIR: path.join(__dirname, '../logs'),
  PROGRESS_FILE: 'sync-progress.json',
  RESULTS_FILE: 'sync-results.json'
};

class BatchDataSync {
  constructor() {
    this.dataSyncService = new DataSyncService();
    this.results = {
      startTime: new Date().toISOString(),
      endTime: null,
      totalStocks: 0,
      processedStocks: 0,
      successCount: 0,
      failCount: 0,
      skipCount: 0,
      byCategory: {},
      detailedResults: {}
    };

    this.progress = {
      currentBatch: 0,
      totalBatches: 0,
      currentCategory: '',
      currentCategoryIndex: 0,
      completedCategories: []
    };

    // 创建日志目录
    if (!fs.existsSync(CONFIG.LOG_DIR)) {
      fs.mkdirSync(CONFIG.LOG_DIR, { recursive: true });
    }
  }

  async initialize() {
    console.log('=== A股数据批量同步系统 ===\n');
    console.log(`配置:`);
    console.log(`  时间范围: ${CONFIG.START_DATE} 至 ${CONFIG.END_DATE}`);
    console.log(`  批次大小: ${CONFIG.BATCH_SIZE} 只股票`);
    console.log(`  批次延迟: ${CONFIG.BATCH_DELAY_MS} 毫秒\n`);

    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 检查现有进度
    await this.loadProgress();
  }

  async loadProgress() {
    const progressPath = path.join(CONFIG.LOG_DIR, CONFIG.PROGRESS_FILE);
    if (fs.existsSync(progressPath)) {
      try {
        const data = fs.readFileSync(progressPath, 'utf8');
        this.progress = JSON.parse(data);
        console.log(`恢复进度: 已处理 ${this.progress.completedCategories.length} 个类别`);
        return true;
      } catch (error) {
        console.warn('无法读取进度文件，重新开始:', error.message);
      }
    }
    return false;
  }

  async saveProgress() {
    const progressPath = path.join(CONFIG.LOG_DIR, CONFIG.PROGRESS_FILE);
    fs.writeFileSync(progressPath, JSON.stringify(this.progress, null, 2));
  }

  async saveResults() {
    this.results.endTime = new Date().toISOString();
    const resultsPath = path.join(CONFIG.LOG_DIR, CONFIG.RESULTS_FILE);
    fs.writeFileSync(resultsPath, JSON.stringify(this.results, null, 2));
  }

  async getStocksNeedingSync() {
    console.log('查询需要同步的股票...');

    // 查询没有日线数据的股票
    const query = `
      SELECT s.symbol, s.name, s.market, s.type
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
      ORDER BY s.symbol
    `;

    const stocks = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });
    console.log(`找到 ${stocks.length} 只股票需要同步数据\n`);

    return stocks;
  }

  categorizeStocks(stocks) {
    const categories = {};

    CONFIG.PRIORITY_CATEGORIES.forEach(cat => {
      categories[cat.name] = {
        priority: cat.priority,
        stocks: stocks.filter(s => cat.filter(s.symbol)),
        processed: false
      };
    });

    // 按优先级排序
    const sortedCategories = Object.entries(categories)
      .filter(([_, data]) => data.stocks.length > 0)
      .sort((a, b) => a[1].priority - b[1].priority);

    return sortedCategories;
  }

  async syncCategory(categoryName, stocks) {
    console.log(`\n=== 开始同步 ${categoryName} ===`);
    console.log(`股票数量: ${stocks.length} 只`);

    const symbols = stocks.map(s => s.symbol);
    this.results.byCategory[categoryName] = {
      total: stocks.length,
      success: 0,
      fail: 0,
      skip: 0
    };

    // 分批处理
    const batches = Math.ceil(symbols.length / CONFIG.BATCH_SIZE);
    this.progress.totalBatches = batches;

    for (let i = 0; i < symbols.length; i += CONFIG.BATCH_SIZE) {
      this.progress.currentBatch = Math.floor(i / CONFIG.BATCH_SIZE) + 1;
      this.progress.currentCategory = categoryName;
      this.progress.currentCategoryIndex = CONFIG.PRIORITY_CATEGORIES.findIndex(c => c.name === categoryName);

      const batch = symbols.slice(i, i + CONFIG.BATCH_SIZE);
      const batchNum = this.progress.currentBatch;
      const totalBatches = batches;

      console.log(`\n[${categoryName}] 批次 ${batchNum}/${totalBatches} (${batch.length} 只股票)`);
      console.log(`股票: ${batch.join(', ')}`);

      let retryCount = 0;
      let batchResults = null;

      // 重试逻辑
      while (retryCount <= CONFIG.MAX_RETRIES) {
        try {
          batchResults = await this.dataSyncService.syncMultipleStocksHistory(
            batch,
            CONFIG.START_DATE,
            CONFIG.END_DATE,
            CONFIG.BATCH_SIZE
          );
          break;
        } catch (error) {
          retryCount++;
          if (retryCount <= CONFIG.MAX_RETRIES) {
            console.warn(`批次 ${batchNum} 失败，第 ${retryCount} 次重试 (${CONFIG.RETRY_DELAY_MS/1000}秒后)...`);
            await this.delay(CONFIG.RETRY_DELAY_MS);
          } else {
            console.error(`批次 ${batchNum} 失败，达到最大重试次数:`, error.message);
            // 为批次中的每只股票记录失败
            batchResults = {};
            batch.forEach(symbol => {
              batchResults[symbol] = -1;
            });
          }
        }
      }

      // 记录结果
      if (batchResults) {
        this.recordBatchResults(categoryName, batchResults);
      }

      // 保存进度
      await this.saveProgress();

      // 批次间延迟（最后一个批次除外）
      if (i + CONFIG.BATCH_SIZE < symbols.length) {
        console.log(`等待 ${CONFIG.BATCH_DELAY_MS/1000} 秒...`);
        await this.delay(CONFIG.BATCH_DELAY_MS);
      }
    }

    console.log(`\n=== ${categoryName} 同步完成 ===`);
    const catResults = this.results.byCategory[categoryName];
    console.log(`成功: ${catResults.success}, 失败: ${catResults.fail}, 跳过: ${catResults.skip}`);

    this.progress.completedCategories.push(categoryName);
    await this.saveProgress();
  }

  recordBatchResults(categoryName, batchResults) {
    for (const [symbol, count] of Object.entries(batchResults)) {
      this.results.detailedResults[symbol] = {
        count,
        category: categoryName,
        timestamp: new Date().toISOString()
      };

      const catStats = this.results.byCategory[categoryName];
      if (count > 0) {
        catStats.success++;
        this.results.successCount++;
      } else if (count === 0) {
        catStats.skip++;
        this.results.skipCount++;
      } else {
        catStats.fail++;
        this.results.failCount++;
      }

      this.results.processedStocks++;
    }
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async run() {
    try {
      await this.initialize();

      // 获取需要同步的股票
      const stocks = await this.getStocksNeedingSync();
      this.results.totalStocks = stocks.length;

      if (stocks.length === 0) {
        console.log('所有股票已有数据，无需同步');
        return;
      }

      // 按类别分组
      const categories = this.categorizeStocks(stocks);

      console.log('\n=== 同步计划 ===');
      categories.forEach(([name, data]) => {
        console.log(`${name.padEnd(10)}: ${data.stocks.length} 只股票 (优先级: ${data.priority})`);
      });

      // 按优先级同步
      for (const [categoryName, categoryData] of categories) {
        // 如果已处理过，跳过
        if (this.progress.completedCategories.includes(categoryName)) {
          console.log(`\n跳过已完成的类别: ${categoryName}`);
          continue;
        }

        await this.syncCategory(categoryName, categoryData.stocks);

        // 保存最终结果
        await this.saveResults();

        // 类别间延迟（最后一个类别除外）
        const nextCategoryIndex = categories.findIndex(([name]) => name === categoryName) + 1;
        if (nextCategoryIndex < categories.length) {
          console.log(`\n准备下一个类别，等待 5 秒...`);
          await this.delay(5000);
        }
      }

      // 完成
      console.log('\n=== 数据同步完成 ===');
      console.log(`总计: ${this.results.totalStocks} 只股票`);
      console.log(`成功: ${this.results.successCount}`);
      console.log(`失败: ${this.results.failCount}`);
      console.log(`跳过: ${this.results.skipCount}`);

      // 保存最终结果
      await this.saveResults();

      // 清理进度文件
      const progressPath = path.join(CONFIG.LOG_DIR, CONFIG.PROGRESS_FILE);
      if (fs.existsSync(progressPath)) {
        fs.unlinkSync(progressPath);
      }

      console.log(`\n结果已保存到: ${path.join(CONFIG.LOG_DIR, CONFIG.RESULTS_FILE)}`);

    } catch (error) {
      console.error('同步过程发生错误:', error);
      // 保存当前进度以便恢复
      await this.saveProgress();
      await this.saveResults();
      throw error;
    } finally {
      await sequelize.close();
    }
  }

  async resume() {
    console.log('=== 恢复数据同步 ===\n');
    await this.initialize();

    // 获取需要同步的股票
    const stocks = await this.getStocksNeedingSync();
    this.results.totalStocks = stocks.length;

    // 按类别分组
    const categories = this.categorizeStocks(stocks);

    // 跳过已完成的类别
    const remainingCategories = categories.filter(
      ([name]) => !this.progress.completedCategories.includes(name)
    );

    if (remainingCategories.length === 0) {
      console.log('所有类别已完成，无需恢复');
      return;
    }

    console.log('剩余类别:');
    remainingCategories.forEach(([name, data]) => {
      console.log(`  ${name}: ${data.stocks.length} 只股票`);
    });

    // 继续同步
    for (const [categoryName, categoryData] of remainingCategories) {
      await this.syncCategory(categoryName, categoryData.stocks);
      await this.saveResults();
    }
  }
}

// 命令行接口
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'run';

  const sync = new BatchDataSync();

  try {
    if (command === 'resume') {
      await sync.resume();
    } else if (command === 'run') {
      await sync.run();
    } else if (command === 'status') {
      await sync.initialize();
      const stocks = await sync.getStocksNeedingSync();
      console.log(`需要同步的股票: ${stocks.length} 只`);
      // TODO: 显示更多状态信息
    } else {
      console.log('用法:');
      console.log('  node batch-sync-data.js run     - 开始新同步');
      console.log('  node batch-sync-data.js resume  - 恢复上次同步');
      console.log('  node batch-sync-data.js status  - 查看状态');
    }
  } catch (error) {
    console.error('执行失败:', error);
    process.exit(1);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

module.exports = { BatchDataSync, CONFIG };