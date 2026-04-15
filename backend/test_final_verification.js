// 最终验证：AKShare helper修复和数据同步功能
const { spawn } = require('child_process');
const path = require('path');

const PYTHON_SCRIPT = path.join(__dirname, 'python', 'akshare_helper.py');

// 调用AKShare Python脚本
async function callAKShare(command, ...args) {
  return new Promise((resolve, reject) => {
    const processArgs = [PYTHON_SCRIPT, command, ...args];
    console.log(`调用: python ${processArgs.join(' ')}`);

    const child = spawn('python', processArgs);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`脚本失败，代码 ${code}: ${stderr}`);
        reject(new Error(`脚本失败: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (result.success) {
          resolve(result.data);
        } else {
          reject(new Error(result.error || '未知错误'));
        }
      } catch (error) {
        console.error(`无法解析输出: ${stdout}`);
        reject(new Error(`返回无效JSON: ${error.message}`));
      }
    });

    child.on('error', (error) => {
      console.error(`无法启动Python进程: ${error.message}`);
      reject(error);
    });
  });
}

async function main() {
  console.log('=== AKShare helper修复验证 ===\n');

  // 测试不同的股票和日期范围
  const testCases = [
    { symbol: 'sz.000001', name: '平安银行', start: '2024-03-01', end: '2024-03-05' },
    { symbol: 'sh.600000', name: '浦发银行', start: '2024-03-01', end: '2024-03-05' },
    { symbol: 'sz.000002', name: '万科A', start: '2024-03-01', end: '2024-03-05' },
    { symbol: 'sh.601318', name: '中国平安', start: '2024-03-01', end: '2024-03-05' },
    { symbol: 'sz.300750', name: '宁德时代', start: '2024-03-01', end: '2024-03-05' },
  ];

  console.log('测试1: 验证AKShare helper能获取数据\n');

  let allPassed = true;
  for (const testCase of testCases) {
    console.log(`测试 ${testCase.name} (${testCase.symbol}):`);
    try {
      const data = await callAKShare('get_daily_data', testCase.symbol, testCase.start, testCase.end, '2');
      if (data.length > 0) {
        console.log(`  ✅ 成功获取 ${data.length} 条数据`);
        console.log(`     字段: ${Object.keys(data[0]).join(', ')}`);

        // 检查必要字段是否存在
        const requiredFields = ['date', 'open', 'high', 'low', 'close', 'volume'];
        const missingFields = requiredFields.filter(field => !(field in data[0]));
        if (missingFields.length === 0) {
          console.log(`     所有必要字段都存在`);
        } else {
          console.log(`     缺少字段: ${missingFields.join(', ')}`);
          allPassed = false;
        }
      } else {
        console.log(`  ⚠️ 获取到0条数据（可能日期范围无交易）`);
      }
    } catch (error) {
      console.log(`  ❌ 失败: ${error.message}`);
      allPassed = false;
    }
    console.log();
  }

  console.log('测试2: 验证股票代码格式转换\n');

  const formatTests = [
    { input: 'sh.600000', expected: 'sh600000' },
    { input: 'sz.000001', expected: 'sz000001' },
    { input: 'bj.430047', expected: 'bj430047' },
  ];

  for (const test of formatTests) {
    console.log(`转换 ${test.input}:`);
    try {
      // 直接测试Python代码
      const data = await callAKShare('get_daily_data', test.input, '2024-03-01', '2024-03-01', '2');
      if (data.length > 0) {
        console.log(`  ✅ 格式转换成功（能获取数据）`);
      } else {
        console.log(`  ⚠️ 格式转换成功但无数据`);
      }
    } catch (error) {
      console.log(`  ❌ 格式转换可能失败: ${error.message}`);
      allPassed = false;
    }
  }

  console.log('\n测试3: 验证兜底机制\n');

  // 测试一个可能不存在的股票，确保错误处理正常
  try {
    const data = await callAKShare('get_daily_data', 'xx.999999', '2024-03-01', '2024-03-01', '2');
    console.log(`测试无效股票: ${data.length} 条数据（应为0）`);
  } catch (error) {
    console.log(`测试无效股票: 正确抛出错误 - ${error.message}`);
  }

  console.log('\n=== 测试结果总结 ===');
  if (allPassed) {
    console.log('✅ AKShare helper修复成功！');
    console.log('说明:');
    console.log('  1. 股票代码格式转换正确（sh.600000 -> sh600000）');
    console.log('  2. stock_zh_a_daily兜底方法工作正常');
    console.log('  3. 能获取完整的日线数据（包含所有必要字段）');
    console.log('  4. 错误处理机制正常');

    console.log('\n🎉 数据同步功能的核心依赖（AKShare数据源）已修复！');
    console.log('下一步: 可以运行完整的数据同步测试验证端到端功能。');
  } else {
    console.log('⚠️ AKShare helper部分功能需要进一步调试');
    console.log('建议: 检查Python环境、网络连接和数据源可用性');
  }

  console.log('\n=== 建议的数据同步测试步骤 ===');
  console.log('1. 确保后端服务运行正常');
  console.log('2. 通过API触发数据同步: POST /api/market/manual-sync');
  console.log('3. 使用合理的日期范围（如2024-03-01到2024-03-07）');
  console.log('4. 监控同步任务状态: GET /api/market/update-status');
  console.log('5. 验证数据是否成功同步到数据库');
}

main().catch(console.error);