/** Abuse filters for the public signals endpoint. */

/** Normalizes an admin-registered origin to `scheme://host[:port]`. */
export function normalize_origin(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      return undefined;
    }
    return `${url.protocol}//${url.host.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

/**
 * `sendBeacon` sends these browser-controlled headers; plain HTTP clients do
 * not. A client can forge them, so this filters casual abuse rather than
 * providing authentication.
 */
export function has_browser_headers(req: Request): boolean {
  const origin = req.headers.get("origin");
  const mode = req.headers.get("sec-fetch-mode");
  const dest = req.headers.get("sec-fetch-dest");
  const site = req.headers.get("sec-fetch-site");

  return (
    Boolean(origin) &&
    mode === "no-cors" &&
    dest === "empty" &&
    (site === "cross-site" || site === "same-site")
  );
}

interface RateBucket {
  count: number;
  reset_at: number;
}

const buckets = new Map<string, RateBucket>();
const MAX_BUCKETS = 5_000;
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

/** Isolate-local rate limit. Returns false when the request should be rejected. */
export function allow_request(
  key: string,
  limit = DEFAULT_LIMIT,
  window_ms = DEFAULT_WINDOW_MS,
): boolean {
  const now = Date.now();
  const current = buckets.get(key);

  if (!current || current.reset_at <= now) {
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    buckets.set(key, { count: 1, reset_at: now + window_ms });
    return true;
  }

  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

/** Test helper — clears all in-memory rate-limit buckets. */
export function reset_rate_limits(): void {
  buckets.clear();
}
