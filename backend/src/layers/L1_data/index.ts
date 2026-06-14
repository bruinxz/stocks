/**
 * Layer L1 — Data Layer (数据接入)
 *
 * 数据 ingestion / 持久化 / 健康检查 / 数据质量. 是所有上层 layer 的输入源.
 *
 * 包含 (示例): DailyBar / Fundamental / Northbound / DragonTiger /
 * limit-up 数据接入服务. 当前阶段只 re-export 入口型 service, 详细 ingestion
 * job 放在 jobs/ 与 scripts/ 不属本层.
 *
 * 依赖: 无 (最底层)
 * 被依赖: L2 / L3 / L4 / L5 / L6 / L7 / L8 都可读
 */

// A-share PIT data (Sprint 23) — 财务发布期限 + lookahead 检测 + 指数成分历史
export * from '../../services/research/ashare-pit-capacity';
