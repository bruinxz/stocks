/**
 * IntradayUniverseService — CE-A (2026-06-25) unit tests.
 *
 * 纯 pure + service e2e fake-DataSource, 不走真 DB / 真 Python.
 *
 * 覆盖矩阵:
 *  [1] truncateToMax 排序优先级 (position > limit_up > gainer > ...)
 *  [2] mergeSymbolsIntoMap 去重 + source 累计
 *  [3] stockCodeToSymbol 各种入参格式
 *  [4] resolveUniverse: 持仓单分支
 *  [5] resolveUniverse: 涨幅榜分支
 *  [6] resolveUniverse: 跌幅榜分支
 *  [7] resolveUniverse: 涨停板分支
 *  [8] resolveUniverse: 全部空 → market_cap fallback
 *  [9] resolveUniverse: max=500 截断 + 持仓优先保留
 *  [10] resolveUniverse: distinct (持仓与涨幅榜重叠仅出现一次)
 *  [11] resolveUniverse: 单子源 throw 不阻塞主流程 (fail-OPEN)
 *  [12] resolveUniverse: include_market_movers=false 不调涨跌幅 / 成交额
 *  [13] resolveUniverse: min_size 不足时用市值补齐
 *  [14] resolveUniverse: 全部 throw → 走 market_cap fallback
 *  [15] resolveUniverse: 全部 throw 包括 fallback → 返空不抛
 *  [16] resolveUniverse: 默认 9 只 priority 永远在 universe (CPO)
 *  [17] resolveUniverse: priority_symbols=[] 关闭默认 priority
 *  [18] resolveUniverse: 自定义 priority_symbols 覆盖默认
 *  [19] resolveUniverse: priority 永远不被 max_size 截断 (超 max 也保)
 */
import {
  IntradayUniverseService,
  IntradayUniverseDataSource,
  IntradayUniverseEntry,
  truncateToMax,
  mergeSymbolsIntoMap,
  stockCodeToSymbol,
  DEFAULT_PRIORITY_SYMBOLS,
} from '../../src/services/IntradayUniverseService';

