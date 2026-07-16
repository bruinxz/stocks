from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import unittest

from datapipeline.contracts import is_canonical_sha256, is_canonical_source_version
from datapipeline.storage.jpkr import canonical_financial_fact_hash

from datapipeline.contracts.source_envelopes import (
    JpKrDisclosureRecord,
    JpKrFilingEnvelope,
    JpKrFinancialRecord,
    ScanDocument,
    TextHit,
    TextHitEnvelope,
)

UTC_NOW = datetime(2026, 7, 10, tzinfo=timezone.utc)


class ForgedSourceVersion(str):
    def isascii(self) -> bool:
        return True

    def __iter__(self):
        return iter("forged-v1")


class ForgedHash(str):
    def __eq__(self, _other: object) -> bool:
        return True

    def __ne__(self, _other: object) -> bool:
        return False

    __hash__ = str.__hash__


class SourceVersionPolicyTest(unittest.TestCase):
    def test_public_sot_requires_exact_printable_ascii(self) -> None:
        for value in ("!", "~", "api-v2:parser-v1"):
            with self.subTest(value=value):
                self.assertTrue(is_canonical_source_version(value))
        for value in (
            "",
            " capture-v1 ",
            "\tcapture-v1\t",
            "版本-v1",
            ForgedSourceVersion("版本-v1"),
        ):
            with self.subTest(value=value, type=type(value)):
                self.assertFalse(is_canonical_source_version(value))

    def test_public_sha256_sot_rejects_str_subclasses(self) -> None:
        self.assertTrue(is_canonical_sha256("a" * 64))
        self.assertFalse(is_canonical_sha256(ForgedHash("a" * 64)))


