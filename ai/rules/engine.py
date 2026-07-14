import yaml
import hashlib
import json
from pathlib import Path


class RuleEngine:
    def __init__(self, model_version: str):
        self._model_version = model_version
        self._rules = self._load_rules()
        self._bundle_hash = self._compute_bundle_hash()

    def _load_rules(self) -> list[dict]:
        rules = []
        rules_dir = Path(__file__).parent / "catalysts"
        for yaml_file in sorted(rules_dir.glob("*.yaml")):
            with open(yaml_file) as f:
                data = yaml.safe_load(f)
                rules.extend(data.get("rules", []))
        return rules

    def _compute_bundle_hash(self) -> str:
        canonical = json.dumps(
            [{"id": r["id"], "version": r["version"], "conditions": r["conditions"]}
             for r in self._rules],
            sort_keys=True, ensure_ascii=False,
        )
        return hashlib.sha256(canonical.encode()).hexdigest()

    @property
    def bundle_hash(self) -> str:
        return self._bundle_hash

    def evaluate(self, ticker: str, features: dict, signals: list) -> list[dict]:
        triggered = []
        for rule in self._rules:
            if self._match(rule, features, signals):
                triggered.append({
                    "code": rule["trigger_code"],
                    "strength": rule["strength"],
                    "detail": f"{rule['description']} [{ticker}]"[:240],
                    "source_ref": None,
                })
        return triggered

    def _match(self, rule: dict, features: dict, signals: list) -> bool:
        for cond in rule["conditions"]:
            field_val = self._resolve_field(cond["field"], features, signals)
            target = cond["value"]
            op = cond["op"]

            # Runtime placeholders require an explicit resolved context.  A
            # replay must not compare typed values with unresolved "$..."
            # strings or invent a current default; that rule simply cannot
            # match in this context.
            if field_val is None or (
                isinstance(target, str) and target.startswith("$")
            ):
                return False

            if op == "eq" and field_val != target:
                return False
            elif op == "gte" and field_val < target:
                return False
            elif op == "gt" and field_val <= target:
                return False
            elif op == "lt" and field_val >= target:
                return False
            elif op == "contains" and target not in field_val:
                return False

        return True

    def _resolve_field(self, field_path: str, features: dict, signals: list):
        parts = field_path.split(".")
        current = features

        for part in parts:
            if part.endswith("[*]"):
                key = part[:-3]
                arr = current.get(key, [])
                remaining = ".".join(parts[parts.index(part) + 1:])
                return [self._resolve_field(remaining, item, signals) for item in arr]
            elif part.startswith("$"):
                return None
            else:
                if isinstance(current, dict):
                    current = current.get(part)
                else:
                    return None
                if current is None:
                    return None

        return current
