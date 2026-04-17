# A股股票回测系统

## 项目概述
构建完整的A股股票回测系统，包含网页操作界面。支持历史数据回测、策略定义、性能分析和可视化展示。

## 技术方案

### 技术栈
- **后端**：Node.js + TypeScript + Express.js + PostgreSQL + TimescaleDB + Redis + Bull
- **前端**：React + TypeScript + Ant Design + Recharts + Redux Toolkit
- **数据源**：Baostock (免费开源A股数据API)
- **开发环境**：Docker Compose (PostgreSQL + Redis)

### 架构设计
- **数据层**：Baostock API集成 + PostgreSQL TimescaleDB时序数据库
- **回测引擎**：事件驱动回测，支持多策略、多时间框架
- **API层**：RESTful API + WebSocket实时更新
- **前端界面**：单页面应用，模块化组件设计
- **任务队列**：Bull + Redis处理长时间回测任务

## 工具计划

### 开发工具
- **版本控制**：Git
- **代码质量**：ESLint + Prettier + TypeScript严格模式
- **测试框架**：Jest (后端) + React Testing Library (前端)
- **容器化**：Docker + Docker Compose
- **数据库管理**：Sequelize ORM + Sequelize CLI

### 部署工具
- **容器编排**：Docker Compose / Kubernetes
- **持续集成**：GitHub Actions / GitLab CI
- **监控日志**：Winston + ELK Stack
- **性能监控**：Prometheus + Grafana

### 数据工具
- **数据获取**：Baostock API客户端 + 定时任务
- **数据清洗**：数据验证和标准化管道
- **数据缓存**：Redis缓存热点数据
- **数据分析**：ta/tulind技术指标库

## 实施计划

### 阶段1：项目初始化 ✅ 已完成
**目标**：搭建基础开发环境

**完成工作**：
1. ✅ 创建项目目录结构
2. ✅ 初始化Git仓库，配置.gitignore
3. ✅ 设置后端项目
   - package.json配置（包含所有依赖）
   - tsconfig.json TypeScript配置
   - 基础Express服务器代码
   - ESLint + Prettier代码质量配置
4. ✅ 设置前端项目
   - Create React App + TypeScript模板
   - Ant Design UI框架集成
   - 基础布局和路由设置
5. ✅ 配置Docker开发环境
   - PostgreSQL + TimescaleDB容器配置
   - Redis容器配置
   - 数据库初始化脚本
6. ✅ 设置代码质量工具
   - ESLint配置（前后端独立）
   - Prettier代码格式化配置

**生成文件**：
- `backend/` - 后端服务完整结构
- `frontend/` - 前端应用完整结构
- `docker-compose.yml` - 开发环境容器配置
- `scripts/init-db.sql` - 数据库初始化脚本
- `.gitignore` - Git忽略配置

### 阶段2：数据层开发 ✅ 已完成
**目标**：实现A股数据获取和存储

**计划工作**：
1. 集成Baostock API客户端
   - 实现股票列表获取
   - 实现历史K线数据获取
   - 实现数据验证和清洗
2. 设计数据库模式
   - 股票基本信息表
   - 日线数据表（TimescaleDB hypertable）
   - 回测结果表
   - 交易记录表
3. 实现数据获取服务
   - 定时数据更新任务
   - 增量数据同步
   - 数据质量监控
4. 创建数据管理工具
   - 命令行数据导入工具
   - 数据修复和补全工具
   - 数据统计和报表

**预计时间**：4天

### 阶段3：回测引擎核心 ✅ 已完成
**目标**：实现事件驱动回测引擎

**计划工作**：
1. 设计回测引擎接口
   - 事件循环设计
   - 投资组合管理
   - 订单执行模拟
2. 实现基础策略框架
   - 策略基类定义
   - 信号生成机制
   - 仓位管理
3. 添加常用技术指标
   - 移动平均线（SMA, EMA）
   - RSI, MACD, Bollinger Bands
   - ATR, 波动率计算
4. 性能指标计算
   - 收益率、年化收益率
   - 夏普比率、索提诺比率
   - 最大回撤、波动率
   - 胜率、盈亏比

**预计时间**：5天

### 阶段4：后端API开发 ✅ 已完成
**目标**：提供RESTful API接口

