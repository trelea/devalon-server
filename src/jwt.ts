import { normalize_origin } from "./security.js";

/** Verifies the short-lived HMAC JWT minted by a site's backend. */

export type JwtRejectReason =
  | "malformed"
  | "signature"
  | "expired"
  | "pixel"
  | "origin"
  | "ttl";

export type JwtVerification =
  | { ok: true }
  | { ok: false; reason: JwtRejectReason };

interface hmac_algorithm {
  name: "HMAC";
  hash: "SHA-256";
}

type HmacKey = unknown;

interface subtle_hmac {
  importKey(
    format: "raw",
    keyData: ArrayBuffer | ArrayBufferView,
    algorithm: hmac_algorithm,
    extractable: false,
    keyUsages: readonly ["verify"],
  ): Promise<HmacKey>;
  verify(
    algorithm: hmac_algorithm,
    key: HmacKey,
    signature: ArrayBuffer | ArrayBufferView,
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<boolean>;
}

interface global_with_subtle {
  crypto?: { subtle?: subtle_hmac };
}

const ALGORITHM: hmac_algorithm = { name: "HMAC", hash: "SHA-256" };
const MAX_TTL_SECONDS = 300;

function decode_base64url(part: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "===".slice((part.length + 3) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function decode_json(part: string): Record<string, unknown> | undefined {
  const bytes = decode_base64url(part);
  if (!bytes) return undefined;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function reject(reason: JwtRejectReason): JwtVerification {
  return { ok: false, reason };
}

export interface JwtVerificationOptions {
  /** Extra origins (e.g. a registered production origin) allowed in dev mode. */
  allowed_origins?: string[];
}

/** Verifies signature, expiry, pixel binding and origin binding. */
export async function verify_signal_jwt(
  token: unknown,
  secret: string,
  pixel_id: string,
  request_origin: string | undefined,
  now_seconds: number = Math.floor(Date.now() / 1000),
  options: JwtVerificationOptions = {},
): Promise<JwtVerification> {
  if (typeof token !== "string" || token.length > 4096) return reject("malformed");

  const parts = token.split(".");
  if (parts.length !== 3) return reject("malformed");

  const header = decode_json(parts[0]);
  const payload = decode_json(parts[1]);
  const signature = decode_base64url(parts[2]);
  if (!header || !payload || !signature) return reject("malformed");
  if (header.alg !== "HS256" || header.typ !== "JWT") return reject("malformed");

  const subtle = (globalThis as unknown as global_with_subtle).crypto?.subtle;
  if (!subtle) return reject("malformed");

  const encoder = new TextEncoder();
  try {
    const key = await subtle.importKey(
      "raw",
      encoder.encode(secret),
      ALGORITHM,
      false,
      ["verify"],
    );
    const valid = await subtle.verify(
      ALGORITHM,
      key,
      signature,
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return reject("signature");
  } catch {
    return reject("malformed");
  }

  const { exp, iat, pixel_id: claim_pixel, origin: claim_origin } = payload;
  if (typeof exp !== "number" || typeof iat !== "number") return reject("malformed");
  if (exp - iat > MAX_TTL_SECONDS || exp - iat < 1) return reject("ttl");
  if (exp <= now_seconds) return reject("expired");
  if (iat > now_seconds + 60) return reject("expired");

  if (typeof claim_pixel !== "string" || claim_pixel !== pixel_id) return reject("pixel");

  const expected_origin = request_origin ? normalize_origin(request_origin) : undefined;
  const token_origin = typeof claim_origin === "string" ? normalize_origin(claim_origin) : undefined;
  const accepted_origins = [
    ...(expected_origin ? [expected_origin] : []),
    ...(options.allowed_origins ?? [])
      .map((origin) => normalize_origin(origin))
      .filter((origin): origin is string => Boolean(origin)),
  ];
  if (!token_origin || !accepted_origins.includes(token_origin)) {
    return reject("origin");
  }

  return { ok: true };
}
