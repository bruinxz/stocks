import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const controller = readFileSync(
  resolve(__dirname, '../../src/api/controllers/RiskController.ts'),
  'utf8'
);
const routes = readFileSync(resolve(__dirname, '../../src/api/routes/risk.routes.ts'), 'utf8');

const endpoints = [
  ['position-limits', 'getPositionLimits', 'updatePositionLimits'],
  ['trailing-stop', 'getTrailingStop', 'updateTrailingStop'],
  ['drawdown-breaker', 'getDrawdownBreaker', 'updateDrawdownBreaker'],
  ['per-stock-stop-loss', 'getPerStockStopLoss', 'updatePerStockStopLoss'],
  ['industry-concentration', 'getIndustryConcentration', 'updateIndustryConcentration'],
  ['market-regime', 'getMarketRegimeConfig', 'updateMarketRegimeConfig'],
  ['black-swan', 'getBlackSwan', 'updateBlackSwan'],
  ['morning-checkup', 'getMorningCheckupConfig', 'updateMorningCheckupConfig'],
  ['reconciliation-alert', 'getReconciliationAlertConfig', 'updateReconciliationAlertConfig'],
] as const;

for (const [path, getMethod, putMethod] of endpoints) {
  assert.match(
    controller,
    new RegExp(`async\\s+${getMethod}\\s*\\(`),
    `RiskController must expose ${getMethod}`
  );
  assert.match(
    controller,
    new RegExp(`async\\s+${putMethod}\\s*\\(`),
    `RiskController must expose ${putMethod}`
  );
  assert.match(
    routes,
    new RegExp(
      `router\\.get\\(\\s*['"]\\/${path}['"][\\s\\S]{0,160}authController\\.authenticate[\\s\\S]{0,160}riskController\\.${getMethod}`
    ),
    `GET /${path} must authenticate before ${getMethod}`
  );
  assert.match(
    routes,
    new RegExp(
      `router\\.put\\(\\s*['"]\\/${path}['"][\\s\\S]{0,160}authController\\.authenticate[\\s\\S]{0,160}riskController\\.${putMethod}`
    ),
    `PUT /${path} must authenticate before ${putMethod}`
  );
}

console.log(`risk-parameters-contract: ${endpoints.length * 4}/${endpoints.length * 4} PASS`);
