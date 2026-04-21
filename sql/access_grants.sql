-- Access grants: one-time tickets issued out-of-band (emailed manually)
-- Each grant yields either a URL (token) or a 6-digit code; redeeming either
-- creates a standard session cookie (30-day TTL from existing sessions table).
create table if not exists access_grants (
  token          text primary key,
  code           text not null,
  email          text not null,
  cartridge      text not null default 'nolla',
  n_per_title    int  not null default 3,
  monthly_image_quota int not null default 500,
  expires_at     timestamptz not null,
  used_at        timestamptz,
  used_client_id uuid references clients(id),
  note           text,
  created_at     timestamptz not null default now()
);

create unique index if not exists access_grants_code_idx
  on access_grants (code)
  where used_at is null;

create index if not exists access_grants_email_idx
  on access_grants (email);