**计划工作**：
1. 设计API规范
   - OpenAPI/Swagger文档
   - 请求/响应格式定义
2. 实现用户认证
   - JWT令牌认证
   - 用户权限管理
3. 核心API端点
   - 股票数据查询API
   - 回测配置和管理API
   - 策略列表和详情API
   - 回测结果获取API
4. 后台任务系统
   - Bull队列集成
   - 回测任务处理
   - 进度跟踪和结果缓存

**预计时间**：3天

### 阶段5：前端基础界面 🚧 进行中
**目标**：搭建前端应用框架

**计划工作**：
1. 配置React应用基础
   - 路由设置（React Router）
   - 状态管理（Redux Toolkit）
   - 主题配置（Ant Design）
2. 实现基础布局
   - 导航菜单设计
   - 页面容器组件
   - 响应式设计
3. 创建仪表板页面
   - 数据概览卡片
   - 最近回测列表
   - 快速操作入口

**预计时间**：4天

### 阶段6：回测功能界面 ⏳ 待开始
**目标**：实现完整的回测工作流

**计划工作**：
1. 回测配置页面
   - 股票选择器组件
   - 日期范围选择器
   - 策略参数配置表单
   - 资金设置面板
2. 回测执行页面
   - 任务提交界面
   - 进度显示组件
   - 实时日志查看器
3. 结果展示页面
   - 资金曲线图表
   - 业绩指标面板
   - 交易列表表格
   - 回撤分析图表

**预计时间**：5天

### 阶段7-10：高级功能与部署 ⏳ 待开始
- 策略管理界面（策略编辑器、历史回测对比）
- 高级功能（参数优化、多策略组合、风险管理）
- 测试和优化（单元测试、性能优化、用户体验）
- 部署和文档（生产环境配置、容器化部署、用户文档）

## 当前进度

### 已完成
- [x] 项目基础结构搭建（阶段1）
- [x] 开发环境配置（阶段1）
- [x] 代码质量工具配置（阶段1）
- [x] 数据库设计（SQL脚本）（阶段1）
- [x] 数据层开发（阶段2）
  - [x] 集成Baostock API客户端
  - [x] 设计数据库模型（Sequelize模型）
  - [x] 实现数据获取服务
  - [x] 创建数据管理命令行工具
  - [x] 数据清洗和验证逻辑
- [x] 回测引擎核心（阶段3）
  - [x] 设计回测引擎接口（事件循环、投资组合、订单执行）
  - [x] 实现基础策略框架（策略基类、信号生成、仓位管理）
  - [x] 添加常用技术指标（SMA、EMA、RSI、MACD、布林带）
  - [x] 实现性能指标计算（夏普比率、最大回撤、胜率等）
- [x] 前端基础框架搭建（阶段5）
  - [x] React + TypeScript + Ant Design项目结构
  - [x] 路由配置（仪表板、回测管理、策略管理、登录页面）
  - [x] Redux Toolkit状态管理配置（auth、backtest切片）
  - [x] API服务层和拦截器
  - [x] 基础页面组件（Dashboard、Backtest、Strategy、Login）
  - [x] 依赖冲突修复（TypeScript降级、ajv模块修复）
  - [x] 前端开发服务器启动成功（端口4000）


### 待开始
- [ ] 高级功能开发（阶段6-7）
- [ ] 测试和部署（阶段8-9）
- [ ] 文档和优化（阶段10）

## 快速开始

### 环境要求
- Node.js 18+
- Docker & Docker Compose
- PostgreSQL 14+ (通过Docker提供)
- Redis 6+ (通过Docker提供)

### 启动开发环境
```bash
# 1. 启动数据库和Redis
docker-compose up -d

# 2. 安装后端依赖
cd backend
npm install

# 3. 安装前端依赖
cd ../frontend
npm install

# 4. 启动后端开发服务器
cd ../backend
npm run dev

# 5. 启动前端开发服务器
cd ../frontend
npm start
```

### 环境配置
1. 复制环境变量模板：
   ```bash
   cp backend/.env.example backend/.env
   ```
2. 根据需要修改`.env`文件中的配置

