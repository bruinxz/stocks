import os
import psycopg

from strategy.materialization import (
    CandidateIdempotencyConflict,
    PostgresCandidateStore,
    materialize_candidate,
)
from strategy.tests.test_multibagger_candidate_materializer import (
    Policy,
    decision,
    request,
)


def main():
    url = os.environ["R2_CANDIDATE_DATABASE_URL"]
    candidate = materialize_candidate(request(), Policy())
    store = PostgresCandidateStore(url)
    assert store.write_or_verify(candidate) == candidate
    assert store.write_or_verify(candidate) == candidate

    changed = materialize_candidate(request(), Policy(stage="growth"))
    try:
        store.write_or_verify(changed)
        raise AssertionError("changed candidate was accepted")
    except CandidateIdempotencyConflict:
        pass

    rollback_candidate = materialize_candidate(
        request(decision=decision(strategy_version="rollback-test@1.0.0")),
        Policy(),
    )
    with psycopg.connect(url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                CREATE FUNCTION tamper_candidate_insert() RETURNS trigger
                LANGUAGE plpgsql AS $$
                BEGIN
                  IF NEW.strategy_version = 'rollback-test@1.0.0' THEN
                    NEW.classification_policy_version := 'tampered';
                  END IF;
                  RETURN NEW;
                END
                $$
                """
            )
            cursor.execute(
                """
                CREATE TRIGGER tamper_candidate_insert
                BEFORE INSERT ON multibagger_candidate_snapshot
                FOR EACH ROW EXECUTE FUNCTION tamper_candidate_insert()
                """
            )
    try:
        store.write_or_verify(rollback_candidate)
        raise AssertionError("insert/readback mismatch was accepted")
    except Exception:
        pass
    with psycopg.connect(url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT count(*) FROM multibagger_candidate_snapshot
                WHERE strategy_version = 'rollback-test@1.0.0'
                """
            )
            assert cursor.fetchone()[0] == 0

    with psycopg.connect(url) as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE multibagger_candidate_snapshot
                SET classification_policy_version = 'tampered'
                WHERE ticker = %s
                """,
                (candidate.ticker,),
            )
    try:
        store.write_or_verify(candidate)
        raise AssertionError("tampered physical row was accepted")
    except Exception:
        pass

    with psycopg.connect(url) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM multibagger_candidate_snapshot")
            assert cursor.fetchone()[0] == 1
    print("postgres-candidate-store: PASS")


if __name__ == "__main__":
    main()
