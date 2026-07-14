import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface MatrixFixture {
  plan_sha256: string;
  calendar_start: string;
  calendar_end: string;
  profiles: string[];
  market_scopes: string[];
  legal_pairs: [string, string][];
  expected: Record<string, number>;
  request_routes: Record<'list' | 'detail' | 'holdings', string>;
}

interface MatrixRow {
  kind: 'list' | 'detail' | 'holdings';
  profile: string;
  scope: string;
  checkpoint?: number;
  snapshotId?: string;
  url: string;
}

const FIXTURE_PATH = join(
  __dirname,
  'tab5-six-month-request-matrix.fixture.json',
);
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MatrixFixture;

const fail = (message: string): never => {
  throw new Error(message);
};

function validateFixture(value: MatrixFixture): void {
  assert.match(value.plan_sha256, /^[0-9a-f]{64}$/);
  assert.equal(value.calendar_start, '2026-01-10');
  assert.equal(value.calendar_end, '2026-07-10');
  assert.equal(value.profiles.length, 6);
  assert.equal(new Set(value.profiles).size, 6);
  assert.deepEqual(value.market_scopes, ['cn_a', 'us', 'jp', 'kr']);
  assert.equal(value.legal_pairs.length, 8);
  assert.equal(new Set(value.legal_pairs.map(pair => pair.join('/'))).size, 8);
  assert.equal(value.expected.sessions_per_scope, 128);
  assert.equal(value.expected.checkpoints_per_pair, 27);
  assert.equal(value.expected.holdings_per_checkpoint, 3);
  assert.equal(value.expected.snapshots, 216);
  assert.equal(value.expected.holdings, 648);
  assert.equal(value.expected.total_requests, 440);
}

function snapshotId(pairIndex: number, checkpoint: number): string {
  const material = `${fixture.plan_sha256}:${pairIndex}:${checkpoint}`;
  const digest = createHash('sha256').update(material).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

function asOf(pairIndex: number, checkpoint: number): string {
  const day = 1 + ((pairIndex * 27 + checkpoint) % 181);
  return new Date(Date.UTC(2026, 0, 10 + day, 12, 0, 0))
    .toISOString()
    .replace('.000Z', 'Z');
}

function render(
  template: string,
  fields: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (_match, key: string) => {
    const value = fields[key];
    return value === undefined ? fail(`missing route field ${key}`) : encodeURIComponent(value);
  });
}

function buildMatrix(): MatrixRow[] {
  const rows: MatrixRow[] = [];
  fixture.legal_pairs.forEach(([profile, scope], pairIndex) => {
    rows.push({
      kind: 'list',
      profile,
      scope,
      url: render(fixture.request_routes.list, { profile, scope }),
    });
    for (let checkpoint = 0; checkpoint < fixture.expected.checkpoints_per_pair; checkpoint++) {
      const snapshot_id = snapshotId(pairIndex, checkpoint);
      const as_of = asOf(pairIndex, checkpoint);
      rows.push({
        kind: 'detail',
        profile,
        scope,
        checkpoint,
        snapshotId: snapshot_id,
        url: render(fixture.request_routes.detail, { profile, scope, as_of }),
      });
      rows.push({
        kind: 'holdings',
        profile,
        scope,
        checkpoint,
        snapshotId: snapshot_id,
        url: render(fixture.request_routes.holdings, {
          profile,
          scope,
          as_of,
        }),
      });
    }
  });
  return rows;
}

function validateMatrix(rows: MatrixRow[]): void {
  assert.equal(rows.length, fixture.expected.total_requests);
  assert.equal(rows.filter(row => row.kind === 'list').length, 8);
  assert.equal(rows.filter(row => row.kind === 'detail').length, 216);
  assert.equal(rows.filter(row => row.kind === 'holdings').length, 216);
  assert.equal(new Set(rows.map(row => `${row.kind}:${row.url}`)).size, 440);
  assert.ok(rows.every(row => row.url.includes(`market_scope=${row.scope}`)));
  assert.ok(
    rows
      .filter(row => row.kind !== 'holdings')
      .every(row => row.url.includes(encodeURIComponent(row.profile))),
  );
  const details = rows.filter(row => row.kind === 'detail');
  const holdings = rows.filter(row => row.kind === 'holdings');
  assert.deepEqual(
    details.map(row => row.snapshotId).sort(),
    holdings.map(row => row.snapshotId).sort(),
  );
}

function validateNegativeMatrix(): void {
  const legal = new Set(fixture.legal_pairs.map(pair => pair.join('/')));
  const all = fixture.profiles.flatMap(profile =>
    fixture.market_scopes.map(scope => `${profile}/${scope}`),
  );
  assert.equal(all.length, 24);
  assert.equal(all.filter(pair => !legal.has(pair)).length, 16);
  assert.ok(!legal.has('custom/us'));
  assert.throws(
    () => render('/x/{missing}', {}),
    /missing route field/,
  );
}

validateFixture(fixture);
const matrix = buildMatrix();
validateMatrix(matrix);
validateNegativeMatrix();

console.log(
  `tab5-six-month-request-matrix: PASS (${matrix.length} requests, ` +
    `${fixture.expected.snapshots} snapshots, ${fixture.expected.holdings} holdings)`,
);
