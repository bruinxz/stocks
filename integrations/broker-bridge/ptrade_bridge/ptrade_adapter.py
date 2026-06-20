"""PTrade 适配 stub (US-110 [EX-010]).

PTrade Python API 与券商版本相关 (国信 / 海通 / ...) 当前未引入 SDK; 此 stub 提供与
QmtAdapter 同款方法签名, 所有方法**显式拒绝**而非 silent 0 / None, 让上层 BridgeService /
LiveBrokerCommand 派单流程能拿到清晰 error 字段写 RiskAlert.

兼容矩阵单一事实源:
  - 文档: docs/broker_bridge_compat_matrix.md
  - 代码: backend/src/live-trading/brokers/brokerCompatMatrix.ts (BROKER_COMPAT_MATRIX.ptrade)
  - 单测: backend/tests/live-trading/broker-compat-matrix.test.ts (两边漂移 fail)

真接入步骤:
  1. 在目标券商 PTrade 客户端环境 (Windows + 客户端) 安装 PTrade Python SDK
  2. 参考 qmt_adapter.py 同款"延迟 import + 缺失即拒服务"模式实现 _load_ptrade()
  3. 按下表实现 connect / query_* / place_order / cancel_order
  4. 同步把 BROKER_COMPAT_MATRIX.ptrade 的 readonly_supported / trading_supported / order_types
     / events 改为 true (与实现一致), 跑单测确认两边对齐
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger("ptrade_adapter")


_NOT_IMPLEMENTED_ERROR = "PtradeAdapter not implemented (stub; see docs/broker_bridge_compat_matrix.md)"


class PtradeAdapter:
    """
    PTrade 适配 stub. 实例化不会触发 SDK import (SDK 不存在); 所有方法返回明确的
    error/降级值而非抛异常, 让 bridge 主循环不会崩溃.

    与 QmtAdapter 接口对齐, 让 BridgeService 可统一 type 处理两种 adapter.
    """

    def __init__(
        self,
        account_id: Optional[str] = None,
        userdata_path: Optional[str] = None,
    ):
        self.account_id = account_id
        self.userdata_path = userdata_path
        self._connected = False

    # ---------- 连接 / 订阅 ----------

    def connect(self) -> bool:
        """stub: PTrade SDK 未引入, 直接返 False (与 QmtAdapter 缺失 xtquant 时同款)."""
        logger.error("connect(): %s", _NOT_IMPLEMENTED_ERROR)
        return False

    def is_logged_in(self) -> bool:
        """stub: 永远 False, heartbeat 主循环会上报 status=logged_out."""
        return False

    # ---------- 查询 ----------

    def query_asset(self) -> Dict[str, Any]:
        return {
            "total_asset": 0.0,
            "available_cash": 0.0,
            "market_value": 0.0,
            "snapshot_time": datetime.now(timezone.utc).isoformat(),
            "raw_payload": {"error": _NOT_IMPLEMENTED_ERROR},
        }

    def query_positions(self) -> List[Dict[str, Any]]:
        return []

    def query_today_orders(self) -> List[Dict[str, Any]]:
        return []

    def query_today_trades(self) -> List[Dict[str, Any]]:
        return []

    # ---------- 执行 ----------

    def place_order(self, symbol: str, side: str, quantity: int, limit_price: float) -> Dict[str, Any]:
        """stub: 拒绝所有下单. server 派单前应查 BROKER_COMPAT_MATRIX.ptrade.trading_supported."""
        del symbol, side, quantity, limit_price  # silence linter; stub 不消费参数
        return {"broker_order_id": None, "error": _NOT_IMPLEMENTED_ERROR}

    def cancel_order(self, broker_order_id: str) -> Dict[str, Any]:
        del broker_order_id
        return {"submitted": False, "error": _NOT_IMPLEMENTED_ERROR}
