import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const controller = fs.readFileSync(
  path.join(root, 'backend/src/api/controllers/StockController.ts'),
  'utf8'
);
const page = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/a-share-market/AShareMarket.tsx'),
  'utf8'
);
const styles = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/a-share-market/a-share-market.css'),
  'utf8'
);

assert.match(
  controller,
  /assessAShareFreshness\(quote\.quote_date[\s\S]{0,900}quote_status: freshness\.status/,
  'stock list API must attach a per-instrument freshness verdict'
);
assert.match(
  controller,
  /assessAShareFreshness\(null[\s\S]{0,260}quote_status: freshness\.status/,
  'missing bars must be explicit rather than silently inheriting the stock snapshot price'
);
assert.match(
  page,
  /quoteIsDecisionReady\(row\)[\s\S]{0,560}decisionReady \? formatNumber\(value\) : '—'/,
  'stale quotes must not be rendered as current prices'
);
assert.match(
  page,
  /rows\.every\(quoteIsDecisionReady\)/,
  'one fresh instrument must not hide stale rows in the same list'
);
assert.match(
  page,
  /当前行情未通过时效校验[\s\S]{0,260}避免把历史旧值当成今天的决策依据/,
  'the page must explain why stale data is blocked'
);
assert.match(
  page,
  /!quoteIsDecisionReady\(selected\)[\s\S]{0,140}行情未对齐，图表已暂停展示/,
  'a stale or unverified series must not render an apparently actionable chart'
);
assert.match(
  page,
  /render: \(value, row\) => \(quoteIsDecisionReady\(row\) \? formatMarketCap\(value\) : '—'\)/,
  'stale valuation and liquidity fields must be blocked with the price'
);
assert.match(styles, /\.market-data-gate\s*\{/, 'the trust gate needs a visible warning treatment');
assert.match(
  page,
  /api\.post\('\/market\/update-data'[\s\S]{0,120}force: true/,
  'the stale-data warning must provide a real authenticated recovery action'
);
assert.match(
  page,
  /api\.get\('\/market\/update-status'[\s\S]{0,220}job_id: repairJobId/,
  'the recovery action must expose queued, running and failed states instead of fire-and-forget'
);
assert.match(
  page,
  /'补齐行情'[\s\S]{0,900}to="\/workspace\/data"/,
  'the trust gate must keep a visible recovery CTA and an operations escape hatch'
);

console.log('A-share market trust gate: 11 assertions passed');
