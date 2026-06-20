/**
 * broker-compat-matrix.test.ts — US-110 [EX-010] qmt vs ptrade 兼容矩阵单测
 *
 *   cd backend && npx ts-node --transpile-only tests/live-trading/broker-compat-matrix.test.ts
 *
 * AC: docs 完整 + Typecheck passes + 单测覆盖矩阵语义.
 *
 * 测试矩阵:
 *   [1] 常量冻结 (BROKER_COMPAT_MATRIX / BROKER_KEYS / ORDER_TYPES / BROKER_EVENT_KINDS /
 *       QMT_STATUS_MAP) 防 caller 篡改
 *   [2] QMT 能力快照: trading_supported=true / LIMIT=supported / MARKET 等=server_disabled /
 *       全部 query_* 与 place/cancel events=supported / order_events level='half'
 *   [3] PTrade stub 能力快照: trading_supported=false / readonly_supported=false /
 *       LIMIT not_implemented / heartbeat 仍 true (bridge_common 统一发) /
 *       place_order / cancel_order supported=false
 *   [4] getBrokerCapability / isOrderTypeSupported / isEventSupported:
 *       happy + unknown broker / null / undefined / 大小写区分
 *   [5] mapQmtStatusCode: 11 个已知码 → 正确 bridge_status; null/undefined/未知 → 保守 'submitted'
 *   [6] adapter 文件实际存在 (路径不要漂)
 *   [7] QMT_STATUS_MAP 与 qmt_adapter.py._xt_status_to_str 字面对齐 (代码 ↔ 代码 drift guard)
 *   [8] PTrade adapter stub 文件存在并真接入了 stub class (不再是 1 行注释)
 *   [9] docs/broker_bridge_compat_matrix.md ↔ ts 常量 drift guard (文档 ↔ 代码)
 *
 * 关键约束: 项目 backend 测试不依赖 jest, 一律 self-contained IIFE + process.exit.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  BROKER_COMPAT_MATRIX,
  BROKER_KEYS,
  ORDER_TYPES,
  BROKER_EVENT_KINDS,
  QMT_STATUS_MAP,
  getBrokerCapability,
  isOrderTypeSupported,
  isEventSupported,
  mapQmtStatusCode,
} from '../../src/live-trading/brokers/brokerCompatMatrix';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const REPO_ROOT = path.resolve(__dirname, '../../..');

// ----------------------------------------------------------------------------
// [1] 常量冻结
// ----------------------------------------------------------------------------

function test_constantsFrozen() {
  console.log('\n## [1] 常量冻结 / 顺序稳定');
  assert('BROKER_COMPAT_MATRIX frozen', Object.isFrozen(BROKER_COMPAT_MATRIX));
  assert('BROKER_COMPAT_MATRIX.qmt frozen', Object.isFrozen(BROKER_COMPAT_MATRIX.qmt));
  assert('BROKER_COMPAT_MATRIX.ptrade frozen', Object.isFrozen(BROKER_COMPAT_MATRIX.ptrade));
  assert('BROKER_KEYS frozen', Object.isFrozen(BROKER_KEYS));
  assert('ORDER_TYPES frozen', Object.isFrozen(ORDER_TYPES));
  assert('BROKER_EVENT_KINDS frozen', Object.isFrozen(BROKER_EVENT_KINDS));
  assert('QMT_STATUS_MAP frozen', Object.isFrozen(QMT_STATUS_MAP));
  // 顺序稳定 — 单测/UI 渲染依赖
  assert('BROKER_KEYS = [qmt, ptrade]', JSON.stringify(BROKER_KEYS) === '["qmt","ptrade"]');
  assert(
    'ORDER_TYPES = [LIMIT, MARKET, IOC, FOK]',
    JSON.stringify(ORDER_TYPES) === '["LIMIT","MARKET","IOC","FOK"]'
  );
  assert(
    'BROKER_EVENT_KINDS 含 8 项',
    BROKER_EVENT_KINDS.length === 8 && BROKER_EVENT_KINDS[0] === 'heartbeat'
  );
}

// ----------------------------------------------------------------------------
// [2] QMT 能力快照
// ----------------------------------------------------------------------------

function test_qmtSnapshot() {
  console.log('\n## [2] QMT 能力快照 (生产就绪)');
  const qmt = BROKER_COMPAT_MATRIX.qmt;
  assert('qmt.broker_key=qmt', qmt.broker_key === 'qmt');
  assert('qmt.sdk=xtquant', qmt.sdk === 'xtquant');
  assert('qmt.trading_supported=true', qmt.trading_supported === true);
  assert('qmt.readonly_supported=true', qmt.readonly_supported === true);
  // order_type 矩阵
  assert('qmt.order_types.LIMIT supported', qmt.order_types.LIMIT.supported === true);
  assert(
    'qmt.order_types.MARKET supported=false + reason=server_disabled',
    qmt.order_types.MARKET.supported === false &&
      qmt.order_types.MARKET.reason === 'sdk_supported_server_disabled'
  );
  assert('qmt.order_types.IOC supported=false', qmt.order_types.IOC.supported === false);
  assert('qmt.order_types.FOK supported=false', qmt.order_types.FOK.supported === false);
  // events
  assert('qmt.events.heartbeat supported', qmt.events.heartbeat.supported === true);
  assert('qmt.events.account_snapshot supported', qmt.events.account_snapshot.supported === true);
  assert('qmt.events.positions supported', qmt.events.positions.supported === true);
  assert('qmt.events.today_orders supported', qmt.events.today_orders.supported === true);
  assert('qmt.events.today_trades supported', qmt.events.today_trades.supported === true);
  assert(
    'qmt.events.order_events half (轮询差分)',
    qmt.events.order_events.supported === true && qmt.events.order_events.level === 'half'
  );
  assert('qmt.events.place_order supported', qmt.events.place_order.supported === true);
  assert('qmt.events.cancel_order supported', qmt.events.cancel_order.supported === true);
  // 每个 order_type 都列了 (即使 unsupported), 让 caller 可安全 lookup 不 undefined
  for (const ot of ORDER_TYPES) {
    assert(`qmt.order_types.${ot} 存在`, qmt.order_types[ot] !== undefined);
  }
  for (const ev of BROKER_EVENT_KINDS) {
    assert(`qmt.events.${ev} 存在`, qmt.events[ev] !== undefined);
  }
}

// ----------------------------------------------------------------------------
// [3] PTrade stub 能力快照
// ----------------------------------------------------------------------------

function test_ptradeSnapshot() {
  console.log('\n## [3] PTrade stub 能力快照 (未实现, 全 false)');
  const pt = BROKER_COMPAT_MATRIX.ptrade;
  assert('ptrade.broker_key=ptrade', pt.broker_key === 'ptrade');
  assert('ptrade.trading_supported=false', pt.trading_supported === false);
  assert('ptrade.readonly_supported=false', pt.readonly_supported === false);
  // 全部 order_type stub
  for (const ot of ORDER_TYPES) {
    const support = pt.order_types[ot];
    assert(`ptrade.order_types.${ot} supported=false`, support.supported === false);
    assert(
      `ptrade.order_types.${ot} reason=not_implemented`,
      support.reason === 'not_implemented'
    );
  }
  // events: heartbeat 仍 true (bridge_common 统一发, 与适配器无关), 其它全 false
  assert(
    'ptrade.events.heartbeat 仍 supported (bridge_common 统一发)',
    pt.events.heartbeat.supported === true
  );
  assert(
    'ptrade.events.account_snapshot supported=false',
    pt.events.account_snapshot.supported === false
  );
  assert('ptrade.events.positions supported=false', pt.events.positions.supported === false);
  assert(
    'ptrade.events.today_orders supported=false',
    pt.events.today_orders.supported === false
  );
  assert(
    'ptrade.events.today_trades supported=false',
    pt.events.today_trades.supported === false
  );
  assert(
    'ptrade.events.order_events supported=false',
    pt.events.order_events.supported === false
  );
  assert(
    'ptrade.events.place_order supported=false',
    pt.events.place_order.supported === false
  );
  assert(
    'ptrade.events.cancel_order supported=false',
    pt.events.cancel_order.supported === false
  );
}

// ----------------------------------------------------------------------------
// [4] lookup helper
// ----------------------------------------------------------------------------

function test_lookupHelpers() {
  console.log('\n## [4] getBrokerCapability / isOrderTypeSupported / isEventSupported');
  assert('getBrokerCapability(qmt)', getBrokerCapability('qmt')?.broker_key === 'qmt');
  assert('getBrokerCapability(ptrade)', getBrokerCapability('ptrade')?.broker_key === 'ptrade');
  assert('getBrokerCapability(unknown)=null', getBrokerCapability('unknown') === null);
  assert('getBrokerCapability(null)=null', getBrokerCapability(null) === null);
  assert('getBrokerCapability(undefined)=null', getBrokerCapability(undefined) === null);
  assert('getBrokerCapability("")=null', getBrokerCapability('') === null);
  // 大小写敏感 (broker_key 是字典串, server 端写入也是小写)
  assert('getBrokerCapability(QMT)=null (大小写敏感)', getBrokerCapability('QMT') === null);

  // isOrderTypeSupported
  assert('qmt LIMIT supported', isOrderTypeSupported('qmt', 'LIMIT') === true);
  assert('qmt MARKET unsupported', isOrderTypeSupported('qmt', 'MARKET') === false);
  assert('qmt IOC unsupported', isOrderTypeSupported('qmt', 'IOC') === false);
  assert('ptrade LIMIT unsupported', isOrderTypeSupported('ptrade', 'LIMIT') === false);
  assert('unknown broker LIMIT unsupported', isOrderTypeSupported('foo', 'LIMIT') === false);
  assert('null broker unsupported', isOrderTypeSupported(null, 'LIMIT') === false);
  assert('null order_type unsupported', isOrderTypeSupported('qmt', null) === false);
  assert('unknown order_type unsupported', isOrderTypeSupported('qmt', 'STOP_LIMIT') === false);

  // isEventSupported
  assert('qmt heartbeat supported', isEventSupported('qmt', 'heartbeat') === true);
  assert('qmt order_events supported (half)', isEventSupported('qmt', 'order_events') === true);
  assert('ptrade heartbeat supported', isEventSupported('ptrade', 'heartbeat') === true);
  assert(
    'ptrade place_order unsupported',
    isEventSupported('ptrade', 'place_order') === false
  );
  assert('unknown event unsupported', isEventSupported('qmt', 'foo') === false);
}

// ----------------------------------------------------------------------------
// [5] mapQmtStatusCode
// ----------------------------------------------------------------------------

function test_qmtStatusMap() {
  console.log('\n## [5] mapQmtStatusCode 11 个已知码 + unknown fallback');
  // 与 qmt_adapter._xt_status_to_str 同款字典
  const expected: Record<number, string> = {
    48: 'submitted',
    49: 'submitted',
    50: 'partially_filled',
    51: 'cancelled',
    52: 'cancelled',
    53: 'partially_filled',
    54: 'filled',
    55: 'failed',
    56: 'pending',
    57: 'pending',
    58: 'failed',
  };
  for (const [code, status] of Object.entries(expected)) {
    assert(`code ${code} → ${status}`, mapQmtStatusCode(Number(code)) === status);
  }
  // 表大小固定 — 任何加减一项必须同步改 adapter + docs
  assert(
    'QMT_STATUS_MAP 含 11 项',
    Object.keys(QMT_STATUS_MAP).length === 11,
    `actual=${Object.keys(QMT_STATUS_MAP).length}`
  );
  // unknown 保守 'submitted' (与 adapter 一致)
  assert('unknown code 0 → submitted', mapQmtStatusCode(0) === 'submitted');
  assert('unknown code 99 → submitted', mapQmtStatusCode(99) === 'submitted');
  assert('null → submitted', mapQmtStatusCode(null) === 'submitted');
  assert('undefined → submitted', mapQmtStatusCode(undefined) === 'submitted');
}

// ----------------------------------------------------------------------------
// [6] adapter 文件实际存在
// ----------------------------------------------------------------------------

function test_adapterFilesExist() {
  console.log('\n## [6] adapter_path 实际存在 (路径不要漂)');
  for (const cap of Object.values(BROKER_COMPAT_MATRIX)) {
    const full = path.resolve(REPO_ROOT, cap.adapter_path);
    assert(
      `${cap.broker_key} adapter 文件存在: ${cap.adapter_path}`,
      fs.existsSync(full),
      full
    );
  }
}

// ----------------------------------------------------------------------------
// [7] QMT_STATUS_MAP ↔ qmt_adapter.py 代码漂移守护
// ----------------------------------------------------------------------------

function test_qmtAdapterStatusMapAlignment() {
  console.log('\n## [7] QMT_STATUS_MAP ↔ qmt_adapter.py._xt_status_to_str drift guard');
  const adapterPath = path.resolve(
    REPO_ROOT,
    'integrations/broker-bridge/qmt_bridge/qmt_adapter.py'
  );
  const src = fs.readFileSync(adapterPath, 'utf-8');
  // 解析 Python 字典 { 48: "submitted", ... } — 简单正则提取每行
  const dictMatch = src.match(/mapping\s*=\s*\{([\s\S]*?)\}/);
  assert('qmt_adapter.py 含 mapping={...}', dictMatch !== null);
  if (!dictMatch) return;
  const body = dictMatch[1];
  const rows = body.match(/(\d+)\s*:\s*"([a-z_]+)"/g) || [];
  const parsed: Record<number, string> = {};
  for (const row of rows) {
    const m = row.match(/(\d+)\s*:\s*"([a-z_]+)"/);
    if (m) parsed[Number(m[1])] = m[2];
  }
  // 双向相等
  for (const [code, status] of Object.entries(QMT_STATUS_MAP)) {
    assert(
      `ts[${code}]=${status} ↔ py[${code}]=${parsed[Number(code)]}`,
      parsed[Number(code)] === status,
      `py mapping missing/mismatch for code ${code}`
    );
  }
  assert(
    'py mapping 条目数与 ts QMT_STATUS_MAP 一致',
    Object.keys(parsed).length === Object.keys(QMT_STATUS_MAP).length,
    `py=${Object.keys(parsed).length} ts=${Object.keys(QMT_STATUS_MAP).length}`
  );
}

// ----------------------------------------------------------------------------
// [8] PTrade adapter stub 真接入了 class
// ----------------------------------------------------------------------------

function test_ptradeAdapterStub() {
  console.log('\n## [8] PTrade adapter stub 真接入了 class (不再是 1 行注释)');
  const ptradePath = path.resolve(
    REPO_ROOT,
    'integrations/broker-bridge/ptrade_bridge/ptrade_adapter.py'
  );
  const src = fs.readFileSync(ptradePath, 'utf-8');
  assert('ptrade_adapter.py 含 class PtradeAdapter', /class\s+PtradeAdapter/.test(src));
  assert('ptrade_adapter.py 含 def connect', /def\s+connect\s*\(/.test(src));
  assert('ptrade_adapter.py 含 def place_order', /def\s+place_order\s*\(/.test(src));
  assert('ptrade_adapter.py 含 def cancel_order', /def\s+cancel_order\s*\(/.test(src));
  assert('ptrade_adapter.py 含 def query_asset', /def\s+query_asset\s*\(/.test(src));
  assert(
    'ptrade_adapter.py 含 "not implemented" 拒服务',
    /not implemented/i.test(src)
  );
}

// ----------------------------------------------------------------------------
// [9] docs/broker_bridge_compat_matrix.md ↔ ts 常量 drift guard
// ----------------------------------------------------------------------------

function test_docsCodeDriftGuard() {
  console.log('\n## [9] docs/broker_bridge_compat_matrix.md ↔ ts 常量 drift guard');
  const docsPath = path.resolve(REPO_ROOT, 'docs/broker_bridge_compat_matrix.md');
  assert('docs/broker_bridge_compat_matrix.md 存在', fs.existsSync(docsPath));
  if (!fs.existsSync(docsPath)) return;
  const md = fs.readFileSync(docsPath, 'utf-8');
  // 顶部链接到 60_execution_overview §C.5
  assert('docs 引用 60_execution_overview', /60_execution_overview\.md/.test(md));
  // 全部 broker_key 出现
  for (const key of BROKER_KEYS) {
    assert(`docs 含 broker_key=${key}`, md.includes(`\`${key}_bridge\``) || md.includes(`${key}`));
  }
  // 全部 order_type 在表格里 — backtick 包住做 markdown code 标识
  for (const ot of ORDER_TYPES) {
    assert(`docs 含 order_type \`${ot}\``, md.includes(`\`${ot}\``));
  }
  // 全部 event kind 在表格里
  for (const ev of BROKER_EVENT_KINDS) {
    assert(`docs 含 event \`${ev}\``, md.includes(`\`${ev}\``));
  }
  // QMT 状态码 11 个全在表格里
  for (const code of Object.keys(QMT_STATUS_MAP)) {
    assert(`docs 含 QMT 状态码 ${code}`, md.includes(`| ${code} `));
  }
  // 显式 fallback 规则 (server 派单前必须查 trading_supported)
  assert('docs 含 fallback 规则提示', /fallback|不允许|fail-closed/i.test(md));
  // PTrade 状态描述明确 stub / 未实现
  assert('docs 明确 PTrade 是 stub', /stub|未实现/i.test(md));
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

(async () => {
  console.log('\n=== broker-compat-matrix.test.ts (US-110 EX-010) ===\n');
  try {
    test_constantsFrozen();
    test_qmtSnapshot();
    test_ptradeSnapshot();
    test_lookupHelpers();
    test_qmtStatusMap();
    test_adapterFilesExist();
    test_qmtAdapterStatusMapAlignment();
    test_ptradeAdapterStub();
    test_docsCodeDriftGuard();
  } catch (err: any) {
    failed++;
    console.error('THROW in main:', err?.message || err);
    console.error(err?.stack);
  }
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
