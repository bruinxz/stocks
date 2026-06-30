/**
 * PR-N (2026-06-29) IntradayUniverseService board-coverage tests.
 *
 * 验证 includes_board_diversity 默认开启 + listTopByBoardSymbols 注入兜底
 * 让 sh.688 / sz.30x / sh.6 / bj 4 板都有保留, 解决 PR-J 揭示的
 * "realtime_quotes 对 sh.688 11 只存储票零历史 quote" 根因.
 *
 * 覆盖矩阵:
 *  [1] include_board_diversity 默认 true → listTopByBoardSymbols 被各 board 调一次
 *  [2] 4 板都有票 → 输出 universe 包含所有板块
 *  [3] include_board_diversity=false → listTopByBoardSymbols 不被调用 (退回老路径)
 *  [4] PR-J 场景: 持仓 + 涨幅榜全主板 + diversity ON → sh.688 必入 universe
 *  [5] 单 board 抛错隔离 → 其它板正常合并
 *  [6] perBoard = max(10, floor(maxSize*0.05))
 *  [7] (smoke) board diversity 不影响其它 source priority
 */

import {
  IntradayUniverseService,
  IntradayUniverseDataSource,
} from '../../src/services/IntradayUniverseService';

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

interface SpyCalls {
  star: number;
  chinext: number;
  main: number;
  bj: number;
}

function makeSpyDs(rowsByBoard: Partial<Record<'star' | 'chinext' | 'main' | 'bj', string[]>>) {
  const calls: SpyCalls = { star: 0, chinext: 0, main: 0, bj: 0 };
  const ds: IntradayUniverseDataSource = {
    async listPositionSymbols() {
      return [];
    },
    async listFavoriteSymbols() {
      return [];
    },
    async listTopGainerSymbols() {
      return [];
    },
    async listTopLoserSymbols() {
      return [];
    },
    async listYesterdayLimitUpSymbols() {
      return [];
    },
    async listTopTurnoverSymbols() {
      return [];
    },
    async listTopMarketCapSymbols() {
      return [];
    },
    async listTopByBoardSymbols(board, _limit) {
      calls[board] += 1;
      return rowsByBoard[board] || [];
    },
  };
  return { ds, calls };
}

