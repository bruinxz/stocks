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
        return cfg
