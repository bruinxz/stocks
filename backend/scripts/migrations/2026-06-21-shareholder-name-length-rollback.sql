-- Rollback for 2026-06-21-shareholder-name-length.sql
-- WARNING: Rolling back will fail if data > 200 chars exists; consider truncating first.

ALTER TABLE shareholder_trade_records
  ALTER COLUMN shareholder_name TYPE VARCHAR(200);
