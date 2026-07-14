import hashlib

from ai.types import PROFILE_DEFAULT_OUTPUT_LANGUAGE

COPY = {
    "zh-CN": {
        "headline": "{ticker} 评级 {band} · 信念 {level}",
        "summary": "{ticker} 综合评分 {total:.1f} (评级 {band})",
        "strengths": "优势维度",
        "adjustments": "信念调整",
        "risk": "风险提示",
        "low_size": "仓位建议偏低，请结合个人风险承受能力判断",
        "separator": "。",
    },
    "ja-JP": {
        "headline": "{ticker} 評価 {band} · 確信度 {level}",
        "summary": "{ticker} 総合スコア {total:.1f}（評価 {band}）",
        "strengths": "強みのある次元",
        "adjustments": "確信度調整",
        "risk": "リスク注意",
        "low_size": "ポジション目安は低めです。ご自身のリスク許容度をご確認ください",
        "separator": "。",
    },
    "ko-KR": {
        "headline": "{ticker} 등급 {band} · 확신도 {level}",
        "summary": "{ticker} 종합 점수 {total:.1f} (등급 {band})",
        "strengths": "강점 차원",
        "adjustments": "확신도 조정",
        "risk": "위험 주의",
        "low_size": "포지션 제안이 낮습니다. 본인의 위험 감수 수준을 확인하세요",
        "separator": ". ",
    },
}


class TemplateEngine:
    """Render deterministic explanation text from features + triggers."""

    def __init__(self, config):
        self._config = config
        self._language = PROFILE_DEFAULT_OUTPUT_LANGUAGE.get(config.profile)
        if self._language is None:
            raise ValueError("profile has no authorized explanation language")
        self._templates = self._load_templates()

    def _load_templates(self) -> dict:
        return {"morning_brief_v1": COPY[self._language]}

    def render(self, ticker: str, features: dict, triggers: list) -> dict:
        template = self._templates.get("morning_brief_v1", {})

        headline = self._render_headline(ticker, features, template)
        body = self._render_body(ticker, features, triggers, template)
        caveats = self._render_caveats(features, template)

        body_for_hash = f"{headline}|{body}|{'|'.join(caveats)}"
        template_hash = hashlib.sha256(body_for_hash.encode("utf-8")).hexdigest()

        return {
            "headline": headline[:80],
            "body": body[:600],
            "caveats": [c[:120] for c in caveats[:3]],
            "language": self._language,
            "template_id": "morning_brief_v1",
            "template_hash": template_hash,
        }

    def _render_headline(self, ticker: str, features: dict, template: dict) -> str:
        score = features.get("score", {})
        conviction = features.get("conviction", {})
        rating = score.get("rating", "?")
        level = conviction.get("level", "?")
        return template["headline"].format(
            ticker=ticker, band=rating, level=level,
        )

    def _render_body(self, ticker: str, features: dict, triggers: list, template: dict) -> str:
        parts = []
        score = features.get("score", {})

        parts.append(
            template["summary"].format(
                ticker=ticker,
                total=score.get("total", 0),
                band=score.get("rating", "?"),
            )
        )

        top_dims = sorted(score.get("dims", []), key=lambda d: d.get("score", 0), reverse=True)[:3]
        if top_dims:
            dim_strs = [f"{d['key']}={d.get('score', 0):.0f}({d.get('band', '?')})" for d in top_dims]
            parts.append(f"{template['strengths']}: {', '.join(dim_strs)}")

        for i, t in enumerate(triggers[:3], 1):
            parts.append(f"[E{i}] {t.get('detail', '')[:60]}")

        conviction = features.get("conviction", {})
        if conviction.get("adjustments"):
            adj_strs = [f"{a['reason'][:30]}({a['delta']:+.0f})" for a in conviction["adjustments"][:2]]
            parts.append(f"{template['adjustments']}: {'; '.join(adj_strs)}")

        return template["separator"].join(parts)

    def _render_caveats(self, features: dict, template: dict) -> list[str]:
        caveats = []
        risk_gate = features.get("risk_gate", {})
        if risk_gate.get("triggers"):
            for t in risk_gate["triggers"][:2]:
                caveats.append(f"{template['risk']}: {t.get('detail', '')[:100]}")

        entry = features.get("entry_plan", {})
        sh = entry.get("size_hint", {})
        if sh.get("tier") in ("TIER_1", "SKIP"):
            caveats.append(template["low_size"])

        return caveats
