import asyncio
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import unittest

from datapipeline.contracts import ScanDocument, TextHit, TextHitEnvelope
from datapipeline.storage.multibagger import (
    build_text_hit_storage_row,
    canonical_scan_document_fact_hash,
    canonical_text_hit_fact_hash,
    canonical_text_context_hash,
    TextHitIdempotencyConflict,
    TextHitWriter,
)


NOW = datetime(2026, 7, 14, 0, 0, 0, tzinfo=timezone.utc)


class ForgedHash(str):
    def __eq__(self, _other):
        return True

    def __ne__(self, _other):
        return False

    __hash__ = str.__hash__


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
        document_fact_hash="0" * 64,
    )
    document = replace(
        document,
        document_fact_hash=canonical_scan_document_fact_hash(document),
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
        "context_hash": canonical_text_context_hash(document.title[:8]),
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
        self.lock_keys = []
        self.selected_identities = []

    def transaction(self):
        return Context(self)

    async def fetchval(self, _sql, lock_key):
        self.lock_keys.append(lock_key)
        await asyncio.sleep(0)
        return None

    async def fetchrow(self, sql, *params):
        if sql.lstrip().startswith("SELECT"):
            self.selected_identities.append(tuple(params))
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
    def __init__(self, connection=None):
        self.connection = connection or Connection()

    def acquire(self):
        return Context(self.connection)


class TextHitWriterTests(unittest.IsolatedAsyncioTestCase):
    def test_forged_hash_subclasses_fail_before_storage_projection(self):
        item = envelope()
        object.__setattr__(
            item.document,
            "document_fact_hash",
            ForgedHash("f" * 64),
        )
        with self.assertRaisesRegex(ValueError, "document fact hash"):
            build_text_hit_storage_row(item)

        item = envelope()
        object.__setattr__(item.hit, "context_hash", ForgedHash("f" * 64))
        with self.assertRaisesRegex(ValueError, "context hash"):
            build_text_hit_storage_row(item)

    def test_storage_row_uses_one_datapipeline_hash_preimage(self):
        row = build_text_hit_storage_row(envelope())
        values = dict(row.__dict__)
        expected = values.pop("hit_fact_hash")
        self.assertEqual(canonical_text_hit_fact_hash(**values), expected)
        self.assertEqual(row.source_version, "capture-v1")
        self.assertEqual(
            row.context_hash,
            canonical_text_context_hash("capacity"),
        )

    def test_fact_hash_preserves_canonical_microsecond_availability(self):
        available = NOW.replace(microsecond=123456)
        item = envelope()
        document = replace(
            item.document,
            available_at_utc=available,
            document_fact_hash="0" * 64,
        )
        document = replace(
            document,
            document_fact_hash=canonical_scan_document_fact_hash(document),
        )
        item = TextHitEnvelope(document, item.hit)

        row = build_text_hit_storage_row(item)
        body = dict(row.__dict__)
        expected = body.pop("hit_fact_hash")

        self.assertEqual(canonical_text_hit_fact_hash(**body), expected)
        self.assertEqual(
            expected,
            "2f165fd09f53d456cda9655277773a23d24a8d5269b87daf92ff10963a8609ab",
        )

    async def test_insert_replay_conflict_and_pit_gate(self):
        pool = Pool()
        writer = TextHitWriter(pool)
        item = envelope()
        first = await writer.write_batch((item,), as_of_utc=NOW)
        second = await writer.write_batch((item,), as_of_utc=NOW)
        self.assertEqual((first.inserted, second.inserted), (1, 0))

        with self.assertRaises(TextHitIdempotencyConflict):
            await writer.write_batch(
                (
                    item,
                    envelope(hit_kind="NEGATIVE"),
                ),
                as_of_utc=NOW,
            )
        with self.assertRaisesRegex(ValueError, "requested as_of"):
            await writer.write_batch(
                (item,), as_of_utc=NOW - timedelta(hours=3)
            )

    async def test_reversed_concurrent_batches_use_one_advisory_lock_order(self):
        alpha = envelope(term_id="alpha")
        omega = envelope(term_id="omega")
        forward_pool = Pool()
        reversed_pool = Pool()

        forward, reversed_result = await asyncio.wait_for(
            asyncio.gather(
                TextHitWriter(forward_pool).write_batch(
                    (alpha, omega), as_of_utc=NOW
                ),
                TextHitWriter(reversed_pool).write_batch(
                    (omega, alpha), as_of_utc=NOW
                ),
            ),
            timeout=1,
        )

        expected_identities = [
            build_text_hit_storage_row(item).identity for item in (alpha, omega)
        ]
        self.assertEqual(forward.inserted, 2)
        self.assertEqual(reversed_result.inserted, 2)
        self.assertEqual(
            forward_pool.connection.selected_identities, expected_identities
        )
        self.assertEqual(
            reversed_pool.connection.selected_identities, expected_identities
        )
        self.assertEqual(
            forward_pool.connection.lock_keys,
            reversed_pool.connection.lock_keys,
        )


if __name__ == "__main__":
    unittest.main()
