/**
 * check-l8-activation.ts — Sprint 27/28/29 Audit Tool
 *
 * 一行命令 audit "5 项短板代码层面解决进度":
 *   cd backend && npm run check-l8-activation
 *
 * 输出格式 (5 项, 每项 ✅ / ⚠️ / ❌):
 *   #1 PortfolioConstruction 接入 buy-decision loop
 *   #2 MetaLabel 真实特征 (breadth + benchmark drawdown)
 *   #3 ExecutionFeasibility 共享 quote 快照
 *   #4 Governor 全 sizing method 生效 (不仅 hard_cutover)
 *   #5 Activation Dashboard (L1-L8 逐 signal 可视化)
 *
 * 不依赖运行时 DB — 只 grep dist 文件 & 检查代码模式, 离线即可跑.
 */

import * as fs from 'fs';
import * as path from 'path';

interface AuditCheck {
  short_fall: number;
  title: string;
  status: '✅' | '⚠️' | '❌';
  evidence: string[];
}

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
}

function checkShortFall1(): AuditCheck {
  const adapterFile = path.join(SRC, 'portfolio/internal/PortfolioConstructionAdapter.ts');
  const automation = readFileSafe(path.join(SRC, 'portfolio/internal/PaperTradingAutomationService.ts'));
  const evidence: string[] = [];
  let pass = true;
  if (fileExists(adapterFile)) {
    evidence.push(`✓ PortfolioConstructionAdapter.ts 存在 (${fs.statSync(adapterFile).size}B)`);
  } else {
    evidence.push(`✗ PortfolioConstructionAdapter.ts 不存在`);
    pass = false;
  }
  if (automation.includes('buildPortfolioConstruction')) {
    evidence.push('✓ PaperTradingAutomationService 已 import + 调用 buildPortfolioConstruction');
  } else {
    evidence.push('✗ PaperTradingAutomationService 未接入 PortfolioConstruction');
    pass = false;
  }
  if (automation.includes('portfolioConstructionResult')) {
    evidence.push('✓ buy-decision loop 使用 portfolioConstructionResult 变量');
  }
  return {
    short_fall: 1,
    title: 'PortfolioConstruction 接入 buy-decision loop (shadow/hard mode)',
    status: pass ? '✅' : '❌',
    evidence,
  };
}

function checkShortFall2(): AuditCheck {
  const automation = readFileSafe(path.join(SRC, 'portfolio/internal/PaperTradingAutomationService.ts'));
  const evidence: string[] = [];
  let pass = true;
  // 检查是否还有 'market_breadth_score: 0' 或 'market_vol_atr: 4' 硬编码
  if (automation.match(/market_breadth_score:\s*0\b/)) {
    evidence.push('✗ market_breadth_score: 0 硬编码仍存在 (短板 #2 未解)');
    pass = false;
  } else {
    evidence.push('✓ market_breadth_score 硬编码 0 已移除');
  }
  if (automation.match(/market_vol_atr:\s*4\b/)) {
    evidence.push('✗ market_vol_atr: 4 硬编码仍存在 (短板 #2 未解)');
    pass = false;
  } else {
    evidence.push('✓ market_vol_atr 硬编码 4 已移除');
  }
  if (automation.includes('up_20d_ratio')) {
    evidence.push('✓ 改用真实 environment.breadth.up_20d_ratio');
  } else {
    pass = false;
  }
  if (automation.includes('benchmark_drawdown_60d_pct')) {
    evidence.push('✓ 改用真实 environment.benchmark_drawdown_60d_pct');
  }
  if (automation.includes('features_used')) {
    evidence.push('✓ features_used 存到 activation L3 detail (dashboard 可见)');
  }
  return {
    short_fall: 2,
    title: 'MetaLabel 真实特征 (breadth + benchmark vol 代理)',
    status: pass ? '✅' : '❌',
    evidence,
  };
}

function checkShortFall3(): AuditCheck {
  const automation = readFileSafe(path.join(SRC, 'portfolio/internal/PaperTradingAutomationService.ts'));
  const evidence: string[] = [];
  let pass = true;
  if (automation.includes('market_snapshot:')) {
    evidence.push('✓ computeFeasibility 接收 market_snapshot 字段');
  } else {
    evidence.push('✗ computeFeasibility 未传 market_snapshot');
    pass = false;
  }
  if (automation.includes('snapshot_source')) {
    evidence.push('✓ snapshot_source 字段记录到 activation L5 detail');
  }
  // 检查 getLatestPrice 是否扩展了字段
  if (automation.match(/open\?:\s*number/) && automation.match(/volume\?:\s*number/)) {
    evidence.push('✓ getLatestPrice 已扩展返回 open/high/low/volume/turnover');
  } else {
    evidence.push('⚠ getLatestPrice 未扩展返回字段');
    pass = false;
  }
  return {
    short_fall: 3,
    title: 'ExecutionFeasibility 与下单共享同份 quote 快照',
    status: pass ? '✅' : '❌',
    evidence,
  };
}

