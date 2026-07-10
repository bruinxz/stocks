from ai.snapshot.fingerprint import compute_input_fingerprint, jcs_canonicalize


class SnapshotWriter:
    """Write snapshot to storage (DP γ ai_recommendation_snapshot + ai_recommendation_item tables)."""

    def write(self, ctx, recommendation_list: dict):
        input_fingerprint = compute_input_fingerprint(ctx.input_hashes)

        snapshot = {
            "snapshot_id": ctx.snapshot_id,
            "as_of": ctx.as_of,
            "trading_day": ctx.config.trading_day,
            "profile": ctx.config.profile,
            "market_scope": ctx.config.market_scope,
            "pipeline_version": ctx.config.pipeline_version,
            "model_version": ctx.config.model_version,
            "strategy_version": ctx.config.strategy_version,
            "rule_bundle_hash": ctx.config.rule_bundle_hash,
            "template_hash": ctx.config.template_hash,
            "disclaimer_hash": ctx.config.disclaimer_hash,
            "input_fingerprint": input_fingerprint,
            "output_fingerprint": recommendation_list["output_fingerprint"],
            "item_count": len(recommendation_list["items"]),
        }

        self._write_snapshot_row(snapshot)

        for i, entry in enumerate(recommendation_list["items"]):
            item = {
                "snapshot_id": ctx.snapshot_id,
                "ticker": entry["recommendation"]["ticker"],
                "sort_rank": i,
                "recommendation_json": jcs_canonicalize(entry["recommendation"]),
                "rating_band": entry["rating_band"],
                "conviction_final": entry["recommendation"]["conviction"]["final"],
            }
            self._write_item_row(item)

    def _write_snapshot_row(self, snapshot: dict):
        pass

    def _write_item_row(self, item: dict):
        pass
