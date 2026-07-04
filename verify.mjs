import { chromium } from 'playwright';
import fs from 'fs';

const BASE = 'http://103.242.3.87:3001';
const token = fs.readFileSync('/Users/bytedance/go/src/github.com/bruinxz/stocks/.verify_token', 'utf8').trim();
const OUT = '/Users/bytedance/go/src/github.com/bruinxz/stocks/shots';
fs.mkdirSync(OUT, { recursive: true });

const pages = [
  { name: 'factors', url: `${BASE}/workspace/factors`, waitText: null },
  { name: 'portfolio', url: `${BASE}/workspace/portfolio`, waitText: null },
  { name: 'ai-analysis', url: `${BASE}/workspace/ai-analysis`, waitText: null },
];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 2200 } });

// inject auth token + user before any app script runs
await ctx.addInitScript(tok => {
  localStorage.setItem('token', tok);
  localStorage.setItem('user', JSON.stringify({ id: 1, username: 'xz', role: 'admin' }));
}, token);

const results = [];
for (const p of pages) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  try {
    await page.goto(p.url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch (e) {
    errors.push('GOTO: ' + e.message);
  }
  await page.waitForTimeout(3500);
  // detect blank/crash: is there meaningful text?
  const bodyText = (await page.evaluate(() => document.body.innerText || '')).trim();
  const h1count = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(e => e.innerText).filter(Boolean)
  );
  await page.screenshot({ path: `${OUT}/${p.name}.png`, fullPage: true });
  results.push({
    name: p.name,
    bodyLen: bodyText.length,
    headings: h1count,
    errors,
  });
  await page.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
