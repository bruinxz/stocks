from datetime import datetime, timedelta, timezone
import unittest

from datapipeline.contracts import ScanDocument, TextHit, TextHitEnvelope
from datapipeline.storage.multibagger import (
    build_text_hit_storage_row,
    canonical_text_hit_fact_hash,
    TextHitIdempotencyConflict,
    TextHitWriter,
)


NOW = datetime(2026, 7, 14, 0, 0, 0, tzinfo=timezone.utc)


def envelope(**hit_overrides) -> TextHitEnvelope:
    document = ScanDocument(
        document_id="jpx-listed-company:20260630:1301",
        ticker="1301",
        market="JP",
        market_scope="jp",
        language="ja",
        title="capacity expansion",
        body="new production capacity",
        published_at_utc=NOW - timedelta(days=1),
        available_at_utc=NOW - timedelta(hours=2),
        source_kind="jpx-listed-company-monthly",
        source_version="capture-v1",
        source_url=None,
        document_fact_hash="c" * 64,
    )
    values = {
        "term_id": "capacity-expansion",
        "hit_kind": "OPTIONALITY",
        "document_id": document.document_id,
        "ticker": document.ticker,
        "language": document.language,
        "field": "TITLE",
        "start_offset": 0,
        "end_offset": 8,
        "context_hash": "d" * 64,
        "taxonomy_version": "taxonomy-v1",
    }
    values.update(hit_overrides)
    return TextHitEnvelope(document, TextHit(**values))


class Context:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, *_):
        pass


class Connection:
    def __init__(self):
        self.rows = {}

    def transaction(self):
        return Context(self)

    async def fetchval(self, *_):
        return None

    async def fetchrow(self, sql, *params):
        if sql.lstrip().startswith("SELECT"):
            value = self.rows.get(tuple(params))
            return None if value is None else {"hit_fact_hash": value}
        if sql.lstrip().startswith("INSERT"):
            identity = (params[5], params[6], params[7], params[10], params[11], params[12])
            if identity in self.rows:
                return None
            self.rows[identity] = params[14]
            return {"multibagger_text_hit_id": "inserted"}
        raise AssertionError("unexpected SQL")


class Pool:
    def __init__(self):
        self.connection = Connection()

    def acquire(self):
        return Context(self.connection)


class TextHitWriterTests(unittest.IsolatedAsyncioTestCase):
    def test_storage_row_uses_one_datapipeline_hash_preimage(self):
        row = build_text_hit_storage_row(envelope())
        values = dict(row.__dict__)
        expected = values.pop("hit_fact_hash")
        self.assertEqual(canonical_text_hit_fact_hash(**values), expected)
        self.assertEqual(row.source_version, "capture-v1")
        self.assertEqual(row.context_hash, "d" * 64)

    async def test_insert_replay_conflict_and_pit_gate(self):
        pool = Pool()
        writer = TextHitWriter(pool)
        item = envelope()
        first = await writer.write_batch((item,), as_of_utc=NOW)
        second = await writer.write_batch((item,), as_of_utc=NOW)
        self.assertEqual((first.inserted, second.inserted), (1, 0))

        with self.assertRaises(TextHitIdempotencyConflict):
            await writer.write_batch(
                (item, envelope(context_hash="e" * 64)), as_of_utc=NOW
            )
        with self.assertRaisesRegex(ValueError, "requested as_of"):
            await writer.write_batch(
                (item,), as_of_utc=NOW - timedelta(hours=3)
            )


if __name__ == "__main__":
    unittest.main()
