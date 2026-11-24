import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";

import { build_capi_event } from "../capi.js";
import {
  merge_geo_user_data,
  read_geo,
  resolve_external_geo,
} from "../geo.js";

const sha = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function fake_request(cf: unknown): Request {
  return { cf } as unknown as Request;
}

describe("read_geo", () => {
  it("reads the four geo fields from request.cf", () => {
    assert.deepEqual(
      read_geo(
        fake_request({
          colo: "DFW",
          city: "Austin",
          regionCode: "TX",
          postalCode: "78701",
          country: "US",
        }),
      ),
      { city: "Austin", regionCode: "TX", postalCode: "78701", country: "US" },
    );
  });

  it("skips null, empty and missing cf data", () => {
    assert.deepEqual(
      read_geo(fake_request({ city: null, country: "", regionCode: "  " })),
      {},
    );
    assert.deepEqual(read_geo(fake_request(null)), {});
    assert.deepEqual(read_geo(fake_request(undefined)), {});
  });
});

describe("merge_geo_user_data", () => {
  it("fills only missing fields and keeps caller values", () => {
    const merged = merge_geo_user_data(
      { email: "user@example.com", country: "MD" },
      { city: "Austin", regionCode: "TX", postalCode: "78701", country: "US" },
    );

    assert.deepEqual(merged, {
      email: "user@example.com",
      country: "MD",
      ct: "Austin",
      st: "TX",
      zp: "78701",
    });
  });

  it("never overwrites an already-hashed caller value", () => {
    const hash = "a".repeat(64);
    const merged = merge_geo_user_data({ ct: hash }, { city: "Austin" });
    assert.equal(merged?.ct, hash);
  });

  it("returns undefined when there is nothing to add", () => {
    assert.equal(merge_geo_user_data(undefined, {}), undefined);
  });

  it("feeds inferred geo through the standard CAPI normalization and hashing", async () => {
    const merged = merge_geo_user_data(undefined, {
      city: "New York",
      regionCode: "NY",
      postalCode: "10001-1234",
      country: "US",
    });

    const { event } = await build_capi_event({
      event_name: "Lead",
      event_id: "geo-1",
      params: {},
      event_time: 1795538469,
      user_data: merged,
    });

    assert.deepEqual(event.user_data.ct, [sha("newyork")]);
    assert.deepEqual(event.user_data.st, [sha("ny")]);
    assert.deepEqual(event.user_data.zp, [sha("100011234")]);
    assert.deepEqual(event.user_data.country, [sha("us")]);
  });
});

describe("resolve_external_geo", () => {
  const original_fetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = original_fetch;
  });

  function install_fetch(results: unknown[]): string[] {
    const calls: string[] = [];
    let index = 0;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      const result = results[Math.min(index++, results.length - 1)];
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result), { status: 200 });
    }) as typeof fetch;
    return calls;
  }

  it("uses the primary provider and stops when all fields are present", async () => {
    const calls = install_fetch([
      {
        success: true,
        city: "Austin",
        region_code: "TX",
        postal: "78701",
        country_code: "US",
      },
    ]);

    const geo = await resolve_external_geo("11.1.1.1", {});

    assert.deepEqual(geo, {
      city: "Austin",
      regionCode: "TX",
      postalCode: "78701",
      country: "US",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/ipwho\.is\/11\.1\.1\.1/);
  });

  it("falls back to the secondary provider for missing fields", async () => {
    const calls = install_fetch([
      { success: true, city: "Austin" },
      {
        city: "ShouldNotWin",
        region_code: "TX",
        postal: "78701",
        country_code: "US",
      },
    ]);

    const geo = await resolve_external_geo("12.1.1.1", {});

    assert.equal(geo.city, "Austin");
    assert.equal(geo.regionCode, "TX");
    assert.equal(geo.postalCode, "78701");
    assert.equal(geo.country, "US");
    assert.equal(calls.length, 2);
    assert.match(calls[1], /ipapi\.co\/12\.1\.1\.1/);
  });

  it("caches results per IP so repeated events make no external calls", async () => {
    const calls = install_fetch([
      {
        success: true,
        city: "Austin",
        region_code: "TX",
        postal: "78701",
        country_code: "US",
      },
    ]);

    await resolve_external_geo("13.1.1.1", {});
    await resolve_external_geo("13.1.1.1", {});

    assert.equal(calls.length, 1);
  });

  it("returns empty geo when the providers fail", async () => {
    install_fetch([new Error("timeout")]);
    const geo = await resolve_external_geo("14.1.1.1", {});
    assert.deepEqual(geo, {});
  });

  it("skips providers disabled with an empty URL", async () => {
    const calls = install_fetch([
      { city: "Austin", region_code: "TX", postal: "78701", country_code: "US" },
    ]);

    const geo = await resolve_external_geo("15.1.1.1", {
      GEO_LOOKUP_URL_PRIMARY: "",
      GEO_LOOKUP_URL_SECONDARY: "",
    });

    assert.deepEqual(geo, {});
    assert.equal(calls.length, 0);
  });

  it("appends the optional provider key", async () => {
    const calls = install_fetch([
      {
        success: true,
        city: "Austin",
        region_code: "TX",
        postal: "78701",
        country_code: "US",
      },
    ]);

    await resolve_external_geo("16.1.1.1", { GEO_LOOKUP_KEY: "secret" });
    assert.match(calls[0], /key=secret/);
  });
});
