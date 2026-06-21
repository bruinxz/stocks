"""配置加载。"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Optional

import yaml


@dataclass
class BridgeConfig:
    server_base_url: str
    bridge_key: str
    bridge_secret: str
    broker_type: str = "qmt"
    # US-109 [EX-009] ed25519 升级: signature_method 切换. "hmac" 兼容老 bridge (缺省),
    # "ed25519" 启用非对称签名. ed25519 模式下 bridge_secret 仍要求填 (向后兼容字段,
    # 不参与签名), ed25519_private_key 必填. server 端只持公钥, 不持私钥.
    signature_method: str = "hmac"
    ed25519_private_key: Optional[str] = None
    qmt_userdata_path: Optional[str] = None
    qmt_account_id: Optional[str] = None
    account_id_masked: Optional[str] = None
    long_poll_seconds: int = 30
    snapshot_interval_seconds: int = 30
    heartbeat_interval_seconds: int = 15
    max_single_order_amount: float = 10000.0
    readonly_only: bool = True
    allow_order_execution: bool = False
    local_kill_switch_file: str = "./KILL_SWITCH_ON"
    event_seq_state_file: str = "./var/seq.last"
    clock_skew_startup_threshold_seconds: int = 30
    extra: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def load(cls, path: str) -> "BridgeConfig":
        if not os.path.exists(path):
            raise FileNotFoundError(f"config not found: {path}")
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        known_fields = {f.name for f in cls.__dataclass_fields__.values()}
        extras = {k: v for k, v in data.items() if k not in known_fields}
        kwargs = {k: v for k, v in data.items() if k in known_fields}
        kwargs.setdefault("server_base_url", "")
        kwargs.setdefault("bridge_key", "")
        kwargs.setdefault("bridge_secret", "")
        cfg = cls(**kwargs, extra=extras)
        if not cfg.server_base_url or not cfg.bridge_key or not cfg.bridge_secret:
            raise ValueError("config 缺少 server_base_url / bridge_key / bridge_secret")
        sm = (cfg.signature_method or "hmac").lower().strip()
        if sm not in ("hmac", "ed25519"):
            raise ValueError(f"signature_method 必须是 hmac/ed25519, got {cfg.signature_method!r}")
        cfg.signature_method = sm
        if sm == "ed25519" and not cfg.ed25519_private_key:
            raise ValueError("signature_method=ed25519 必须配 ed25519_private_key")
        return cfg
