class SnapshotReader:
    """Read snapshot for replay or historical browse."""

    def read_snapshot(self, snapshot_id: str) -> dict:
        pass

    def read_by_date(self, trading_day: str, profile: str, market_scope: str) -> list[dict]:
        pass

    def diff(self, snapshot_id_a: str, snapshot_id_b: str) -> dict:
        snap_a = self.read_snapshot(snapshot_id_a)
        snap_b = self.read_snapshot(snapshot_id_b)

        if not snap_a or not snap_b:
            return {"error": "snapshot not found"}

        tickers_a = {e["recommendation"]["ticker"] for e in snap_a["items"]}
        tickers_b = {e["recommendation"]["ticker"] for e in snap_b["items"]}

        return {
            "added": list(tickers_b - tickers_a),
            "removed": list(tickers_a - tickers_b),
            "common": list(tickers_a & tickers_b),
            "fingerprint_match": snap_a["output_fingerprint"] == snap_b["output_fingerprint"],
        }
