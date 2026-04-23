# API-Key Exchange Variant

**Status:** design spec. Not yet implemented.
**Date:** 2026-04-22

## One-line

The same Brand Image Blaster pipeline, exposed as a headless HTTP API — no UI, no sign-in screen, no email. A single `X-API-Key` header authenticates a programmatic client. Developers POST titles + N, poll for status, fetch a ZIP. That's the whole product.

## Why this exists

The current surface is a web UI for non-technical testers. Every attempt to onboard a developer through it wastes their time: they don't want invite links, OTP codes, sessions, or a textarea. They want `curl` and a key, the same way they integrate with OpenAI, fal, or Resend.

The API variant collapses the onboarding flow to *"here's your key, here's the endpoint."* Everything downstream — cartridge, prompt factory, renderer, storage — is the existing pipeline unchanged. Only the ingress changes.

This variant also de-risks the auth-delivery problems we've been fighting (Resend sandbox, Slack link-preview bots, domain verification). API keys are server-to-server; none of those failure modes apply.

## Non-goals

- Not a replacement for the UI. UI stays for human-in-the-loop curation.
- Not multi-tenant with RBAC. Each API key maps to one `client` row with a fixed cartridge + quota.
- Not a public self-signup flow. Keys are issued manually (CLI) for now; self-serve key provisioning is a later layer.
- Not streaming (SSE) for v1. Polling only. SSE is a v2 add if developers ask.

## Surface

Four endpoints. Versioned under `/v1/` to keep the existing `/api/public/*` surface untouched.

### `POST /v1/generate`

Start a batch. Fire-and-forget; returns immediately with a `run_id` to poll.

**Request**
```http
POST /v1/generate HTTP/1.1
Host: image-blaster-production.up.railway.app
X-API-Key: ibk_live_7BAnnfQh_JJD6S57zWtENAzi7c6gsQ1A1
Content-Type: application/json

{
  "titles": [
    "what do genital warts look like",
    "best moisturizer for oily skin",
    "how to reduce redness after a pimple"
  ],
  "n_per_title": 3,
  "cartridge": "nolla",
  "aspect_ratio": "1:1",
  "model": "nano-banana-pro"
}
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `titles` | yes | — | Array of strings. Max 200 per batch. |
| `n_per_title` | no | client's `n_per_title` | 1–10 |
| `cartridge` | no | client's `cartridge` | Must be a cartridge the key has access to. |
| `aspect_ratio` | no | `"1:1"` | `1:1` / `3:4` / `4:3` / `16:9` / `9:16` |
| `model` | no | `nano-banana-pro` | Overrides cartridge default |
| `critic` | no | `true` | Whether to run the critic pass |

**Response (202 Accepted)**
```json
{
  "run_id": "run_01HXZ9K2M7FWBA4R5NVPQ8E3TJ",
  "status": "queued",
  "titles": 3,
  "total_images": 9,
  "estimated_seconds": 72,
  "polling_url": "/v1/runs/run_01HXZ9K2M7FWBA4R5NVPQ8E3TJ"
}
```

**Quota enforcement:** if `total_images` would push the client past `monthly_image_quota`, 402 Payment Required with remaining balance.

### `GET /v1/runs/:id`

Poll for status.

**Response (200 OK)**
```json
{
  "run_id": "run_01HXZ9K2M7FWBA4R5NVPQ8E3TJ",
  "status": "running",
  "progress": { "ok": 4, "failed": 0, "total": 9 },
  "started_at": "2026-04-22T17:43:12Z",
  "finished_at": null,
  "images": [
    {
      "title": "what do genital warts look like",
      "filename": "gen-001.png",
      "url": "https://.../v1/runs/run_01.../images/gen-001.png",
      "prompt": "…",
      "status": "ok"
    }
  ],
  "zip_url": null
}
```

Status values: `queued` | `running` | `done` | `failed`.
When `done`, `zip_url` is populated and every image row has a `url` (pre-signed, 7-day TTL from Supabase storage).

### `GET /v1/runs/:id/zip`

Stream the ZIP. Same streaming archiver behavior we already use for the UI. Returns 404 until the run is `done`.

### `GET /v1/runs`

List this key's recent runs. Pagination via `?limit=50&before=<iso>`.

```json
{
  "runs": [
    {
      "run_id": "...",
      "status": "done",
      "titles": 3,
      "ok": 9, "failed": 0,
      "started_at": "...",
      "finished_at": "..."
    }
  ],
  "has_more": false
}
```

## Auth

`X-API-Key` header. No bearer prefix — every API product eventually gets asked for either `Bearer` or `X-API-Key`, and `X-API-Key` is the more self-documenting choice for a single-purpose key.

Key format: `ibk_live_<22 base64url chars>` (`ibk` = image-blaster-key; `live` vs `test` to leave room for a sandbox key type later).

### Storage

Keys are stored **hashed** in the DB, never in plaintext:

```sql
alter table clients
  add column api_key_hash text,
  add column api_key_prefix text,  -- first 11 chars ("ibk_live_XX") for display
  add column api_key_created_at timestamptz;

