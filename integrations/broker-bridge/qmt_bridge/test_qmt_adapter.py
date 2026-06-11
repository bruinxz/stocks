"""QmtAdapter 单元测试。

不依赖 xtquant；用 fake trader 注入 `_trader_factory` / `_constants`。
覆盖：
  - xtquant 缺失时 connect() 返回 False
  - connect 后查询返回结构正确
  - place_order BUY/SELL 走对应 xtconstant
  - cancel_order 异步语义
  - order status mapping

跑：
  cd integrations/broker-bridge
  python -m pytest qmt_bridge/test_qmt_adapter.py -v
"""
from __future__ import annotations

from qmt_bridge.qmt_adapter import QmtAdapter, _xt_status_to_str, _xt_order_type_to_side


class FakeAsset:
    def __init__(self):
        self.total_asset = 12345.67
        self.cash = 10000.0
        self.market_value = 2345.67
        self.frozen_cash = 0.0
        self.total_profit_and_loss = 100.0
        self.today_profit_and_loss = 50.0
        self.account_type = "STOCK"
        self.account_id = "1234567890"


class FakePosition:
    def __init__(self, stock_code, volume, open_price, market_value):
        self.stock_code = stock_code
        self.volume = volume
        self.can_use_volume = volume
        self.frozen_volume = 0
        self.open_price = open_price
        self.market_value = market_value
        self.profit_and_loss = market_value - open_price * volume


class FakeOrder:
    def __init__(self, order_id, stock_code, side_const, qty, price, status):
        self.order_id = order_id
        self.stock_code = stock_code
        self.order_type = side_const
        self.order_volume = qty
        self.traded_volume = 0
        self.price = price
        self.order_status = status
        self.order_time = 1700000000
        self.order_remark = ""
        self.strategy_name = "live_bridge"


class FakeTrade:
    def __init__(self, traded_id, order_id, stock_code, side_const, qty, price):
        self.traded_id = traded_id
        self.order_id = order_id
        self.stock_code = stock_code
        self.order_type = side_const
        self.traded_volume = qty
        self.traded_price = price
        self.traded_amount = qty * price
        self.traded_time = 1700000000


class FakeTrader:
    """模拟 XtQuantTrader 行为。"""

    def __init__(self):
        self.started = False
        self.connected = False
        self.subscribed = False
        self._orders = []
        self._trades = []
        self._next_order_id = 1000

    def start(self): self.started = True

    def connect(self): self.connected = True; return 0

    def subscribe(self, account): self.subscribed = True; return 0

    def query_stock_asset(self, account):
        return FakeAsset()

    def query_stock_positions(self, account):
        return [FakePosition("600519.SH", 100, 1700.0, 175000.0)]

    def query_stock_orders(self, account, cancelable_only=False):
        return list(self._orders)

    def query_stock_trades(self, account):
        return list(self._trades)

    def order_stock(self, account, stock_code, order_type, qty, price_type, price, strategy, remark):
        oid = self._next_order_id
        self._next_order_id += 1
        order = FakeOrder(oid, stock_code, order_type, qty, price, 48)  # submitted
        self._orders.append(order)
        return oid

    def cancel_order_stock(self, account, order_id):
        for o in self._orders:
            if getattr(o, "order_id", None) == int(order_id):
                o.order_status = 52  # cancelled
                return 0
        return -1


class FakeXtconstant:
    STOCK_BUY = 23
    STOCK_SELL = 24
    FIX_PRICE = 11


class FakeStockAccount:
    def __init__(self, account_id, account_type):
        self.account_id = account_id
        self.account_type = account_type


def make_adapter():
    fake_trader = FakeTrader()

    def factory(userdata_path, session_id):
        return fake_trader

    constants = {"xtconstant": FakeXtconstant, "StockAccount": FakeStockAccount}
    adapter = QmtAdapter(
        account_id="1234567890",
        userdata_path="/fake",
        _trader_factory=factory,
        _constants=constants,
    )
    return adapter, fake_trader


# ---------- 连接 / 缺失 ----------

def test_connect_without_xtquant_returns_false():
    adapter = QmtAdapter(account_id="x", userdata_path="/fake")
    # 真实环境 xtquant 不存在；不应抛
    assert adapter.connect() is False
    assert adapter.is_logged_in() is False


def test_connect_with_fake_factory_succeeds():
    adapter, fake = make_adapter()
    assert adapter.connect() is True
    assert fake.started and fake.connected and fake.subscribed
    assert adapter.is_logged_in() is True


def test_connect_idempotent():
    adapter, _ = make_adapter()
    adapter.connect()
    assert adapter.connect() is True  # 第二次直接返回 True，不重复 start


def test_connect_requires_account_id():
    adapter = QmtAdapter(account_id=None, userdata_path="/fake")
    assert adapter.connect() is False


# ---------- 查询 ----------

def test_query_asset_returns_normalized_dict():
    adapter, _ = make_adapter()
    adapter.connect()
    asset = adapter.query_asset()
    assert asset["total_asset"] == 12345.67
    assert asset["available_cash"] == 10000.0
    assert asset["market_value"] == 2345.67
    assert "snapshot_time" in asset


