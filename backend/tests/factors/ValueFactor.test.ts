import assert from 'assert';
import {
  annualizeCumulativeEps,
  financialReportValueProxy,
  valueFactor,
} from '../../src/quant/factors/library/ValueFactor';

assert.equal(annualizeCumulativeEps(1, '2026-03-31'), 4);
assert.equal(annualizeCumulativeEps(2, '2026-06-30'), 4);
assert.equal(annualizeCumulativeEps(3, '2026-09-30'), 4);
assert.equal(annualizeCumulativeEps(4, '2026-12-31'), 4);
assert.equal(annualizeCumulativeEps(-1, '2026-03-31'), null);

const raw_payload = {
  announcement_date: '2026-04-28',
  indicator_row: { '摊薄每股收益(元)': 2 },
  market_report_row: { 每股净资产: 10 },
};
assert.equal(
  financialReportValueProxy({
    report_date: '2026-03-31',
    raw_payload,
    close: 20,
    as_of_date: '2026-04-28',
  }),
  0.9
);
assert.equal(
  financialReportValueProxy({
    report_date: '2026-03-31',
    raw_payload,
    close: 20,
    as_of_date: '2026-04-27',
  }),
  null
);

const ValuationModel = require('../../src/models/StockValuationFactor').StockValuationFactor;
const FinancialModel = require('../../src/models/FinancialReport').FinancialReport;
const StockModel = require('../../src/models/Stock').Stock;
const BarModel = require('../../src/models/DailyBar').DailyBar;
const originals = {
  valuation: ValuationModel.findAll,
  financial: FinancialModel.findAll,
  stock: StockModel.findAll,
  bar: BarModel.findAll,
};

(async () => {
  ValuationModel.findAll = async () => [
    { symbol: 'sh.600000', factor_date: '2026-07-23', pe_ttm: 10, pb: 2 },
  ];
  FinancialModel.findAll = async () => [
    { stock_code: '000001', report_date: '2026-03-31', raw_payload },
    {
      stock_code: '000002',
      report_date: '2026-03-31',
      raw_payload: { ...raw_payload, announcement_date: '2026-07-24' },
    },
  ];
  StockModel.findAll = async () => [
    { id: 1, symbol: 'sz.000001' },
    { id: 2, symbol: 'sz.000002' },
  ];
  BarModel.findAll = async () => [
    { stock_id: 1, time: new Date('2026-07-23T00:00:00Z'), close: 20 },
    { stock_id: 2, time: new Date('2026-07-23T00:00:00Z'), close: 20 },
  ];

  const values = await valueFactor.compute({
    universe: ['600000', '000001', '000002'],
    as_of_date: '2026-07-23',
  } as any);
  assert.equal(values.get('600000'), 0.6, 'direct PE/PB stays the preferred path');
  assert.equal(values.get('000001'), 0.9, 'financial per-share fallback is calculated');
  assert(!values.has('000002'), 'future-announced reports stay unavailable');

  console.log('ValueFactor: 10 assertions passed');
})()
  .finally(() => {
    ValuationModel.findAll = originals.valuation;
    FinancialModel.findAll = originals.financial;
    StockModel.findAll = originals.stock;
    BarModel.findAll = originals.bar;
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