function checkShortFall4(): AuditCheck {
  const automation = readFileSafe(path.join(SRC, 'portfolio/internal/PaperTradingAutomationService.ts'));
  const evidence: string[] = [];
  let pass = true;
  // 检查 governor multiplier 是否在 sizing block 外 (短板 #4 解法)
  // 旧代码: governor 在 'if (sizingPolicy.hard_cutover_enabled && shadowSizingDecision.position_pct > 0)' 内
  // 新代码: governor 在 sizing try-catch 之后, tradeRisk 之前.
  // Anchor: 找 sizing-catch 注释 + governor 移出后的标志注释 + tradeRisk 二次出现
  // (preTradeRisk 在更早, 用 evaluateEntryRiskGuard 第二次 occurrence)
  const sizingCatchIdx = automation.indexOf('shadow 不影响主流程，失败仅 warn');
  const governorIdx = automation.indexOf('EquityCurveGovernor multiplier 对所有');
  // 找第 2 个 evaluateEntryRiskGuard occurrence (跳过 preTradeRisk)
  const firstRiskIdx = automation.indexOf('this.evaluateEntryRiskGuard');
  const tradeRiskIdx =
    firstRiskIdx > 0
      ? automation.indexOf('this.evaluateEntryRiskGuard', firstRiskIdx + 1)
      : -1;
  if (sizingCatchIdx > 0 && governorIdx > 0 && tradeRiskIdx > 0) {
    if (sizingCatchIdx < governorIdx && governorIdx < tradeRiskIdx) {
      evidence.push('✓ Governor multiplier 已移出 sizing block (在 sizing-catch 之后, tradeRisk 之前)');
      evidence.push('✓ 所有 sizing method (含默认 equal_pct) 都过 governor');
    } else {
      evidence.push(
        `✗ Governor 位置异常 (sizing-catch=${sizingCatchIdx} / governor=${governorIdx} / tradeRisk=${tradeRiskIdx} 顺序不对)`
      );
      pass = false;
    }
  } else {
    evidence.push(
      `⚠ 找不到标志注释 (sizing-catch=${sizingCatchIdx}, governor=${governorIdx}, tradeRisk=${tradeRiskIdx})`
    );
    pass = false;
  }
  return {
    short_fall: 4,
    title: 'Governor 对默认 sizing 也生效 (不仅 hard_cutover 分支)',
    status: pass ? '✅' : '❌',
    evidence,
  };
}

function checkShortFall5(): AuditCheck {
  const evidence: string[] = [];
  let pass = true;
  const activationFile = path.join(SRC, 'portfolio/internal/l8-activation.ts');
  const dashboardFile = path.join(__dirname, '../../../frontend/src/components/data/ActivationDashboard.tsx');
  const controllerFile = path.join(SRC, 'api/controllers/PaperTradingController.ts');
  if (fileExists(activationFile)) {
    evidence.push(`✓ l8-activation.ts 存在 (${fs.statSync(activationFile).size}B)`);
  } else {
    pass = false;
  }
  if (fileExists(dashboardFile)) {
    evidence.push(`✓ ActivationDashboard.tsx 存在 (${fs.statSync(dashboardFile).size}B)`);
  } else {
    evidence.push(`✗ ActivationDashboard.tsx 不存在`);
    pass = false;
  }
  const controllerSrc = readFileSafe(controllerFile);
  if (controllerSrc.includes('getActivationSummary')) {
    evidence.push('✓ GET /api/paper-trading/activation-summary endpoint 已实现');
  } else {
    pass = false;
  }
  const automation = readFileSafe(path.join(SRC, 'portfolio/internal/PaperTradingAutomationService.ts'));
  if (automation.includes('l8_activation: activation')) {
    evidence.push('✓ buy-decision loop 注入 l8_activation 到 orderIntentMetadata');
  } else {
    pass = false;
  }
  return {
    short_fall: 5,
    title: 'Activation Dashboard — L1-L8 逐 signal 可视化',
    status: pass ? '✅' : '❌',
    evidence,
  };
}

function main(): void {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('   L8 Activation Audit — Sprint 27/28/29 解决进度检查');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  const checks = [
    checkShortFall1(),
    checkShortFall2(),
    checkShortFall3(),
    checkShortFall4(),
    checkShortFall5(),
  ];
  let passed = 0;
  for (const c of checks) {
    console.log(`${c.status}  #${c.short_fall} ${c.title}`);
    for (const e of c.evidence) {
      console.log(`     ${e}`);
    }
    console.log('');
    if (c.status === '✅') passed += 1;
  }
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`总计 ${passed}/5 短板已解决.`);
  console.log('───────────────────────────────────────────────────────────────');
  process.exit(passed === 5 ? 0 : 1);
}

main();
