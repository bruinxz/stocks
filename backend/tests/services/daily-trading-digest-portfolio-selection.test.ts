import { DefaultDailyTradingDigestDataSource } from '../../src/services/DailyTradingDigestService';
import { PaperTradingPortfolio } from '../../src/models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../src/models/PaperTradingPosition';
import { AUTONOMOUS_PORTFOLIO_NAME } from '../../src/portfolio/internal/PaperTradingPortfolioFamilies';

let failed = 0;
function assert(name: string, condition: boolean, detail = '') {
  if (!condition) {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

async function main() {
  const originalFindPortfolio = PaperTradingPortfolio.findOne;
  const originalFindPositions = PaperTradingPosition.findAll;
  const originalEnv = process.env.DAILY_TRADING_DIGEST_PORTFOLIO_NAME;
  const calls: any[] = [];
  const positionPortfolioIds: number[] = [];
  try {
    process.env.DAILY_TRADING_DIGEST_PORTFOLIO_NAME = '我的日报盘';
    (PaperTradingPortfolio as any).findOne = async (options: any) => {
      calls.push(options);
      if (options.where.name === '我的日报盘') return null;
      return { id: 12, user_id: 3, name: '自动跟单盘', is_active: true };
    };
    (PaperTradingPosition as any).findAll = async (options: any) => {
      positionPortfolioIds.push(options.where.portfolio_id);
      return [];
    };

    const ds = new DefaultDailyTradingDigestDataSource();
    const selected = await ds.loadPortfolioSummary(3);
    assert('configured portfolio attempted first', calls[0].where.name === '我的日报盘');
    assert(
      'selection only considers active portfolios',
      calls.every(call => call.where.is_active === true)
    );
    assert(
      'fallback has deterministic order',
      JSON.stringify(calls[1].order) ===
        JSON.stringify([
          ['auto_trade_enabled', 'DESC'],
          ['id', 'ASC'],
        ])
    );
    assert('fallback portfolio returned', selected?.portfolio?.id === 12);
    assert('positions use selected fallback portfolio', positionPortfolioIds[0] === 12);

    calls.length = 0;
    delete process.env.DAILY_TRADING_DIGEST_PORTFOLIO_NAME;
    (PaperTradingPortfolio as any).findOne = async (options: any) => {
      calls.push(options);
      return { id: 20, user_id: 3, name: AUTONOMOUS_PORTFOLIO_NAME, is_active: true };
    };
    const preferred = await ds.loadPortfolioSummary(3);
    assert('autonomous portfolio is default', calls[0].where.name === AUTONOMOUS_PORTFOLIO_NAME);
    assert(
      'default hit avoids arbitrary fallback query',
      calls.length === 1 && preferred?.portfolio?.id === 20
    );
    assert('positions use selected default portfolio', positionPortfolioIds[1] === 20);
  } finally {
    (PaperTradingPortfolio as any).findOne = originalFindPortfolio;
    (PaperTradingPosition as any).findAll = originalFindPositions;
    if (originalEnv === undefined) delete process.env.DAILY_TRADING_DIGEST_PORTFOLIO_NAME;
    else process.env.DAILY_TRADING_DIGEST_PORTFOLIO_NAME = originalEnv;
  }

  console.log(`[daily-trading-digest-portfolio-selection] ${8 - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
