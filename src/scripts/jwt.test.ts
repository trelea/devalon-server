import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { verify_signal_jwt } from "../jwt.js";

const SECRET = "a-very-long-shared-secret-value";
const PIXEL_ID = "1683475309995701";
const ORIGIN = "https://ventprime.md";
const NOW = 1_795_538_469;

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const unsigned = `${header}.${body}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function valid_payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pixel_id: PIXEL_ID,
    origin: ORIGIN,
    iat: NOW - 10,
    exp: NOW + 290,
    jti: "abc123",
    ...overrides,
  };
}

describe("verify_signal_jwt", () => {
  it("accepts a valid token", async () => {
    const result = await verify_signal_jwt(
      sign(valid_payload()),
      SECRET,
      PIXEL_ID,
      ORIGIN,
      NOW,
    );
    assert.deepEqual(result, { ok: true });
  });

  it("accepts an origin with a trailing slash or different case", async () => {
    const result = await verify_signal_jwt(
      sign(valid_payload({ origin: "HTTPS://VentPrime.md/" })),
      SECRET,
      PIXEL_ID,
      ORIGIN,
      NOW,
    );
    assert.deepEqual(result, { ok: true });
  });

  it("rejects a bad signature", async () => {
    const token = sign(valid_payload(), "a-different-long-secret-value");
    const result = await verify_signal_jwt(token, SECRET, PIXEL_ID, ORIGIN, NOW);
    assert.deepEqual(result, { ok: false, reason: "signature" });
  });

  it("rejects a tampered payload", async () => {
    const parts = sign(valid_payload()).split(".");
    const tampered = Buffer.from(
      JSON.stringify(valid_payload({ pixel_id: "999" })),
    ).toString("base64url");
    const result = await verify_signal_jwt(
      `${parts[0]}.${tampered}.${parts[2]}`,
      SECRET,
      PIXEL_ID,
      ORIGIN,
      NOW,
    );
    assert.deepEqual(result, { ok: false, reason: "signature" });
  });

  it("rejects expired, wrong-pixel and wrong-origin tokens", async () => {
    assert.deepEqual(
      await verify_signal_jwt(
        sign(valid_payload({ exp: NOW - 1 })),
        SECRET,
        PIXEL_ID,
        ORIGIN,
        NOW,
      ),
      { ok: false, reason: "expired" },
    );
    assert.deepEqual(
      await verify_signal_jwt(sign(valid_payload()), SECRET, "999", ORIGIN, NOW),
      { ok: false, reason: "pixel" },
    );
    assert.deepEqual(
      await verify_signal_jwt(
        sign(valid_payload()),
        SECRET,
        PIXEL_ID,
        "https://other.example",
        NOW,
      ),
      { ok: false, reason: "origin" },
    );
  });

  it("rejects tokens with a lifetime over five minutes", async () => {
    const result = await verify_signal_jwt(
      sign(valid_payload({ exp: NOW + 301 })),
      SECRET,
      PIXEL_ID,
      ORIGIN,
      NOW,
    );
    assert.deepEqual(result, { ok: false, reason: "ttl" });
  });

  it("rejects malformed tokens", async () => {
    assert.deepEqual(
      await verify_signal_jwt("not-a-jwt", SECRET, PIXEL_ID, ORIGIN, NOW),
      { ok: false, reason: "malformed" },
    );
    assert.deepEqual(
      await verify_signal_jwt(undefined, SECRET, PIXEL_ID, ORIGIN, NOW),
      { ok: false, reason: "malformed" },
    );
  });
});
