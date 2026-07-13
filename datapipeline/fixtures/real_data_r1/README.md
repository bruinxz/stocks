# REAL-DATA R1 captured official-source fixtures

These are tiny, sanitized samples captured by read-only requests on
2026-07-14 (Asia/Shanghai) for task #343. They are allowed only for
self-use/non-commercial tests and disposable local PostgreSQL evidence.

- No API keys, cookies, request headers, or bulk raw provider files are stored.
- `captured_response_sha256` binds internal records to the asserted
  live-response digest; it is not provider-signed or external authenticity.
  `payload_sha256` and `wrapper_sha256` authenticate the sanitized committed
  payload and every provenance field inside this evidence chain.
- These fixtures must never seed a production database.
- Source attribution and terms remain binding:
  - JPX: <https://www.jpx.co.jp/english/term-of-use/index.html>
  - KIND/KRX: <https://kind.krx.co.kr/>
  - BOJ: <https://www.boj.or.jp/en/copyright.htm>

Credential/legal gaps intentionally remain:

- EDINET disclosures/financials: registered Subscription-Key required.
- OpenDART financials: registered API key required.
- J-Quants structured JP master/bars: API key/plan required.
- KRX structured daily bars: anonymous endpoint rejected the live probe.
- JPX/BOJ commercial use: provider permission/legal approval required.
- BOK ECOS capture is private-key-only. The retained
  `bok_fx_sample.json` is explicitly `synthetic-keyed-unverified`, is excluded
  from live-evidence and disposable-PG counts, and has no public capture path.