class FilingEnvelopeTest(unittest.TestCase):
    def financial(self, **overrides: object) -> JpKrFinancialRecord:
        values: dict[str, object] = {
            "market_scope": "jp",
            "exchange": "tse",
            "ticker": "7203",
            "fiscal_period_kind": "ANNUAL",
            "fiscal_period_start": date(2024, 4, 1),
            "fiscal_period_end": date(2025, 3, 31),
            "fiscal_quarter": None,
            "currency": "JPY",
            "is_consolidated": True,
            "revenue": Decimal("1000"),
            "eps": Decimal("12.34"),
            "net_income": Decimal("100"),
            "total_assets": Decimal("5000"),
            "total_equity": Decimal("2500"),
            "total_liabilities": Decimal("2500"),
            "operating_cash_flow": Decimal("120"),
            "research_and_development": Decimal("25"),
            "segment_facts": (),
            "taxonomy_version": "edinet-taxonomy-v1",
            "parser_version": "parser-v1",
            "account_mapping_version": None,
            "concept_provenance": {},
            "parse_warnings": (),
            "source_payload": {},
            "source_kind": "jpx-edinet",
            "source_document_id": "EDINET-DOC-1",
            "source_version": "api-v2:taxonomy-v1:parser-v1",
            "effective_at_utc": datetime(2025, 3, 31, 6, tzinfo=timezone.utc),
            "available_at_utc": UTC_NOW,
            "fact_hash": "a" * 64,
        }
        values.update(overrides)
        return JpKrFinancialRecord(**values)  # type: ignore[arg-type]

    def disclosure(self, **overrides: object) -> JpKrDisclosureRecord:
        values: dict[str, object] = {
            "market_scope": "jp",
            "exchange": "tse",
            "ticker": "7203",
            "disclosure_kind": "ANNUAL_REPORT",
            "event_headline_local": "有価証券報告書",
            "event_body_url": "https://example.invalid/filing",
            "event_time_utc": UTC_NOW,
            "available_at_utc": UTC_NOW,
            "source_kind": "jpx-edinet",
            "source_document_id": "EDINET-DOC-1",
            "source_version": "api-v2:parser-v1",
            "fact_hash": "b" * 64,
            "source_payload": {},
        }
        values.update(overrides)
        return JpKrDisclosureRecord(**values)  # type: ignore[arg-type]

    def test_edinet_document_envelope_is_constructible(self) -> None:
        envelope = JpKrFilingEnvelope(self.disclosure(), (self.financial(),))
        self.assertEqual(envelope.financials[0].identity[2], "EDINET-DOC-1")
        envelope.require_available_by(UTC_NOW)

    def test_dart_semiannual_mapping_is_constructible(self) -> None:
        financial = self.financial(
            market_scope="kr",
            exchange="krx",
            ticker="005930",
            fiscal_period_kind="SEMIANNUAL",
            fiscal_period_start=date(2025, 1, 1),
            fiscal_period_end=date(2025, 6, 30),
            currency="KRW",
            taxonomy_version=None,
            account_mapping_version="dart-account-map-v1",
            source_kind="dart",
            source_document_id="DART-RECEIPT-1",
            effective_at_utc=datetime(2025, 6, 30, 6, tzinfo=timezone.utc),
        )
        disclosure = self.disclosure(
            market_scope="kr",
            exchange="krx",
            ticker="005930",
            source_kind="dart",
            source_document_id="DART-RECEIPT-1",
        )
        self.assertEqual(
            JpKrFilingEnvelope(disclosure, (financial,)).financials[0].currency, "KRW"
        )

    def test_market_currency_and_source_lineage_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "market_scope and currency"):
            self.financial(currency="KRW")
        with self.assertRaisesRegex(ValueError, "taxonomy_version"):
            self.financial(taxonomy_version=None)
        with self.assertRaisesRegex(ValueError, "cannot carry taxonomy"):
            self.financial(
                market_scope="kr",
                exchange="krx",
                ticker="005930",
                currency="KRW",
                source_kind="dart",
                taxonomy_version="wrong",
                account_mapping_version="map-v1",
            )

    def test_period_and_quarter_mapping_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "fiscal_period_kind"):
            self.financial(fiscal_period_kind="Q1", fiscal_quarter=None)
        with self.assertRaisesRegex(ValueError, "not supported"):
            self.financial(fiscal_period_kind="Q2")
        with self.assertRaisesRegex(ValueError, "period-end date"):
            self.financial(
                effective_at_utc=datetime(2025, 3, 30, 6, tzinfo=timezone.utc)
            )

    def test_future_filing_and_invalid_numeric_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "requested as_of"):
            self.financial().require_available_by(UTC_NOW - timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "finite Decimal"):
            self.financial(revenue=Decimal("NaN"))
        with self.assertRaisesRegex(ValueError, "finite Decimal"):
            self.financial(revenue=1.0)

    def test_jsonb_fields_validate_recursively(self) -> None:
        self.financial(
            segment_facts=({"items": [{"name": "cars", "value": 1.0}]},),
            concept_provenance={"revenue": {"unit": "JPY", "nil": False}},
            source_payload={"warnings": [None, "safe"]},
        )
        for field, value in (
            ("source_payload", {"nested": {"bad": object()}}),
            ("concept_provenance", {"bad": object()}),
            ("segment_facts", ({"bad": [object()]},)),
        ):
            with self.subTest(field=field):
                with self.assertRaisesRegex(ValueError, "non-JSON value"):
                    self.financial(**{field: value})
        with self.assertRaisesRegex(ValueError, "non-string JSON object key"):
            self.financial(source_payload={1: "bad-key"})
        with self.assertRaisesRegex(ValueError, "non-finite JSON number"):
            self.financial(source_payload={"bad": float("nan")})

    def test_document_identity_mismatch_fails_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "share document identity"):
            JpKrFilingEnvelope(
                self.disclosure(),
                (self.financial(source_document_id="OTHER-DOC"),),
            )
        with self.assertRaisesRegex(ValueError, "at least one"):
            JpKrFilingEnvelope(self.disclosure(), ())

    def test_disclosure_availability_and_json_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "event_time_utc"):
            self.disclosure(available_at_utc=UTC_NOW - timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "non-JSON value"):
            self.disclosure(source_payload={"bad": object()})

    def test_utc_and_hash_are_strict(self) -> None:
        with self.assertRaisesRegex(ValueError, "timezone-aware UTC"):
            self.disclosure(event_time_utc=datetime(2026, 7, 10))
        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            self.financial(fact_hash="A" * 64)
        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            self.financial(fact_hash=ForgedHash("a" * 64))
        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            self.disclosure(fact_hash=ForgedHash("b" * 64))
        with self.assertRaisesRegex(ValueError, "source_kind"):
            self.financial(source_kind="EDINET")
        with self.assertRaisesRegex(ValueError, "printable ASCII"):
            self.financial(source_version=" financial-v1 ")
        with self.assertRaisesRegex(ValueError, "printable ASCII"):
            self.disclosure(source_version=" disclosure-v1 ")

    def test_source_version_rejects_unicode_controls_and_str_subclasses(self) -> None:
        invalid_versions = (
            "版本-v1",
            " financial-v1 ",
            "\tfinancial-v1\t",
            ForgedSourceVersion("版本-v1"),
        )
        for value in invalid_versions:
            with self.subTest(value=value, type=type(value)):
                with self.assertRaisesRegex(ValueError, "printable ASCII"):
                    self.financial(source_version=value)
                with self.assertRaisesRegex(ValueError, "printable ASCII"):
                    self.disclosure(source_version=value)

    def test_financial_fact_hash_has_one_datapipeline_authority(self) -> None:
        record = self.financial()
        original = canonical_financial_fact_hash(record)
        changed = canonical_financial_fact_hash(
            self.financial(revenue=Decimal("1001"))
        )

        self.assertRegex(original, r"^[0-9a-f]{64}$")
        self.assertEqual(canonical_financial_fact_hash(asdict(record)), original)
        self.assertEqual(
            original,
            "f41a97dfb2ab16254aa97a5d73a60aaf059c0715312e37480f4a3f688018fd40",
        )
        self.assertNotEqual(original, changed)


