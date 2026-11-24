import { Hono } from "hono";
import { sql } from "kysely";

import {
  CapiError,
  build_capi_event,
  send_to_meta,
  type MetaCapiResult,
  type SignalPayload,
  type SignalUserData,
} from "./capi.js";
import { get_db, type Env } from "./db.js";
import { merge_geo_user_data, read_geo, resolve_external_geo } from "./geo.js";
import {
  allow_request,
  has_browser_headers,
  is_dev_origin,
  normalize_origin,
} from "./security.js";
import { verify_signal_jwt } from "./jwt.js";
import { read_signal_jwt } from "./signal-jwt.js";

const app = new Hono<{ Bindings: Env }>();

const PIXEL_ID_PATTERN = /^\d+$/;
const TEST_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_SIGNAL_BODY_BYTES = 64 * 1024;
const MAX_EVENT_AGE_S = 7 * 24 * 60 * 60;
const MAX_FUTURE_SKEW_S = 300;

function is_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function is_non_empty_string(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function constant_time_equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

function is_admin(c: {
  req: { header: (name: string) => string | undefined };
  env: Env;
}): boolean {
  const token = c.env.ADMIN_TOKEN;
  const provided = c.req.header("x-admin-token");
  return Boolean(token && provided && constant_time_equal(provided, token));
}

function is_unique_error(error: unknown): boolean {
  return (
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
  );
}

function parse_user_data(value: unknown): SignalUserData | undefined {
  if (!is_object(value)) return undefined;

  const user_data: SignalUserData = {};
  for (const key of [
    "email",
    "phone",
    "externalId",
    "leadId",
    "name",
    "firstName",
    "lastName",
    "ge",
    "db",
    "ct",
    "st",
    "zp",
    "country",
  ] as const) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) user_data[key] = field;
  }

  return Object.keys(user_data).length > 0 ? user_data : undefined;
}

type LogLevel = "info" | "warn" | "error";

/** One JSON line per event; never pass tokens or raw event params here. */
function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    level,
    event,
    time: new Date().toISOString(),
    ...fields,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** Keepalive fetch uses cors; answer its preflight and expose the response. */
app.use("/:pixel_id/signals", async (c, next) => {
  const origin = c.req.header("Origin");

  c.header("Access-Control-Allow-Origin", origin ?? "*");
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  c.header("Vary", "Origin");

  if (c.req.method === "OPTIONS") return c.body(null, 204);

  await next();
});

