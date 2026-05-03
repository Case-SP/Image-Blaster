-- 20260503_runs_cartridge_stage_columns.sql
-- Denormalize cartridge + stage from the trace JSON into real columns on
-- the runs table, with a composite index for the /tiles cartridge filter.
--
-- WHY: /tiles cold load was 25-40s because every page load extracts cartridge
-- from JSON (`trace->>'cartridge'`) for ~600 runs across 30 sequential
-- queries. With a real indexed column, that becomes one query, ~50ms.
--
-- Safe to run on a live DB: ALTER TABLE ADD COLUMN is non-blocking on
-- Postgres 11+. Backfill UPDATE may take seconds on a large table; run
-- during a quiet window if the runs table has 100K+ rows.

-- 1. Add the columns. NULL-able so old code paths still write fine.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS cartridge text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stage text;

-- 2. Backfill from existing trace JSON. Stage uses shotList.stage when set
--    (staged/promote runs) and falls back to input.stage (sketch input on
--    product cartridge).
UPDATE runs
SET
  cartridge = COALESCE(cartridge, trace->>'cartridge'),
  stage = COALESCE(
    stage,
    trace->'stages'->'shotList'->>'stage',
    trace->'input'->>'stage'
  )
WHERE cartridge IS NULL OR stage IS NULL;

-- 3. Composite index for the tiles filter:
--    WHERE client_id = $1 AND cartridge = $2 ORDER BY started_at DESC
CREATE INDEX IF NOT EXISTS idx_runs_client_cartridge_started
  ON runs (client_id, cartridge, started_at DESC);

-- 4. Trigger to keep the columns in sync with future trace writes. The
--    orchestrator may write the trace JSON without setting these columns
--    (legacy code path); this ensures we never have to re-read the JSON.
CREATE OR REPLACE FUNCTION sync_runs_cartridge_stage() RETURNS trigger AS $$
BEGIN
  IF NEW.trace IS NOT NULL THEN
    NEW.cartridge := COALESCE(NEW.cartridge, NEW.trace->>'cartridge');
    NEW.stage := COALESCE(
      NEW.stage,
      NEW.trace->'stages'->'shotList'->>'stage',
      NEW.trace->'input'->>'stage'
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_runs_sync_cartridge_stage ON runs;
CREATE TRIGGER trg_runs_sync_cartridge_stage
BEFORE INSERT OR UPDATE ON runs
FOR EACH ROW EXECUTE FUNCTION sync_runs_cartridge_stage();

-- 5. Sanity check: row counts should match. If `null_cartridge` > 0 after
--    this runs, some legacy rows have malformed trace JSON — we'll handle
--    those at the application layer (treat null cartridge as "unknown").
SELECT
  COUNT(*) AS total_runs,
  COUNT(*) FILTER (WHERE cartridge IS NULL) AS null_cartridge,
  COUNT(*) FILTER (WHERE stage IS NULL) AS null_stage
FROM runs;
