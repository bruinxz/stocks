# Captured R1 fixture boundary

The JPX and KIND files in this directory are byte-identical copies of the
versioned capture wrappers owned by DataPipeline task #343. The shared
`validate_capture_wrapper` and `capture_source_version` functions bind their
internal provenance chain (asserted response digest, capture instance, payload
digest and wrapper digest). They are self-use/non-commercial test fixtures,
not provider-signed or external authenticity, and must never seed production.

The materializer tests derive synthetic `TextHitFact`, `StrategyDecision`, and
classification objects around those captured rows. Their generated hashes and
scores are test-only values; they are not claimed to be provider outputs or
live Strategy recommendations.
