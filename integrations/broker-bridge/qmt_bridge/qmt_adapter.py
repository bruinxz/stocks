"""QMT 适配实现（xtquant）。

设计：xtquant 只能在 Windows + QMT 客户端登录后才能加载；在 Linux/CI 上 import 会失败，
所以这里采用"延迟 import + 缺失即拒服务"的模式：

  - 模块顶部不直接 `from xtquant.xttrader import ...`，避免开发机和 CI 跑测试时炸。
  - QmtAdapter 实例化时不会立刻连 xtquant；调用 connect() 才真正 import & 初始化。
  - xtquant 缺失时 connect() 返回 False 并打日志；place_order / cancel_order 等
    都会安全降级为返回带 error 的 dict，bridge 主流程不会崩。
  - 所有方法用了 xtquant 的真实 API 签名（来自迅投官方文档 v2.x），Windows 部署机
    复制本文件 + 安装 QMT 客户端 + pip install xtquant 即可工作。

xtquant 关键 API 速查（截至 2025-Q1 QMT v2.x）:
  from xtquant.xttrader import XtQuantTrader, XtQuantTraderCallback
  from xtquant.xttype import StockAccount
  from xtquant import xtconstant

  trader = XtQuantTrader(userdata_path, session_id)
  trader.start()
  trader.connect()                                  # 连后台
  account = StockAccount(account_id, 'STOCK')
  trader.subscribe(account)                         # 订阅账户回报

  trader.query_stock_asset(account) -> XtAsset
  trader.query_stock_positions(account) -> [XtPosition]
  trader.query_stock_orders(account, cancelable_only=False) -> [XtOrder]
  trader.query_stock_trades(account) -> [XtTrade]

  trader.order_stock(
    account,
    stock_code,                                     # "600519.SH"
    order_type,                                     # xtconstant.STOCK_BUY / STOCK_SELL
    quantity,                                       # int，100 整手
    price_type,                                     # xtconstant.FIX_PRICE / MARKET 等
    price,                                          # float
    strategy_name,                                  # str，便于审计
    order_remark                                    # str，回写 broker_order_id
  ) -> int  # 委托号 broker_order_id；<0 失败

  trader.cancel_order_stock(account, order_id) -> int  # 0 成功；其它失败码

注意事项（线上必看）:
  1. xtquant session_id 必须每个进程唯一；本类用 int(time.time()) 兜底
  2. QMT 客户端"勾选-允许策略下单"必须由人工在客户端 UI 勾，代码无法替代
  3. order_stock 是同步阻塞调用，但成交回报通过 callback 异步推；这里不依赖 callback，
     bridge 主循环靠 query_stock_orders 轮询 + push_orders/push_trades 推 server
  4. QMT 委托号在重启后不变，但跨账户可能重复；server 侧 (account_id, broker_order_id)
     unique 索引兜底
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("qmt_adapter")


def _to_iso(value: Any) -> str:
    """xtquant 时间字段统一转 ISO8601 字符串。"""
    if value is None:
        return datetime.now(timezone.utc).isoformat()
    try:
        if isinstance(value, (int, float)):
            # xtquant 通常给秒级 timestamp
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
        return str(value)
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


class QmtAdapter:
    """
    生产实现。xtquant 模块在非 Windows / QMT 未安装时不存在；
    所有 xtquant 调用都包在 try/except，缺失时安全降级，不会 crash 主进程。

    可注入 `_trader_factory` / `_constants` 方便单测用 fake 替换；
    生产场景默认让 connect() 自己去加载真模块。
    """

    def __init__(
        self,
        account_id: Optional[str] = None,
        userdata_path: Optional[str] = None,
        _trader_factory: Optional[Any] = None,
        _constants: Optional[Any] = None,
    ):
        self.account_id = account_id
        self.userdata_path = userdata_path
        self.session_id = int(time.time()) & 0x7FFFFFFF  # 32-bit
        self._trader = None
        self._account = None
        self._connected = False
        self._trader_factory = _trader_factory  # (userdata_path, session_id) -> trader
        self._constants = _constants  # 暴露常量包；单测注入用

    # ---------- 内部 ----------

    def _load_xtquant(self):
        """运行时延迟加载 xtquant；失败抛 ImportError 由调用方处理。"""
        if self._trader_factory and self._constants:
            return self._trader_factory, self._constants
        from xtquant.xttrader import XtQuantTrader  # type: ignore
        from xtquant.xttype import StockAccount  # type: ignore
        from xtquant import xtconstant  # type: ignore

        def factory(userdata_path: str, session_id: int):
            return XtQuantTrader(userdata_path, session_id)

        constants = {
            "xtconstant": xtconstant,
            "StockAccount": StockAccount,
        }
        return factory, constants

    def _require_connected(self) -> bool:
        if not self._connected or self._trader is None or self._account is None:
            logger.warning("QmtAdapter not connected; call connect() first")
            return False
        return True

    # ---------- 连接 / 订阅 ----------

    def connect(self) -> bool:
        """
        启动 XtQuantTrader、connect 后台、subscribe 账户。
        xtquant 缺失或 QMT 客户端未登录时返回 False，bridge 主流程会写心跳 status=logged_out。
        """
        if self._connected:
            return True
        if not self.account_id or not self.userdata_path:
            logger.error("connect(): account_id/userdata_path 必须配置")
            return False
        try:
            factory, constants = self._load_xtquant()
        except ImportError as e:
            logger.error(
                "xtquant import 失败：%s。请确认运行在 Windows + QMT 客户端 + pip install xtquant 的环境。",
                e,
            )
            return False
        try:
            trader = factory(self.userdata_path, self.session_id)
            trader.start()
            ret = trader.connect()
            if ret != 0:
                logger.error("XtQuantTrader.connect() 返回 %s，QMT 客户端可能未登录", ret)
                return False
            StockAccount = constants["StockAccount"]
            account = StockAccount(self.account_id, "STOCK")
            sub_ret = trader.subscribe(account)
            if sub_ret != 0:
                logger.error("XtQuantTrader.subscribe(account) 返回 %s", sub_ret)
                return False
            self._trader = trader
            self._account = account
            self._constants = constants
            self._connected = True
            logger.info("QMT 连接成功，account=%s session=%s", self.account_id, self.session_id)
            return True
        except Exception as e:
            logger.exception("connect() 异常: %s", e)
            return False

    def is_logged_in(self) -> bool:
        """查询 QMT 客户端账户登录状态。xtquant 没有专门的 API，靠 query_stock_asset 是否成功兜底。"""
        if not self._require_connected():
            return False
        try:
            asset = self._trader.query_stock_asset(self._account)
            return asset is not None
        except Exception as e:
            logger.warning("is_logged_in query_stock_asset 异常: %s", e)
            return False

    # ---------- 查询 ----------

    def query_asset(self) -> Dict[str, Any]:
        """xttrader.query_stock_asset(account) -> XtAsset。缺失字段安全填 0。"""
        if not self._require_connected():
            return {
                "total_asset": 0.0,
                "available_cash": 0.0,
                "market_value": 0.0,
                "snapshot_time": datetime.now(timezone.utc).isoformat(),
                "raw_payload": {"error": "QmtAdapter not connected"},
            }
        try:
            asset = self._trader.query_stock_asset(self._account)
            if asset is None:
                return {
                    "total_asset": 0.0,
                    "available_cash": 0.0,
                    "market_value": 0.0,
                    "snapshot_time": datetime.now(timezone.utc).isoformat(),
                    "raw_payload": {"error": "query_stock_asset returned None"},
                }
            return {
                "total_asset": _safe_float(getattr(asset, "total_asset", 0)),
                "available_cash": _safe_float(getattr(asset, "cash", 0)),
                "market_value": _safe_float(getattr(asset, "market_value", 0)),
                "frozen_cash": _safe_float(getattr(asset, "frozen_cash", 0)),
                "total_pnl": _safe_float(getattr(asset, "total_profit_and_loss", 0)),
                "day_pnl": _safe_float(getattr(asset, "today_profit_and_loss", 0)),
                "snapshot_time": datetime.now(timezone.utc).isoformat(),
                "raw_payload": {
                    "account_type": getattr(asset, "account_type", None),
                    "account_id": getattr(asset, "account_id", None),
                },
            }
        except Exception as e:
            logger.exception("query_asset 异常: %s", e)
            return {
                "total_asset": 0.0,
                "available_cash": 0.0,
                "market_value": 0.0,
                "snapshot_time": datetime.now(timezone.utc).isoformat(),
                "raw_payload": {"error": str(e)},
            }

    def query_positions(self) -> List[Dict[str, Any]]:
        """xttrader.query_stock_positions(account) -> [XtPosition]。"""
        if not self._require_connected():
            return []
        try:
            positions = self._trader.query_stock_positions(self._account) or []
        except Exception as e:
            logger.exception("query_positions 异常: %s", e)
            return []
        out: List[Dict[str, Any]] = []
        for p in positions:
            quantity = _safe_int(getattr(p, "volume", 0))
            if quantity <= 0:
                continue
            avg_cost = _safe_float(getattr(p, "open_price", 0))
            current_price = _safe_float(getattr(p, "market_value", 0)) / max(quantity, 1) if quantity else 0
            out.append(
                {
                    "symbol": str(getattr(p, "stock_code", "")),
                    "name": None,  # xtquant 不直接给名称；server 侧用 stock 表 join
                    "quantity": quantity,
                    "available_quantity": _safe_int(getattr(p, "can_use_volume", 0)),
                    "avg_cost": avg_cost,
                    "current_price": current_price if current_price > 0 else avg_cost,
                    "market_value": _safe_float(getattr(p, "market_value", 0)),
                    "unrealized_pnl": _safe_float(getattr(p, "profit_and_loss", 0)),
                    "unrealized_pnl_pct": 0.0,  # xtquant 不直接给；server 端可算
                    "quote_time": datetime.now(timezone.utc).isoformat(),
                    "raw_payload": {"frozen_volume": _safe_int(getattr(p, "frozen_volume", 0))},
                }
            )
        return out

    def query_today_orders(self) -> List[Dict[str, Any]]:
        """xttrader.query_stock_orders(account, cancelable_only=False) -> [XtOrder]。"""
        if not self._require_connected():
            return []
        try:
            orders = self._trader.query_stock_orders(self._account, cancelable_only=False) or []
        except Exception as e:
            logger.exception("query_today_orders 异常: %s", e)
            return []
        out: List[Dict[str, Any]] = []
        for o in orders:
            order_status = _safe_int(getattr(o, "order_status", 0))
            out.append(
                {
                    "broker_order_id": str(getattr(o, "order_id", "")),
                    "client_order_id": str(getattr(o, "order_remark", "") or ""),
                    "symbol": str(getattr(o, "stock_code", "")),
                    "side": _xt_order_type_to_side(getattr(o, "order_type", 0)),
                    "quantity": _safe_int(getattr(o, "order_volume", 0)),
                    "limit_price": _safe_float(getattr(o, "price", 0)),
                    "status": _xt_status_to_str(order_status),
                    "bridge_status": _xt_status_to_str(order_status),
                    "submitted_at": _to_iso(getattr(o, "order_time", None)),
                    "raw_payload": {
                        "traded_volume": _safe_int(getattr(o, "traded_volume", 0)),
                        "order_status_raw": order_status,
                        "strategy_name": getattr(o, "strategy_name", None),
                    },
                }
            )
        return out

    def query_today_trades(self) -> List[Dict[str, Any]]:
        """xttrader.query_stock_trades(account) -> [XtTrade]。"""
        if not self._require_connected():
            return []
        try:
            trades = self._trader.query_stock_trades(self._account) or []
        except Exception as e:
            logger.exception("query_today_trades 异常: %s", e)
            return []
        out: List[Dict[str, Any]] = []
        for t in trades:
            quantity = _safe_int(getattr(t, "traded_volume", 0))
            price = _safe_float(getattr(t, "traded_price", 0))
            out.append(
                {
                    "broker_trade_id": str(getattr(t, "traded_id", "")),
                    "broker_order_id": str(getattr(t, "order_id", "")),
                    "symbol": str(getattr(t, "stock_code", "")),
                    "side": _xt_order_type_to_side(getattr(t, "order_type", 0)),
                    "quantity": quantity,
                    "trade_price": price,
                    "trade_amount": _safe_float(getattr(t, "traded_amount", quantity * price)),
                    "trade_time": _to_iso(getattr(t, "traded_time", None)),
                    "raw_payload": {},
                }
            )
        return out

    # ---------- 执行 ----------

    def place_order(self, symbol: str, side: str, quantity: int, limit_price: float) -> Dict[str, Any]:
        """
        xttrader.order_stock(...) -> broker_order_id (int)。
        return:
          {broker_order_id: str | None, error: str | None}
        """
        if not self._require_connected():
            return {"broker_order_id": None, "error": "QmtAdapter not connected"}
        constants = self._constants
        xtconstant = constants["xtconstant"]
        side_upper = (side or "").upper()
        if side_upper == "BUY":
            order_type = xtconstant.STOCK_BUY
        elif side_upper == "SELL":
            order_type = xtconstant.STOCK_SELL
        else:
            return {"broker_order_id": None, "error": f"invalid side: {side}"}
        try:
            ret = self._trader.order_stock(
                self._account,
                str(symbol),
                order_type,
                int(quantity),
                xtconstant.FIX_PRICE,
                float(limit_price),
                "live_bridge",  # strategy_name 落 server 侧审计 raw_payload.strategy_name
                "",             # order_remark，由 server 端 client_order_id 反向追溯
            )
        except Exception as e:
            logger.exception("order_stock 异常: %s", e)
            return {"broker_order_id": None, "error": f"xtquant exception: {e}"}
        if ret is None or ret < 0:
            return {"broker_order_id": None, "error": f"order_stock returned {ret}"}
        return {"broker_order_id": str(ret)}

    def cancel_order(self, broker_order_id: str) -> Dict[str, Any]:
        """
        xttrader.cancel_order_stock(account, order_id) -> int。
        return:
          {submitted: bool, error: str | None}
        注意：QMT 撤单是异步过程，返回 0 仅表示"请求已提交"，撤单成功要等 trade callback。
        bridge 主循环靠 query_stock_orders 轮询验证。
        """
        if not self._require_connected():
            return {"submitted": False, "error": "QmtAdapter not connected"}
        try:
            ret = self._trader.cancel_order_stock(self._account, int(broker_order_id))
        except (TypeError, ValueError) as e:
            return {"submitted": False, "error": f"broker_order_id 不是合法整数: {broker_order_id} ({e})"}
        except Exception as e:
            logger.exception("cancel_order_stock 异常: %s", e)
            return {"submitted": False, "error": f"xtquant exception: {e}"}
        if ret == 0:
            return {"submitted": True}
        return {"submitted": False, "error": f"cancel_order_stock returned {ret}"}


# ---------- xtquant 常量解析 ----------

# xtconstant 的实际数值在不同 QMT 版本可能微调；以下映射兜底，
# 实际优先用 xtconstant 模块常量（QmtAdapter 已经依赖 xtconstant）。
_XT_ORDER_TYPE_BUY = 23  # xtconstant.STOCK_BUY
_XT_ORDER_TYPE_SELL = 24  # xtconstant.STOCK_SELL


def _xt_order_type_to_side(value: Any) -> str:
    v = _safe_int(value)
    if v == _XT_ORDER_TYPE_BUY:
        return "BUY"
    if v == _XT_ORDER_TYPE_SELL:
        return "SELL"
    return "BUY"


def _xt_status_to_str(value: Any) -> str:
    """
    XtQuant 订单状态码 → server 侧 bridge_status 字符串。
    参考 xtconstant：
      48 ORDER_REPORTED       已报
      49 ORDER_REPORTED_CANCEL 已报待撤
      50 ORDER_PARTSUCC_CANCEL 部成待撤
      51 ORDER_PART_CANCEL    部撤
      52 ORDER_CANCELED       已撤
      53 ORDER_PART_SUCC      部成
      54 ORDER_SUCCEEDED      全成
      55 ORDER_JUNK           废单
      56 ORDER_UNREPORTED     未报
      57 ORDER_WAIT_REPORTING 待报
      58 ORDER_REJECTED       已拒
    """
    v = _safe_int(value)
    mapping = {
        48: "submitted",
        49: "submitted",
        50: "partially_filled",
        51: "cancelled",
        52: "cancelled",
        53: "partially_filled",
        54: "filled",
        55: "failed",
        56: "pending",
        57: "pending",
        58: "failed",
    }
    return mapping.get(v, "submitted")
