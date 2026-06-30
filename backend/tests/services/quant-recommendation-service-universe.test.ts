/**
 * PR-N (2026-06-29) quant-recommendation-service-universe tests.
 *
 * 验证 applyBoardDiversity 纯函数 + 默认配置, 解决 PR-J 揭示的"存储模块 11/11
 * 0 推荐"根因. 不依赖 DB / Sequelize / fixture.
 *
 * 覆盖矩阵:
 *  [1] stocks.length ≤ limit → 返原数组拷贝 (无多样性)
 *  [2] diversityPct=0 → 退回 slice(0, limit)
 *  [3] 默认 25% diversity → main + star + chinext + bj 均有保留
 *  [4] 单一板块 (全 main) → 输出 == slice(0, limit)
 *  [5] sh.688 / sz.30x 票真能被 diversity selector 选中 (PR-J 关键回归)
 *  [6] round-robin 顺序: star → chinext → bj → main (小板块优先)
 *  [7] picked 不重复 (Set 唯一性)
 *  [8] 极端 limit (1) + diversity 25% → 仍能产出至少 1 票
 *  [9] empty input → []
 * [10] DEFAULT_BOARD_DIVERSITY_PCT 常量值 === 0.25
 */

import {
  applyBoardDiversity,
  DEFAULT_BOARD_DIVERSITY_PCT,
} from '../../src/services/QuantRecommendationService';

let ok = 0;
let fail = 0;

function expectEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    ok += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

