/**
 * TradingAgents 已作为本仓 `ai/tradingagents-app` 的受管运行时部署在同机 loopback。
 * 后端不再接受远程 URL 覆盖，避免发布后仍悄悄依赖旧独立仓库或失联内网地址。
 */
export const TRADING_AGENTS_BASE_URL = 'http://127.0.0.1:8000' as const;
