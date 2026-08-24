// Foxridge-owned, quota-free Yahoo Finance chart proxy for GitHub Pages.

export const ALLOWED_ORIGINS = new Set([
  "https://foxridge-holdings.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

const UPSTREAM_HOST = "query1.finance.yahoo.com";
const SYMBOL_PATTERN = /^[A-Z0-9.^=_-]{1,32}$/i;
const ALLOWED_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1d"]);
const ALLOWED_RANGES = new Set(["1d", "5d", "1mo"]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const UPSTREAM_TIMEOUT_MS = 6_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function corsHeaders(origin) {
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(body, status, cors = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function errorResponse(code, message, status, cors, details = {}) {
  return jsonResponse(
    { ok: false, error: { code, message, ...details } },
    status,
    cors,
    { "Cache-Control": "no-store" },
  );
}

async function fetchUpstream(upstream, options) {
  const { fetchImpl, sleepImpl, timeoutMs } = options;
  let lastFailure = {
    code: "upstream_unavailable",
    message: "Yahoo Finance is unavailable.",
    status: 502,
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(upstream, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; FoxridgeHoldingsProxy/2.0)",
          "Accept": "application/json",
        },
        cf: { cacheTtl: 30, cacheEverything: true },
      });

      if (!response.ok) {
        lastFailure = {
          code: response.status === 404 ? "symbol_not_found" : "upstream_http_error",
          message: `Yahoo Finance returned HTTP ${response.status}.`,
          status: response.status === 404 ? 404 : 502,
          upstreamStatus: response.status,
        };
        if (!RETRYABLE_STATUS.has(response.status) || attempt === 2) break;
      } else {
        let data;
        try {
          data = await response.json();
        } catch {
          lastFailure = {
            code: "invalid_upstream_json",
            message: "Yahoo Finance returned invalid JSON.",
            status: 502,
          };
          break;
        }
        if (!data?.chart || data.chart.error || !data.chart.result?.[0]) {
          lastFailure = {
            code: data?.chart?.error?.code || "invalid_upstream_response",
            message: data?.chart?.error?.description || "Yahoo Finance returned no chart data.",
            status: 502,
          };
          break;
        }
        return { ok: true, data, attempts: attempt };
      }
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      lastFailure = {
        code: timedOut ? "upstream_timeout" : "upstream_network_error",
        message: timedOut ? "Yahoo Finance timed out." : "Yahoo Finance could not be reached.",
        status: timedOut ? 504 : 502,
      };
      if (attempt === 2) break;
    } finally {
      clearTimeout(timer);
    }

    await sleepImpl(250 * attempt);
  }

  return { ok: false, ...lastFailure, attempts: 2 };
}

export async function handleRequest(request, options = {}) {
  const origin = request.headers.get("Origin") || "";
  const cors = corsHeaders(origin);
  if (!cors) {
    return errorResponse("origin_not_allowed", "This origin is not allowed.", 403, {});
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "GET") {
    return errorResponse("method_not_allowed", "Only GET requests are supported.", 405, cors);
  }

  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return jsonResponse(
      { ok: true, service: "foxridge-yahoo-proxy" },
      200,
      cors,
      { "Cache-Control": "no-store" },
    );
  }
  if (url.pathname !== "/quote") {
    return errorResponse("not_found", "Unknown Worker endpoint.", 404, cors);
  }

  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  const interval = url.searchParams.get("interval") || "1m";
  const range = url.searchParams.get("range") || "1d";
  if (!SYMBOL_PATTERN.test(symbol)) {
    return errorResponse("invalid_symbol", "A valid Yahoo Finance symbol is required.", 400, cors);
  }
  if (!ALLOWED_INTERVALS.has(interval) || !ALLOWED_RANGES.has(range)) {
    return errorResponse("invalid_query", "Unsupported interval or range.", 400, cors);
  }

  const upstream = new URL(
    `https://${UPSTREAM_HOST}/v8/finance/chart/${encodeURIComponent(symbol)}`,
  );
  upstream.searchParams.set("interval", interval);
  upstream.searchParams.set("range", range);
  upstream.searchParams.set("includePrePost", "true");

  const result = await fetchUpstream(upstream, {
    fetchImpl: options.fetchImpl || fetch,
    sleepImpl: options.sleepImpl || sleep,
    timeoutMs: options.timeoutMs || UPSTREAM_TIMEOUT_MS,
  });
  if (!result.ok) {
    return errorResponse(
      result.code,
      result.message,
      result.status,
      cors,
      { symbol, upstreamStatus: result.upstreamStatus },
    );
  }

  return jsonResponse(
    { ok: true, symbol, data: result.data },
    200,
    cors,
    {
      "Cache-Control": "public, max-age=30",
      "X-Foxridge-Upstream-Attempts": String(result.attempts),
    },
  );
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
