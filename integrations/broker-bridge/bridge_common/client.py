"""HTTP client：包装 HMAC 鉴权 + 长轮询 / ack / event 推送。"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import requests

from .auth import canonicalize_params, make_auth_headers
from .config import BridgeConfig


class BridgeClient:
    def __init__(self, config: BridgeConfig):
        self.config = config
        self._session = requests.Session()

    def _post(self, sub_path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        url = f"{self.config.server_base_url.rstrip('/')}/{sub_path.lstrip('/')}"
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        path = urlparse(url).path
        headers, _, _ = make_auth_headers(
            "POST",
            path,
            body,
            self.config.bridge_key,
            self.config.bridge_secret,
            canonical_query="",
            signature_method=self.config.signature_method,
            ed25519_private_key=self.config.ed25519_private_key,
        )
        resp = self._session.post(url, data=body.encode("utf-8"), headers=headers, timeout=20)
        resp.raise_for_status()
        return resp.json()

    def _get(self, sub_path: str, params: Optional[Dict[str, Any]] = None, timeout: int = 60) -> Dict[str, Any]:
        url = f"{self.config.server_base_url.rstrip('/')}/{sub_path.lstrip('/')}"
        path = urlparse(url).path
        # 用 canonical_params 计算签名串，requests 实际发出 url 也按相同 canonical 顺序构造
        items = [(k, v) for k, v in (params or {}).items() if v is not None]
        canonical_query = canonicalize_params(items)
        headers, _, _ = make_auth_headers(
            "GET",
            path,
            "",
            self.config.bridge_key,
            self.config.bridge_secret,
            canonical_query=canonical_query,
            signature_method=self.config.signature_method,
            ed25519_private_key=self.config.ed25519_private_key,
        )
        full_url = f"{url}?{canonical_query}" if canonical_query else url
        resp = self._session.get(full_url, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.json()

    # ----------------- 推送 -----------------

    def heartbeat(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("heartbeat", payload)

    def push_account_snapshot(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._post("account-snapshot", payload)

    def push_positions(self, positions: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._post("positions", {"positions": positions})

    def push_orders(self, orders: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._post("orders", {"orders": orders})

    def push_trades(self, trades: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._post("trades", {"trades": trades})

    def push_order_events(self, events: List[Dict[str, Any]]) -> Dict[str, Any]:
        return self._post("order-events", {"events": events})

    # ----------------- 命令通道 -----------------

    def pull_commands(self, wait_seconds: int = 30, limit: int = 10) -> List[Dict[str, Any]]:
        # 长轮询 timeout 必须大于 wait + 缓冲
        resp = self._get("order-commands", {"wait": wait_seconds, "limit": limit}, timeout=wait_seconds + 15)
        return (resp.get("data") or {}).get("commands") or []

    def ack_command(self, command_id: int) -> Dict[str, Any]:
        return self._post(f"order-commands/{command_id}/ack", {})