class TextHitEnvelopeTest(unittest.TestCase):
    def document(self, **overrides: object) -> ScanDocument:
        values: dict[str, object] = {
            "document_id": "doc-1",
            "ticker": "600000",
            "market": "CN",
            "market_scope": "cn_a",
            "language": "zh",
            "title": "产能扩张计划",
            "body": "公司批准新的产能扩张计划。",
            "published_at_utc": UTC_NOW,
            "available_at_utc": UTC_NOW,
            "source_kind": "official-disclosure",
            "source_version": "capture-v1",
            "source_url": None,
            "document_fact_hash": "c" * 64,
        }
        values.update(overrides)
        return ScanDocument(**values)  # type: ignore[arg-type]

    def hit(self, **overrides: object) -> TextHit:
        values: dict[str, object] = {
            "term_id": "capacity-expansion",
            "hit_kind": "EARLY_NEWS",
            "document_id": "doc-1",
            "ticker": "600000",
            "language": "zh",
            "field": "TITLE",
            "start_offset": 0,
            "end_offset": 4,
            "context_hash": "d" * 64,
            "taxonomy_version": "taxonomy-v1",
        }
        values.update(overrides)
        return TextHit(**values)  # type: ignore[arg-type]

    def test_text_hit_envelope_is_lossless_and_has_six_part_identity(self) -> None:
        envelope = TextHitEnvelope(self.document(), self.hit())
        self.assertEqual(
            envelope.identity,
            ("c" * 64, "taxonomy-v1", "capacity-expansion", "TITLE", 0, 4),
        )
        envelope.require_available_by(UTC_NOW)

    def test_document_scope_and_availability_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "canonical mapping"):
            self.document(market_scope="us")
        with self.assertRaisesRegex(ValueError, "market is not supported"):
            self.document(market="EU")
        with self.assertRaisesRegex(ValueError, "language is not supported"):
            self.document(language="fr")
        with self.assertRaisesRegex(ValueError, "must not precede"):
            self.document(available_at_utc=UTC_NOW - timedelta(seconds=1))
        with self.assertRaisesRegex(ValueError, "printable ASCII"):
            self.document(source_version=" capture-v1 ")
        with self.assertRaisesRegex(ValueError, "requested as_of"):
            self.document().require_available_by(UTC_NOW - timedelta(seconds=1))

    def test_hit_must_match_document_and_field_bounds(self) -> None:
        with self.assertRaisesRegex(ValueError, "match its source document"):
            TextHitEnvelope(self.document(), self.hit(ticker="000001"))
        with self.assertRaisesRegex(ValueError, "exceed"):
            TextHitEnvelope(self.document(), self.hit(end_offset=100))

    def test_hit_offsets_and_context_hash_fail_closed(self) -> None:
        with self.assertRaisesRegex(ValueError, "non-empty range"):
            self.hit(start_offset=4, end_offset=4)
        with self.assertRaisesRegex(ValueError, "lowercase SHA-256"):
            self.hit(context_hash="bad")
        with self.assertRaisesRegex(ValueError, "hit_kind is not supported"):
            self.hit(hit_kind="BUY")
        with self.assertRaisesRegex(ValueError, "field is not supported"):
            self.hit(field="SUMMARY")
        for start, end in ((0.0, 4), (False, 4), (0, 4.0), (0, True)):
            with self.subTest(start=start, end=end):
                with self.assertRaisesRegex(ValueError, "exact integers"):
                    self.hit(start_offset=start, end_offset=end)

    def test_all_hit_kinds_and_languages_are_constructible(self) -> None:
        kinds = ("OPTIONALITY", "POSITIVE", "NEGATIVE", "EARLY_NEWS")
        languages = ("en", "zh", "ja", "ko")
        for kind, language in zip(kinds, languages):
            document = self.document(language=language)
            hit = self.hit(hit_kind=kind, language=language)
            self.assertEqual(TextHitEnvelope(document, hit).hit.hit_kind, kind)


if __name__ == "__main__":
    unittest.main()
