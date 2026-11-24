/**
 * Conversion of the browser envelope produced by `@devalon.dev/credits/signals`
 * into a Meta Conversions API request, and delivery to the Graph API.
 *
 * The access token never leaves this module: it is read from the database by
 * the route and used only as a query parameter on the outbound request.
 */

export interface SignalUserData {
  email?: string;
  phone?: string;
  externalId?: string;
  leadId?: string;
}

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
  /** Raw PII from the app; normalized and hashed here before Meta. */
  user_data?: SignalUserData;
  opt_out?: boolean;
  data_processing_options?: string[];
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
  opt_out?: boolean;
  data_processing_options?: string[];
}

export interface MetaCapiResult {
  events_received: number;
  messages: string[];
  fbtrace_id?: string;
}

export class CapiError extends Error {
  readonly details: unknown;
  readonly status?: number;

  constructor(message: string, details?: unknown, status?: number) {
    super(message);
    this.name = "CapiError";
    this.details = details;
    this.status = status;
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
  "status",
  "lead_event_source",
  "custom_properties",
] as const;

const TEST_CODE_PATTERN = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hash_field(
  value: string | undefined,
  normalize: (value: string) => string,
): Promise<string | undefined> {
  if (!value) return undefined;

  const clean = normalize(value);
  if (!clean) return undefined;

  // Already hashed by the client (`hash_meta_user_data()`): do not hash twice.
  return SHA256_HEX.test(clean) ? clean : await sha256(clean);
}

function normalize_email(value: string): string {
  return value.trim().toLowerCase();
}

/** Keep the leading + and digits only. Callers should prefer E.164 numbers. */
function normalize_phone(value: string): string {
  return value.trim().replace(/[^\d+]/g, "");
}

/**
 * Builds one Meta server event. PII is hashed here, at the boundary to Meta;
 * fbp/fbc/IP/UA are deliberately left raw as Meta requires.
 */
export async function build_capi_event(
  payload: SignalPayload,
  client_ip?: string | undefined,
): Promise<{ event: MetaCapiEvent; test_event_code?: string }> {
  const params = payload.params ?? {};
  const raw_user_data = payload.user_data ?? {};

  const [email, phone, external_id, lead_id] = await Promise.all([
    hash_field(raw_user_data.email, normalize_email),
    hash_field(raw_user_data.phone, normalize_phone),
    hash_field(
      raw_user_data.externalId ??
        (typeof params.external_id === "string" ? params.external_id : undefined),
      (value) => value.trim(),
    ),
    hash_field(raw_user_data.leadId, (value) => value.trim()),
  ]);

  const user_data: Record<string, unknown> = {
    ...(email ? { em: [email] } : {}),
    ...(phone ? { ph: [phone] } : {}),
    ...(external_id ? { external_id } : {}),
    ...(lead_id ? { lead_id } : {}),
  };
  if (payload.user_agent) user_data.client_user_agent = payload.user_agent;
  if (payload.fbp) user_data.fbp = payload.fbp;
  if (payload.fbc) user_data.fbc = payload.fbc;
  if (client_ip) user_data.client_ip_address = client_ip;

  const custom_data: Record<string, unknown> = {};
  for (const key of CUSTOM_DATA_KEYS) {
    const value = params[key];
    if (value === undefined || value === null) continue;

    // Meta expects custom_properties as a JSON string, not a nested object.
    custom_data[key] =
      key === "custom_properties" && typeof value === "object"
        ? JSON.stringify(value)
        : value;
  }

  const event_source_url = payload.event_source_url || payload.referrer || "";
  const processing_options = Array.isArray(payload.data_processing_options)
    ? payload.data_processing_options.filter(
        (item): item is string => typeof item === "string",
      )
    : [];

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
    ...(typeof payload.opt_out === "boolean" ? { opt_out: payload.opt_out } : {}),
    ...(processing_options.length > 0
      ? { data_processing_options: processing_options }
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
    throw new CapiError(message, raw, response.status);
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
