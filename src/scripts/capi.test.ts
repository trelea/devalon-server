import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { build_capi_event, type SignalPayload } from "../capi.js";

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function payload(
  user_data: Record<string, string>,
  extra: Partial<SignalPayload> = {},
): SignalPayload {
  return {
    event_name: "Lead",
    event_id: "id-1",
    params: {},
    event_time: 1795538469,
    user_data,
    ...extra,
  };
}

describe("build_capi_event user_data", () => {
  it("normalizes and hashes names and phone, but sends lead_id verbatim", async () => {
    const { event } = await build_capi_event(
      payload({
        email: " User@Example.COM ",
        phone: "+373 69 123-456",
        firstName: "Mary",
        lastName: "Valéry",
        leadId: "lead-9",
      }),
    );

    assert.deepEqual(event.user_data.em, [sha("user@example.com")]);
    assert.deepEqual(event.user_data.ph, [sha("37369123456")]);
    assert.deepEqual(event.user_data.fn, [sha("mary")]);
    assert.deepEqual(event.user_data.ln, [sha("valéry")]);
    assert.equal(event.user_data.lead_id, "lead-9");
  });

  it("normalizes ge/db/ct/st/zp/country and skips invalid values", async () => {
    const { event } = await build_capi_event(
      payload({
        ge: "F",
        db: "2/16/1997",
        ct: "New York",
        st: "CA",
        zp: "94025-1234",
        country: "US",
      }),
    );

    assert.deepEqual(event.user_data.ge, [sha("f")]);
    assert.equal(event.user_data.db, undefined);
    assert.deepEqual(event.user_data.ct, [sha("newyork")]);
    assert.deepEqual(event.user_data.st, [sha("ca")]);
    assert.deepEqual(event.user_data.zp, [sha("940251234")]);
    assert.deepEqual(event.user_data.country, [sha("us")]);

    const valid = await build_capi_event(payload({ db: "19970216" }));
    assert.deepEqual(valid.event.user_data.db, [sha("19970216")]);
  });

  it("passes pre-hashed values through without hashing twice", async () => {
    const hash = sha("mary");
    const { event } = await build_capi_event(
      payload({ firstName: `${hash}\n` }),
    );
    assert.deepEqual(event.user_data.fn, [hash]);
  });

  it("keeps fbp, fbc, user agent and IP raw", async () => {
    const { event } = await build_capi_event(
      payload(
        {},
        {
          fbp: "fb.1.abc",
          fbc: "fb.1.xyz",
          user_agent: "test-ua",
        },
      ),
      "1.2.3.4",
    );

    assert.equal(event.user_data.fbp, "fb.1.abc");
    assert.equal(event.user_data.fbc, "fb.1.xyz");
    assert.equal(event.user_data.client_user_agent, "test-ua");
    assert.equal(event.user_data.client_ip_address, "1.2.3.4");
  });

  it("accepts uppercase pre-hashed values and canonicalizes to lowercase", async () => {
    const hash = sha("mary").toUpperCase();
    const { event } = await build_capi_event(payload({ firstName: hash }));
    assert.deepEqual(event.user_data.fn, [sha("mary")]);
  });

  it("hashes case-sensitive externalId without lowercasing it", async () => {
    const { event } = await build_capi_event(payload({ externalId: "ABC123" }));
    assert.equal(event.user_data.external_id, sha("ABC123"));
    assert.notEqual(event.user_data.external_id, sha("abc123"));
  });

  it("accepts a single name field as firstName", async () => {
    const { event } = await build_capi_event(payload({ name: "Marius" }));
    assert.deepEqual(event.user_data.fn, [sha("marius")]);
    assert.equal(event.user_data.ln, undefined);
  });
});
