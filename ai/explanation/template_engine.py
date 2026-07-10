import hashlib


class TemplateEngine:
    """Render deterministic explanation text from features + triggers."""

    def __init__(self, config):
        self._config = config
        self._templates = self._load_templates()

    def _load_templates(self) -> dict:
        from ai.explanation.templates.zh_cn_morning_brief_v1 import TEMPLATE
        return {"morning_brief_v1": TEMPLATE}

    def render(self, ticker: str, features: dict, triggers: list) -> dict:
        template = self._templates.get("morning_brief_v1", {})

        headline = self._render_headline(ticker, features, template)
        body = self._render_body(ticker, features, triggers, template)
        caveats = self._render_caveats(features, template)

        body_for_hash = f"{headline}|{body}|{'|'.join(caveats)}"
        template_hash = hashlib.sha256(body_for_hash.encode()).hexdigest()

        return {
            "headline": headline[:80],
            "body": body[:600],
            "caveats": [c[:120] for c in caveats[:3]],
            "language": "zh-CN",
            "template_id": "morning_brief_v1",
            "template_hash": template_hash,
        }

    def _render_headline(self, ticker: str, features: dict, template: dict) -> str:
        score = features.get("score", {})
        conviction = features.get("conviction", {})
        band = score.get("band", "?")
        level = conviction.get("level", "?")
        return template.get("headline", "{ticker} 评级 {band} · 信念 {level}").format(
            ticker=ticker, band=band, level=level,
        )

    def _render_body(self, ticker: str, features: dict, triggers: list, template: dict) -> str:
        parts = []
        score = features.get("score", {})

        parts.append(f"{ticker} 综合评分 {score.get('total', 0):.1f} (评级 {score.get('band', '?')})")

        top_dims = sorted(score.get("dims", []), key=lambda d: d.get("score", 0), reverse=True)[:3]
        if top_dims:
            dim_strs = [f"{d['key']}={d.get('score', 0):.0f}({d.get('band', '?')})" for d in top_dims]
            parts.append(f"优势维度: {', '.join(dim_strs)}")

        for i, t in enumerate(triggers[:3], 1):
            parts.append(f"[E{i}] {t.get('detail', '')[:60]}")

        conviction = features.get("conviction", {})
        if conviction.get("adjustments"):
            adj_strs = [f"{a['reason'][:30]}({a['delta']:+.0f})" for a in conviction["adjustments"][:2]]
            parts.append(f"信念调整: {'; '.join(adj_strs)}")

        return "。".join(parts)

    def _render_caveats(self, features: dict, template: dict) -> list[str]:
        caveats = []
        risk_gate = features.get("risk_gate", {})
        if risk_gate.get("triggers"):
            for t in risk_gate["triggers"][:2]:
                caveats.append(f"风险提示: {t.get('detail', '')[:100]}")

        entry = features.get("entry_plan", {})
        sh = entry.get("size_hint", {})
        if sh.get("tier") in ("TIER_1", "SKIP"):
            caveats.append("仓位建议偏低，请结合个人风险承受能力判断")

        return caveats
