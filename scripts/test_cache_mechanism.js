#!/usr/bin/env node
/**
 * 测试数据完整性统计缓存机制
 */

async function testCacheMechanism() {
  try {
    console.log('=== 测试数据完整性统计缓存机制 ===\n');

    // 模拟HTTP请求的工具函数
    const mockApiCall = async (endpoint, method = 'GET', body = null) => {
      console.log(`调用 ${method} ${endpoint}`);

      // 这里我们实际上无法直接调用API，因为我们没有运行服务器
      // 所以我们将模拟响应
      if (endpoint === '/market/data-completeness' && method === 'GET') {
        const timestamp = new Date().toISOString();
        return {
          success: true,
          data: {
            summary: {
              totalStocks: 5500,
              processedStocks: 5500,
              stocksWithData: 310,
              stocksWithoutData: 5190,
              expectedTradingDays: 1575,
              dateRange: { startDate: '2020-01-01', endDate: '2026-04-10' },
              timestamp,
              cached: false
            },
            completenessLevels: [
              { label: '90%-100%', count: 300, percentage: '5.5' },
              { label: '70%-89%', count: 10, percentage: '0.2' },
              { label: '50%-69%', count: 0, percentage: '0.0' },
              { label: '30%-49%', count: 0, percentage: '0.0' },
              { label: '10%-29%', count: 0, percentage: '0.0' },
              { label: '0%-9%', count: 5190, percentage: '94.4' }
            ],
            marketStats: [
              { market: 'SH', total: 2000, completeCount: 200, completeRate: '10.0' },
              { market: 'SZ', total: 3000, completeCount: 100, completeRate: '3.3' },
              { market: 'BJ', total: 500, completeCount: 10, completeRate: '2.0' }
            ],
            metrics: {
              avgCompleteness: '5.65',
              medianCompleteness: '0.00',
              highQualityStocks: 300,
              highQualityPercentage: '5.5',
              lowQualityStocks: 5190,
              lowQualityPercentage: '94.4'
            },
            qualityAssessment: '警告：平均数据完整性低于50%，建议执行全量数据更新',
            dataQualityIssues: {
              hasUndefinedSymbols: false,
              undefinedSymbolCount: 0,
              hasEmptyNames: false,
              emptyNameCount: 0
            }
          }
        };
      }

      if (endpoint === '/market/data-completeness/refresh' && method === 'POST') {
        return {
          success: true,
          data: {
            message: '数据完整性统计缓存已清除，下次请求将重新计算',
            timestamp: new Date().toISOString()
          }
        };
      }

      throw new Error(`未知的API端点: ${endpoint}`);
    };

    // 测试1: 第一次请求应该计算（非缓存）
    console.log('1. 第一次请求（应该重新计算）:');
    const response1 = await mockApiCall('/market/data-completeness', 'GET');
    console.log(`   响应: cached=${response1.data.summary.cached}`);
    console.log(`   时间戳: ${response1.data.summary.timestamp}`);

    // 测试2: 第二次请求（在真实系统中应该使用缓存）
    console.log('\n2. 第二次请求（在真实系统中应该使用缓存）:');
    console.log('   等待2秒...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    const response2 = await mockApiCall('/market/data-completeness', 'GET');
    console.log(`   响应: cached=${response2.data.summary.cached}`);
    console.log(`   时间戳: ${response2.data.summary.timestamp}`);

    // 测试3: 刷新缓存
    console.log('\n3. 刷新缓存:');
    const refreshResponse = await mockApiCall('/market/data-completeness/refresh', 'POST');
    console.log(`   响应: ${refreshResponse.data.message}`);

    // 测试4: 刷新后的第一次请求（应该重新计算）
    console.log('\n4. 刷新后的第一次请求（应该重新计算）:');
    const response3 = await mockApiCall('/market/data-completeness', 'GET');
    console.log(`   响应: cached=${response3.data.summary.cached}`);
    console.log(`   时间戳: ${response3.data.summary.timestamp}`);

    console.log('\n=== 测试总结 ===');
    console.log('1. 缓存机制实现:');
    console.log('   ✅ 添加了数据完整性统计缓存（5分钟TTL）');
    console.log('   ✅ 实现了缓存检查和跳过逻辑');
    console.log('   ✅ 实现了缓存刷新端点');
    console.log('');
    console.log('2. 前端实现:');
    console.log('   ✅ 在Market页面数据完整性统计卡片添加了刷新按钮');
    console.log('   ✅ 实现了refreshDataCompletenessStats函数');
    console.log('   ✅ 刷新按钮包含加载状态和图标');
    console.log('');
    console.log('3. 用户体验改进:');
    console.log('   ✅ 避免每次页面操作都重新计算统计');
    console.log('   ✅ 用户可以通过刷新按钮主动更新统计');
    console.log('   ✅ 统计数据显示缓存状态和时间戳');
    console.log('');
    console.log('4. 真实系统测试:');
    console.log('   ⚠️  需要启动后端服务进行真实API测试');
    console.log('   ⚠️  需要验证缓存是否确实减少了数据库查询');
    console.log('');
    console.log('5. 实际验证步骤:');
    console.log('   1. 启动后端服务: cd backend && npm start');
    console.log('   2. 访问前端Market页面: http://localhost:3000/market');
    console.log('   3. 观察控制台日志，确认第一次请求显示"缓存未命中，重新计算"');
    console.log('   4. 刷新页面，观察第二次请求是否显示"使用缓存的数据完整性统计"');
    console.log('   5. 点击"刷新"按钮，验证缓存被清除并重新计算');

  } catch (error) {
    console.error('测试失败:', error.message);
    process.exit(1);
  }
}

testCacheMechanism().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});