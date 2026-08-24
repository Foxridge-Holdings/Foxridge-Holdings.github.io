import { loadMonitored } from "./csv.js";
import { getQuotesBatch } from "./api.js";
import { fmtNative, fmtSignedNative, fmtSignedPercent, fmtRelativeTime } from "./format.js";
import { thresholdMetrics, sortByThreshold } from "./monitor-model.js";
import { parseAllSymbols } from "./parse.js?v=20260824-worker";
import { loadSnapshot } from "./snapshot.js";

const EXTERNAL_SVG = `<svg class="link-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true"><path d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.59 5H14V3z" fill="currentColor"/><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" fill="currentColor"/></svg>`;

const state = {
  rows: [],
  updatedAt: null,
};

const $ = (id) => document.getElementById(id);

function detailUrl(symbol) {
  const query = new URLSearchParams({ symbol, mode: "monitoring" });
  return `stock.html?${query.toString()}`;
}

function inferLogoUrl(symbol) {
  const base = symbol.split(".")[0].toUpperCase();
  if (!base) return null;
  if (!symbol.includes(".")) {
    return `https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/${encodeURIComponent(base)}.png`;
  }
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(base)}.png`;
}

function logoEl(symbol, profile) {
  const wrap = document.createElement("div");
  wrap.className = "logo";
  const url = profile?.logo || inferLogoUrl(symbol);
  if (!url) {
    wrap.textContent = symbol.charAt(0);
    return wrap;
  }

  const img = document.createElement("img");
  img.src = url;
  img.alt = `${symbol} logo`;
  img.loading = "lazy";
  img.onerror = () => {
    wrap.textContent = symbol.charAt(0);
    img.remove();
  };
  wrap.appendChild(img);
  return wrap;
}

function currencyFor(row) {
  return row.quote?.currency || row.monitor.currency || "USD";
}

function positionText(metrics, currency) {
  if (!metrics.available) return "Waiting for price data";
  const direction = metrics.difference <= 0 ? "below threshold" : "above threshold";
  return `${fmtSignedNative(metrics.difference, currency)} (${fmtSignedPercent(metrics.percent)}) ${direction}`;
}

function meterEl(metrics) {
  const meter = document.createElement("div");
  meter.className = `threshold-meter ${metrics.statusClass}`;
  meter.setAttribute("role", "img");
  meter.setAttribute(
    "aria-label",
    metrics.available
      ? `${metrics.status}; ${Math.abs(metrics.percent).toFixed(2)} percent ${metrics.percent <= 0 ? "below" : "above"} threshold`
      : "Current price unavailable",
  );

  const position = metrics.meterPosition;
  const start = Math.min(50, position);
  const width = Math.abs(position - 50);
  meter.style.setProperty("--meter-position", `${position}%`);
  meter.style.setProperty("--meter-start", `${start}%`);
  meter.style.setProperty("--meter-width", `${width}%`);
  meter.innerHTML =
    '<span class="threshold-center"></span>' +
    '<span class="threshold-fill"></span>' +
    '<span class="threshold-dot"></span>';
  return meter;
}

function renderRow(row) {
  const { monitor, quote, profile } = row;
  const currency = currencyFor(row);
  const metrics = thresholdMetrics(quote?.c, monitor.buyThreshold);

  const card = document.createElement("div");
  card.className = "monitor-row";
  card.dataset.symbol = monitor.symbol;
  card.tabIndex = 0;
  card.setAttribute("role", "link");
  card.appendChild(logoEl(monitor.symbol, profile));

  const meta = document.createElement("div");
  meta.className = "monitor-meta";
  const symbolLine = document.createElement("div");
  symbolLine.className = "symbol-line";
  const symbol = document.createElement("span");
  symbol.className = "symbol";
  symbol.textContent = monitor.symbol;
  symbolLine.appendChild(symbol);
  if (profile?.name || quote?.name) {
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = profile?.name || quote.name;
    symbolLine.appendChild(name);
  }
  const quoteLink = document.createElement("a");
  quoteLink.className = "quote-btn";
  quoteLink.href = detailUrl(monitor.symbol);
  quoteLink.textContent = "Detailed Quote";
  symbolLine.appendChild(quoteLink);
  const external = document.createElement("a");
  external.className = "link-btn";
  external.href = monitor.link;
  external.target = "_blank";
  external.rel = "noopener noreferrer";
  external.title = "Open external page";
  external.setAttribute("aria-label", `Open external page for ${monitor.symbol}`);
  external.innerHTML = EXTERNAL_SVG;
  symbolLine.appendChild(external);
  meta.appendChild(symbolLine);

  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = monitor.note || "Research candidate";
  if (monitor.market) {
    const chip = document.createElement("span");
    chip.className = "chip muted";
    chip.textContent = monitor.market;
    sub.appendChild(chip);
  }
  meta.appendChild(sub);
  card.appendChild(meta);

  const metricsWrap = document.createElement("div");
  metricsWrap.className = "monitor-metrics";

  const current = document.createElement("div");
  current.className = "monitor-metric current-price";
  current.innerHTML = '<span class="metric-label">Current share price</span>';
  const currentValue = document.createElement("strong");
  currentValue.textContent = fmtNative(quote?.c, currency);
  current.appendChild(currentValue);
  if (quote && isFinite(quote.dp)) {
    const day = document.createElement("small");
    day.className = quote.dp > 0 ? "up" : quote.dp < 0 ? "down" : "muted";
    day.textContent = `${fmtSignedPercent(quote.dp)} today`;
    current.appendChild(day);
  }

  const threshold = document.createElement("div");
  threshold.className = "monitor-metric buy-threshold";
  threshold.innerHTML = '<span class="metric-label">Research buy threshold</span>';
  const thresholdValue = document.createElement("strong");
  thresholdValue.textContent = fmtNative(monitor.buyThreshold, currency);
  threshold.appendChild(thresholdValue);

  const position = document.createElement("div");
  position.className = "monitor-metric threshold-position";
  position.innerHTML = '<span class="metric-label">Position versus threshold</span>';
  const status = document.createElement("div");
  status.className = `monitor-status ${metrics.statusClass}`;
  status.innerHTML = '<span class="status-light" aria-hidden="true"></span>';
  const statusText = document.createElement("strong");
  statusText.textContent = metrics.status;
  status.appendChild(statusText);
  position.appendChild(status);
  const gap = document.createElement("small");
  gap.textContent = positionText(metrics, currency);
  position.append(gap, meterEl(metrics));

  metricsWrap.append(current, threshold, position);
  card.appendChild(metricsWrap);
  return card;
}

function render() {
  const list = $("monitored");
  list.innerHTML = "";
  const sorted = sortByThreshold(state.rows);
  for (const row of sorted) list.appendChild(renderRow(row));

  const states = state.rows.map((row) =>
    thresholdMetrics(row.quote?.c, row.monitor.buyThreshold),
  );
  const buyCount = states.filter((entry) => entry.statusClass === "buy-zone").length;
  const watchCount = states.filter((entry) => entry.statusClass === "monitoring").length;
  const unavailableCount = states.filter((entry) => !entry.available).length;

  const total = state.rows.length;
  $("monitor-count").textContent = `${total} stock${total === 1 ? "" : "s"}`;
  $("monitor-count").classList.remove("skeleton");
  $("buy-zone-count").textContent = String(buyCount);
  $("watch-count").textContent = String(watchCount);
  $("unavailable-count").textContent = String(unavailableCount);
  $("empty").hidden = total > 0;
  renderUpdatedAt();
}

function renderUpdatedAt() {
  const el = $("updated-at");
  if (!state.updatedAt) {
    el.textContent = "";
    el.title = "";
    return;
  }
  el.textContent = `Updated ${fmtRelativeTime(state.updatedAt)}`;
  el.title = new Date(state.updatedAt).toLocaleString();
}

function applyQuotes(quotes, profiles = {}) {
  state.rows = state.rows.map((row) => ({
    ...row,
    quote: quotes?.[row.monitor.symbol] || row.quote,
    profile: profiles?.[row.monitor.symbol] || row.profile,
  }));
}

function showBanner(message, kind = "warn") {
  const el = $("banner");
  el.hidden = false;
  el.className = `banner ${kind === "info" ? "banner-info" : ""}`.trim();
  el.textContent = message;
}

function setBusy(kind, on) {
  for (const action of ["refresh", "parse"]) {
    const button = $(action);
    if (button) button.disabled = on;
    if (!on) {
      const current = $(`${action}-icon`);
      if (current) {
        current.outerHTML = `<span id="${action}-icon">${action === "refresh" ? "↻" : "⚡"}</span>`;
      }
    }
  }
  if (on) {
    const icon = $(`${kind}-icon`);
    if (icon) icon.outerHTML = `<span class="spin" id="${kind}-icon"></span>`;
  }
}

function failureSymbols(failures, limit = 5) {
  const symbols = (failures || []).map((failure) => failure.symbol);
  if (symbols.length <= limit) return symbols.join(", ");
  return `${symbols.slice(0, limit).join(", ")} +${symbols.length - limit} more`;
}

async function refreshLive() {
  setBusy("refresh", true);
  try {
    const symbols = [...new Set(state.rows.map((row) => row.monitor.symbol))];
    const quotes = await getQuotesBatch(symbols, { force: true });
    applyQuotes(quotes);
    state.updatedAt = new Date().toISOString();
    render();
    showBanner(`Refreshed ${Object.keys(quotes).length}/${symbols.length} monitored prices.`, "info");
  } catch (error) {
    showBanner(`Could not refresh monitored prices — ${error.message}`);
  } finally {
    setBusy("refresh", false);
  }
}

async function parseLive() {
  setBusy("parse", true);
  try {
    const symbols = [...new Set(state.rows.map((row) => row.monitor.symbol))];
    showBanner(`Parsing 0/${symbols.length} from Yahoo Finance…`, "info");
    const result = await parseAllSymbols(symbols, ({ done, total, sym, ok }) => {
      showBanner(`Parsing ${done}/${total} — ${sym} ${ok ? "✓" : "✗"}`, "info");
    });
    if (result.successCount > 0) {
      applyQuotes(result.quotes);
      state.updatedAt = new Date().toISOString();
      render();
    }

    if (result.successCount === result.requestedCount) {
      showBanner(`Parsed all ${result.successCount} monitored prices ✓`, "info");
    } else if (result.successCount === 0) {
      showBanner(
        "Parse Data unavailable — snapshot prices are unchanged. Use Refresh to try the live API.",
      );
    } else {
      showBanner(
        `Parsed ${result.successCount}/${result.requestedCount} monitored prices. ` +
        `Snapshot prices kept for ${failureSymbols(result.failures)}.`,
      );
    }
  } catch (error) {
    console.warn("Parse Data failed:", error);
    showBanner(
      "Parse Data unavailable — snapshot prices are unchanged. Use Refresh to try the live API.",
    );
  } finally {
    setBusy("parse", false);
  }
}

function bindNavigation() {
  const list = $("monitored");
  const isInnerControl = (target) =>
    target && (target.closest(".link-btn") || target.closest(".quote-btn"));

  list.addEventListener("click", (event) => {
    if (isInnerControl(event.target)) return;
    const row = event.target.closest(".monitor-row");
    if (row) window.location.href = detailUrl(row.dataset.symbol);
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInnerControl(event.target)) return;
    const row = event.target.closest(".monitor-row");
    if (!row) return;
    event.preventDefault();
    window.location.href = detailUrl(row.dataset.symbol);
  });
}

async function main() {
  $("refresh").addEventListener("click", refreshLive);
  $("parse").addEventListener("click", parseLive);
  bindNavigation();

  let monitored;
  try {
    monitored = await loadMonitored();
  } catch (error) {
    showBanner(`Could not load monitored.csv — ${error.message}`);
    $("monitor-count").textContent = "0 stocks";
    $("monitor-count").classList.remove("skeleton");
    return;
  }

  state.rows = monitored.map((monitor) => ({ monitor, quote: null, profile: null }));
  render();

  const snapshot = await loadSnapshot();
  if (snapshot) {
    applyQuotes(snapshot.quotes, snapshot.profiles);
    state.updatedAt = snapshot.updatedAt || null;
    render();
  }
}

main();
