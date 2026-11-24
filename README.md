# @devalon.dev/server

Hono API on Cloudflare Workers, backed by Kysely + Turso (libSQL). It receives
the event envelopes produced by `@devalon.dev/credits/signals` and forwards them
to Meta Conversions API.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Checks database connectivity |
| `POST` | `/meta-pixel-access-tokens` | Registers a Meta pixel ID ↔ access token pair (requires `X-Admin-Token`) |
| `POST` | `/:pixel_id/signals` | Public CAPI forwarding endpoint used by `sendBeacon` |

Register a token:

```bash
curl -X POST https://signal.devalon.dev/meta-pixel-access-tokens \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: <secret>' \
  -d '{"pixel_id":"1683475309995701","access_token":"EA..."}'
```

The access token is never returned by the API and never exposed to the browser.

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