async function main(): Promise<void> {
  // [1] include_board_diversity 默认 true → 4 board 各调一次
  console.log('[1] 默认 4 板都调一次 listTopByBoardSymbols...');
  {
    const { ds, calls } = makeSpyDs({
      star: ['sh.688008'],
      chinext: ['sz.300750'],
      main: ['sh.600519'],
      bj: ['bj.920003'],
    });
    const svc = new IntradayUniverseService(ds);
    await svc.resolveUniverse({ min_size: 1, max_size: 20, priority_symbols: [] });
    expectEqual('调用计数 = 4 板各 1 次', calls, { star: 1, chinext: 1, main: 1, bj: 1 });
  }

  // [2] 4 板都有票 → 输出包含所有板块
  console.log('[2] 4 板均合并到 universe...');
  {
    const { ds } = makeSpyDs({
      star: ['sh.688008', 'sh.688123'],
      chinext: ['sz.300750', 'sz.301888'],
      main: ['sh.600519', 'sh.600000'],
      bj: ['bj.920003'],
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 20, priority_symbols: [] });
    expectTrue('universe 含 sh.688', out.some(s => s.startsWith('sh.688')));
    expectTrue('universe 含 sz.30', out.some(s => s.startsWith('sz.30')));
    expectTrue(
      'universe 含 sh.6 (非688)',
      out.some(s => s.startsWith('sh.6') && !s.startsWith('sh.688'))
    );
    expectTrue('universe 含 bj.', out.some(s => s.startsWith('bj.')));
  }

  // [3] include_board_diversity=false → listTopByBoardSymbols 不被调用
  console.log('[3] include_board_diversity=false → 不调...');
  {
    const { ds, calls } = makeSpyDs({});
    const svc = new IntradayUniverseService(ds);
    await svc.resolveUniverse({
      min_size: 1,
      max_size: 20,
      priority_symbols: [],
      include_board_diversity: false,
    });
    expectEqual('调用计数 = 0', calls, { star: 0, chinext: 0, main: 0, bj: 0 });
  }

  // [4] PR-J 关键场景: 持仓 + 涨幅榜全主板 + diversity ON → sh.688 必入
  console.log('[4] PR-J 场景: 主板 movers + diversity ON → sh.688 入 universe...');
  {
    const calls: SpyCalls = { star: 0, chinext: 0, main: 0, bj: 0 };
    const ds: IntradayUniverseDataSource = {
      async listPositionSymbols() {
        return ['sh.600519', 'sh.600036'];
      },
      async listFavoriteSymbols() {
        return [];
      },
      async listTopGainerSymbols() {
        return Array.from({ length: 200 }, (_, i) =>
          `sh.${String(600000 + i).padStart(6, '0')}`
        );
      },
      async listTopLoserSymbols() {
        return [];
      },
      async listYesterdayLimitUpSymbols() {
        return [];
      },
      async listTopTurnoverSymbols() {
        return [];
      },
      async listTopMarketCapSymbols() {
        return [];
      },
      async listTopByBoardSymbols(board) {
        calls[board] += 1;
        if (board === 'star') return ['sh.688008', 'sh.688123', 'sh.688256'];
        if (board === 'chinext') return ['sz.300750', 'sz.301888'];
        if (board === 'bj') return ['bj.920003'];
        return [];
      },
    };
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({
      min_size: 50,
      max_size: 500,
      priority_symbols: [],
    });
    expectTrue('star diversity 被调用 1 次', calls.star === 1);
    expectTrue('sh.688008 in universe (PR-J 存储票)', out.includes('sh.688008'));
    expectTrue(
      'sh.688 板块至少 1 票',
      out.filter(s => s.startsWith('sh.688')).length >= 1
    );
  }

  // [5] 单 board throw → 其它板正常合并 (fail-OPEN)
  console.log('[5] 单 board throw → 其它板继续...');
  {
    const calls: SpyCalls = { star: 0, chinext: 0, main: 0, bj: 0 };
    const ds: IntradayUniverseDataSource = {
      async listPositionSymbols() {
        return [];
      },
      async listFavoriteSymbols() {
        return [];
      },
      async listTopGainerSymbols() {
        return [];
      },
      async listTopLoserSymbols() {
        return [];
      },
      async listYesterdayLimitUpSymbols() {
        return [];
      },
      async listTopTurnoverSymbols() {
        return [];
      },
      async listTopMarketCapSymbols() {
        return [];
      },
      async listTopByBoardSymbols(board) {
        calls[board] += 1;
        if (board === 'star') throw new Error('mocked star failure');
        if (board === 'chinext') return ['sz.300750'];
        if (board === 'main') return ['sh.600519'];
        if (board === 'bj') return ['bj.920003'];
        return [];
      },
    };
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 20, priority_symbols: [] });
    expectEqual('全部 4 board 都被调 (含 throw)', calls, {
      star: 1,
      chinext: 1,
      main: 1,
      bj: 1,
    });
    expectTrue(
      'chinext / main / bj 仍合并到 universe',
      out.includes('sz.300750') && out.includes('sh.600519') && out.includes('bj.920003')
    );
  }

  // [6] perBoard = max(10, floor(maxSize*0.05))
  console.log('[6] perBoard 计算: max=500 → 25 票/板; max=100 → 10 票/板...');
  {
    let perBoardSeen: number | null = null;
    const ds: IntradayUniverseDataSource = {
      async listPositionSymbols() {
        return [];
      },
      async listFavoriteSymbols() {
        return [];
      },
      async listTopGainerSymbols() {
        return [];
      },
      async listTopLoserSymbols() {
        return [];
      },
      async listYesterdayLimitUpSymbols() {
        return [];
      },
      async listTopTurnoverSymbols() {
        return [];
      },
      async listTopMarketCapSymbols() {
        return [];
      },
      async listTopByBoardSymbols(_board, limit) {
        if (perBoardSeen === null) perBoardSeen = limit;
        return [];
      },
    };
    const svc = new IntradayUniverseService(ds);
    await svc.resolveUniverse({ min_size: 1, max_size: 500, priority_symbols: [] });
    expectEqual('max=500 → perBoard = 25', perBoardSeen, 25);
    perBoardSeen = null;
    await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('max=100 → perBoard = 10 (max(10, 5))', perBoardSeen, 10);
  }

  // [7] smoke: board diversity 不影响其它 source priority
  console.log('[7] (smoke) board diversity 不影响其它 source priority...');
  {
    const { ds } = makeSpyDs({
      star: ['sh.688008'],
      main: ['sh.600519'],
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 10, priority_symbols: [] });
    expectTrue('含 sh.688008', out.includes('sh.688008'));
    expectTrue('含 sh.600519', out.includes('sh.600519'));
  }

  console.log('\n========================================');
  console.log(`intraday-universe-board-coverage: ${ok} ok / ${fail} failed`);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