def test_query_asset_returns_safe_default_without_connect():
    adapter = QmtAdapter(account_id="x", userdata_path="/fake")
    asset = adapter.query_asset()
    assert asset["total_asset"] == 0.0
    assert asset["raw_payload"]["error"]


def test_query_positions_filters_zero_volume():
    adapter, fake = make_adapter()
    adapter.connect()
    fake.query_stock_positions = lambda account: [
        FakePosition("600519.SH", 100, 1700, 175000),
        FakePosition("000001.SZ", 0, 12, 0),  # 应被过滤
    ]
    positions = adapter.query_positions()
    assert len(positions) == 1
    assert positions[0]["symbol"] == "600519.SH"
    assert positions[0]["quantity"] == 100


def test_query_today_orders_maps_status():
    adapter, fake = make_adapter()
    adapter.connect()
    fake._orders = [
        FakeOrder(1, "600519.SH", FakeXtconstant.STOCK_BUY, 100, 1700, 54),  # filled
        FakeOrder(2, "000001.SZ", FakeXtconstant.STOCK_SELL, 100, 12, 52),  # cancelled
    ]
    orders = adapter.query_today_orders()
    assert orders[0]["status"] == "filled"
    assert orders[0]["side"] == "BUY"
    assert orders[1]["status"] == "cancelled"
    assert orders[1]["side"] == "SELL"


def test_query_today_trades_maps_fields():
    adapter, fake = make_adapter()
    adapter.connect()
    fake._trades = [FakeTrade("t1", 1, "600519.SH", FakeXtconstant.STOCK_BUY, 100, 1700)]
    trades = adapter.query_today_trades()
    assert trades[0]["broker_trade_id"] == "t1"
    assert trades[0]["trade_amount"] == 170000.0


# ---------- 下单 / 撤单 ----------

def test_place_order_buy_returns_broker_order_id():
    adapter, fake = make_adapter()
    adapter.connect()
    res = adapter.place_order("600519.SH", "BUY", 100, 1700.0)
    assert res["broker_order_id"] == "1000"
    assert "error" not in res
    # fake 已记录 1 笔订单
    assert len(fake._orders) == 1
    assert fake._orders[0].order_type == FakeXtconstant.STOCK_BUY


def test_place_order_sell_uses_sell_const():
    adapter, fake = make_adapter()
    adapter.connect()
    adapter.place_order("600519.SH", "SELL", 100, 1700.0)
    assert fake._orders[0].order_type == FakeXtconstant.STOCK_SELL


def test_place_order_invalid_side():
    adapter, _ = make_adapter()
    adapter.connect()
    res = adapter.place_order("600519.SH", "HOLD", 100, 1700)
    assert res["broker_order_id"] is None
    assert "invalid side" in res["error"]


def test_place_order_without_connect_safe():
    adapter = QmtAdapter(account_id="x", userdata_path="/fake")
    res = adapter.place_order("600519.SH", "BUY", 100, 1700)
    assert res["broker_order_id"] is None
    assert res["error"]


def test_place_order_negative_return_marked_failed():
    adapter, fake = make_adapter()
    adapter.connect()
    fake.order_stock = lambda *a, **kw: -1
    res = adapter.place_order("600519.SH", "BUY", 100, 1700)
    assert res["broker_order_id"] is None
    assert "returned -1" in res["error"]


def test_cancel_order_success():
    adapter, fake = make_adapter()
    adapter.connect()
    place = adapter.place_order("600519.SH", "BUY", 100, 1700)
    res = adapter.cancel_order(place["broker_order_id"])
    assert res["submitted"] is True
    # FakeTrader 撤单后会把订单状态改成 cancelled
    assert fake._orders[0].order_status == 52


def test_cancel_order_unknown_id():
    adapter, fake = make_adapter()
    adapter.connect()
    res = adapter.cancel_order("9999")
    assert res["submitted"] is False
    assert "returned -1" in res["error"]


def test_cancel_order_non_integer():
    adapter, _ = make_adapter()
    adapter.connect()
    res = adapter.cancel_order("not-a-number")
    assert res["submitted"] is False
    assert "不是合法整数" in res["error"]


# ---------- 常量映射 ----------

def test_xt_order_type_to_side():
    assert _xt_order_type_to_side(23) == "BUY"
    assert _xt_order_type_to_side(24) == "SELL"
    assert _xt_order_type_to_side(0) == "BUY"  # 兜底


def test_xt_status_to_str_full_table():
    assert _xt_status_to_str(48) == "submitted"
    assert _xt_status_to_str(54) == "filled"
    assert _xt_status_to_str(52) == "cancelled"
    assert _xt_status_to_str(55) == "failed"
    assert _xt_status_to_str(57) == "pending"
    assert _xt_status_to_str(999) == "submitted"  # unknown → 默认 submitted


if __name__ == "__main__":
    # 不依赖 pytest 的简化 runner
    import sys, traceback
    passed = failed = 0
    for name, fn in list(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            passed += 1
            print(f"  ok  {name}")
        except Exception as e:
            failed += 1
            print(f"  FAIL {name}: {e}")
            traceback.print_exc()
    print(f"\nResult: {passed} passed, {failed} failed")
    sys.exit(0 if failed == 0 else 1)
