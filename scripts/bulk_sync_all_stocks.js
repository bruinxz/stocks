#!/usr/bin/env node
/**
 * 全量数据同步脚本
 * 同步所有A股股票的日线数据
 * 支持断点续传和进度跟踪
 */

const fs = require('fs');
const path = require('path');

async function bulkSyncAllStocks() {
  // 配置文件路径
  const progressFile = path.join(__dirname, '.bulk_sync_progress.json');
  const statsFile = path.join(__dirname, '.bulk_sync_stats.json');

  // 进度和统计变量
  let progress;
  let stats;

  try {
    // 导入必要的模块
    const { DataSyncService } = require('../backend/dist/data/services/DataSyncService');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');
    const { Op } = require('../backend/node_modules/sequelize');

    // 抑制日志输出，只显示关键信息
    logger.level = 'info';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    const syncService = new DataSyncService();

    // 加载或初始化进度
    progress = {
      startedAt: null,
      completedAt: null,
      totalStocks: 0,
      processedStocks: 0,
      successfulSyncs: 0,
      failedSyncs: 0,
      totalRecordsInserted: 0,
      currentBatch: 0,
      totalBatches: 0,
      lastProcessedSymbol: null,
      errors: []
    };

    stats = {
      totalSyncTime: 0,
      averageTimePerStock: 0,
      successRate: 0
    };

    // 尝试加载进度
    if (fs.existsSync(progressFile)) {
      try {
        progress = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
        console.log(`加载之前的进度: 已处理 ${progress.processedStocks}/${progress.totalStocks} 只股票`);
      } catch (e) {
        console.log('无法加载进度文件，将重新开始');
      }
    }

    // 配置参数
    const config = {
      batchSize: 20, // 每批次处理的股票数
      delayBetweenBatches: 3000, // 批次间延迟（毫秒）
      delayBetweenStocks: 100, // 股票间延迟（毫秒）
      maxRetries: 3, // 最大重试次数
      retryDelay: 2000, // 重试延迟（毫秒）
      startDate: '2024-01-01', // 开始日期（最近2年，减少数据量）
      endDate: '2025-12-31', // 结束日期
      forceRestart: process.argv.includes('--restart') // 强制重新开始
    };

    console.log('=== A股股票全量数据同步 ===');
    console.log(`配置: 批次大小=${config.batchSize}, 延迟=${config.delayBetweenBatches}ms`);
    console.log(`日期范围: ${config.startDate} 到 ${config.endDate}`);
    console.log(`断点续传: ${!config.forceRestart ? '启用' : '禁用'}`);
    console.log('');

    if (config.forceRestart) {
      console.log('⚠️  强制重新开始，清除所有进度');
      progress = {
        startedAt: new Date().toISOString(),
        completedAt: null,
        totalStocks: 0,
        processedStocks: 0,
        successfulSyncs: 0,
        failedSyncs: 0,
        totalRecordsInserted: 0,
        currentBatch: 0,
        totalBatches: 0,
        lastProcessedSymbol: null,
        errors: []
      };
    } else if (progress.completedAt) {
      console.log('✅ 同步已完成，如需重新运行请添加 --restart 参数');
      return;
    }

    // 获取所有已上市的A股股票
    console.log('1. 获取股票列表...');
    const stocks = await Stock.findAll({
      where: {
        isListed: true,
        // 过滤掉无效的股票代码
        symbol: {
          [Op.notLike]: '%undefined%',
          [Op.not]: null,
          [Op.ne]: ''
        }
      },
      order: [
        ['market', 'ASC'],
        ['symbol', 'ASC']
      ]
    });

    const totalStocks = stocks.length;
    console.log(`   找到 ${totalStocks} 只已上市的A股股票`);

    if (totalStocks === 0) {
      console.error('❌ 没有找到可同步的股票');
      return;
    }

    // 初始化进度
    if (!progress.startedAt || config.forceRestart) {
      progress.startedAt = new Date().toISOString();
      progress.totalStocks = totalStocks;
      progress.totalBatches = Math.ceil(totalStocks / config.batchSize);
      progress.processedStocks = 0;
      progress.successfulSyncs = 0;
      progress.failedSyncs = 0;
      progress.totalRecordsInserted = 0;
      progress.currentBatch = 0;
      progress.lastProcessedSymbol = null;
      progress.errors = [];

      saveProgress();
    }

    // 找出需要处理的股票
    let stocksToProcess = stocks;
    if (progress.lastProcessedSymbol && !config.forceRestart) {
      // 找到上次处理的股票位置
      const lastIndex = stocks.findIndex(s => s.symbol === progress.lastProcessedSymbol);
      if (lastIndex >= 0) {
        stocksToProcess = stocks.slice(lastIndex + 1);
        console.log(`   从 ${progress.lastProcessedSymbol} 之后继续，剩余 ${stocksToProcess.length} 只股票`);
      }
    }

    const totalBatches = Math.ceil(stocksToProcess.length / config.batchSize);

    console.log(`2. 开始批量同步 (共 ${totalBatches} 批，每批 ${config.batchSize} 只股票)`);
    console.log('   按 Ctrl+C 可以暂停，进度会自动保存\n');

    const overallStartTime = Date.now();

    // 处理每个批次
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStartIndex = batchIndex * config.batchSize;
      const batchEndIndex = Math.min(batchStartIndex + config.batchSize, stocksToProcess.length);
      const batchStocks = stocksToProcess.slice(batchStartIndex, batchEndIndex);

      progress.currentBatch = batchIndex + 1;

      console.log(`\n--- 批次 ${batchIndex + 1}/${totalBatches} (股票 ${batchStartIndex + 1}-${batchEndIndex}/${stocksToProcess.length}) ---`);

      const batchStartTime = Date.now();

      // 处理批次中的每只股票
      for (let i = 0; i < batchStocks.length; i++) {
        const stock = batchStocks[i];
        const stockIndex = batchStartIndex + i + 1;
        const overallIndex = progress.processedStocks + 1;

        console.log(`   ${overallIndex}/${progress.totalStocks} [${stock.market}] ${stock.symbol} (${stock.name})...`);

        let success = false;
        let recordsInserted = 0;
        let errorMessage = null;

        // 重试机制
        for (let retry = 1; retry <= config.maxRetries; retry++) {
          try {
            if (retry > 1) {
              console.log(`     第 ${retry} 次重试...`);
              await new Promise(resolve => setTimeout(resolve, config.retryDelay));
            }

            const startTime = Date.now();
            recordsInserted = await syncService.syncStockHistory(
              stock.symbol,
              config.startDate,
              config.endDate
            );
            const elapsedTime = Date.now() - startTime;

            success = true;
            progress.successfulSyncs++;
            progress.totalRecordsInserted += recordsInserted;

            if (recordsInserted > 0) {
              console.log(`     ✅ 插入 ${recordsInserted} 条数据 (${elapsedTime}ms)`);
            } else {
              console.log(`     ⚠️  无新数据 (${elapsedTime}ms)`);
            }

            break; // 成功，跳出重试循环
          } catch (error) {
            errorMessage = error.message;
            if (retry === config.maxRetries) {
              console.log(`     ❌ 失败: ${errorMessage}`);
            }
          }
        }

        if (!success) {
          progress.failedSyncs++;
          progress.errors.push({
            symbol: stock.symbol,
            error: errorMessage,
            timestamp: new Date().toISOString()
          });
        }

        progress.processedStocks++;
        progress.lastProcessedSymbol = stock.symbol;

        // 保存进度
        saveProgress();

        // 股票间延迟
        if (i < batchStocks.length - 1) {
          await new Promise(resolve => setTimeout(resolve, config.delayBetweenStocks));
        }
      }

      const batchTime = Date.now() - batchStartTime;
      console.log(`   批次完成，耗时 ${Math.round(batchTime / 1000)} 秒`);

      // 显示进度信息
      displayProgress(batchIndex, totalBatches, stocksToProcess, progress, overallStartTime);

      // 批次间延迟（最后一个批次除外）
      if (batchIndex < totalBatches - 1) {
        console.log(`   等待 ${config.delayBetweenBatches}ms 后处理下一批...`);
        await new Promise(resolve => setTimeout(resolve, config.delayBetweenBatches));
      }
    }

    const overallTime = Date.now() - overallStartTime;
    progress.completedAt = new Date().toISOString();

    // 计算统计
    stats.totalSyncTime = overallTime;
    stats.averageTimePerStock = overallTime / progress.processedStocks;
    stats.successRate = progress.processedStocks > 0
      ? (progress.successfulSyncs / progress.processedStocks) * 100
      : 0;

    // 保存最终进度和统计
    saveProgress();
    saveStats();

    console.log('\n=== 同步完成 ===');
    console.log(`总耗时: ${Math.round(overallTime / 1000)} 秒 (${Math.round(overallTime / 60000)} 分钟)`);
    console.log(`处理股票: ${progress.processedStocks} / ${progress.totalStocks}`);
    console.log(`成功: ${progress.successfulSyncs}, 失败: ${progress.failedSyncs}`);
    console.log(`成功率: ${stats.successRate.toFixed(1)}%`);
    console.log(`插入记录: ${progress.totalRecordsInserted} 条`);
    console.log(`平均每只股票: ${Math.round(stats.averageTimePerStock)}ms`);

    if (progress.errors.length > 0) {
      console.log(`\n错误列表 (前10个):`);
      progress.errors.slice(0, 10).forEach(err => {
        console.log(`  ${err.symbol}: ${err.error}`);
      });
      if (progress.errors.length > 10) {
        console.log(`  ... 还有 ${progress.errors.length - 10} 个错误`);
      }
    }

    console.log(`\n进度文件: ${progressFile}`);
    console.log(`统计文件: ${statsFile}`);

    // 显示同步服务统计
    const syncStats = syncService.getSyncStats();
    console.log(`\n同步服务统计:`);
    console.log(`  总同步次数: ${syncStats.totalSyncs}`);
    console.log(`  成功同步: ${syncStats.successfulSyncs}`);
    console.log(`  失败同步: ${syncStats.failedSyncs}`);
    console.log(`  平均每次插入: ${syncStats.averageInsertPerSync.toFixed(2)} 条`);

  } catch (error) {
    console.error(`\n❌ 同步失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }

  // 显示进度信息的函数
  function displayProgress(batchIndex, totalBatches, stocksToProcess, progress, overallStartTime) {
    const overallTime = Date.now() - overallStartTime;
    const totalToProcess = stocksToProcess.length;
    const processedOverall = progress.processedStocks;
    const totalOverall = progress.totalStocks;

    // 避免除以零
    if (totalOverall === 0) return;

    const percentOverall = totalOverall > 0 ? (processedOverall / totalOverall * 100).toFixed(1) : 0;
    const percentBatch = totalBatches > 0 ? ((batchIndex + 1) / totalBatches * 100).toFixed(1) : 0;

    // 计算ETA
    const averageTimePerStock = overallTime / processedOverall;
    const remainingStocks = totalOverall - processedOverall;
    const etaMs = averageTimePerStock * remainingStocks;
    const etaMinutes = Math.floor(etaMs / 60000);
    const etaSeconds = Math.floor((etaMs % 60000) / 1000);

    // 创建进度条
    const progressBarLength = 30;
    const filledLength = Math.round(progressBarLength * processedOverall / totalOverall);
    const emptyLength = progressBarLength - filledLength;
    const progressBar = '█'.repeat(filledLength) + '░'.repeat(emptyLength);

    console.log('\n' + '='.repeat(60));
    console.log('📊 同步进度监控');
    console.log('='.repeat(60));
    console.log(`总体进度: ${progressBar} ${percentOverall}%`);
    console.log(`已处理: ${processedOverall}/${totalOverall} 只股票`);
    console.log(`成功: ${progress.successfulSyncs}, 失败: ${progress.failedSyncs}`);
    console.log(`插入记录: ${progress.totalRecordsInserted} 条`);
    console.log(`\n📈 批次进度: ${batchIndex + 1}/${totalBatches} (总体 ${percentOverall}%)`);
    console.log(`已用时间: ${Math.floor(overallTime / 60000)}分${Math.floor((overallTime % 60000) / 1000)}秒`);
    console.log(`预计剩余: ${etaMinutes}分${etaSeconds}秒`);
    console.log(`预计完成: ${new Date(Date.now() + etaMs).toLocaleTimeString()}`);
    console.log(`平均每只: ${Math.round(averageTimePerStock)}ms`);
    console.log('='.repeat(60));
  }

  // 保存进度到文件
  function saveProgress() {
    try {
      if (!progressFile) {
        console.warn(`进度文件路径未定义: progressFile=${progressFile}`);
        return;
      }
      fs.writeFileSync(progressFile, JSON.stringify(progress, null, 2), 'utf8');
    } catch (e) {
      console.warn(`无法保存进度文件: ${e.message} (progressFile=${progressFile})`);
    }
  }

  // 保存统计到文件
  function saveStats() {
    try {
      fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf8');
    } catch (e) {
      console.warn(`无法保存统计文件: ${e.message}`);
    }
  }
}

// 处理Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n⚠️  同步被用户中断，进度已保存');
  console.log('下次运行将继续从断点开始');
  console.log('如需重新开始，请使用: node scripts/bulk_sync_all_stocks.js --restart');
  process.exit(0);
});

bulkSyncAllStocks().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});