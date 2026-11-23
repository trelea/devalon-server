/**
 * Conversion of the browser envelope produced by `@devalon.dev/credits/signals`
 * into a Meta Conversions API request, and delivery to the Graph API.
 *
 * The access token never leaves this module: it is read from the database by
 * the route and used only as a query parameter on the outbound request.
 */

export interface SignalPayload {
  event_name: string;
  event_id: string;
  params: Record<string, unknown>;
  emitted_at?: string;
  capi_test_event_code?: string;
  pixel_id?: string;
  event_time: number;
  action_source?: string;
  fbp?: string;
  fbc?: string;
  event_source_url?: string;
  referrer?: string;
  user_agent?: string;
  language?: string;
  timezone?: string;
  screen?: Record<string, unknown>;
  viewport?: Record<string, unknown>;
  page_title?: string;
  sent_at?: string;
}

export interface MetaCapiEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  action_source: "website";
  event_source_url?: string;
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
  order_id?: string;
}

export interface MetaCapiResult {
  events_received: number;
  messages: string[];
  fbtrace_id?: string;
}

export class CapiError extends Error {
  readonly details: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "CapiError";
    this.details = details;
  }
}

/** Only Meta's documented custom_data keys are forwarded from event params. */
const CUSTOM_DATA_KEYS = [
  "value",
  "currency",
  "content_ids",
  "contents",
  "content_type",
  "content_name",
  "content_category",
  "num_items",
  "predicted_ltv",
  "search_string",
  "delivery_category",
] as const;

const TEST_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function build_capi_event(
  payload: SignalPayload,
  client_ip?: string | undefined,
): { event: MetaCapiEvent; test_event_code?: string } {
  const params = payload.params ?? {};

  const user_data: Record<string, unknown> = {};
  if (payload.user_agent) user_data.client_user_agent = payload.user_agent;
  if (payload.fbp) user_data.fbp = payload.fbp;
  if (payload.fbc) user_data.fbc = payload.fbc;
  if (client_ip) user_data.client_ip_address = client_ip;
  if (typeof params.external_id === "string" && params.external_id) {
    user_data.external_id = params.external_id;
  }

  const custom_data: Record<string, unknown> = {};
  for (const key of CUSTOM_DATA_KEYS) {
    const value = params[key];
    if (value !== undefined && value !== null) custom_data[key] = value;
  }

  const event_source_url = payload.event_source_url || payload.referrer || "";

  const event: MetaCapiEvent = {
    event_name: payload.event_name,
    event_time: payload.event_time,
    event_id: payload.event_id,
    action_source: "website",
    ...(event_source_url ? { event_source_url } : {}),
    user_data,
    ...(Object.keys(custom_data).length > 0 ? { custom_data } : {}),
    ...(typeof params.order_id === "string" && params.order_id
      ? { order_id: params.order_id }
      : {}),
  };

  const test_event_code = payload.capi_test_event_code;
  const safe_test_code =
    typeof test_event_code === "string" &&
    TEST_CODE_PATTERN.test(test_event_code)
      ? test_event_code
      : undefined;

  return {
    event,
    ...(safe_test_code ? { test_event_code: safe_test_code } : {}),
  };
}

export interface CapiConfig {
  base_url?: string;
  version?: string;
}

/** Sends one event to `POST /{version}/{pixel_id}/events`. */
export async function send_to_meta(
  pixel_id: string,
  access_token: string,
  event: MetaCapiEvent,
  test_event_code?: string | undefined,
  config: CapiConfig = {},
): Promise<MetaCapiResult> {
  const base_url = config.base_url ?? "https://graph.facebook.com";
  const version = config.version ?? "v27.0";

  const url = new URL(`/${version}/${encodeURIComponent(pixel_id)}/events`, base_url);
  url.searchParams.set("access_token", access_token);

  const body = JSON.stringify({
    data: [event],
    ...(test_event_code ? { test_event_code } : {}),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    throw new CapiError("Meta CAPI request failed", error);
  } finally {
    clearTimeout(timer);
  }

  const raw: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const graph_error = (raw as { error?: { message?: unknown } } | null)?.error;
    const message =
      typeof graph_error?.message === "string" && graph_error.message
        ? graph_error.message
        : `Meta CAPI returned HTTP ${response.status}`;
    throw new CapiError(message, raw);
  }

  if (!raw || typeof raw !== "object") {
    throw new CapiError("Meta CAPI returned an invalid response", raw);
  }

  const result = raw as Record<string, unknown>;

  return {
    events_received:
      typeof result.events_received === "number" ? result.events_received : 0,
    messages: Array.isArray(result.messages)
      ? result.messages.filter((item): item is string => typeof item === "string")
      : [],
    ...(typeof result.fbtrace_id === "string"
      ? { fbtrace_id: result.fbtrace_id }
      : {}),
  };
}
