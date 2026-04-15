// API健康检查测试
const axios = require('axios');

const API_BASE_URL = 'http://localhost:3003/api';

async function testAPIHealth() {
  console.log('=== API健康检查测试 ===\n');

  const endpoints = [
    { name: '市场数据更新状态', path: '/market/update-status', method: 'GET' },
    { name: '清理队列', path: '/market/clean-queue', method: 'POST' },
    { name: '股票列表', path: '/stocks', method: 'GET' },
    { name: '回测列表', path: '/backtests', method: 'GET' },
  ];

  let passed = 0;
  let failed = 0;

  for (const endpoint of endpoints) {
    try {
      console.log(`测试: ${endpoint.name} (${endpoint.method} ${endpoint.path})`);

      let response;
      if (endpoint.method === 'GET') {
        response = await axios.get(`${API_BASE_URL}${endpoint.path}`, { timeout: 10000 });
      } else if (endpoint.method === 'POST') {
        response = await axios.post(`${API_BASE_URL}${endpoint.path}`, {}, { timeout: 10000 });
      }

      if (response.data && response.data.success !== undefined) {
        console.log(`  ✅ 成功: ${response.data.success ? '是' : '否'}`);
        if (response.data.success) {
          passed++;
        } else {
          failed++;
          console.log(`     错误: ${response.data.error || '未知错误'}`);
        }
      } else {
        console.log(`  ⚠️ 响应格式异常`);
        failed++;
      }

      if (response.data && response.data.data) {
        const dataType = typeof response.data.data;
        if (Array.isArray(response.data.data)) {
          console.log(`     返回数组长度: ${response.data.data.length}`);
        } else if (dataType === 'object') {
          const keys = Object.keys(response.data.data);
          console.log(`     返回对象字段: ${keys.length} 个`);
        }
      }

    } catch (error) {
      failed++;
      if (error.response) {
        console.log(`  ❌ 失败: HTTP ${error.response.status}`);
        console.log(`     错误信息: ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        console.log(`  ❌ 失败: 无响应 (${error.message})`);
      } else {
        console.log(`  ❌ 失败: ${error.message}`);
      }
    }
    console.log();
  }

  console.log('=== 测试结果 ===');
  console.log(`总共测试端点: ${endpoints.length}`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${failed}`);
  console.log(`通过率: ${((passed / endpoints.length) * 100).toFixed(1)}%`);

  if (failed === 0) {
    console.log('\n🎉 所有API端点健康检查通过！');
  } else if (passed > 0) {
    console.log(`\n⚠️ 部分API端点存在问题 (${failed}/${endpoints.length})`);
  } else {
    console.log('\n❌ API健康检查失败');
  }

  // 特别检查数据更新状态
  console.log('\n=== 数据更新服务状态 ===');
  try {
    const response = await axios.get(`${API_BASE_URL}/market/update-status`, { timeout: 10000 });
    if (response.data.success) {
      const data = response.data.data;
      console.log('队列状态:');
      console.log(`  等待中: ${data.queue?.waiting || 0}`);
      console.log(`  活动中: ${data.queue?.active || 0}`);
      console.log(`  已完成: ${data.queue?.completed || 0}`);
      console.log(`  失败: ${data.queue?.failed || 0}`);

      console.log('\n锁状态:');
      console.log(`  全局锁: ${data.locks?.global ? '锁定' : '未锁定'}`);
      console.log(`  每日更新锁: ${data.locks?.daily ? '锁定' : '未锁定'}`);
      console.log(`  新股锁: ${data.locks?.newStocks ? '锁定' : '未锁定'}`);

      if (data.logs && data.logs.length > 0) {
        console.log('\n最近更新日志:');
        const latestLog = data.logs[0];
        console.log(`  ID: ${latestLog.id}`);
        console.log(`  类型: ${latestLog.type}`);
        console.log(`  状态: ${latestLog.status}`);
        console.log(`  日期: ${latestLog.date}`);
        if (latestLog.result) {
          console.log(`  结果: ${JSON.stringify(latestLog.result, null, 2)}`);
        }
      }
    }
  } catch (error) {
    console.log(`获取更新状态失败: ${error.message}`);
  }
}

testAPIHealth().catch(console.error);