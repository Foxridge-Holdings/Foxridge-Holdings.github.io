import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeYahooChartResult,
  parseAllSymbols,
} from "../js/parse.js";

const periods = {
  pre: { start: 100, end: 200 },
  regular: { start: 200, end: 300 },
  post: { start: 300, end: 400 },
};

function chartResult({ timestamps = [], closes = [], meta = {} } = {}) {
  return {
    meta: {
      symbol: "POOL",
      shortName: "Pool Corporation",
      chartPreviousClose: 100,
      regularMarketPrice: 101,
      regularMarketTime: 250,
      currency: "USD",
      fullExchangeName: "NYSE",
      currentTradingPeriod: periods,
      ...meta,
    },
    timestamp: timestamps,
    indicators: { quote: [{ close: closes }] },
  };
}

function workerPayload(symbol, price = 101) {
  const result = chartResult({
    timestamps: [250],
    closes: [price],
    meta: { symbol, shortName: symbol },
  });
  return { ok: true, symbol, data: { chart: { result: [result], error: null } } };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("normalizes regular, pre-market, post-market, and overnight sessions", () => {
  const regular = normalizeYahooChartResult(chartResult({
    timestamps: [150, 250],
    closes: [101, 105],
  }));
  assert.equal(regular.marketState, "REGULAR");
  assert.equal(regular.c, 105);
  assert.equal(regular.d, 5);

  const pre = normalizeYahooChartResult(chartResult({
    timestamps: [150],
    closes: [101],
  }));
  assert.equal(pre.marketState, "PRE");
  assert.equal(pre.extendedLabel, "Pre-market");

  const post = normalizeYahooChartResult(chartResult({
    timestamps: [250, 350],
    closes: [102, 103],
  }));
  assert.equal(post.marketState, "POST");
  assert.equal(post.extendedLabel, "After hours");
  assert.equal(post.d, 1);

  const overnight = normalizeYahooChartResult(
    chartResult({ timestamps: [450], closes: [104] }),
    600_000,
  );
  assert.equal(overnight.marketState, "OVERNIGHT");
  assert.equal(overnight.extendedLabel, "Overnight");
});

test("falls back to meta prices when candles are missing and rejects invalid data", () => {
  const fallback = normalizeYahooChartResult(chartResult());
  assert.equal(fallback.c, 101);
  assert.equal(normalizeYahooChartResult({}), null);
  assert.equal(normalizeYahooChartResult({ meta: {} }), null);
});

test("deduplicates symbols and returns structured all-success results", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === "/health") return json({ ok: true });
    const symbol = parsed.searchParams.get("symbol");
    return json(workerPayload(symbol));
  };

  const result = await parseAllSymbols(
    ["pool", "POOL", "6634.TWO"],
    null,
    { proxyBase: "https://worker.test", fetchImpl, sleepImpl: async () => {} },
  );

  assert.equal(result.requestedCount, 2);
  assert.equal(result.successCount, 2);
  assert.deepEqual(Object.keys(result.quotes).sort(), ["6634.TWO", "POOL"]);
  assert.deepEqual(result.failures, []);
  assert.equal(calls.filter((url) => new URL(url).pathname === "/quote").length, 2);
});

test("returns partial success without inventing failed quotes", async () => {
  let failedAttempts = 0;
  const progress = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/health") return json({ ok: true });
    const symbol = parsed.searchParams.get("symbol");
    if (symbol === "NKE") {
      failedAttempts++;
      return json({ ok: false, error: { code: "upstream_http_error", message: "Unavailable" } }, 503);
    }
    return json(workerPayload(symbol, 180));
  };

  const result = await parseAllSymbols(
    ["POOL", "NKE"],
    (entry) => progress.push(entry),
    { proxyBase: "https://worker.test", fetchImpl, sleepImpl: async () => {} },
  );

  assert.equal(result.successCount, 1);
  assert.equal(result.quotes.POOL.c, 180);
  assert.equal(result.quotes.NKE, undefined);
  assert.equal(result.failures[0].symbol, "NKE");
  assert.equal(failedAttempts, 2);
  assert.equal(progress.length, 2);
});

test("health-check failure produces total failure without quote requests", async () => {
  let quoteRequests = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/quote") quoteRequests++;
    return json({ ok: false, error: { code: "unhealthy", message: "Unavailable" } }, 503);
  };

  const result = await parseAllSymbols(
    ["POOL", "NKE"],
    null,
    { proxyBase: "https://worker.test", fetchImpl, sleepImpl: async () => {} },
  );

  assert.equal(result.successCount, 0);
  assert.equal(result.failures.length, 2);
  assert.equal(quoteRequests, 0);
});

test("missing proxy configuration fails closed without using a paid API", async () => {
  let called = false;
  const result = await parseAllSymbols(["POOL"], null, {
    proxyBase: "",
    fetchImpl: async () => {
      called = true;
      throw new Error("should not fetch");
    },
  });

  assert.equal(result.successCount, 0);
  assert.equal(result.failures[0].code, "proxy_not_configured");
  assert.equal(called, false);
});
