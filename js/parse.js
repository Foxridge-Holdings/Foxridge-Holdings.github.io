// Quota-free quote parsing through the Foxridge-owned Cloudflare Worker.
// The browser never calls Yahoo Finance directly: Yahoo does not expose the
// CORS headers required by GitHub Pages. The Worker contract is documented in
// worker/README.md and its base URL lives in js/config.js.

import { PARSE_PROXY_BASE } from "./config.js?v=20260824-worker";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 3;
const MAX_TRANSPORT_ATTEMPTS = 2;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function proxyUrl(base, path) {
  return `${String(base || "").replace(/\/+$/, "")}${path}`;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function requestProxy(path, options) {
  const { proxyBase, fetchImpl, timeoutMs, sleepImpl } = options;
  const attempts = [];
  let failure = {
    code: "proxy_unavailable",
    message: "The Parse Data proxy is unavailable.",
    status: null,
  };

  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(proxyUrl(proxyBase, path), {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
      });
      const body = await readJsonResponse(response);
      attempts.push(`worker: HTTP ${response.status}`);
      if (response.ok) {
        return { ok: true, body, status: response.status, attempts };
      }

      failure = {
        code: body?.error?.code || `http_${response.status}`,
        message: body?.error?.message || `Worker returned HTTP ${response.status}.`,
        status: response.status,
      };
      if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_TRANSPORT_ATTEMPTS) {
        break;
      }
    } catch (error) {
      const timedOut = error?.name === "AbortError";
      attempts.push(`worker: ${timedOut ? "timeout" : error?.name || "network error"}`);
      failure = {
        code: timedOut ? "timeout" : "network_error",
        message: timedOut
          ? "The Parse Data proxy timed out."
          : "The Parse Data proxy could not be reached.",
        status: null,
      };
      if (attempt === MAX_TRANSPORT_ATTEMPTS) break;
    } finally {
      clearTimeout(timer);
    }

    await sleepImpl(500 * attempt);
  }

  return { ok: false, ...failure, attempts };
}

function inWindow(window, timestamp) {
  if (!window) return false;
  const start = +window.start;
  const end = +window.end;
  return Number.isFinite(start) && Number.isFinite(end)
    && timestamp >= start && timestamp < end;
}

export function normalizeYahooChartResult(result, nowMs = Date.now()) {
  if (!result?.meta) return null;
  const meta = result.meta;
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const period = meta.currentTradingPeriod || {};
  const previousClose = +(meta.chartPreviousClose ?? meta.previousClose);

  let latestIndex = -1;
  for (let index = timestamps.length - 1; index >= 0; index--) {
    if (Number.isFinite(closes[index])) {
      latestIndex = index;
      break;
    }
  }

  let price;
  let latestTimestamp;
  if (latestIndex >= 0) {
    price = +closes[latestIndex];
    latestTimestamp = +timestamps[latestIndex];
  } else {
    price = +meta.regularMarketPrice;
    latestTimestamp = +meta.regularMarketTime || 0;
    if (!Number.isFinite(price) && Number.isFinite(previousClose)) {
      price = previousClose;
    }
  }
  if (!Number.isFinite(price)) return null;

  let marketState = null;
  let extendedLabel = null;
  let baseline = previousClose;

  if (inWindow(period.pre, latestTimestamp)) {
    marketState = "PRE";
    extendedLabel = "Pre-market";
  } else if (inWindow(period.regular, latestTimestamp)) {
    marketState = "REGULAR";
  } else if (inWindow(period.post, latestTimestamp)) {
    marketState = "POST";
    extendedLabel = "After hours";
    const regularEnd = +period.regular?.end;
    if (Number.isFinite(regularEnd)) {
      for (let index = timestamps.length - 1; index >= 0; index--) {
        if (Number.isFinite(closes[index]) && +timestamps[index] < regularEnd) {
          baseline = +closes[index];
          break;
        }
      }
    }
  } else {
    const postEnd = +period.post?.end;
    const preStart = +period.pre?.start;
    const nowSeconds = nowMs / 1000;
    if (Number.isFinite(postEnd) && nowSeconds > postEnd) {
      marketState = "OVERNIGHT";
      extendedLabel = "Overnight";
    } else if (Number.isFinite(preStart) && nowSeconds < preStart) {
      marketState = "CLOSED";
    }
  }

  const difference = Number.isFinite(baseline) ? price - baseline : 0;
  const percentage = Number.isFinite(baseline) && baseline !== 0
    ? (difference / baseline) * 100
    : 0;

  return {
    c: price,
    d: difference,
    dp: percentage,
    pc: Number.isFinite(previousClose) ? previousClose : NaN,
    o: NaN,
    h: NaN,
    l: NaN,
    currency: meta.currency || null,
    name: meta.shortName || meta.longName || meta.symbol || null,
    exchange: meta.fullExchangeName || meta.exchangeName || null,
    fiftyTwoWeekHigh: NaN,
    fiftyTwoWeekLow: NaN,
    volume: NaN,
    averageVolume: NaN,
    marketCap: NaN,
    peTTM: NaN,
    eps: NaN,
    divYield: NaN,
    marketState,
    extendedLabel,
  };
}