create index clients_api_key_hash_idx on clients (api_key_hash);
```

Lookup at request time: `sha256(key) → index lookup → client row`. We never need to "see" the key after it's issued, which means we never display it twice (issuing CLI prints it once, that's it — same UX as Stripe / OpenAI).

### Middleware

Extends the existing `requireClient` middleware with a third auth path:

1. `AUTH_MODE=open` → shared public client (current behavior)
2. `X-API-Key` header present → hash + lookup, populate `req.client`
3. `sid` cookie → existing session-cookie path
4. Else 401

This means the API variant **coexists** with the UI flow on the same deploy. One Railway service handles both surfaces; key holders hit `/v1/*`, UI users hit `/` + `/api/auth/*`. No fork needed.

## Rate limits

Per-key, in-memory token bucket for v1 (no Redis yet — Railway single-instance):

- **`POST /v1/generate`**: 10/minute (batches are expensive)
- **`GET /v1/runs*`**: 120/minute (polling is cheap)
- **ZIP downloads**: 30/hour

Headers returned on every response:
```
X-RateLimit-Limit: 10
X-RateLimit-Remaining: 7
X-RateLimit-Reset: 1713812100
```

## Errors

All errors return the same shape:

```json
{ "error": { "code": "quota_exceeded", "message": "this batch would exceed your monthly quota", "remaining": 42 } }
```

Codes: `invalid_key`, `key_revoked`, `quota_exceeded`, `rate_limited`, `batch_too_large`, `cartridge_not_found`, `titles_required`, `internal`.

## CLI for issuing keys

```
node scripts/issue-api-key.js --email dev@example.com --cartridge nolla --n 3 --quota 2000 --note "acme pilot"
```

Prints, once and never again:

```
✓ API key issued for dev@example.com
  key:       ibk_live_7BAnnfQh_JJD6S57zWtENAzi7c6gsQ1A1
  client_id: 341ca731-3dec-4693-b4b0-fd184cd10f06
  cartridge: nolla · n/title: 3 · quota: 2000/mo
  note:      acme pilot

Send to developer. Store the key in their secret manager.
This is the last time this key will be visible in plaintext.
```

Matching revoke:
```
node scripts/revoke-api-key.js --prefix ibk_live_7BAnnfQh
```

## What stays the same

Everything below the ingress layer is reused as-is:

- `runBatch()` orchestrator — unchanged
- Cartridge loader — unchanged
- Prompt factory + slot grammar — unchanged
- fal renderer + retry logic — unchanged
- Supabase storage adapter — unchanged
- Trace store — unchanged (`client_id` scoping already works)

The API variant is ~300 lines of code: a `routes/v1.js` file + a hashed-key middleware + two CLI scripts. Everything else is free.

## Migration from today's state

1. **Phase A — coexistence.** Add `v1/` routes + key-hash middleware next to the existing UI. Issue the first key to a developer internally, dogfood.
2. **Phase B — docs.** Single `docs/api.md` (or `docs.image-blaster.com`) with the four endpoints, one `curl` example per, quota + key-rotation. Deliberately not shipped as OpenAPI yet — Markdown is faster to keep accurate.
3. **Phase C — SDK (only if asked).** A thin `@image-blaster/client` npm package. Three functions: `generate()`, `getRun()`, `downloadZip()`. Each is a wrapper around `fetch`. Don't build this until a developer tells you they want it; most API consumers are happy with `curl` + whatever HTTP client their language ships with.
4. **Phase D — OpenAPI spec.** When the surface is stable and a second customer asks for it.

## Pricing model (later, not v1)

Not scoped for this doc, but the architecture is ready for it. `clients.monthly_image_quota` already exists. When we want to bill, add a `plan_id`, a stripe customer id, and a quota reset job — nothing in the request path changes. The API surface above is compatible with pay-as-you-go, tiered monthly, or credit-pack models without changes.

## Open questions

1. **Key visibility to users.** Stripe lets users see their keys in the dashboard on login. OpenAI lets you see each key's prefix but never the full key again. We should match OpenAI (prefix-only, never reveal again) — it's safer and developers are already trained on the pattern.
2. **Webhooks?** Polling is the v1 answer. If a developer asks "can you POST to me when a run finishes?", that's a small addition: `POST /v1/webhooks` with an HMAC-signed body, retry-with-backoff. Don't build until asked.
3. **Idempotency.** `POST /v1/generate` with an `Idempotency-Key` header = same `run_id` returned on retry instead of starting a second batch. Adding this in v1 is cheap and saves a class of bug later. Recommend: ship it.
4. **Per-key cartridge override.** Today each key → one client → one cartridge. If a single customer wants to use multiple cartridges under one key, we either issue N keys or let `POST /v1/generate` accept a `cartridge` field that must be in an allowlist on the client. The latter is cleaner but adds a permission model. For v1, one cartridge per key.
5. **Sandbox mode.** `ibk_test_*` keys that return fake runs with placeholder images from a cached pool, for free. Mimics Stripe's test keys. Useful later for integration-testing without burning fal credits. Not v1.

## Definition of done

- A developer can integrate the tool with a single `curl` of <1KB:
  ```
  curl -X POST https://image-blaster.app/v1/generate \
    -H "X-API-Key: $IBK_KEY" -H "Content-Type: application/json" \
    -d '{"titles":["..."], "n_per_title": 3}'
  ```
- They can poll `/v1/runs/:id` and get back URLs to each image.
- No OTP, no email, no invite, no session cookie involved at any step.
- Revoking a key instantly locks out further requests (cache TTL ≤ 60s).
- Existing UI users on the same deploy are unaffected.
