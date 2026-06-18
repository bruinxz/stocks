/**
 * 外部服务基址集中常量 (audit L-19 修复, 2026-06-18).
 *
 * 在引入本模块前, `TRADING_AGENTS_URL` 在 10+ 处文件中各自硬编码
 * `process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000'`,
 * 内部 IP 被多次暴露在 git 历史中, 且换服务器需要改 10+ 处.
 *
 * 本模块约定: **任何调用 TradingAgents AI 远端的代码必须 import 这里的
 * `TRADING_AGENTS_BASE_URL` 常量, 不再自己 hardcode 默认值**. CI lint 可加
 * grep 兜底: `rg "TRADING_AGENTS_URL.*\|\|.*http" backend/src/` 应只命中本文件.
 *
 * 默认值改成 `http://127.0.0.1:8000` (loopback):
 *   - 不暴露任何内网 IP;
 *   - 本地开发默认值, 引导开发者起本机 TradingAgents 服务;
 *   - 生产环境必须通过 `.env` / Kubernetes secret 显式指定真实地址 (EnvValidator
 *     已校验 `TRADING_AGENTS_URL` 为必填 uri, 见 `EnvValidator.ts:139`),
 *     loopback 默认在 prod 永远不会被使用.
 *
 * 未来扩展: 若 backend 接入其他外部 service (例如 broker bridge / OpenAI 代理 /
 * KOL 提供方), 都集中到本文件; 让 `config/` 目录里只有这一处 "外部 base url" 定义.
 */

/**
 * TradingAgents AI 远端 base URL (无尾部 `/`).
 *
 * 用例: `axios.post(\`\${TRADING_AGENTS_BASE_URL}/api/analyze\`, ...)`.
 *
 * 优先级 env > 默认 loopback. EnvValidator 在启动时校验 prod 环境下 env 必填,
 * 因此默认值仅在本地开发 / 单测下生效.
 */
export const TRADING_AGENTS_BASE_URL: string =
  process.env.TRADING_AGENTS_URL || 'http://127.0.0.1:8000';
