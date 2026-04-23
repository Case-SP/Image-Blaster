-- Enable Row Level Security on every public table.
-- All app traffic uses the service-role key, which bypasses RLS, so this
-- is non-breaking. The effect is to deny anon-key access to these tables,
-- which is what Supabase's linter (rls_disabled_in_public,
-- sensitive_columns_exposed) flags as required for any table reachable via
-- the public PostgREST API.
--
-- No policies are added — RLS-enabled-with-no-policies = anon sees nothing.
-- Add policies later if/when the anon key is exposed to browsers (e.g. for
-- realtime subscriptions or direct client-side queries).

alter table public.clients        enable row level security;
alter table public.runs           enable row level security;
alter table public.images         enable row level security;
alter table public.sessions       enable row level security;
alter table public.invites        enable row level security;
alter table public.access_grants  enable row level security;