## 项目结构
```
stocks/
├── backend/                 # 后端服务
│   ├── src/                # 源代码
│   │   ├── config/         # 配置文件
│   │   ├── data/           # 数据层
│   │   ├── backtest/       # 回测引擎
│   │   ├── api/            # API层
│   │   ├── models/         # 数据库模型
│   │   ├── services/       # 业务服务
│   │   ├── jobs/           # 后台任务
│   │   └── utils/          # 工具函数
│   ├── tests/              # 测试文件
│   ├── package.json        # 依赖配置
│   └── tsconfig.json       # TypeScript配置
├── frontend/               # 前端应用
│   ├── src/                # 源代码
│   │   ├── components/     # React组件
│   │   ├── pages/          # 页面组件
│   │   ├── store/          # 状态管理
│   │   ├── services/       # API服务
│   │   ├── hooks/          # 自定义Hooks
│   │   └── utils/          # 工具函数
│   ├── public/             # 静态资源
│   ├── package.json        # 依赖配置
│   └── tsconfig.json       # TypeScript配置
├── shared/                 # 共享代码
│   └── types/              # TypeScript类型定义
├── scripts/                # 工具脚本
│   └── init-db.sql         # 数据库初始化脚本
├── docker-compose.yml      # 容器编排配置
└── README.md               # 项目文档
```

## 依赖项

### 后端主要依赖
- `express` - Web框架
- `sequelize` + `sequelize-typescript` - ORM
- `pg` + `timescaledb` - PostgreSQL驱动和时序扩展
- `redis` + `bull` - 缓存和任务队列
- `axios` - HTTP客户端（Baostock API）
- `ta`/`tulind` - 技术指标计算
- `joi` - 数据验证
- `jsonwebtoken` + `bcrypt` - 认证加密
- `winston` - 日志记录

### 前端主要依赖
- `react` + `react-dom` - React核心
- `react-router-dom` - 路由管理
- `@reduxjs/toolkit` + `react-redux` - 状态管理
- `antd` + `@ant-design/icons` - UI组件库
- `recharts` + `lightweight-charts` - 图表库
- `axios` - HTTP客户端
- `date-fns` - 日期处理
- `monaco-editor` - 代码编辑器

## 下一步行动

1. **继续阶段2（数据层开发）**：
   - 实现Baostock API客户端
   - 完成数据库模型定义
   - 创建数据获取服务

2. **环境准备**：
   - 安装Node.js（如未安装）
   - 启动Docker容器：`docker-compose up -d`
   - 安装依赖：`npm install`（前后端分别执行）

3. **验证当前设置**：
   - 检查后端服务器能否启动：`cd backend && npm run dev`
   - 检查前端应用能否启动：`cd frontend && npm start`
   - 验证数据库连接

## 注意事项

1. **Node.js安装**：当前环境未检测到Node.js，需要先安装Node.js 18+
2. **数据源**：Baostock API需要网络连接，且可能有限制
3. **数据库**：首次启动需要运行数据库初始化脚本
4. **开发顺序**：建议按阶段顺序开发，确保基础功能完整
5. **测试**：每个阶段完成后应进行基本功能测试

## 贡献指南

1. 遵循代码规范（ESLint + Prettier）
2. 新功能需包含单元测试
3. 提交前运行完整测试套件
4. 更新相关文档

## 当前状态和下一步

### 已完成工作
1. **阶段1-4（后端核心）**：代码结构完整，但存在TypeScript编译错误
   - 数据层：Baostock API客户端、数据库模型、数据服务
   - 回测引擎：事件驱动架构、策略框架、技术指标
   - API层：用户认证、股票数据、回测管理、策略管理接口
   - 任务队列：Bull + Redis集成

2. **阶段5（前端基础界面）**：基础框架已搭建
   - React + TypeScript + Ant Design项目结构
   - 路由配置（仪表板、回测管理、策略管理、登录页面）
   - Redux Toolkit状态管理配置（auth、backtest切片）
   - API服务层（axios配置、认证拦截器）
   - 基础页面组件（Dashboard、Backtest、Strategy、Login）

### 遇到的问题和解决方案
1. **后端TypeScript编译错误** - ✅ **已完全修复**
   - 模型装饰器属性重复声明 - ✅ 为所有Sequelize模型属性添加了`declare`修饰符
   - 策略构造函数参数类型错误 - ✅ 已修正，通过类型检查
   - 技术指标类型错误 - ✅ 已修正，通过类型检查
   - 服务器现已完全基于强类型编译通过启动：`npm run dev` 成功，健康端点正常工作