app.get("/health", async (c) => {
  try {
    await sql`SELECT 1`.execute(get_db(c.env));

    return c.json({ status: "ok", db: "ok" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    return c.json({ status: "error", db: "unavailable", error: message }, 503);
  }
});

/**
 * Registers the Meta access token used by the public signals endpoint.
 * Requires `X-Admin-Token` matching ADMIN_TOKEN; the token is never returned.
 */
app.post("/meta-pixel-access-tokens", async (c) => {
  const admin_token = c.env.ADMIN_TOKEN;

  if (!admin_token) {
    log("error", "token.rejected", { reason: "server_misconfigured" });
    return c.json({ error: "Server is not configured" }, 500);
  }

  const provided = c.req.header("x-admin-token");
  if (!provided || !constant_time_equal(provided, admin_token)) {
    log("warn", "token.rejected", { reason: "unauthorized" });
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  if (!is_object(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const { pixel_id, access_token } = body;

  if (
    !is_non_empty_string(pixel_id) ||
    !PIXEL_ID_PATTERN.test(pixel_id.trim())
  ) {
    log("warn", "token.rejected", { reason: "invalid_pixel_id" });
    return c.json({ error: "pixel_id must be a numeric Meta pixel ID" }, 400);
  }
  if (!is_non_empty_string(access_token) || access_token.trim().length > 4096) {
    log("warn", "token.rejected", {
      reason: "invalid_access_token",
      pixel_id: pixel_id.trim(),
    });
    return c.json({ error: "access_token must be a non-empty string" }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const clean_pixel_id = pixel_id.trim();

  try {
    await get_db(c.env)
      .insertInto("meta_pixel_access_tokens")
      .values({
        id,
        pixel_id: clean_pixel_id,
        access_token: access_token.trim(),
        created_at: now,
        updated_at: now,
      })
      .execute();
  } catch (error) {
    if (is_unique_error(error)) {
      log("warn", "token.rejected", {
        reason: "duplicate",
        pixel_id: clean_pixel_id,
      });
      return c.json(
        {
          error:
            "A token is already registered for that pixel_id or access_token",
        },
        409,
      );
    }

    log("error", "token.rejected", {
      reason: "db_error",
      pixel_id: clean_pixel_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Internal server error" }, 500);
  }

  log("info", "token.created", { id, pixel_id: clean_pixel_id });

  return c.json(
    {
      id,
      pixel_id: clean_pixel_id,
      created_at: now,
      updated_at: now,
    },
    201,
  );
});

/** Partially updates a pixel identified by the path. Requires X-Admin-Token. */
app.patch("/meta-pixel-access-tokens/:pixel_id", async (c) => {
  if (!is_admin(c)) return c.json({ error: "Unauthorized" }, 401);

  const pixel_id = c.req.param("pixel_id");
  if (!PIXEL_ID_PATTERN.test(pixel_id)) {
    return c.json({ error: "pixel_id must be a numeric Meta pixel ID" }, 400);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!is_object(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const {
    access_token,
    origin,
    enforce_browser_checks,
    rotate_signing_secret,
    signing_secret,
    allow_dev_origins,
  } = body;
  if (
    access_token === undefined &&
    origin === undefined &&
    enforce_browser_checks === undefined &&
    rotate_signing_secret === undefined &&
    signing_secret === undefined &&
    allow_dev_origins === undefined
  ) {
    return c.json({ error: "No updatable fields supplied" }, 400);
  }
  if (
    access_token !== undefined &&
    (!is_non_empty_string(access_token) || access_token.trim().length > 4096)
  ) {
    return c.json({ error: "access_token must be a non-empty string" }, 400);
  }
  if (
    origin !== undefined &&
    origin !== null &&
    origin !== "" &&
    !is_non_empty_string(origin)
  ) {
    return c.json({ error: "origin must be a string or empty to clear" }, 400);
  }
  if (
    enforce_browser_checks !== undefined &&
    typeof enforce_browser_checks !== "boolean"
  ) {
    return c.json({ error: "enforce_browser_checks must be a boolean" }, 400);
  }
  if (
    rotate_signing_secret !== undefined &&
    typeof rotate_signing_secret !== "boolean"
  ) {
    return c.json({ error: "rotate_signing_secret must be a boolean" }, 400);
  }
  if (
    allow_dev_origins !== undefined &&
    typeof allow_dev_origins !== "boolean"
  ) {
    return c.json({ error: "allow_dev_origins must be a boolean" }, 400);
  }
  if (
    signing_secret !== undefined &&
    (!is_non_empty_string(signing_secret) || signing_secret.length > 4096)
  ) {
    return c.json({ error: "signing_secret must be a non-empty string" }, 400);
  }

  let normalized_origin: string | null | undefined;
  if (origin === "" || origin === null) normalized_origin = null;
  else if (origin !== undefined) {
    const value = normalize_origin(origin);
    if (!value)
      return c.json(
        { error: "origin must be an absolute http(s) origin" },
        400,
      );
    normalized_origin = value;
  }

  // An explicit secret wins over rotation; only one can be applied.
  const updated_secret =
    signing_secret !== undefined
      ? signing_secret.trim()
      : rotate_signing_secret === true
        ? `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`
        : undefined;

  const now = new Date().toISOString();
  const clean_pixel_id = pixel_id.trim();
  const update: {
    access_token?: string;
    origin?: string | null;
    signing_secret?: string;
    enforce_browser_checks?: number;
    allow_dev_origins?: number;
    updated_at: string;
  } = { updated_at: now };
  if (access_token !== undefined) update.access_token = access_token.trim();
  if (normalized_origin !== undefined) update.origin = normalized_origin;
  if (updated_secret !== undefined) update.signing_secret = updated_secret;
  if (enforce_browser_checks !== undefined) {
    update.enforce_browser_checks = enforce_browser_checks ? 1 : 0;
  }
  if (allow_dev_origins !== undefined) {
    update.allow_dev_origins = allow_dev_origins ? 1 : 0;
  }

  try {
    const result = await get_db(c.env)
      .updateTable("meta_pixel_access_tokens")
      .set(update)
      .where("pixel_id", "=", clean_pixel_id)
      .executeTakeFirst();

    if (!result || Number(result.numUpdatedRows) === 0) {
      return c.json({ error: "No token registered for this pixel" }, 404);
    }

    log("info", "token.updated", { pixel_id: clean_pixel_id });
    return c.json({
      pixel_id: clean_pixel_id,
      updated_at: now,
      ...(updated_secret ? { signing_secret: updated_secret } : {}),
    });
  } catch (error) {
    if (is_unique_error(error)) {
      return c.json({ error: "That access token is already in use" }, 409);
    }
    log("error", "token.rejected", {
      reason: "db_error",
      pixel_id: clean_pixel_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * Receives envelopes from `credits/src/signals/transport.ts` via keepalive
 * fetch, with the JWT in an Authorization header, then delivers them
 * server-side through Meta CAPI. The browser event_id is preserved so Meta
 * can deduplicate the two channels.
 */
app.post("/:pixel_id/signals", async (c) => {
  const pixel_id = c.req.param("pixel_id");

  if (!PIXEL_ID_PATTERN.test(pixel_id)) {
    log("warn", "signals.rejected", { reason: "invalid_pixel_id", pixel_id });
    return c.json({ error: "pixel_id must be a numeric Meta pixel ID" }, 400);
  }

  const forwarded_for = c.req.header("x-forwarded-for");
  const client_ip =
    forwarded_for?.split(",")[0]?.trim() || c.req.header("x-real-ip");
  if (!allow_request(`${pixel_id}:${client_ip ?? "unknown"}`)) {
    log("warn", "signals.rejected", { reason: "rate_limited", pixel_id });
    return c.json({ error: "Too many signals" }, 429);
  }

  let raw_body: string;
  try {
    raw_body = await c.req.text();
  } catch {
    return c.json({ error: "Could not read request body" }, 400);
  }
  if (raw_body.length > MAX_SIGNAL_BODY_BYTES) {
    return c.json({ error: "Request body is too large" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw_body);
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (!is_object(parsed)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }

  const { event_name, event_id, event_time, params, capi_test_event_code } =
    parsed;

  if (!is_non_empty_string(event_name) || !is_non_empty_string(event_id)) {
    log("warn", "signals.rejected", { reason: "invalid_event", pixel_id });
    return c.json(
      { error: "event_name and event_id must be non-empty strings" },
      400,
    );
  }
  if (typeof event_time !== "number" || !Number.isInteger(event_time)) {
    log("warn", "signals.rejected", { reason: "invalid_event_time", pixel_id });
    return c.json(
      { error: "event_time must be an integer Unix timestamp" },
      400,
    );
  }

  const now_s = Math.floor(Date.now() / 1000);
  if (
    event_time < now_s - MAX_EVENT_AGE_S ||
    event_time > now_s + MAX_FUTURE_SKEW_S
  ) {
    log("warn", "signals.rejected", { reason: "stale_event_time", pixel_id });
    return c.json({ error: "event_time is outside the accepted window" }, 400);
  }

  if (params !== undefined && !is_object(params)) {
    return c.json({ error: "params must be an object" }, 400);
  }
  if (
    capi_test_event_code !== undefined &&
    (!is_non_empty_string(capi_test_event_code) ||
      !TEST_CODE_PATTERN.test(capi_test_event_code))
  ) {
    return c.json(
      { error: "capi_test_event_code contains unsupported characters" },
      400,
    );
  }

  let token_row:
    | {
        access_token: string;
        origin: string | null;
        signing_secret: string | null;
        enforce_browser_checks: number;
        allow_dev_origins: number;
      }
    | undefined;
  try {
    token_row = await get_db(c.env)
      .selectFrom("meta_pixel_access_tokens")
      .select([
        "access_token",
        "origin",
        "signing_secret",
        "enforce_browser_checks",
        "allow_dev_origins",
      ])
      .where("pixel_id", "=", pixel_id)
      .executeTakeFirst();
  } catch (error) {
    log("error", "signals.rejected", {
      reason: "db_error",
      pixel_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Internal server error" }, 500);
  }
  if (!token_row) {
    log("warn", "token.missing", { pixel_id });
    return c.json({ error: "No access token registered for this pixel" }, 404);
  }

  // Layer 1: browser-controlled fetch metadata. Off until enabled per pixel.
  if (
    token_row.enforce_browser_checks === 1 &&
    !has_browser_headers(c.req.raw)
  ) {
    log("warn", "signals.rejected", { reason: "browser_headers", pixel_id });
    return c.json({ error: "Browser request required" }, 403);
  }

  // One origin and one signing secret live on the pixel row itself.
  const request_origin = c.req.header("origin");
  const normalized_request_origin = request_origin
    ? normalize_origin(request_origin)
    : undefined;
  const dev_origin_allowed =
    token_row.allow_dev_origins === 1 && is_dev_origin(normalized_request_origin);

  if (
    token_row.origin &&
    normalized_request_origin !== token_row.origin &&
    !dev_origin_allowed
  ) {
    log("warn", "signals.rejected", { reason: "origin", pixel_id });
    return c.json({ error: "Origin not allowed" }, 403);
  }

  const { token: jwt_token, from_body } = read_signal_jwt(c, parsed);
  if (from_body) {
    log("warn", "signals.deprecated", {
      reason: "jwt_in_body",
      pixel_id,
    });
  }

  if (token_row.signing_secret) {
    const verification = await verify_signal_jwt(
      jwt_token,
      token_row.signing_secret,
      pixel_id,
      request_origin,
      undefined,
      {
        // Local testing may mint a token for the dev origin or keep the
        // production origin; both are acceptable only when enabled by admin.
        allowed_origins:
          dev_origin_allowed && token_row.origin ? [token_row.origin] : [],
      },
    );
    if (!verification.ok) {
      const code = `jwt_${verification.reason}`;
      log("warn", "signals.rejected", { reason: code, pixel_id });
      return c.json({ error: code }, 403);
    }
  }

  // Geo fields are inferred at the edge for every forwarded event. Caller data
  // wins, so a supplied (or pre-hashed) value is never overwritten.
  const user_data = merge_geo_user_data(
    parsed.user_data !== undefined
      ? parse_user_data(parsed.user_data)
      : undefined,
    read_geo(c.req.raw),
  );

  const payload: SignalPayload = {
    event_name: event_name.trim(),
    event_id: event_id.trim(),
    params: is_object(params) ? params : {},
    event_time,
    ...(typeof parsed.fbp === "string" ? { fbp: parsed.fbp } : {}),
    ...(typeof parsed.fbc === "string" ? { fbc: parsed.fbc } : {}),
    ...(typeof parsed.event_source_url === "string"
      ? { event_source_url: parsed.event_source_url }
      : {}),
    ...(typeof parsed.referrer === "string"
      ? { referrer: parsed.referrer }
      : {}),
    ...(typeof parsed.user_agent === "string"
      ? { user_agent: parsed.user_agent }
      : {}),
    ...(typeof capi_test_event_code === "string"
      ? { capi_test_event_code }
      : {}),
    ...(user_data ? { user_data } : {}),
    ...(typeof parsed.opt_out === "boolean" ? { opt_out: parsed.opt_out } : {}),
    ...(Array.isArray(parsed.data_processing_options)
      ? {
          data_processing_options: parsed.data_processing_options.filter(
            (item): item is string => typeof item === "string",
          ),
        }
      : {}),
  };

  log("info", "signals.in", {
    pixel_id,
    event_name: payload.event_name,
    event_id: payload.event_id,
    has_fbp: Boolean(payload.fbp),
    has_fbc: Boolean(payload.fbc),
    has_user_data: Boolean(
      payload.user_data && Object.keys(payload.user_data).length > 0,
    ),
    event_source_url: payload.event_source_url ?? "",
    ...(dev_origin_allowed ? { dev_origin: true } : {}),
  });

  const config = {
    base_url: c.env.META_GRAPH_API_BASE_URL,
    version: c.env.META_GRAPH_API_VERSION,
  };

  // Deliver to Meta after the response is sent. The browser uses sendBeacon
  // and never reads the body, so a fast 202 is enough. One retry is safe
  // because Meta deduplicates by event_id.
  const deliver = async (): Promise<MetaCapiResult> => {
    // Runs after the 202 response: fill any geo gaps Cloudflare left, then
    // build the event with the same normalization and hashing as always.
    const external_geo = await resolve_external_geo(client_ip ?? "", c.env);
    const enriched = merge_geo_user_data(payload.user_data, external_geo);
    const { event, test_event_code } = await build_capi_event(
      { ...payload, user_data: enriched },
      client_ip,
    );

    try {
      return await send_to_meta(
        pixel_id,
        token_row.access_token,
        event,
        test_event_code,
        config,
      );
    } catch (error) {
      const status = error instanceof CapiError ? error.status : undefined;
      if (status !== undefined && status < 500) throw error;

      await new Promise((resolve) => setTimeout(resolve, 500));
      return await send_to_meta(
        pixel_id,
        token_row.access_token,
        event,
        test_event_code,
        config,
      );
    }
  };

  const delivery = deliver().then(
    (result) => {
      log("info", "capi.ok", {
        pixel_id,
        event_id: payload.event_id,
        events_received: result.events_received,
        ...(result.fbtrace_id ? { fbtrace_id: result.fbtrace_id } : {}),
      });
    },
    (error: unknown) => {
      log("error", "capi.fail", {
        pixel_id,
        event_id: payload.event_id,
        error: error instanceof CapiError ? error.message : "unknown error",
      });
    },
  );

  const execution_ctx = c.executionCtx;
  if (execution_ctx && typeof execution_ctx.waitUntil === "function") {
    execution_ctx.waitUntil(delivery);
  } else {
    await delivery;
  }

  return c.json({ status: "accepted" }, 202);
});

export default app;
