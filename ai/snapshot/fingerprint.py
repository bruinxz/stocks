import hashlib
import json


def jcs_canonicalize(obj) -> str:
    """RFC 8785 JCS canonical JSON serialization."""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def compute_input_fingerprint(input_hashes: list[str]) -> str:
    sorted_hashes = sorted(input_hashes)
    combined = "\n".join(sorted_hashes)
    return hashlib.sha256(combined.encode()).hexdigest()


def compute_output_fingerprint(items: list[dict]) -> str:
    items_for_hash = sorted(items, key=lambda x: x["recommendation"]["ticker"])

    cleaned = []
    for item in items_for_hash:
        rec = dict(item["recommendation"])
        cleaned.append({
            "recommendation": rec,
            "rating_band": item["rating_band"],
        })

    canonical = jcs_canonicalize(cleaned)
    return hashlib.sha256(canonical.encode()).hexdigest()
