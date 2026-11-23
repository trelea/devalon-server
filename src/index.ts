import { Hono } from "hono";
import { sql } from "kysely";

import {
  CapiError,
  build_capi_event,
  send_to_meta,
  type SignalPayload,
} from "./capi.js";
import { get_db, type Env } from "./db.js";

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

function is_unique_error(error: unknown): boolean {
  return (
    (error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ||
    (error instanceof Error && /UNIQUE constraint failed/i.test(error.message))
  );
}

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
    console.error("ADMIN_TOKEN is not configured");
    return c.json({ error: "Server is not configured" }, 500);
  }

  const provided = c.req.header("x-admin-token");
  if (!provided || !constant_time_equal(provided, admin_token)) {
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

  if (!is_non_empty_string(pixel_id) || !PIXEL_ID_PATTERN.test(pixel_id.trim())) {
    return c.json({ error: "pixel_id must be a numeric Meta pixel ID" }, 400);
  }
  if (
    !is_non_empty_string(access_token) ||
    access_token.trim().length > 4096
  ) {
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
      return c.json(
        {
          error:
            "A token is already registered for that pixel_id or access_token",
        },
        409,
      );
    }

    console.error("Failed to register access token:", error);
    return c.json({ error: "Internal server error" }, 500);
  }

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

/**
 * Receives envelopes from `credits/src/signals/transport.ts` via sendBeacon
 * (text/plain body), then delivers them server-side through Meta CAPI.
 * The browser event_id is preserved so Meta can deduplicate the two channels.
 */
app.post("/:pixel_id/signals", async (c) => {
  const pixel_id = c.req.param("pixel_id");

  if (!PIXEL_ID_PATTERN.test(pixel_id)) {
    return c.json({ error: "pixel_id must be a numeric Meta pixel ID" }, 400);
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

  const {
    event_name,
    event_id,
    event_time,
    params,
    capi_test_event_code,
  } = parsed;

  if (!is_non_empty_string(event_name) || !is_non_empty_string(event_id)) {
    return c.json({ error: "event_name and event_id must be non-empty strings" }, 400);
  }
  if (typeof event_time !== "number" || !Number.isInteger(event_time)) {
    return c.json({ error: "event_time must be an integer Unix timestamp" }, 400);
  }

  const now_s = Math.floor(Date.now() / 1000);
  if (
    event_time < now_s - MAX_EVENT_AGE_S ||
    event_time > now_s + MAX_FUTURE_SKEW_S
  ) {
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
    return c.json({ error: "capi_test_event_code contains unsupported characters" }, 400);
  }

  let token_row: { access_token: string } | undefined;
  try {
    token_row = await get_db(c.env)
      .selectFrom("meta_pixel_access_tokens")
      .select("access_token")
      .where("pixel_id", "=", pixel_id)
      .executeTakeFirst();
  } catch (error) {
    console.error("Failed to look up access token:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
  if (!token_row) {
    return c.json({ error: "No access token registered for this pixel" }, 404);
  }

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
    ...(typeof parsed.referrer === "string" ? { referrer: parsed.referrer } : {}),
    ...(typeof parsed.user_agent === "string"
      ? { user_agent: parsed.user_agent }
      : {}),
    ...(typeof capi_test_event_code === "string"
      ? { capi_test_event_code }
      : {}),
  };

  const forwarded_for = c.req.header("x-forwarded-for");
  const client_ip = forwarded_for?.split(",")[0]?.trim() || c.req.header("x-real-ip");

  const { event, test_event_code } = build_capi_event(payload, client_ip);

  try {
    const result = await send_to_meta(
      pixel_id,
      token_row.access_token,
      event,
      test_event_code,
      {
        base_url: c.env.META_GRAPH_API_BASE_URL,
        version: c.env.META_GRAPH_API_VERSION,
      },
    );

    return c.json({
      status: "ok",
      events_received: result.events_received,
      ...(result.fbtrace_id ? { fbtrace_id: result.fbtrace_id } : {}),
    });
  } catch (error) {
    console.error(
      `Meta CAPI request failed for pixel ${pixel_id}:`,
      error instanceof CapiError ? (error.details ?? error.message) : error,
    );

    return c.json({ error: "Meta CAPI request failed" }, 502);
  }
});

export default app;
