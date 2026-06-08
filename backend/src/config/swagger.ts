/**
 * swagger.ts — US-070 运维：API 接口文档自动生成（OpenAPI）
 *
 * 设计要点：
 *  1. **swagger-jsdoc** 从 routes 文件里扫描 `@openapi` JSDoc 注释 → 拼装 OpenAPI 3.0 spec。
 *  2. **swagger-ui-express** 在 `/api-docs` 暴露交互式 UI（仅 development 模式，避免 production
 *     泄露内部 endpoint 列表 + 不需鉴权方便联调）。
 *  3. **公共 schemas / securitySchemes** 在此文件集中定义，路由 JSDoc 用 `$ref` 引用，避免每个
 *     endpoint 重复写 `{success, data, message}` envelope schema。
 *  4. **CLI 入口 `npm run docs:openapi`** 直接 import 本文件的 `buildOpenApiSpec()`，输出 JSON
 *     到 `docs/openapi.json`，不需要启动整个 Express 服务。
 *  5. **下次扩展新 route 文件时只需**：(a) 在 routes/*.ts 加 `@openapi` JSDoc；(b) 如果是
 *     全新业务领域则在下面 `tags` 数组加一项分类（让 UI 分组清晰）。无需修改 swagger config 本身。
 *  6. **schema 命名约定**：复用既有 model + DTO 时直接给 `components.schemas.<ModelName>`
 *     占位即可（先粗后细，避免一次性写完 80+ schemas 拖慢迭代）。
 */

import swaggerJSDoc from 'swagger-jsdoc';
import path from 'path';

// OpenAPI 3.0 base info — 与 package.json `name/version` 对齐，让 docs 与代码同步
const OPENAPI_INFO = {
  title: 'A-Share Stock Backtesting & Quant Platform API',
  version: '1.0.0',
  description: [
    'A-share 量化平台后端 REST API。',
    '',
    '主要业务领域：',
    '- **认证 & 用户**：登录/注册/JWT 刷新',
    '- **回测 & 策略**：单股回测、组合级策略、参数优化',
    '- **因子**：因子库管理、IC 报告、相关性矩阵',
    '- **模拟交易**：持仓、订单、风控守卫',
    '- **量化引擎**：StrategyEngine / SignalEngine / BacktestEngine 等 5 大 facade',
    '- **数据 & 行情**：股票元信息、K 线、实时行情、龙虎榜、北向资金',
    '- **AI**：TradingAgents 深度分析、KOL 观点、公告 NLP、市场情绪',
    '- **推送 & 告警**：飞书 / 邮件 / 微信 / 短信 4 channel',
    '- **运维 & 监控**：env 校验、CI 状态、健康度检查',
    '',
    '所有 endpoint 默认返回 `{ success: boolean, data?: any, message?: string }` envelope。',
    '需要鉴权的 endpoint 需在 Header 携带 `Authorization: Bearer <JWT>`。',
  ].join('\n'),
  contact: {
    name: 'QuantX A-Share Alpha Refactor',
  },
};

// 业务分类 tags — UI 分组依据，新增大类时在此扩展
const OPENAPI_TAGS = [
  { name: '认证 Auth', description: '登录 / 注册 / Token 刷新 / 头像上传' },
  { name: '股票 Stocks', description: '股票元信息 / K 线 / 实时行情' },
  { name: '回测 Backtests', description: '单股回测任务管理' },
  { name: '策略 Strategies', description: '策略列表 / 详情 / 多因子选股' },
  { name: '组合 Portfolio', description: '用户组合的持仓与资金' },
  { name: '行情 Market', description: '市场快照 / 指数 / 板块 / 龙虎榜' },
  { name: 'AI 分析', description: 'TradingAgents 深度分析 / Copilot / 复盘' },
  { name: '任务 Tasks', description: '异步任务队列管理（数据同步 / 回测 / AI）' },
  { name: '模拟交易 PaperTrading', description: '组合视图 / 下单 / 自动化 / 风控档案' },
  { name: '告警 RiskAlert', description: '风控告警列表 / 已读 / 未读' },
  { name: '风控 Risk', description: 'pre-trade 风控策略配置（持仓上限 / 追踪止损 / 熔断）' },
  { name: '日记 Journals', description: '复盘日记 CRUD' },
  { name: '用户 Users', description: '用户配置 / 自选股 / 偏好' },
  { name: '日志 Logs', description: '系统日志查询' },
  { name: 'Internal', description: 'TradingAgents 内网回调接口（仅服务端使用）' },
  {
    name: '量化 Quant',
    description: 'StrategyEngine / SignalEngine / BacktestEngine 等 5 大 facade',
  },
  { name: '今日作战 Today', description: '今日信号清单 + 一键应用' },
  { name: '复盘 Review', description: '事后业绩归因' },
  { name: '研究 StrategyResearch', description: '策略研究中心' },
  { name: '信号 SignalTrace', description: '信号追踪与审计' },
  { name: '实盘 LiveTrading', description: '实盘账户 / 持仓 / 订单（券商对接）' },
  { name: '因子 Factors', description: '因子库 / 横截面 / IC 报告 / 相关性' },
  { name: '情绪 Sentiment', description: '市场情绪指数 / 雪球热词 / KOL 观点' },
  { name: '公告 Announcements', description: '上市公司公告 NLP' },
  { name: '设置 Settings', description: '推送渠道 / 微信绑定 / 通知偏好' },
];

