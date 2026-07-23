import assert from 'assert';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');
const controller = fs.readFileSync(
  path.join(root, 'backend/src/api/controllers/MarketController.ts'),
  'utf8'
);
const routes = fs.readFileSync(path.join(root, 'backend/src/api/routes/market.routes.ts'), 'utf8');
const report = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/daily-report/ReportDocument.tsx'),
  'utf8'
);
const container = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/daily-report/DailyReportContainer.tsx'),
  'utf8'
);
const editorial = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/daily-report/AShareEditorialSummary.tsx'),
  'utf8'
);
const overseas = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/daily-report/GlobalCatalystSummary.tsx'),
  'utf8'
);
const reportStyles = fs.readFileSync(
  path.join(root, 'frontend/src/pages/catdesk/tabs/daily-report/report.css'),
  'utf8'
);

assert.match(
  controller,
  /getDailyBrief[\s\S]{0,3600}covered \/ NULLIF\(listed\.total, 0\) >= 0\.95/,
  'daily brief must select a full-coverage trading day'
);
assert.match(
  controller,
  /bar\.time >= :requested_date::date[\s\S]{0,180}bar\.time < :requested_date::date \+ INTERVAL '1 day'/,
  'a requested report day must be checked exactly instead of falling back to an older close'
);
assert.match(
  controller,
  /不使用更早交易日替代/,
  'an incomplete requested close must fail closed with an explicit no-fallback message'
);
assert.match(
  controller,
  /advancing_count[\s\S]{0,220}declining_count[\s\S]{0,260}flat_count/,
  'daily brief must expose market breadth'
);
assert.match(
  controller,
  /leaders: normalizedSectors\.slice\(0, 5\)[\s\S]{0,120}laggards:/,
  'daily brief must expose both leading and lagging industries'
);
assert.match(
  routes,
  /router\.get\('\/daily-brief', authController\.authenticate, marketController\.getDailyBrief\)/,
  'daily brief route must remain authenticated and read-only'
);
assert.match(editorial, /A 股收盘主稿/, 'daily report must lead with the A-share close article');
assert.match(report, /个股观察/, 'daily report must retain an A-share stock evidence section');
assert.match(overseas, /海外三句话/, 'US, Japan and Korea must be reduced to a brief aside');
assert.ok(
  container.indexOf('aShareOverview=') < container.indexOf('globalSummary='),
  'A-share editorial content must precede the overseas aside'
);
assert.match(
  reportStyles,
  /\.report-document\s*\{[\s\S]{0,320}grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  'the report grid must shrink to a narrow viewport instead of clipping its article'
);
assert.match(
  reportStyles,
  /\.index-tape__scroll\s*\{[\s\S]{0,180}overflow-x:\s*auto/,
  'the index tape must own horizontal overflow on narrow screens'
);

console.log('daily market brief contract: 12 assertions passed');
