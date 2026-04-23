-- API keys: hashed at rest, prefix stored for display, indexed on hash for O(1) lookup.
-- Shown once at issue time; never recoverable (developer must store in their secret manager).
alter table public.clients
  add column if not exists api_key_hash        text,
  add column if not exists api_key_prefix      text,
  add column if not exists api_key_created_at  timestamptz;

create index if not exists clients_api_key_hash_idx on public.clients (api_key_hash);
