"""签名实现，与 backend/src/live-trading/middlewares/bridgeAuth.ts 对齐。

支持两种 signature method (US-109 [EX-009] ed25519 升级):
  - "hmac"    : HMAC-SHA256, 对称密钥, 兼容旧 bridge (缺省)
  - "ed25519" : Ed25519 detached signature, 非对称
                bridge 持 private key (32 字节 seed), server 仅持 public key
                即使 server 端 env/DB 泄露也无法伪造命令

签名 base string（按行 \n 分隔, 两条 path 共用）：
  method
  path                 # 不含 query
  canonical_query      # 规范化后的 query：按 key 升序，RFC3986 编码（空格 → %20）
  timestamp_ms
  nonce
  sha256(body)         # 空 body → sha256('')
"""
from __future__ import annotations

import binascii
import hashlib
import hmac
import time
import uuid
from typing import Iterable, Optional, Tuple
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
    """HMAC-SHA256 hex 签名 (缺省 path)."""
    return hmac.new(secret.encode("utf-8"), base_string.encode("utf-8"), hashlib.sha256).hexdigest()


# ---------------------------------------------------------------------------
# US-109 [EX-009] ed25519 path
# ---------------------------------------------------------------------------


def _load_ed25519_seed(raw: str) -> bytes:
    """把 bridge 配置里的 ed25519 private key 字符串解码成 32 字节 seed.

    接受 (按 try 顺序):
      - PEM (BEGIN PRIVATE KEY...) — 需要 cryptography 库, 不强依赖
      - hex 64 字符 = 32 字节 seed
      - base64 (44 字符) = 32 字节 seed
    解码失败抛 ValueError, 调用方应在启动时早 fail.
    """
    s = (raw or "").strip()
    if not s:
        raise ValueError("ed25519 private key 为空")
    if "-----BEGIN" in s:
        try:
            from cryptography.hazmat.primitives.serialization import load_pem_private_key

            key = load_pem_private_key(s.encode("utf-8"), password=None)
            from cryptography.hazmat.primitives.asymmetric.ed25519 import (
                Ed25519PrivateKey,
            )
            from cryptography.hazmat.primitives.serialization import (
                Encoding,
                NoEncryption,
                PrivateFormat,
            )

            if not isinstance(key, Ed25519PrivateKey):
                raise ValueError("PEM 不是 Ed25519 private key")
            # raw seed 32 bytes
            return key.private_bytes(
                Encoding.Raw, PrivateFormat.Raw, NoEncryption()
            )
        except ImportError as e:
            raise ValueError(
                "ed25519 PEM 解析需要 cryptography 库, pip install cryptography"
            ) from e
    if len(s) == 64 and all(c in "0123456789abcdefABCDEF" for c in s):
        return binascii.unhexlify(s)
    # base64
    import base64

    try:
        buf = base64.b64decode(s, validate=False)
    except Exception as e:
        raise ValueError(f"ed25519 私钥 base64 解析失败: {e}") from e
    if len(buf) != 32:
        raise ValueError(
            f"ed25519 seed 必须是 32 字节 (base64 解出 {len(buf)} 字节)"
        )
    return buf


def sign_ed25519(private_key: str, base_string: str) -> str:
    """Ed25519 detached signature, hex 64 字节 (128 hex chars).

    private_key: 32 字节 seed 的 hex / base64 / PEM 表示
    使用 cryptography 库 (要求 pip install cryptography). 没装会在解析阶段就 throw,
    不是签名阶段; 因此 dev/CI 早 fail.
    """
    seed = _load_ed25519_seed(private_key)
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
    except ImportError as e:
        raise ValueError(
            "ed25519 签名需要 cryptography 库, pip install cryptography"
        ) from e
    key = Ed25519PrivateKey.from_private_bytes(seed)
    sig = key.sign(base_string.encode("utf-8"))
    return sig.hex()


def derive_ed25519_pubkey_hex(private_key: str) -> str:
    """从私钥派生 raw 32 字节 ed25519 公钥 (hex), 用于在 server 配置 LIVE_BRIDGE_ED25519_PUBKEYS.

    bridge 操作员只在 server 端配公钥 hex; 私钥永远不出 bridge 机器.
    """
    seed = _load_ed25519_seed(private_key)
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
        from cryptography.hazmat.primitives.serialization import (
            Encoding,
            PublicFormat,
        )
    except ImportError as e:
        raise ValueError(
            "derive_ed25519_pubkey_hex 需要 cryptography 库"
        ) from e
    key = Ed25519PrivateKey.from_private_bytes(seed)
    pub = key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    return pub.hex()


def make_auth_headers(
    method: str,
    path: str,
    body: str,
    bridge_key: str,
    bridge_secret: str,
    canonical_query: str = "",
    signature_method: str = "hmac",
    ed25519_private_key: Optional[str] = None,
) -> Tuple[dict, int, str]:
    """生成 bridge 鉴权头.

    signature_method:
      - "hmac" (缺省): 用 bridge_secret HMAC-SHA256 签
      - "ed25519": 用 ed25519_private_key 签; bridge_secret 仍传 (兼容 callers 不必改),
        但不参与签名. server 端按 X-Live-Bridge-Sig-Method 路由到对应 verify path.
    """
    timestamp_ms = int(time.time() * 1000)
    nonce = uuid.uuid4().hex
    base = build_signature_base(method, path, canonical_query, timestamp_ms, nonce, body)
    method_lower = (signature_method or "hmac").lower().strip()
    if method_lower == "ed25519":
        if not ed25519_private_key:
            raise ValueError("signature_method=ed25519 需要 ed25519_private_key")
        signature = sign_ed25519(ed25519_private_key, base)
    else:
        signature = sign(bridge_secret, base)
    headers = {
        "X-Live-Bridge-Key": bridge_key,
        "X-Live-Bridge-Timestamp": str(timestamp_ms),
        "X-Live-Bridge-Nonce": nonce,
        "X-Live-Bridge-Signature": signature,
        "X-Live-Bridge-Sig-Method": method_lower if method_lower == "ed25519" else "hmac",
        "Content-Type": "application/json",
    }
    return headers, timestamp_ms, nonce

