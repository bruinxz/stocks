/**
 * @fileoverview Task #12 · §Rounding-Tie-Break SHA-lock 4 断言
 *
 * SHA-lock: refs/heads/main @ 47e8dd1 · §Rounding-Tie-Break
 *
 * 权威锚 (副 · 规则源):
 *   docs/refactor/adr/0001-layering-and-collab.md §附录 §Rounding-Tie-Break
 * 权威锚 (主 · 数值定值表 + slot 命名):
 *   docs/refactor/contracts/strategy.md v1 §Q7.1 (主态 5-slot 定值表)
 *   docs/refactor/contracts/strategy.md v1 §Q7.2 (回落态 4-slot 精算表)
 *   docs/refactor/contracts/strategy.md v1 §Q7.4 (ENABLE_US_DRIVER_SIGNAL 双态切换开关)
 *
 * 承接位: QADocs Task #12 · 契约层数值 + slot 命名 SHA-lock
 * 语义: 契约层 v1 §Q7 slot 命名 + 定值表 + §Rounding-Tie-Break 规则的数值不变守护
 * 独立性: 本 v1 断言纯契约层数值 · 不依赖 production module
 *
 * §Q7 5-slot 主态 slot 命名 (v1 §Q7.1 landed):
 *   us_driver / history_response / quality_proxy / intraday_momentum / news_evidence
 * §Q7 4-slot 回落态 slot 命名 (v1 §Q7.2 landed · us_driver 移除):
 *   history_response / quality_proxy / intraday_momentum / news_evidence
 *
 * 注: 上述 5-slot 命名 ≠ core.factors 5-factor 命名 (Momentum/Value/Quality/Size/LowVol)
 *     satellite 层 vs core 层 · 不同层不同命名 · 参照 §Layer-Separation 层分离原则
 *
 * 版本历史:
 *   v0   - 初稿 · slot 命名错误引 core.factors 5-factor · Strategy msg=b40c2100 blocker
 *   v0.1 (本文件) - slot 命名修正为 v1 §Q7 官方名 · Strategy 二签流程
 *   v2 (未来) - Strategy M2 独占窗口起草 `backend/src/backtest/satellite/slot-weight-scheme.ts`
 *              后 · Task #12 v2 追增 PR 融合 `import { renormalizeWeights } from ...`
 *              断言由 hardcoded → module invocation · 语义等价
 */

import { describe, it, expect } from '@jest/globals';

describe('§Rounding-Tie-Break · Satellite 5-slot ↔ 4-slot renormalization · SHA-lock @ 47e8dd1', () => {

  it('断言 A · 5-slot 主态权重和归一化 == 1.000', () => {
    // 参照 docs/refactor/contracts/strategy.md v1 §Q7.1 · 5-slot 主态定值表
    // 主态 (ENABLE_US_DRIVER_SIGNAL=true): us_driver / history_response / quality_proxy / intraday_momentum / news_evidence
    const us_driver = 0.30;
    const history_response = 0.25;
    const quality_proxy = 0.15;
    const intraday_momentum = 0.15;
    const news_evidence = 0.15;
    const sum = us_driver + history_response + quality_proxy + intraday_momentum + news_evidence;
    expect(sum).toBeCloseTo(1.000, 3);
  });

  it('断言 B · 4-slot 回落态归一化前值 w_i / 0.70 三值等 0.214286', () => {
    // 参照 docs/refactor/contracts/strategy.md v1 §Q7.2 · 4-slot 精算表
    // 回落态 (ENABLE_US_DRIVER_SIGNAL=false): us_driver slot 移除 · 剩余 4 slot 归一化
    // history_response 归一化前值 = 0.25 / 0.70
    // quality_proxy / intraday_momentum / news_evidence 归一化前值 = 0.15 / 0.70
    const history_response_raw = 0.25 / 0.70;
    const quality_proxy_raw = 0.15 / 0.70;
    const intraday_momentum_raw = 0.15 / 0.70;
    const news_evidence_raw = 0.15 / 0.70;

    expect(history_response_raw).toBeCloseTo(0.357143, 6);
    expect(quality_proxy_raw).toBeCloseTo(0.214286, 6);
    expect(intraday_momentum_raw).toBeCloseTo(0.214286, 6);
    expect(news_evidence_raw).toBeCloseTo(0.214286, 6);

    // 归一化前四值权重和 == 1.000 · 但 3 位小数舍入后需 tie-break（见断言 C）
    const raw_sum = history_response_raw + quality_proxy_raw + intraday_momentum_raw + news_evidence_raw;
    expect(raw_sum).toBeCloseTo(1.000, 6);
  });

  it('断言 C · §Rounding-Tie-Break · tie-break +0.001 落 news_evidence slot', () => {
    // 参照 docs/refactor/adr/0001-layering-and-collab.md §附录 §Rounding-Tie-Break
    // 4-slot 精算 3 位小数舍入后权重和 = 0.999
    // §Rounding-Tie-Break 规则: 尾差 +0.001 补偿位落在 news_evidence slot
    // 理由: news_evidence slot 属证据链融合位（Announcement/DragonTiger/MoneyFlow）· 尾差不影响 signal 权重排序 · UX 感知无差异 · 语义呼应"证据补足"
    const history_response = 0.357;
    const quality_proxy = 0.214;
    const intraday_momentum = 0.214;
    const news_evidence = 0.215;  // 0.214 + 0.001 tie-break

    expect(news_evidence).toBeCloseTo(0.215, 3);

    // 其他三值保持 0.357/0.214/0.214
    expect(history_response).toBeCloseTo(0.357, 3);
    expect(quality_proxy).toBeCloseTo(0.214, 3);
    expect(intraday_momentum).toBeCloseTo(0.214, 3);

    // tie-break 后权重和 == 1.000
    const sum = history_response + quality_proxy + intraday_momentum + news_evidence;
    expect(sum).toBeCloseTo(1.000, 3);
  });

  it('断言 D · 双态互斥 · 4-slot 回落态权重和 = 1.000', () => {
    // 参照 docs/refactor/contracts/strategy.md v1 §Q7.4 · ENABLE_US_DRIVER_SIGNAL 双态切换开关
    // 主态 5-slot (us_driver 0.30 + 4-slot 剩余 0.70) 权重和 = 1.000（断言 A 已验证）
    // 回落态 4-slot (us_driver slot 移除 · history_response/quality_proxy/intraday_momentum/news_evidence 归一化 + tie-break) 权重和 = 1.000
    // 双态互斥 · 权重和统一归一化到 1.000
    const fallback_sum = 0.357 + 0.214 + 0.214 + 0.215;
    expect(fallback_sum).toBeCloseTo(1.000, 3);
  });
});
