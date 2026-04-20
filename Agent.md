# Agent 会话上下文备忘录

## 1. 项目基础架构状态
*   **技术栈**: 
    *   前端: React (基于 `react-scripts` / Webpack)
    *   后端: Node.js, Express, TypeScript, Sequelize (ORM)
    *   数据库: PostgreSQL 14 (`stock_backtest` 数据库)
    *   缓存: Redis (默认监听本地 6379)
    *   量化依赖: Python 3 + `akshare`
*   **本地开发运行端口**:
    *   前端: `3001` (使用 `PORT=3001 npm start` 启动)
    *   后端: `3000` (使用 `npm run dev` 启动)

## 2. 关键路径与环境配置
*   **前端环境变量**: [frontend/.env.development.local](frontend/.env.development.local) 必须配置 `REACT_APP_API_BASE_URL=http://localhost:3000/api`，否则会请求到远端的 `103.242.3.87:3000`。
*   **后端环境变量**: [backend/.env](backend/.env) 包含 PG 数据库连接信息 (`postgres:postgres`)、Redis 端口 (`6379`)，以及 JWT_SECRET。

## 3. 核心机制排查与修复记录
### 数据库同步与初始化 ( Sequelize )
*   开发模式下 (`NODE_ENV=development`)，后端启动时 ([backend/src/index.ts](backend/src/index.ts)) 会通过 `sequelize.sync({ alter: true })` 自动同步表结构。
*   **初始管理员账号注入**: 在 `index.ts` 启动时，如果 `users` 表为空，会自动插入两个初始管理员账号：
    *   `xz` (密码 `666`)
    *   `lym` (密码 `666`)
    *   **避坑注意**: `User.ts` 模型中有 `@BeforeCreate` 钩子会自动对密码进行 bcrypt hash，所以在 `index.ts` 中直接插入明文 `666` 即可，绝对不能在插入前手动进行 `bcrypt.hash`，否则会导致双重哈希引起登录时始终报 `401 Unauthorized` 密码错误。

### TypeScript / Sequelize 模型定义 ( Models )
*   **避坑注意**: Sequelize 模型中使用 `!:` 声明公共类字段（如 `declare role: string;` 或 `role!: string;`）时，**必须加上 `declare` 关键字**，例如 `declare direction: TradeDirection;`，否则这些类字段会屏蔽（shadow）Sequelize 底层的 `getters & setters`，导致插入数据库时该字段为 `null`。
    *   *历史操作记录*: 已经使用 `perl -pi -e 's/([a-zA-Z0-9_]+)!: ([a-zA-Z0-9_\[\]]+);/declare $1: $2;/g'` 批量修复了 `src/models/` 目录下所有遗漏 `declare` 的 `!:` 声明。

### 身份认证 ( Authentication )
*   认证中间件位于 [backend/src/middlewares/auth.ts](backend/src/middlewares/auth.ts)，最终调用 `AuthController.authenticate` ([backend/src/api/controllers/AuthController.ts](backend/src/api/controllers/AuthController.ts))。
*   所有的受保护路由（如 `/api/market/favorites`、`/api/backtests` 等）必须显式在路由层引入并调用 `authController.authenticate`。
*   移除了开发环境中的“无感后门”，当前环境必须携带合法的 `Bearer Token` 才能访问。

## 4. 下一步开发/排查建议
*   如果遇到数据库相关报错（如表不存在、字段不存在），可以尝试在后端执行 `DROP DATABASE stock_backtest; CREATE DATABASE stock_backtest;` 后重启后端触发 `alter: true` 同步。
*   如果启动端口冲突，使用 `lsof -i :3000` / `lsof -i :3001` 找出 PID 并 `kill -9`。
