import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  allow_request,
  has_browser_headers,
  is_dev_origin,
  normalize_origin,
  reset_rate_limits,
} from "../security.js";

function beacon_request(headers: Record<string, string> = {}): Request {
  return new Request("https://signal.devalon.dev/123/signals", {
    method: "POST",
    headers: {
      Origin: "https://client.example",
      "Sec-Fetch-Mode": "no-cors",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Site": "cross-site",
      ...headers,
    },
  });
}

describe("normalize_origin", () => {
  it("normalizes scheme and host, dropping the trailing slash", () => {
    assert.equal(normalize_origin("https://Client.Example/"), "https://client.example");
    assert.equal(
      normalize_origin("http://localhost:3000"),
      "http://localhost:3000",
    );
  });

  it("rejects paths, queries, credentials and non-http schemes", () => {
    assert.equal(normalize_origin("https://client.example/page"), undefined);
    assert.equal(normalize_origin("https://client.example/?x=1"), undefined);
    assert.equal(normalize_origin("ftp://client.example"), undefined);
    assert.equal(normalize_origin("not a url"), undefined);
  });
});

describe("has_browser_headers", () => {
  it("accepts a real sendBeacon header set", () => {
    assert.equal(has_browser_headers(beacon_request()), true);
  });

  it("accepts keepalive fetch (cors) requests", () => {
    assert.equal(has_browser_headers(beacon_request({ "Sec-Fetch-Mode": "cors" })), true);
  });

  it("rejects plain REST clients and wrong fetch metadata", () => {
    assert.equal(has_browser_headers(new Request("https://signal.devalon.dev/x")), false);
    assert.equal(has_browser_headers(beacon_request({ "Sec-Fetch-Mode": "navigate" })), false);
    assert.equal(has_browser_headers(beacon_request({ Origin: "" })), false);
  });

  it("accepts same-site beacons too", () => {
    assert.equal(
      has_browser_headers(beacon_request({ "Sec-Fetch-Site": "same-site" })),
      true,
    );
  });
});

describe("is_dev_origin", () => {
  it("accepts loopback and private IPv4 origins on any port", () => {
    for (const origin of [
      "http://localhost:3000",
      "http://app.localhost:5173",
      "http://127.0.0.1:3000",
      "http://[::1]:3000",
      "http://10.0.0.5:3000",
      "http://172.16.2.3:8080",
      "http://172.31.255.254:3000",
      "http://192.168.1.50:3000",
      "https://localhost:3443",
    ]) {
      assert.equal(is_dev_origin(origin), true, origin);
    }
  });

  it("rejects public origins, other schemes and missing values", () => {
    for (const origin of [
      "https://ventprime.md",
      "http://example.com:3000",
      "http://172.32.0.1:3000",
      "http://192.169.0.1:3000",
      "file:///tmp/index.html",
      "not a url",
      undefined,
    ]) {
      assert.equal(is_dev_origin(origin), false, String(origin));
    }
  });
});

describe("allow_request", () => {
  it("allows up to the limit then rejects until the window resets", () => {
    reset_rate_limits();
    const key = "123:1.2.3.4";
    for (let i = 0; i < 3; i += 1) assert.equal(allow_request(key, 3, 60_000), true);
    assert.equal(allow_request(key, 3, 60_000), false);
  });

  it("tracks different pixel/IP keys independently", () => {
    reset_rate_limits();
    assert.equal(allow_request("123:1.1.1.1", 1, 60_000), true);
    assert.equal(allow_request("123:1.1.1.1", 1, 60_000), false);
    assert.equal(allow_request("123:2.2.2.2", 1, 60_000), true);
  });

  it("evicts old buckets when the map is full", () => {
    reset_rate_limits();
    for (let i = 0; i < 5_001; i += 1) allow_request(`pixel:${i}`, 1, 1);
    assert.equal(allow_request("new:key", 1, 60_000), true);
  });
});
