import type { SignalUserData } from "./capi.js";

/**
 * IP-geolocation fields Cloudflare attaches to the incoming request. All are
 * available on every Workers plan via `request.cf` — no external lookup is
 * needed when these are present.
 */
export interface IncomingRequestGeo {
  city?: string | undefined;
  regionCode?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
}

/** Optional provider configuration. Both providers are on by default. */
export interface GeoLookupEnv {
  GEO_LOOKUP_URL_PRIMARY?: string | undefined;
  GEO_LOOKUP_URL_SECONDARY?: string | undefined;
  GEO_LOOKUP_KEY?: string | undefined;
}

interface CfGeoProperties {
  city?: string | null;
  regionCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

const DEFAULT_PRIMARY =
  "https://ipwho.is/{ip}?fields=city,region_code,postal,country_code";
const DEFAULT_SECONDARY = "https://ipapi.co/{ip}/json/";
const LOOKUP_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 16 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const EMPTY_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1_000;

interface CacheEntry {
  geo: IncomingRequestGeo;
  expires: number;
}

const geo_cache = new Map<string, CacheEntry>();

function non_empty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Reads geo fields from a request. Returns only values Cloudflare supplied. */
export function read_geo(request: Request): IncomingRequestGeo {
  const cf = (request as unknown as { cf?: CfGeoProperties | null }).cf;
  if (!cf) return {};

  const geo: IncomingRequestGeo = {};
  const city = non_empty(cf.city);
  const regionCode = non_empty(cf.regionCode);
  const postalCode = non_empty(cf.postalCode);
  const country = non_empty(cf.country);

  if (city) geo.city = city;
  if (regionCode) geo.regionCode = regionCode;
  if (postalCode) geo.postalCode = postalCode;
  if (country) geo.country = country;

  return geo;
}

/**
 * Fills missing geo fields from the request. Caller-supplied values always win,
 * including already-hashed 64-character values, which must never be replaced.
 */
export function merge_geo_user_data(
  caller: SignalUserData | undefined,
  geo: IncomingRequestGeo,
): SignalUserData | undefined {
  const merged: SignalUserData = { ...(caller ?? {}) };

  if (!merged.ct && geo.city) merged.ct = geo.city;
  if (!merged.st && geo.regionCode) merged.st = geo.regionCode;
  if (!merged.zp && geo.postalCode) merged.zp = geo.postalCode;
  if (!merged.country && geo.country) merged.country = geo.country;

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function has_all_geo(geo: IncomingRequestGeo): boolean {
  return Boolean(geo.city && geo.regionCode && geo.postalCode && geo.country);
}

function text_field(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Both providers use the same four field names. */
function parse_provider_response(raw: unknown): IncomingRequestGeo {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const data = raw as Record<string, unknown>;
  if (data.success === false || data.error === true) return {};

  const geo: IncomingRequestGeo = {};
  const city = text_field(data, "city");
  const regionCode = text_field(data, "region_code");
  const postalCode = text_field(data, "postal");
  const country = text_field(data, "country_code") ?? text_field(data, "country");

  if (city) geo.city = city;
  if (regionCode) geo.regionCode = regionCode;
  if (postalCode) geo.postalCode = postalCode;
  if (country) geo.country = country;

  return geo;
}

async function fetch_provider(
  template: string,
  ip: string,
  key: string | undefined,
): Promise<IncomingRequestGeo> {
  try {
    const url = new URL(template.replace("{ip}", encodeURIComponent(ip)));
    if (url.protocol !== "https:") return {};
    if (key) url.searchParams.set("key", key);

    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return {};

    const body = await response.text();
    if (body.length > MAX_RESPONSE_BYTES) return {};

    return parse_provider_response(JSON.parse(body));
  } catch {
    // Timeouts, rate limits and malformed responses all degrade to no geo.
    return {};
  }
}

function read_cache(ip: string): IncomingRequestGeo | undefined {
  const entry = geo_cache.get(ip);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    geo_cache.delete(ip);
    return undefined;
  }
  return entry.geo;
}

function write_cache(ip: string, geo: IncomingRequestGeo): void {
  if (geo_cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = geo_cache.keys().next().value;
    if (oldest !== undefined) geo_cache.delete(oldest);
  }
  const ttl = Object.keys(geo).length > 0 ? CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
  geo_cache.set(ip, { geo, expires: Date.now() + ttl });
}

/**
 * Fallback chain for fields Cloudflare did not supply: ipwho.is first, then
 * ipapi.co for any remaining gaps. First source wins. Results are cached per IP
 * so repeated events never spend the providers' rate limit twice.
 */
export async function resolve_external_geo(
  ip: string,
  env: GeoLookupEnv,
): Promise<IncomingRequestGeo> {
  if (!ip) return {};

  const cached = read_cache(ip);
  if (cached) return cached;

  const templates = [
    env.GEO_LOOKUP_URL_PRIMARY ?? DEFAULT_PRIMARY,
    env.GEO_LOOKUP_URL_SECONDARY ?? DEFAULT_SECONDARY,
  ].filter((template) => typeof template === "string" && template.trim().length > 0);

  const merged: IncomingRequestGeo = {};
  for (const template of templates) {
    const found = await fetch_provider(template, ip, env.GEO_LOOKUP_KEY);
    if (!merged.city && found.city) merged.city = found.city;
    if (!merged.regionCode && found.regionCode) merged.regionCode = found.regionCode;
    if (!merged.postalCode && found.postalCode) merged.postalCode = found.postalCode;
    if (!merged.country && found.country) merged.country = found.country;
    if (has_all_geo(merged)) break;
  }

  write_cache(ip, merged);
  return merged;
}
