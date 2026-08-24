import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest } from "./yahoo-proxy.js";

const LIVE_ORIGIN = "https://foxridge-holdings.github.io";

function request(path, init = {}) {
  const headers = new Headers(init.headers || {});
  if (init.withOrigin !== false) headers.set("Origin", LIVE_ORIGIN);
  return new Request(`https://worker.test${path}`, { ...init, headers });
}

function yahooResponse(symbol = "POOL") {
  return {
    chart: {
      result: [{
        meta: { symbol, chartPreviousClose: 100, regularMarketPrice: 101 },
        timestamp: [1],
        indicators: { quote: [{ close: [101] }] },
      }],
      error: null,
    },
  };
}

test("health endpoint supports strict CORS and command-line requests", async () => {
  const browserResponse = await handleRequest(request("/health"));
  assert.equal(browserResponse.status, 200);
  assert.equal(browserResponse.headers.get("Access-Control-Allow-Origin"), LIVE_ORIGIN);
  assert.equal((await browserResponse.json()).ok, true);

  const cliResponse = await handleRequest(request("/health", { withOrigin: false }));
  assert.equal(cliResponse.status, 200);
  assert.equal(cliResponse.headers.get("Access-Control-Allow-Origin"), null);
});

test("rejects unknown origins, methods, endpoints, symbols, and query values", async () => {
  const badOrigin = await handleRequest(new Request("https://worker.test/health", {
    headers: { Origin: "https://example.com" },
  }));
  assert.equal(badOrigin.status, 403);

  assert.equal((await handleRequest(request("/health", { method: "POST" }))).status, 405);
  assert.equal((await handleRequest(request("/missing"))).status, 404);
  assert.equal((await handleRequest(request("/quote?symbol=../../bad"))).status, 400);
  assert.equal((await handleRequest(request("/quote?symbol=POOL&range=10y"))).status, 400);
});

test("handles CORS preflight", async () => {
  const response = await handleRequest(request("/quote", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");
});

test("returns validated Yahoo data with cache headers", async () => {
  let upstreamUrl;
  const response = await handleRequest(
    request("/quote?symbol=pool&interval=1m&range=1d"),
    {
      fetchImpl: async (url) => {
        upstreamUrl = new URL(url);
        return new Response(JSON.stringify(yahooResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      sleepImpl: async () => {},
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "public, max-age=30");
  assert.equal(response.headers.get("X-Foxridge-Upstream-Attempts"), "1");
  assert.equal(upstreamUrl.pathname.endsWith("/POOL"), true);
  assert.equal(upstreamUrl.searchParams.get("includePrePost"), "true");
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.symbol, "POOL");
});

test("retries a transient Yahoo error once", async () => {
  let attempts = 0;
  const response = await handleRequest(request("/quote?symbol=POOL"), {
    fetchImpl: async () => {
      attempts++;
      if (attempts === 1) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify(yahooResponse()), { status: 200 });
    },
    sleepImpl: async () => {},
  });

  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.equal(response.headers.get("X-Foxridge-Upstream-Attempts"), "2");
});

test("returns a structured timeout error", async () => {
  const response = await handleRequest(request("/quote?symbol=POOL"), {
    timeoutMs: 1,
    sleepImpl: async () => {},
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        reject(new DOMException("Timed out", "AbortError"));
      }, { once: true });
    }),
  });

  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "upstream_timeout");
});

test("returns structured Yahoo response errors", async () => {
  const response = await handleRequest(request("/quote?symbol=POOL"), {
    fetchImpl: async () => new Response(JSON.stringify({
      chart: { result: null, error: { code: "Not Found", description: "No data" } },
    }), { status: 200 }),
    sleepImpl: async () => {},
  });

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, "Not Found");
});
