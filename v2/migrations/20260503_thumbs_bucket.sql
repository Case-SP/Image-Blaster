-- Public bucket for pre-baked tile thumbnails.
-- The original PNGs stay in the private `generations` bucket; thumbs live
-- here so the UI can fetch them directly from the CDN without round-tripping
-- through Node. Drops cold tile paint from ~600-2000ms → ~50-150ms per tile.

INSERT INTO storage.buckets (id, name, public)
VALUES ('generations-thumbs', 'generations-thumbs', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Public-read policy on this bucket. Writes still require service-role key
-- (the orchestrator uses it via the supabase-js client).
-- Note: Postgres `CREATE POLICY IF NOT EXISTS` isn't supported on Supabase's
-- version, so we DROP-then-CREATE to keep this idempotent.
DROP POLICY IF EXISTS "thumbs are publicly readable" ON storage.objects;
CREATE POLICY "thumbs are publicly readable"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'generations-thumbs');