// 公共 components — schemas / securitySchemes
const COMMON_COMPONENTS = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        '在 Authorization Header 携带 `Bearer <JWT>`。Token 通过 `/api/auth/login` 获取。',
    },
  },
  schemas: {
    // 公共 envelope
    SuccessResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: true },
        data: { type: 'object', description: '业务数据（结构因 endpoint 而异）' },
        message: { type: 'string', example: '操作成功' },
      },
    },
    ErrorResponse: {
      type: 'object',
      properties: {
        success: { type: 'boolean', example: false },
        message: { type: 'string', example: '错误描述' },
        errors: { type: 'array', items: { type: 'object' }, description: '详细错误列表（可选）' },
      },
    },
    Pagination: {
      type: 'object',
      properties: {
        page: { type: 'integer', example: 1 },
        page_size: { type: 'integer', example: 20 },
        total: { type: 'integer', example: 100 },
        total_pages: { type: 'integer', example: 5 },
      },
    },
    // 常用业务对象（占位 — 后续按需细化字段）
    User: {
      type: 'object',
      properties: {
        id: { type: 'integer', example: 1 },
        username: { type: 'string', example: 'demo_user' },
        email: { type: 'string', example: 'demo@example.com' },
        avatar_url: { type: 'string', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
    Stock: {
      type: 'object',
      properties: {
        symbol: { type: 'string', example: '600519.SH' },
        stock_code: { type: 'string', example: '600519' },
        name: { type: 'string', example: '贵州茅台' },
        industry: { type: 'string', example: '白酒' },
        market: { type: 'string', example: 'SH' },
        is_listed: { type: 'boolean', example: true },
      },
    },
    Portfolio: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        user_id: { type: 'integer' },
        name: { type: 'string' },
        cash: { type: 'number', format: 'float' },
        total_value: { type: 'number', format: 'float' },
        positions: { type: 'array', items: { $ref: '#/components/schemas/Position' } },
      },
    },
    Position: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        quantity: { type: 'integer' },
        avg_cost: { type: 'number' },
        current_price: { type: 'number' },
        market_value: { type: 'number' },
        gain_pct: { type: 'number' },
      },
    },
    RiskAlert: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        user_id: { type: 'integer' },
        symbol: { type: 'string' },
        rule_id: { type: 'string' },
        level: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        message: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
        is_read: { type: 'boolean' },
      },
    },
    Backtest: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        user_id: { type: 'integer' },
        name: { type: 'string' },
        symbols: { type: 'array', items: { type: 'string' } },
        start_date: { type: 'string', format: 'date' },
        end_date: { type: 'string', format: 'date' },
        initial_capital: { type: 'number' },
        status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed'] },
        sharpe_ratio: { type: 'number' },
        annual_return: { type: 'number' },
        max_drawdown: { type: 'number' },
      },
    },
    FactorScore: {
      type: 'object',
      properties: {
        stock_code: { type: 'string' },
        factor_name: { type: 'string' },
        factor_date: { type: 'string', format: 'date' },
        raw_value: { type: 'number', nullable: true },
        z_score: { type: 'number' },
        percentile: { type: 'number' },
      },
    },
    Journal: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        user_id: { type: 'integer' },
        review_date: { type: 'string', format: 'date' },
        mood: { type: 'string' },
        notes: { type: 'string' },
        ai_summary: { type: 'string' },
      },
    },
  },
};

/**
 * 构建 OpenAPI 3.0 spec —— 扫描所有 routes/*.ts 里的 `@openapi` JSDoc 注释。
 *
 * 默认 servers 列出 development URL；production / staging 部署时可通过环境变量覆盖
 * （让 Swagger UI "Try it out" 直接打到对应环境）。
 */
export function buildOpenApiSpec(): object {
  const apiBaseUrl =
    process.env.SWAGGER_API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // routes 的绝对路径 — 使用 backend/src/api/routes/*.ts 通配
  // 注意：dist/ 也保留同名 *.js 让 production 启动时也能扫描（虽然 production 不暴露 /api-docs）
  const apisGlob = [
    path.resolve(__dirname, '../api/routes/*.ts'),
    path.resolve(__dirname, '../api/routes/*.js'),
    path.resolve(__dirname, '../live-trading/routes/*.ts'),
    path.resolve(__dirname, '../live-trading/routes/*.js'),
  ];

  const options: swaggerJSDoc.Options = {
    definition: {
      openapi: '3.0.3',
      info: OPENAPI_INFO,
      servers: [
        {
          url: apiBaseUrl,
          description: process.env.NODE_ENV === 'production' ? 'Production' : 'Development (本地)',
        },
      ],
      tags: OPENAPI_TAGS,
      components: COMMON_COMPONENTS,
      security: [{ bearerAuth: [] }],
    },
    apis: apisGlob,
  };

  return swaggerJSDoc(options);
}

/**
 * 判断是否应该暴露 Swagger UI —— production 默认禁用避免暴露内部 endpoint 列表。
 * 通过环境变量 `ENABLE_SWAGGER_UI=true` 可在 production 也强制开启（少见场景）。
 */
export function shouldExposeSwaggerUI(): boolean {
  const force = String(process.env.ENABLE_SWAGGER_UI || '').toLowerCase() === 'true';
  if (force) return true;
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return env !== 'production';
}
