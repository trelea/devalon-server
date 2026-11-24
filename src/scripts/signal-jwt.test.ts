import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { read_signal_jwt } from "../signal-jwt.js";

function request(headers: Record<string, string> = {}) {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return {
    req: {
      header: (name: string) => normalized[name.toLowerCase()],
    },
  };
}

describe("read_signal_jwt", () => {
  it("prefers the bearer header", () => {
    assert.deepEqual(
      read_signal_jwt(request({ Authorization: "Bearer header.token" }), {
        jwt: "body.token",
      }),
      { token: "header.token", from_body: false },
    );
  });

  it("accepts a case-insensitive scheme", () => {
    assert.deepEqual(
      read_signal_jwt(request({ authorization: "bearer header.token" }), {}),
      { token: "header.token", from_body: false },
    );
  });

  it("falls back to the envelope only for legacy clients", () => {
    assert.deepEqual(read_signal_jwt(request(), { jwt: "body.token" }), {
      token: "body.token",
      from_body: true,
    });
    assert.deepEqual(read_signal_jwt(request(), { jwt: "" }), {
      token: "",
      from_body: true,
    });
  });

  it("rejects missing or malformed headers without falling back", () => {
    assert.deepEqual(
      read_signal_jwt(request({ Authorization: "Basic abc" }), {
        jwt: "body.token",
      }),
      { token: undefined, from_body: false },
    );
    assert.deepEqual(read_signal_jwt(request(), { event_name: "Lead" }), {
      token: undefined,
      from_body: false,
    });
    assert.deepEqual(read_signal_jwt(request(), undefined), {
      token: undefined,
      from_body: false,
    });
  });
});