function failureForSymbol(symbol, requestFailure) {
  return {
    symbol,
    code: requestFailure.code || "invalid_response",
    message: requestFailure.message || "No valid Yahoo Finance quote was returned.",
    status: requestFailure.status ?? null,
    attempts: requestFailure.attempts || [],
  };
}

async function fetchYahooChart(symbol, options) {
  const request = await requestProxy(
    `/quote?symbol=${encodeURIComponent(symbol)}&interval=1m&range=1d`,
    options,
  );
  if (!request.ok) return { quote: null, failure: failureForSymbol(symbol, request) };

  const chartResult = request.body?.data?.chart?.result?.[0];
  const quote = normalizeYahooChartResult(chartResult);
  if (!request.body?.ok || !quote) {
    return {
      quote: null,
      failure: failureForSymbol(symbol, {
        code: "invalid_response",
        message: "The Worker returned an invalid Yahoo Finance response.",
        status: request.status,
        attempts: request.attempts,
      }),
    };
  }

  quote.__source = "foxridge-worker";
  return { quote, failure: null, attempts: request.attempts };
}

export async function parseAllSymbols(symbols, onProgress, options = {}) {
  const uniqueSymbols = [...new Set(
    (symbols || [])
      .map((symbol) => String(symbol || "").trim().toUpperCase())
      .filter(Boolean),
  )];
  const requestedCount = uniqueSymbols.length;
  if (!requestedCount) {
    return { quotes: {}, failures: [], requestedCount: 0, successCount: 0 };
  }

  const proxyBase = options.proxyBase ?? PARSE_PROXY_BASE;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const sleepImpl = options.sleepImpl || sleep;
  const concurrency = Math.max(
    1,
    Math.min(options.concurrency || DEFAULT_CONCURRENCY, requestedCount),
  );
  const requestOptions = { proxyBase, fetchImpl, timeoutMs, sleepImpl };

  if (!proxyBase) {
    const failures = uniqueSymbols.map((symbol) => failureForSymbol(symbol, {
      code: "proxy_not_configured",
      message: "The Parse Data proxy has not been configured.",
    }));
    return { quotes: {}, failures, requestedCount, successCount: 0 };
  }

  if (options.checkHealth !== false) {
    const health = await requestProxy("/health", requestOptions);
    if (!health.ok || health.body?.ok !== true) {
      const failures = uniqueSymbols.map((symbol) => failureForSymbol(symbol, {
        code: health.code || "proxy_unavailable",
        message: health.message || "The Parse Data proxy health check failed.",
        status: health.status,
        attempts: health.attempts,
      }));
      failures.forEach((failure, index) => onProgress?.({
        done: index + 1,
        total: requestedCount,
        sym: failure.symbol,
        ok: false,
        source: null,
        attempts: failure.attempts,
      }));
      return { quotes: {}, failures, requestedCount, successCount: 0 };
    }
  }

  const quotes = {};
  const failures = [];
  const queue = [...uniqueSymbols];
  let done = 0;

  async function runWorker() {
    while (queue.length) {
      const symbol = queue.shift();
      const result = await fetchYahooChart(symbol, requestOptions);
      if (result.quote) {
        quotes[symbol] = result.quote;
        console.log(`[parse] ${symbol} ok via foxridge-worker`);
      } else {
        failures.push(result.failure);
        console.warn(`[parse] ${symbol} failed:`, result.failure.attempts.join(" | "));
      }
      done++;
      onProgress?.({
        done,
        total: requestedCount,
        sym: symbol,
        ok: !!result.quote,
        source: result.quote ? "foxridge-worker" : null,
        attempts: result.failure?.attempts || result.attempts || [],
      });
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  const order = new Map(uniqueSymbols.map((symbol, index) => [symbol, index]));
  failures.sort((a, b) => order.get(a.symbol) - order.get(b.symbol));
  return {
    quotes,
    failures,
    requestedCount,
    successCount: Object.keys(quotes).length,
  };
}
