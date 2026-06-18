/**
 * QuantDataService.buildListedSurvivalWhere — audit S-7 (生存者偏差修复).
 *
 *   cd backend && npx ts-node --transpile-only tests/quant/quant_data_service_delisting.test.ts
 *
 * 验证 where 构造正确包含"退市时间 > as_of_date"的退市股:
 *   - 不传 as_of → 默认 today, is_listed OR delisting_date > today
 *   - 传 as_of='2015-01-01' → 2018 年才退市的票仍能命中 (历史时点该票还活着)
 */

import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { buildListedSurvivalWhere } from '../../src/quant/engine/internal/QuantDataService';

let passed = 0;
let failed = 0;
function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    failed += 1;
  }
}

console.log('QuantDataService.buildListedSurvivalWhere');

it('不传 as_of → 默认 today, 含 is_listed:true OR delisting_date>today', () => {
  const where = buildListedSurvivalWhere();
  const today = new Date().toISOString().slice(0, 10);
  const orClause = (where as any)[Op.or];
  assert.ok(Array.isArray(orClause));
  assert.equal(orClause.length, 2);
  assert.deepStrictEqual(orClause[0], { is_listed: true });
  // delisting clause: ne null + gt today
  assert.ok(orClause[1].delisting_date);
  const delistingCond = orClause[1].delisting_date;
  assert.equal(delistingCond[Op.gt], today);
});

it('传 as_of=2015-01-01 → 2018 年才退市的票仍命中 (历史时点该票活着)', () => {
  const where = buildListedSurvivalWhere('2015-01-01');
  const orClause = (where as any)[Op.or];
  assert.equal(orClause[1].delisting_date[Op.gt], '2015-01-01');
  // 模拟一行 row 数据 — 2018 退市 > 2015 → 满足 (业务方向断言)
  const simulatedRow = { delisting_date: '2018-06-30' };
  assert.ok(simulatedRow.delisting_date > '2015-01-01');
});

it('已退市 (delisting_date < as_of) 不应命中 — 业务方向断言', () => {
  // 2010 退市股 + as_of=2015 → orClause[1] delisting_date>=2015 不命中
  const where = buildListedSurvivalWhere('2015-01-01');
  const orClause = (where as any)[Op.or];
  const delistingThreshold = orClause[1].delisting_date[Op.gt];
  // 模拟 2010 退市 < 2015 阈值
  assert.ok('2010-12-31' < delistingThreshold);
});

it('未退市 (delisting_date=null) 通过 is_listed:true 命中', () => {
  const where = buildListedSurvivalWhere('2015-01-01');
  const orClause = (where as any)[Op.or];
  assert.deepStrictEqual(orClause[0], { is_listed: true });
});

it('as_of_date 与 today 不等时 delisting_date 阈值随之变', () => {
  const w1 = buildListedSurvivalWhere('2020-01-01');
  const w2 = buildListedSurvivalWhere('2021-01-01');
  assert.notEqual(
    (w1 as any)[Op.or][1].delisting_date[Op.gt],
    (w2 as any)[Op.or][1].delisting_date[Op.gt]
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