let ok = 0;
let fail = 0;
function expectEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}
function expectTrue(name: string, cond: boolean, detail = ''): void {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' ' + detail : ''}`);
  }
}

/** 帮助构造 DataSource. 默认所有方法返空数组 (不抛). */
function makeDs(overrides: Partial<IntradayUniverseDataSource> = {}): IntradayUniverseDataSource {
  return {
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
    ...overrides,
  };
}

async function main(): Promise<void> {
  // [1] truncateToMax 排序优先级
  console.log('[1] truncateToMax 优先级排序...');
  {
    const entries: IntradayUniverseEntry[] = [
      { symbol: 'sh.600000', sources: ['top_turnover'] },
      { symbol: 'sh.600519', sources: ['position'] },
      { symbol: 'sz.000001', sources: ['market_cap_fallback'] },
      { symbol: 'sh.600036', sources: ['top_gainer'] },
      { symbol: 'sz.300750', sources: ['yesterday_limit_up'] },
    ];
    const out = truncateToMax(entries, 3);
    expectEqual(
      '保留 top-3 (position > limit_up > gainer)',
      out.map(e => e.symbol),
      ['sh.600519', 'sz.300750', 'sh.600036']
    );
  }
  {
    // 全部都进, 不需截断
    const entries: IntradayUniverseEntry[] = [
      { symbol: 'sh.600000', sources: ['position'] },
      { symbol: 'sh.600519', sources: ['position'] },
    ];
    const out = truncateToMax(entries, 10);
    expectEqual('未达 max 不截', out.length, 2);
  }

  // [2] mergeSymbolsIntoMap 去重 + source 累计
  console.log('[2] mergeSymbolsIntoMap...');
  {
    const map = new Map<string, IntradayUniverseEntry>();
    mergeSymbolsIntoMap(map, ['600519', 'sh.600036'], 'position');
    mergeSymbolsIntoMap(map, ['600519', '000001'], 'top_gainer');
    expectEqual('map size = 3', map.size, 3);
    const moutai = map.get('sh.600519');
    expectTrue('600519 normalized as sh.600519', !!moutai);
    expectEqual(
      '600519 累计 sources',
      moutai?.sources.sort(),
      ['position', 'top_gainer']
    );
    // 空串 / 垃圾输入跳过
    mergeSymbolsIntoMap(map, ['', '  ', null as any, undefined as any], 'top_loser');
    expectEqual('空/null 不污染', map.size, 3);
  }

  // [3] stockCodeToSymbol
  console.log('[3] stockCodeToSymbol...');
  expectEqual('600519 → sh.600519', stockCodeToSymbol('600519'), 'sh.600519');
  expectEqual('000001 → sz.000001', stockCodeToSymbol('000001'), 'sz.000001');
  expectEqual('sh.600519 keep', stockCodeToSymbol('sh.600519'), 'sh.600519');
  expectEqual('空 → null', stockCodeToSymbol(''), null);
  expectEqual('SH.600519 → sh.600519', stockCodeToSymbol('SH.600519'), 'sh.600519');

  // [4] resolveUniverse: 持仓分支
  console.log('[4] resolveUniverse 持仓单分支...');
  {
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519', 'sz.000001', '600036'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('out len=3', out.length, 3);
    expectTrue('contains sh.600519', out.includes('sh.600519'));
    expectTrue('contains sh.600036', out.includes('sh.600036'));
    expectTrue('contains sz.000001', out.includes('sz.000001'));
  }

  // [5] resolveUniverse: 涨幅榜分支
  console.log('[5] resolveUniverse 涨幅榜...');
  {
    let gainerLimit = 0;
    const ds = makeDs({
      async listTopGainerSymbols(limit) {
        gainerLimit = limit;
        return ['sh.600519', 'sh.600036'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('gainer limit=200', gainerLimit, 200);
    expectEqual('out len=2', out.length, 2);
  }

  // [6] resolveUniverse: 跌幅榜分支
  console.log('[6] resolveUniverse 跌幅榜...');
  {
    let loserLimit = 0;
    const ds = makeDs({
      async listTopLoserSymbols(limit) {
        loserLimit = limit;
        return ['sh.600519'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('loser limit=50', loserLimit, 50);
    expectEqual('len=1', out.length, 1);
  }

  // [7] resolveUniverse: 涨停板分支
  console.log('[7] resolveUniverse 涨停板...');
  {
    const ds = makeDs({
      async listYesterdayLimitUpSymbols() {
        return ['sh.600519', 'sz.300750'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('len=2', out.length, 2);
    expectTrue('contains 300750', out.includes('sz.300750'));
  }

  // [8] resolveUniverse: 全部空 → market_cap fallback
  console.log('[8] resolveUniverse 全空 → market_cap fallback...');
  {
    let fallbackCalled = false;
    let receivedLimit = 0;
    const ds = makeDs({
      async listTopMarketCapSymbols(limit) {
        fallbackCalled = true;
        receivedLimit = limit;
        // 真实场景 stocks 表返 max_size 票
        return Array.from({ length: 500 }, (_, i) =>
          `sh.${String(600000 + i).padStart(6, '0')}`
        );
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 200, max_size: 500, priority_symbols: [] });
    expectTrue('fallback 被调', fallbackCalled);
    expectEqual('fallback 拿 max=500', receivedLimit, 500);
    expectEqual('out 长度=500', out.length, 500);
  }

  // [9] resolveUniverse: max 截断 + 优先保留持仓
  console.log('[9] resolveUniverse max 截断 + 持仓优先...');
  {
    const positions = ['sh.600000', 'sh.600001', 'sh.600002'];
    const limitUps = ['sh.600003', 'sh.600004', 'sh.600005'];
    // 700 个涨幅榜, 总 universe 远超 max
    const gainers = Array.from({ length: 700 }, (_, i) =>
      `sh.${String(601000 + i).padStart(6, '0')}`
    );
    const ds = makeDs({
      async listPositionSymbols() {
        return positions;
      },
      async listYesterdayLimitUpSymbols() {
        return limitUps;
      },
      async listTopGainerSymbols() {
        return gainers;
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 10, priority_symbols: [] });
    expectEqual('截到 max=10', out.length, 10);
    for (const p of positions) {
      expectTrue(`持仓 ${p} 必保留 (优先级最高)`, out.includes(p));
    }
    for (const l of limitUps) {
      expectTrue(`涨停 ${l} 在 top-10 内保留`, out.includes(l));
    }
  }

  // [10] resolveUniverse: distinct (重叠不重复)
  console.log('[10] resolveUniverse distinct (持仓+涨幅榜 重叠不重复)...');
  {
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519', 'sh.600036'];
      },
      async listTopGainerSymbols() {
        // 涨幅榜也命中 600519
        return ['sh.600519', 'sz.300750'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('out len=3 (不是 4)', out.length, 3);
    // 检查每个 symbol 只出现一次
    const seen = new Set(out);
    expectEqual('seen size = out length', seen.size, out.length);
  }

  // [11] resolveUniverse: 单子源 throw → fail-OPEN
  console.log('[11] resolveUniverse fail-OPEN: 涨幅榜抛错也不阻塞...');
  {
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519'];
      },
      async listTopGainerSymbols() {
        throw new Error('DB connection lost');
      },
      async listYesterdayLimitUpSymbols() {
        return ['sz.300750'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('len=2 (gainer 失败被吞)', out.length, 2);
    expectTrue('600519 保留', out.includes('sh.600519'));
    expectTrue('300750 保留', out.includes('sz.300750'));
  }

  // [12] resolveUniverse: include_market_movers=false
  console.log('[12] resolveUniverse include_market_movers=false...');
  {
    let gainerCalled = false;
    let loserCalled = false;
    let turnoverCalled = false;
    let posCalled = false;
    const ds = makeDs({
      async listPositionSymbols() {
        posCalled = true;
        return ['sh.600519'];
      },
      async listTopGainerSymbols() {
        gainerCalled = true;
        return [];
      },
      async listTopLoserSymbols() {
        loserCalled = true;
        return [];
      },
      async listTopTurnoverSymbols() {
        turnoverCalled = true;
        return [];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({
      min_size: 1,
      max_size: 100,
      include_market_movers: false,
      priority_symbols: [],
    });
    expectTrue('position 仍被调', posCalled);
    expectTrue('gainer 跳过', !gainerCalled);
    expectTrue('loser 跳过', !loserCalled);
    expectTrue('turnover 跳过', !turnoverCalled);
    expectEqual('out len=1', out.length, 1);
  }

  // [13] resolveUniverse: 不足 min_size 用市值补齐
  console.log('[13] resolveUniverse 不足 min_size 用市值补齐...');
  {
    let fallbackCalled = false;
    let fallbackLimit = 0;
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519'];
      },
      async listTopMarketCapSymbols(limit) {
        fallbackCalled = true;
        fallbackLimit = limit;
        return Array.from({ length: 50 }, (_, i) =>
          `sh.${String(602000 + i).padStart(6, '0')}`
        );
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 30, max_size: 500, priority_symbols: [] });
    expectTrue('fallback 调到补 min', fallbackCalled);
    expectEqual('fallback 拿 min=30', fallbackLimit, 30);
    // 持仓 1 个 + market_cap 50 个 → 51 个 (假设 normalized 后无重叠)
    expectTrue('总数 >= min', out.length >= 30);
    expectTrue('总数 <= max', out.length <= 500);
  }

  // [14] resolveUniverse: 全部子源都 throw → 仍返 fallback
  console.log('[14] resolveUniverse 全部 throw → 走 fallback...');
  {
    let fallbackCalled = false;
    const ds = makeDs({
      async listPositionSymbols() {
        throw new Error('boom1');
      },
      async listFavoriteSymbols() {
        throw new Error('boom2');
      },
      async listTopGainerSymbols() {
        throw new Error('boom3');
      },
      async listTopLoserSymbols() {
        throw new Error('boom4');
      },
      async listYesterdayLimitUpSymbols() {
        throw new Error('boom5');
      },
      async listTopTurnoverSymbols() {
        throw new Error('boom6');
      },
      async listTopMarketCapSymbols(limit) {
        fallbackCalled = true;
        return Array.from({ length: limit }, (_, i) =>
          `sh.${String(603000 + i).padStart(6, '0')}`
        );
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectTrue('fallback called', fallbackCalled);
    expectEqual('out len=100', out.length, 100);
  }

  // [15] resolveUniverse: 全部 throw 且 fallback 也 throw → 真返空 (不抛)
  console.log('[15] resolveUniverse 全 throw 包括 fallback → 返空不抛...');
  {
    const ds = makeDs({
      async listPositionSymbols() {
        throw new Error('x');
      },
      async listTopMarketCapSymbols() {
        throw new Error('x');
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100, priority_symbols: [] });
    expectEqual('空数组', out, []);
  }

  // [16] resolveUniverse: 默认 9 只 priority 永远在 universe
  console.log('[16] resolveUniverse 默认 priority (CPO 9 只) 永在 universe...');
  {
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    // 不传 priority_symbols → 用默认 DEFAULT_PRIORITY_SYMBOLS
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 100 });
    expectEqual(
      'CPO 9 只全部在 universe',
      DEFAULT_PRIORITY_SYMBOLS.filter(s => out.includes(s)).length,
      DEFAULT_PRIORITY_SYMBOLS.length
    );
    expectTrue('持仓 sh.600519 也在', out.includes('sh.600519'));
    expectEqual(
      'len = 9 (priority) + 1 (position) — 持仓不与 priority 重叠',
      out.length,
      DEFAULT_PRIORITY_SYMBOLS.length + 1
    );
  }

  // [17] resolveUniverse: priority_symbols=[] 关闭默认 priority
  console.log('[17] resolveUniverse priority_symbols=[] 关闭...');
  {
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({
      min_size: 1,
      max_size: 100,
      priority_symbols: [],
    });
    expectEqual('len=1 (无 priority)', out.length, 1);
    for (const cpo of DEFAULT_PRIORITY_SYMBOLS) {
      expectTrue(`CPO ${cpo} 不在 universe`, !out.includes(cpo));
    }
  }

  // [18] resolveUniverse: 自定义 priority_symbols 覆盖默认
  console.log('[18] resolveUniverse 自定义 priority_symbols 覆盖默认...');
  {
    const custom = ['sh.600900', 'sz.002594'];
    const ds = makeDs({
      async listPositionSymbols() {
        return ['sh.600519'];
      },
    });
    const svc = new IntradayUniverseService(ds);
    const out = await svc.resolveUniverse({
      min_size: 1,
      max_size: 100,
      priority_symbols: custom,
    });
    for (const c of custom) {
      expectTrue(`自定义 priority ${c} 在 universe`, out.includes(c));
    }
    for (const cpo of DEFAULT_PRIORITY_SYMBOLS) {
      expectTrue(`默认 CPO ${cpo} 被替换, 不在 universe`, !out.includes(cpo));
    }
    expectTrue('持仓 sh.600519 仍在', out.includes('sh.600519'));
    expectEqual('len = 2 priority + 1 position', out.length, 3);
  }

  // [19] resolveUniverse: priority 永远不被 max_size 截断
  console.log('[19] resolveUniverse priority 永不被 max 截断 (即使 max < priority.length)...');
  {
    // 持仓 + 涨幅榜共 100+ 票, 默认 priority 9 只, max=5 < 9
    const positions = Array.from({ length: 50 }, (_, i) =>
      `sh.${String(700000 + i).padStart(6, '0')}`
    );
    const gainers = Array.from({ length: 200 }, (_, i) =>
      `sh.${String(710000 + i).padStart(6, '0')}`
    );
    const ds = makeDs({
      async listPositionSymbols() {
        return positions;
      },
      async listTopGainerSymbols() {
        return gainers;
      },
    });
    const svc = new IntradayUniverseService(ds);
    // max_size=5, 但 priority 有 9 只 → priority 必须全在, 其它都被截掉
    const out = await svc.resolveUniverse({ min_size: 1, max_size: 5 });
    expectEqual(
      'CPO 9 只全保留 (超 max=5 也保)',
      DEFAULT_PRIORITY_SYMBOLS.filter(s => out.includes(s)).length,
      DEFAULT_PRIORITY_SYMBOLS.length
    );
    expectEqual(
      'out.length === priority.length (其它全被挤掉)',
      out.length,
      DEFAULT_PRIORITY_SYMBOLS.length
    );
  }

  console.log('\n========================================');
  console.log(`intraday-universe: ${ok} ok / ${fail} failed`);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