2. **前端依赖冲突** - ✅ **已修复**
   - react-scripts@5.0.1与TypeScript 5.x兼容性问题
   - ajv模块缺失：`Cannot find module 'ajv/dist/compile/codegen'`
   - 解决方案：降级TypeScript到4.9.5版本，使用`npm install --legacy-peer-deps`
   - 前端依赖安装成功，正在启动开发服务器

3. **Docker环境缺失** - ❌ **仍需安装**
   - 当前环境未安装Docker，无法启动PostgreSQL和Redis
   - API端点需要数据库连接才能正常工作

### 已完成工作
✅ **后端核心修复完成**
- 批量添加`declare`修饰符到所有Sequelize模型属性
- 修复`AuthController`中的`Op`导入错误
- 安装缺失依赖：`reflect-metadata`、`ajv@8.12.0`
- 修复后端依赖问题：移除`@types/commander`，降级commander到11.0.0
- 后端服务器已成功启动：`npm run dev` ✅
- 健康端点测试通过：`curl http://localhost:3000/health` ✅

✅ **系统架构与模块设计文档化完成**
- 基于角色/模块抽象机制，生成了 `Agents.md` 文档。
- 梳理了系统的数据流（分析师 -> 研究员 -> 交易员 -> 基金经理）。
- 明确了基于 `Event.ts` 的异步事件驱动架构（BAR, SIGNAL, ORDER, FILL）。

✅ **前端基础框架搭建完成**
- 完整的页面组件：仪表板、回测管理、策略管理、登录
- Redux Toolkit状态管理配置
- API服务层和拦截器
- Ant Design UI组件集成
- 修复前端依赖冲突：降级TypeScript到4.9.5，使用`--legacy-peer-deps`安装成功
- 解决ajv模块缺失：安装ajv@8.12.0和ajv-keywords@5.1.0
- 前端开发服务器成功启动：`npm start` (端口4000) ✅

### 剩余问题
✅ **后端编译错误（已修复）**
- `BacktestController.ts`: 策略构造函数参数类型已修复
- `TechnicalIndicators.ts`: 技术指标类型定义已修复
- `BacktestEngine.ts`: 事件类型系统已优化
- 所有TypeScript类型检查现已通过 (`tsc --noEmit` 零报错)

✅ **前端启动问题** - **已解决**
- 依赖冲突已解决：TypeScript降级到4.9.5，依赖安装成功
- ajv模块缺失：安装ajv@8.12.0和ajv-keywords@5.1.0解决路径问题
- ESLint配置：安装eslint-plugin-prettier和eslint-config-prettier
- 图标修复：将不存在的`StrategyOutlined`替换为`StockOutlined`
- 端口冲突：后端占用3000端口，前端已配置为4000端口
- 前端开发服务器已成功启动：`npm start`（端口4000）✅

❌ **数据库环境缺失**
- Docker未安装，无法启动PostgreSQL和Redis
- API端点需要数据库连接

### 下一步建议
1. **验证前后端运行状态** ✅ **已完成**
   - 前端开发服务器启动验证（端口4000）✅
   - 后端API功能测试（健康端点已通过）✅
   - TypeScript 编译验证 (`tsc --noEmit` 成功通过) ✅

2. **安装Docker环境** ⚠️ **仍需安装**
   - 安装Docker Desktop for Windows
   - 启动数据库容器：`docker-compose up -d`
   - 运行数据库迁移脚本

3. **功能验证测试** ⏳ **待开始**
   - 测试API端点：用户认证、股票数据、回测管理（需要数据库）
   - 连接前后端，实现基础回测工作流
   - 验证状态管理和数据流

4. **系统架构文档化** ✅ **已完成**
   - 编写了 `Agents.md` 文件，使用角色化（Agent/Actor）比喻将回测系统核心模块进行解耦和讲解
   - 明确了数据流和事件驱动架构的流转方向

### 短期目标
- ✅ 修复编译错误，使前后端能够启动（后端已启动，前端正在启动）
- 实现基本的回测创建和列表功能（需要数据库）
- 连接前后端，实现真实数据展示（需要数据库）

### 长期目标
- 完善回测配置界面
- 实现实时回测进度监控
- 添加高级分析图表
- 部署到生产环境

## 许可证
MIT License