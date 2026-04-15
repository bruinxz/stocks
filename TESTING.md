# 测试现有功能指南

## 环境准备

### 1. 安装必要软件
- **Node.js 18+**: 从 [nodejs.org](https://nodejs.org/) 下载安装
- **Docker Desktop**: 从 [docker.com](https://www.docker.com/products/docker-desktop/) 下载安装
- **Git**: 已安装

### 2. 启动基础设施
```bash
# 进入项目目录
cd /e/projects/stocks

# 启动数据库和Redis
docker-compose up -d
```

### 3. 安装依赖
```bash
# 安装后端依赖
cd backend
npm install

# 安装前端依赖
cd ../frontend
npm install
```

## 测试数据层

### 1. 配置环境变量
```bash
# 复制环境变量模板
cd backend
cp .env.example .env

# 编辑.env文件，根据需要修改配置
```

### 2. 运行数据库迁移（可选）
数据库初始化脚本已在Docker启动时自动执行。如需手动初始化：
```bash
# 进入PostgreSQL容器
docker exec -it stock_postgres psql -U postgres -d stock_backtest

# 执行初始化脚本
\i /docker-entrypoint-initdb.d/init.sql
```

### 3. 测试Baostock API客户端
创建测试脚本 `test-baostock.js`:
```javascript
const { BaostockClient } = require('./dist/data/sources/BaostockClient');

async function test() {
  const client = new BaostockClient();

  // 登录
  const loggedIn = await client.login();
  console.log('Login success:', loggedIn);

  // 获取股票列表
  const stocks = await client.getAllStocks();
  console.log('Total stocks:', stocks.length);

  // 获取单只股票历史数据
  const bars = await client.queryHistoryKData(
    'sh.600000',
    '2024-01-01',
    '2024-01-31'
  );
  console.log('History bars:', bars.length);

  // 登出
  await client.logout();
}

test().catch(console.error);
```

运行测试：
```bash
cd backend
npx ts-node src/test-baostock.ts
```

### 4. 测试数据同步服务
```bash
# 同步股票列表
npm run data:sync-stocks

# 同步单只股票历史数据
npm run data:sync-history sh.600000 --start 2024-01-01 --end 2024-01-31

# 查看数据服务状态
npm run data:status
```

## 测试回测引擎

### 1. 创建回测测试脚本
创建 `test-backtest.js`:
```javascript
const { BacktestEngine } = require('./dist/backtest/engine/BacktestEngine');
const { MovingAverageCrossoverStrategy } = require('./dist/backtest/strategies/MovingAverageCrossoverStrategy');
const { DataService } = require('./dist/data/services/DataService');

async function testBacktest() {
  // 创建策略配置
  const strategyConfig = {
    id: 'ma_crossover_1',
    name: 'Moving Average Crossover',
    parameters: {
      shortWindow: 10,
      longWindow: 30,
    },
  };

  // 创建策略实例
  const strategy = new MovingAverageCrossoverStrategy(strategyConfig, 'sh.600000');

  // 创建数据服务（需要实际实现）
  const dataService = new DataService();

  // 创建回测配置
  const config = {
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-01-31'),
    initialCapital: 100000,
    symbols: ['sh.600000'],
    strategy,
    dataService,
    slippage: 0.001,
    commissionRate: 0.0003,
    frequency: 'daily',
  };

  // 创建回测引擎
  const engine = new BacktestEngine(config);

  // 运行回测
  const result = await engine.run();

  console.log('回测结果:');
  console.log('总收益率:', result.metrics.totalReturn.toFixed(2) + '%');
  console.log('夏普比率:', result.metrics.sharpeRatio.toFixed(3));
  console.log('最大回撤:', result.metrics.maxDrawdown.toFixed(2) + '%');
  console.log('胜率:', result.metrics.winRate.toFixed(2) + '%');
  console.log('总交易次数:', result.metrics.totalTrades);
}

testBacktest().catch(console.error);
```

### 2. 测试技术指标计算
创建 `test-indicators.js`:
```javascript
const { SMA, EMA, RSI, MACD, BollingerBands } = require('./dist/backtest/indicators/TechnicalIndicators');

// 生成测试数据
const prices = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.1) * 10);

// 测试SMA
const sma = new SMA(20);
const smaResult = sma.calculate(prices);
console.log('SMA values:', smaResult.value.length);

// 测试EMA
const ema = new EMA(20);
const emaResult = ema.calculate(prices);
console.log('EMA values:', emaResult.value.length);

// 测试RSI
const rsi = new RSI(14);
const rsiResult = rsi.calculate(prices);
console.log('RSI values:', rsiResult.value.length);
console.log('RSI signal:', rsiResult.signal);

// 测试MACD
const macd = new MACD(12, 26, 9);
const macdResult = macd.calculate(prices);
console.log('MACD histogram:', macdResult.value.histogram.length);

// 测试布林带
const bb = new BollingerBands(20, 2);
const bbResult = bb.calculate(prices);
console.log('Bollinger Bands upper:', bbResult.value.upper.length);
```

## 测试前端应用

### 1. 启动前端开发服务器
```bash
cd frontend
npm start
```

访问 http://localhost:3000 查看前端界面。

### 2. 启动后端开发服务器
```bash
cd backend
npm run dev
```

访问 http://localhost:3000/health 检查后端健康状态。

## 常见问题

### 1. Node.js未找到
- 确认Node.js已安装：`node --version`
- 如果使用nvm，确保正确版本已激活

### 2. Docker容器启动失败
- 确认Docker Desktop正在运行
- 检查端口冲突：5432 (PostgreSQL), 6379 (Redis)
- 查看日志：`docker-compose logs`

### 3. 数据库连接失败
- 确认PostgreSQL容器正在运行：`docker ps`
- 检查环境变量配置
- 测试连接：`pg_isready -h localhost -p 5432`

### 4. Baostock API连接失败
- 检查网络连接
- 确认Baostock服务可用
- 查看API响应日志

### 5. TypeScript编译错误
- 确保所有依赖已安装
- 检查TypeScript配置：`npx tsc --noEmit`
- 查看具体错误信息

## 下一步

完成基本测试后，可以：

1. **填充测试数据**: 使用数据同步工具获取更多股票数据
2. **运行完整回测**: 使用真实数据测试回测引擎
3. **开发前端界面**: 基于现有API开发用户界面
4. **完善API功能**: 添加用户认证、回测管理等API

## 获取帮助

如有问题，请：
1. 查看项目文档
2. 检查错误日志
3. 搜索相关错误信息
4. 提交Issue到项目仓库