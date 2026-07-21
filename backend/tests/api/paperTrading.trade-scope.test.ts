import { paperTradingController } from '../../src/api/controllers/PaperTradingController';
import { paperTradingFacade } from '../../src/portfolio/PaperTradingFacade';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function responseSpy() {
  const state: { status: number; body: any } = { status: 200, body: null };
  const response = {
    status(code: number) {
      state.status = code;
      return response;
    },
    json(body: any) {
      state.body = body;
      return response;
    },
  };
  return { response, state };
}

async function invoke(body: Record<string, unknown>) {
  const { response, state } = responseSpy();
  await paperTradingController.placeTrade(
    { body, user: { id: 4, username: 'scope-test' } } as any,
    response as any,
    () => undefined
  );
  return state;
}

async function run(): Promise<void> {
  const originalPlaceOrder = paperTradingFacade.placeOrder;
  const calls: any[] = [];
  try {
    (paperTradingFacade as any).placeOrder = async (input: any) => {
      calls.push(input);
      return { trade: { id: 1 } };
    };

    const missing = await invoke({ symbol: 'sh.600000', direction: 'BUY', quantity: 100 });
    assert('missing portfolio_id returns 400', missing.status === 400);
    assert('missing portfolio_id never reaches facade', calls.length === 0);

    const invalid = await invoke({
      portfolio_id: 0,
      symbol: 'sh.600000',
      direction: 'BUY',
      quantity: 100,
    });
    assert('invalid portfolio_id returns 400', invalid.status === 400);
    assert('invalid portfolio_id never reaches facade', calls.length === 0);

    const legacyAlias = await invoke({
      portfolio_id: 65,
      symbol: 'sh.600000',
      action: 'buy',
      quantity: 100,
    });
    assert('legacy action alias is rejected', legacyAlias.status === 400);
    assert('legacy action alias never reaches facade', calls.length === 0);

    const valid = await invoke({
      portfolio_id: 65,
      symbol: 'sh.600000',
      direction: 'BUY',
      quantity: 100,
    });
    assert('explicit portfolio order succeeds', valid.status === 200 && valid.body?.success === true);
    assert('explicit portfolio id reaches facade unchanged', calls[0]?.portfolio_id === 65);

    (paperTradingFacade as any).placeOrder = async (input: any) => {
      calls.push(input);
      const error: any = new Error('未找到模拟盘或无权访问');
      error.statusCode = 404;
      throw error;
    };
    const forbidden = await invoke({
      portfolio_id: 999999,
      symbol: 'sh.600000',
      direction: 'SELL',
      quantity: 100,
    });
    assert('foreign portfolio id returns 404', forbidden.status === 404);
    assert('foreign portfolio id is not replaced by another id', calls[1]?.portfolio_id === 999999);
    assert('foreign portfolio attempt performs one facade call', calls.length === 2);
  } finally {
    (paperTradingFacade as any).placeOrder = originalPlaceOrder;
  }

  console.log(`${passed} ok, ${failed} failed`);
}

void run()
  .then(() => process.exit(failed === 0 ? 0 : 1))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