function expectTrue(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    ok += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ' ' + detail : ''}`);
  }
}

type Stub = { symbol: string };

function s(sym: string): Stub {
  return { symbol: sym };
}

function symbols(stocks: Stub[]): string[] {
  return stocks.map(x => x.symbol);
}

async function main(): Promise<void> {
  // [1] stocks.length ≤ limit → 返原数组拷贝
  console.log('[1] stocks.length ≤ limit → 原数组拷贝...');
  {
    const input = [s('sh.600519'), s('sz.000001')];
    const out = applyBoardDiversity(input, 10);
    expectEqual('=== 全部输入', symbols(out), symbols(input));
    expectTrue('不是同一引用 (拷贝)', out !== input);
  }

  // [2] diversityPct=0 → 退回 slice(0, limit)
  console.log('[2] diversityPct=0 → slice(0, limit)...');
  {
    const input = [
      s('sh.600519'),
      s('sh.600000'),
      s('sh.688008'),
      s('sz.300750'),
      s('sz.001234'),
    ];
    const out = applyBoardDiversity(input, 2, 0);
    expectEqual('前 2 个原序', symbols(out), ['sh.600519', 'sh.600000']);
  }

  // [3] 默认 25% diversity → main + star + chinext + bj 均有保留
  console.log('[3] 默认 25% 多样性 → 4 板都有保留...');
  {
    const mains = Array.from({ length: 30 }, (_, i) => s(`sh.${String(600000 + i).padStart(6, '0')}`));
    const stars = Array.from({ length: 5 }, (_, i) => s(`sh.${String(688000 + i).padStart(6, '0')}`));
    const chinexts = Array.from({ length: 5 }, (_, i) => s(`sz.${String(300000 + i).padStart(6, '0')}`));
    const bjs = Array.from({ length: 5 }, (_, i) => s(`bj.${String(920000 + i).padStart(6, '0')}`));
    const input = [...mains, ...stars, ...chinexts, ...bjs];
    const out = applyBoardDiversity(input, 20, 0.25);
    expectEqual('total = 20', out.length, 20);
    const hasStar = out.some(x => x.symbol.startsWith('sh.688'));
    const hasChinext = out.some(x => x.symbol.startsWith('sz.30'));
    const hasBj = out.some(x => x.symbol.startsWith('bj.'));
    const hasMain = out.some(x => x.symbol.startsWith('sh.6') && !x.symbol.startsWith('sh.68'));
    expectTrue('包含 star (sh.688)', hasStar);
    expectTrue('包含 chinext (sz.30)', hasChinext);
    expectTrue('包含 bj (bj.)', hasBj);
    expectTrue('包含 main (sh.6)', hasMain);
  }

  // [4] 单一板块 (全 main) → 输出 == slice(0, limit)
  console.log('[4] 单一板块 → slice 一致...');
  {
    const mains = Array.from({ length: 20 }, (_, i) => s(`sh.${String(600000 + i).padStart(6, '0')}`));
    const out = applyBoardDiversity(mains, 5, 0.25);
    expectEqual('全 main 板块', symbols(out), symbols(mains.slice(0, 5)));
  }

  // [5] sh.688 / sz.30x 票真能被 diversity selector 选中 (PR-J 关键回归).
  //     sz.001 (深主板 001) 按 inferMarketSegment 归 'main' 桶 — PR-J 对 sz.001
  //     的修复主要靠 candidate pool limit 1000→2000 (在 getCandidateStocks SQL).
  console.log('[5] PR-J 关键回归: sh.688 + sz.30x 入选...');
  {
    // 模拟 PR-J 现场: 候选池前 100 票按 change_percent DESC 都是主板, sh.688
    // 的存储票排在第 200-210 (change_percent stale 让排序靠后).
    const front = Array.from({ length: 100 }, (_, i) =>
      s(`sh.${String(600000 + i).padStart(6, '0')}`)
    );
    const storageStars = ['sh.688008', 'sh.688123', 'sh.688256', 'sh.688981', 'sh.688107'].map(s);
    const middle = Array.from({ length: 90 }, (_, i) =>
      s(`sh.${String(601000 + i).padStart(6, '0')}`)
    );
    const sz301 = [s('sz.301888'), s('sz.301999')];
    const back = Array.from({ length: 90 }, (_, i) =>
      s(`sh.${String(603000 + i).padStart(6, '0')}`)
    );
    const input = [...front, ...storageStars, ...middle, ...sz301, ...back];
    const out = applyBoardDiversity(input, 20, 0.25);
    expectEqual('总数 = 20', out.length, 20);
    expectTrue(
      '选中至少 1 只 sh.688 存储票 (老逻辑必淘汰)',
      out.some(x => x.symbol.startsWith('sh.688'))
    );
    expectTrue(
      '选中至少 1 只 sz.301 (老逻辑也淘汰)',
      out.some(x => x.symbol.startsWith('sz.301'))
    );
  }

  // [6] round-robin 顺序: star → chinext → bj → main (小板块优先)
  console.log('[6] round-robin 顺序: star → chinext → bj → main...');
  {
    const stars = Array.from({ length: 5 }, (_, i) => s(`sh.${String(688000 + i).padStart(6, '0')}`));
    const chinexts = Array.from({ length: 5 }, (_, i) => s(`sz.${String(300000 + i).padStart(6, '0')}`));
    const bjs = Array.from({ length: 5 }, (_, i) => s(`bj.${String(920000 + i).padStart(6, '0')}`));
    const mains = Array.from({ length: 5 }, (_, i) => s(`sh.${String(600000 + i).padStart(6, '0')}`));
    const input = [...stars, ...chinexts, ...bjs, ...mains];
    const out = applyBoardDiversity(input, 8, 1.0);
    const seq = out.map(x => {
      if (x.symbol.startsWith('sh.688')) return 'star';
      if (x.symbol.startsWith('sz.30')) return 'chinext';
      if (x.symbol.startsWith('bj.')) return 'bj';
      return 'main';
    });
    expectEqual(
      'round-robin 顺序',
      seq,
      ['star', 'chinext', 'bj', 'main', 'star', 'chinext', 'bj', 'main']
    );
  }

  // [7] picked 不重复
  console.log('[7] 输出 stocks 不重复...');
  {
    const mains = Array.from({ length: 30 }, (_, i) => s(`sh.${String(600000 + i).padStart(6, '0')}`));
    const stars = Array.from({ length: 30 }, (_, i) => s(`sh.${String(688000 + i).padStart(6, '0')}`));
    const input = [...mains, ...stars];
    const out = applyBoardDiversity(input, 20, 0.25);
    const uniq = new Set(out.map(x => x.symbol));
    expectEqual('uniq.size === out.length', uniq.size, out.length);
  }

  // [8] 极端 limit (1) + diversity 25% → round-robin 不死循环
  console.log('[8] limit=1 + 25% 不死循环...');
  {
    const input = [s('sh.600519'), s('sh.688008'), s('sz.300750')];
    const out = applyBoardDiversity(input, 1, 0.25);
    expectEqual('1 个输出', out.length, 1);
  }

  // [9] empty input → []
  console.log('[9] empty input → []...');
  {
    const out = applyBoardDiversity([], 10, 0.25);
    expectEqual('空数组', out, []);
  }

  // [10] DEFAULT_BOARD_DIVERSITY_PCT === 0.25
  console.log('[10] DEFAULT_BOARD_DIVERSITY_PCT 常量...');
  {
    expectEqual('常量 0.25', DEFAULT_BOARD_DIVERSITY_PCT, 0.25);
  }

  console.log('\n========================================');
  console.log(`quant-recommendation-universe: ${ok} ok / ${fail} failed`);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
