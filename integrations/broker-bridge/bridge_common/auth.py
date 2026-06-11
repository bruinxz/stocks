"""HMAC 签名实现，与 backend/src/live-trading/middlewares/bridgeAuth.ts 对齐。

签名 base string（按行 \n 分隔）：
  method
  path                 # 不含 query
  canonical_query      # 规范化后的 query：按 key 升序，RFC3986 编码（空格 → %20）
  timestamp_ms
  nonce
  sha256(body)         # 空 body → sha256('')
"""
from __future__ import annotations

import hashlib
import hmac
import time
import uuid
from typing import Iterable, Tuple
from urllib.parse import parse_qsl, quote


# P2 review：Node 的 encodeURIComponent 不编码 ! * ' ( )，
# Python quote 默认会编码这些。两端必须字节对齐，否则 query 含这些字符时签名失败。
# 因此 safe="~!*'()"
_RFC3986_UNRESERVED_SAFE = "~!*'()"


def hash_body(body: str) -> str:
    return hashlib.sha256((body or "").encode("utf-8")).hexdigest()


def canonicalize_query(raw_query: str) -> str:
    """与 backend bridgeAuth.canonicalizeQuery 字节对齐。"""
    if not raw_query:
        return ""
    pairs: list[Tuple[str, str]] = []
    for k, v in parse_qsl(raw_query, keep_blank_values=True, encoding="utf-8"):
        ek = quote(k, safe=_RFC3986_UNRESERVED_SAFE)
        ev = quote(v, safe=_RFC3986_UNRESERVED_SAFE)
        pairs.append((ek, ev))
    pairs.sort()
    return "&".join(f"{k}={v}" for k, v in pairs)


def canonicalize_params(params: Iterable[Tuple[str, str]]) -> str:
    """直接接受 (key, value) 列表，按相同规则规范化。"""
    pairs: list[Tuple[str, str]] = []
    for k, v in params:
        if v is None:
            continue
        ek = quote(str(k), safe=_RFC3986_UNRESERVED_SAFE)
        ev = quote(str(v), safe=_RFC3986_UNRESERVED_SAFE)
        pairs.append((ek, ev))
    pairs.sort()
    return "&".join(f"{k}={v}" for k, v in pairs)


def build_signature_base(
    method: str,
    path: str,
    canonical_query: str,
    timestamp_ms: int,
    nonce: str,
    body: str,
) -> str:
    return "\n".join([
        method.upper(),
        path,
        canonical_query or "",
        str(timestamp_ms),
        nonce,
        hash_body(body),
    ])


def sign(secret: str, base_string: str) -> str:
    return hmac.new(secret.encode("utf-8"), base_string.encode("utf-8"), hashlib.sha256).hexdigest()


def make_auth_headers(
    method: str,
    path: str,
    body: str,
    bridge_key: str,
    bridge_secret: str,
    canonical_query: str = "",
) -> Tuple[dict, int, str]:
    timestamp_ms = int(time.time() * 1000)
    nonce = uuid.uuid4().hex
    base = build_signature_base(method, path, canonical_query, timestamp_ms, nonce, body)
    signature = sign(bridge_secret, base)
    headers = {
        "X-Live-Bridge-Key": bridge_key,
        "X-Live-Bridge-Timestamp": str(timestamp_ms),
        "X-Live-Bridge-Nonce": nonce,
        "X-Live-Bridge-Signature": signature,
        "Content-Type": "application/json",
    }
    return headers, timestamp_ms, nonce
