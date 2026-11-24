# @devalon.dev/server

Hono API on Cloudflare Workers, backed by Kysely + Turso (libSQL). It receives
the event envelopes produced by `@devalon.dev/credits/signals` and forwards them
to Meta Conversions API.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Checks database connectivity |
| `POST` | `/meta-pixel-access-tokens` | Registers a pixel (requires `X-Admin-Token`) |
| `PUT` | `/meta-pixel-access-tokens` | Updates any pixel setting, including secret rotation (admin only) |
| `POST` | `/:pixel_id/signals` | Public CAPI forwarding endpoint used by `sendBeacon` |

Register a token:

```bash
curl -X POST https://signal.devalon.dev/meta-pixel-access-tokens \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: <secret>' \
  -d '{"pixel_id":"YOUR_PIXEL_ID","access_token":"EA..."}'
```

The access token is never returned by the API and never exposed to the browser.
`PUT /meta-pixel-access-tokens` updates any setting on the same single row:

```bash
curl -X PUT https://signal.devalon.dev/meta-pixel-access-tokens \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: <secret>' \
  -d '{"pixel_id":"YOUR_PIXEL_ID","origin":"https://ventprime.md","enforce_browser_checks":true,"rotate_signing_secret":true}'
```

All fields except `pixel_id` are optional. `origin: ""` clears it. When
`rotate_signing_secret` is true, a new HMAC secret is generated, stored on the
pixel row and returned **once** in the response — give it to the site's backend.

## Signals endpoint protection

The public `/:pixel_id/signals` endpoint has four optional layers. All values
live on the single pixel row, so the route makes one database query.

1. **Browser headers** — with `enforce_browser_checks: true`, requests must carry
   `Origin`, `Sec-Fetch-Mode: no-cors`, `Sec-Fetch-Dest: empty` and a
   cross-/same-site `Sec-Fetch-Site`. Plain REST clients don't send these.
2. **Origin** — when `origin` is set on the pixel, the request `Origin` must match
   it. One origin per pixel; an empty value leaves the endpoint open.
3. **JWT** — when `signing_secret` is set, the site's backend mints short-lived
   tokens with `createDevalonSignalJwt()` and passes them as `meta.jwt`. The
   Worker verifies the HMAC signature and the `exp`, `pixel_id` and `origin`
   claims. A stolen token expires within five minutes; a curl client without
   the backend secret cannot mint a new one.
4. **Rate limit** — 60 events per minute per `pixel_id` + IP, checked before the
   database lookup. The map is in-memory and isolate-local (not global); a
   distributed limit would need a Durable Object or KV. Returns `429`.

Layers 1, 2 and 4 are filters: their values can be copied from a page. The JWT
is the actual boundary — it is minted with a secret the browser never has, and
it expires within five minutes. All layers are skipped when unconfigured, so
existing integrations keep working.

## User data and privacy

The signals envelope may carry `user_data` with these customer fields, which
the Worker normalizes and SHA-256 hashes before calling the Graph API:

| Envelope field | Meta `user_data` key | Normalization |
| --- | --- | --- |
| `email` | `em` | Trim, lowercase |
| `phone` | `ph` | Digits only, leading zeros dropped (country code required) |
| `firstName` / `name` / `fn` | `fn` | Lowercase, punctuation stripped, never split |
| `lastName` / `ln` | `ln` | Lowercase, punctuation stripped |
| `externalId` | `external_id` | Trim; case-sensitive |
| `ge` | `ge` | `f` or `m`; caller-supplied only |
| `db` | `db` | `YYYYMMDD`; caller-supplied only |
| `ct` / `st` / `zp` / `country` | same keys | Lowercase, no spaces or punctuation; auto-filled from `request.cf` |

`ct`, `st`, `zp` and `country` are filled on every forwarded event from
Cloudflare's `request.cf` (`city`, `regionCode`, `postalCode`, `country`) — no
external call when those are present. Caller-supplied values always win,
including already-hashed ones, so precise CRM data can override the IP estimate.

When Cloudflare leaves a field empty, the Worker falls back to ipwho.is and then
ipapi.co for the remaining gaps (first source wins). Configure them with
`GEO_LOOKUP_URL_PRIMARY` and `GEO_LOOKUP_URL_SECONDARY`; set either to an empty
string to disable it, and set `GEO_LOOKUP_KEY` if your provider requires one.
Defaults are `https://ipwho.is/{ip}?fields=city,region_code,postal,country_code`
and `https://ipapi.co/{ip}/json/`. Lookups run after the 202 response, time out
after 1.5 s, and are cached per IP for 24 hours (one hour for empty results,
max 1,000 entries). Failures are skipped silently and never block CAPI delivery.
The visitor IP is sent to those providers only when a fallback runs. City and
postal code may be wrong under VPNs or mobile networks. `ge` and `db` have no
such source and stay empty unless the caller supplies them.

`leadId` is the exception: Meta requires it verbatim, so it is emitted as
`lead_id` without hashing. Values already hashed by the SDK's
`hash_meta_user_data()` (64 hex characters, uppercase accepted) are passed
through unchanged and lowercased. `fbp`, `fbc`, `client_user_agent` and
`client_ip_address` are also sent raw, as Meta requires. Client and server
normalization use identical rules. All hashes are computed in one parallel
batch. The optional `opt_out` and `data_processing_options` fields are
forwarded at event level. The `custom_data` whitelist includes Meta's standard
keys plus `status`, `lead_event_source` and `custom_properties` (objects are
serialized to JSON strings). No PII is written to logs.

## Local development

```bash
yarn install
yarn migration:run   # apply schema changes to Turso
yarn dev             # wrangler dev
```

Create a gitignored `.dev.vars` file with `TURSO_DATABASE_URL`,
`TURSO_AUTH_TOKEN` and `ADMIN_TOKEN` before running `yarn dev`. Set
`META_GRAPH_API_BASE_URL` to a local mock while testing to avoid sending real
events to Meta. `wrangler.jsonc` holds non-secret vars; secrets come from
`.dev.vars` locally and from Worker secrets in production.

## Deploy

Deployment is automated by `.github/workflows/deploy.yml` on every push to
`main`. The job runs typecheck, applies migrations, then deploys with
`cloudflare/wrangler-action@v4`.

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `ADMIN_TOKEN`

Manual deploy (requires Cloudflare credentials):

```bash
yarn typecheck
yarn build        # dry-run bundle into dist/
yarn deploy
```

## Logs

The Worker emits one JSON line per event: `signals.in`, `capi.ok`, `capi.fail`,
`token.created`, `token.missing`, `token.rejected`, `signals.rejected`. Tokens
and raw event params are never logged. Watch them live with:

```bash
npx wrangler tail devalon-server
```

or in the dashboard under **Workers & Pages → devalon-server → Logs**. The
Graph API call runs in `waitUntil`, so its success/failure line appears after
the `202 Accepted` response.

## Custom domain

The Worker is published on `workers.dev` by default. To match the SDK's default
endpoint, create `signal.devalon.dev` in Cloudflare DNS and attach it to this
Worker via **Workers & Pages → devalon-server → Settings → Domains & Routes**.
No SDK change is needed.

## Migrations

Migration files live in `src/migrations/` and are applied with
`yarn migration:run`. Do not delete already-applied migration files: Kysely
records them in `kysely_migration` and rejects missing files.
