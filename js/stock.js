import { loadHoldings, loadMonitored } from "./csv.js";
import { loadSnapshot } from "./snapshot.js";
import { aggregateHoldingLots } from "./holdings.js";
import { thresholdMetrics } from "./monitor-model.js";
import {
  getQuote,
  getProfile,
  getMetric,
  getCandles,
  timeframeToRange,
} from "./api.js";
import {
  fmtMoney,
  fmtMoneyCompact,
  fmtNative,
  fmtNumber,
  fmtSignedMoney,
  fmtSignedNative,
  fmtSignedPercent,
  fmtShares,
  changeClass,
} from "./format.js";

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(window.location.search);
const symbol = (params.get("symbol") || "").toUpperCase();
const requestedOwner = (params.get("owner") || "").trim();
const mode = params.get("mode") === "monitoring" ? "monitoring" : "portfolio";

const state = {
  symbol,
  mode,
  owner: requestedOwner,
  holding: null,
  monitored: null,
  quote: null,
  profile: null,
  metric: null,
  timeframe: "1M",
  chart: null,
  series: null,
  seriesIsUp: null,
};

window.addEventListener("foxridge:themechange", () => {
  if (state.chart) state.chart.applyOptions(chartThemeOptions());
  if (state.series && state.seriesIsUp !== null) {
    state.series.applyOptions(seriesThemeOptions(state.seriesIsUp));
  }
});

if (!symbol) {
  document.title = "Stock — Foxridge Holdings";
  showBanner("No symbol supplied. Use stock.html?symbol=ADBE");
} else {
  if (state.mode === "monitoring") {
    const backLink = $("back-link");
    backLink.href = "monitoring.html";
    backLink.textContent = "← Monitoring";
  }
  document.title = `${symbol} — Foxridge Holdings`;
  $("symbol-tag").textContent = symbol;
  main();
}

function showBanner(message) {
  const el = $("banner");
  el.hidden = false;
  el.textContent = message;
}

function effectiveCurrency() {
  return (
    state.holding?.currency ||
    state.monitored?.currency ||
    state.quote?.currency ||
    state.profile?.currency ||
    "USD"
  );
}

function inferLogoUrl(symbol) {
  const base = symbol.split(".")[0].toUpperCase();
  if (!base) return null;
  if (!symbol.includes(".")) {
    return `https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/${encodeURIComponent(base)}.png`;
  }
  return `https://financialmodelingprep.com/image-stock/${encodeURIComponent(base)}.png`;
}

function setLogo(profile) {
  const wrap = $("logo");
  wrap.classList.remove("skeleton");
  wrap.innerHTML = "";
  const url = profile?.logo || inferLogoUrl(state.symbol);
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = `${state.symbol} logo`;
    img.onerror = () => {
      wrap.textContent = state.symbol.charAt(0);
      img.remove();
    };
    wrap.appendChild(img);
  } else {
    wrap.textContent = state.symbol.charAt(0);
  }
}

function renderHeader() {
  const { quote, profile, holding } = state;
  setLogo(profile);

  const company = $("company");
  company.classList.remove("skeleton");
  company.textContent = profile?.name || state.symbol;

  const linkEl = $("company-link");
  if (linkEl) {
    const trackedEntry = state.mode === "monitoring" ? state.monitored : holding;
    if (trackedEntry && trackedEntry.link) {
      linkEl.href = trackedEntry.link;
      linkEl.hidden = false;
      linkEl.setAttribute("aria-label", `Open external page for ${state.symbol}`);
    } else {
      // Fallback: build a Yahoo Finance link from the symbol when the page is
      // visited directly without the symbol being in the CSV.
      linkEl.href = `https://au.finance.yahoo.com/quote/${encodeURIComponent(state.symbol)}/`;
      linkEl.hidden = false;
    }
  }

  const currency = effectiveCurrency();

  const priceEl = $("price");
  priceEl.classList.remove("skeleton");
  if (quote && isFinite(quote.c) && quote.c > 0) {
    priceEl.textContent = fmtNative(quote.c, currency);
    const ch = $("change");
    const chText = $("change-text");
    chText.textContent =
      `${fmtSignedNative(quote.d, currency)} (${fmtSignedPercent(quote.dp)})`;
    ch.className = `change ${changeClass(quote.d)}`;
    $("change-tag").textContent = state.quote?.extendedLabel ?? "Today";

    // USD equivalent for non-USD symbols.
    const usdEl = $("price-usd");
    if (currency !== "USD" && holding && isFinite(holding.usdRate)) {
      usdEl.hidden = false;
      usdEl.textContent = `≈ ${fmtMoney(quote.c * holding.usdRate)} USD`;
    } else {
      usdEl.hidden = true;
    }
  } else {
    priceEl.textContent = "—";
    $("change-text").textContent = "Quote unavailable";
    $("change").className = "change muted";
  }
}

function renderPosition() {
  if (state.mode === "monitoring") {
    renderMonitoringPosition();
    return;
  }

  if (!state.holding) {
    $("position").hidden = true;
    return;
  }
  const h = state.holding;
  const q = state.quote;
  const cur = h.currency;

  const items = [];
  items.push(["Owner", escapeText(h.owner)]);
  items.push(["Shares", fmtShares(h.shares)]);
  items.push(["Avg cost", fmtNative(h.unitCost, cur)]);
  items.push([
    "Total cost",
    cur === "USD"
      ? fmtMoney(h.totalCostUsd)
      : `${fmtNative(h.totalCostNative, cur)} <span class="muted">≈ ${fmtMoney(h.totalCostUsd)}</span>`,
  ]);

  if (q && isFinite(q.c) && q.c > 0) {
    const mvNative = q.c * h.shares;
    const mvUsd = mvNative * h.usdRate;
    const change = mvUsd - h.totalCostUsd;
    const pct = (change / h.totalCostUsd) * 100;
    items.push([
      "Market value",
      cur === "USD"
        ? fmtMoney(mvUsd)
        : `${fmtNative(mvNative, cur)} <span class="muted">≈ ${fmtMoney(mvUsd)}</span>`,
    ]);
    items.push([
      "Total return (USD)",
      `<span class="${changeClass(change)}">` +
        `${fmtSignedMoney(change)} (${fmtSignedPercent(pct)})</span>`,
    ]);
    items.push([
      "Today's P/L (USD)",
      `<span class="${changeClass(q.d)}">` +
        `${fmtSignedMoney((q.d ?? 0) * h.shares * h.usdRate)} (${fmtSignedPercent(q.dp)})</span>`,
    ]);
  }

  if (h.platform) items.push(["Platform", h.platform]);
  if (h.market && h.market !== "US") items.push(["Market", h.market]);
  if (cur !== "USD" && isFinite(h.usdRate)) {
    items.push(["FX rate", `1 ${cur} = ${fmtNumber(h.usdRate, 4)} USD`]);
  }
  if (h.note) items.push(["Note", h.note]);

  const wrap = $("position-kv");
  wrap.innerHTML = items
    .map(
      ([k, v]) =>
        `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`,
    )
    .join("");
  $("position").hidden = false;
}

function renderMonitoringPosition() {
  const monitor = state.monitored;
  $("position").querySelector(".monitor-detail-panel")?.remove();
  if (!monitor) {
    $("position").hidden = true;
    return;
  }

  const currency = effectiveCurrency();
  const metrics = thresholdMetrics(state.quote?.c, monitor.buyThreshold);
  const currentPrice = fmtNative(state.quote?.c, currency);
  const threshold = fmtNative(monitor.buyThreshold, currency);
  const direction = metrics.available
    ? metrics.difference <= 0 ? "below threshold" : "above threshold"
    : "";
  const gap = metrics.available
    ? `${fmtSignedNative(metrics.difference, currency)} (${fmtSignedPercent(metrics.percent)}) ${direction}`
    : "Waiting for price data";

  $("position-title").textContent = "Research threshold";
  const wrap = $("position-kv");
  wrap.innerHTML =
    `<div class="item"><span class="k">Current share price</span><span class="v">${currentPrice}</span></div>` +
    `<div class="item"><span class="k">Research buy threshold</span><span class="v">${threshold}</span></div>` +
    `<div class="item"><span class="k">Position versus threshold</span><span class="v">${gap}</span></div>` +
    `<div class="item"><span class="k">Status</span><span class="v ${metrics.statusClass === "buy-zone" ? "up" : metrics.statusClass === "monitoring" ? "watch-text" : "muted"}">${metrics.status}</span></div>`;

  const visual = document.createElement("div");
  visual.className = "monitor-detail-panel";
  const status = document.createElement("div");
  status.className = `monitor-status ${metrics.statusClass}`;
  status.innerHTML = '<span class="status-light" aria-hidden="true"></span>';
  const statusText = document.createElement("strong");
  statusText.textContent = metrics.status;
  status.appendChild(statusText);

  const meter = document.createElement("div");
  meter.className = `threshold-meter ${metrics.statusClass}`;
  const position = metrics.meterPosition;
  meter.style.setProperty("--meter-position", `${position}%`);
  meter.style.setProperty("--meter-start", `${Math.min(50, position)}%`);
  meter.style.setProperty("--meter-width", `${Math.abs(position - 50)}%`);
  meter.setAttribute("role", "img");
  meter.setAttribute("aria-label", metrics.available ? gap : "Current price unavailable");
  meter.innerHTML =
    '<span class="threshold-center"></span>' +
    '<span class="threshold-fill"></span>' +
    '<span class="threshold-dot"></span>';

  const gapText = document.createElement("div");
  gapText.className = "monitor-gap";
  gapText.textContent = gap;
  visual.append(status, meter, gapText);
  if (monitor.note) {
    const note = document.createElement("div");
    note.className = "monitor-research-note";
    note.textContent = monitor.note;
    visual.appendChild(note);
  }

  $("position").appendChild(visual);
  $("position").hidden = false;
}

function renderAbout() {
  const p = state.profile;
  const q = state.quote;
  if (!p && !q) return;
  const body = $("about-body");
  const parts = [];

  const sector = p?.sector || p?.industry;
  const country = p?.country;
  const exchange = p?.exchange || q?.exchange;
  const headerBits = [sector, country, exchange].filter(Boolean);
  if (headerBits.length) {
    parts.push(`<p><strong>${headerBits.join(" · ")}</strong></p>`);
  }
  if (p?.ipo) parts.push(`<p class="muted">IPO: ${p.ipo}</p>`);

  const links = [];
  if (p?.weburl) links.push(`<a class="pill" href="${p.weburl}" target="_blank" rel="noopener">Website ↗</a>`);
  if (p?.ticker) links.push(`<span class="pill">${p.ticker}</span>`);
  const cur = effectiveCurrency();
  if (cur) links.push(`<span class="pill">${cur}</span>`);
  if (links.length) parts.push(`<div class="links">${links.join("")}</div>`);

  if (!parts.length) {
    $("about").hidden = true;
    return;
  }
  body.innerHTML = parts.join("");
  $("about").hidden = false;
}

function renderStats() {
  const m = state.metric;
  const p = state.profile;
  const q = state.quote;
  if (!m && !p && !q) return;
  const cur = effectiveCurrency();

  const items = [];
  if (p && isFinite(p.marketCap) && p.marketCap > 0) {
    items.push(["Market cap", fmtMoneyCompact(p.marketCap)]);
  }
  if (m) {
    if (isFinite(m.peTTM)) items.push(["P/E (TTM)", fmtNumber(m.peTTM)]);
    if (isFinite(m.pbAnnual)) items.push(["P/B", fmtNumber(m.pbAnnual)]);
    if (isFinite(m.fiftyTwoWeekHigh))
      items.push(["52w high", fmtNative(m.fiftyTwoWeekHigh, cur)]);
    if (isFinite(m.fiftyTwoWeekLow))
      items.push(["52w low", fmtNative(m.fiftyTwoWeekLow, cur)]);
    if (isFinite(m.divYield)) items.push(["Dividend yield", `${fmtNumber(m.divYield)}%`]);
    if (isFinite(m.beta)) items.push(["Beta", fmtNumber(m.beta)]);
    if (isFinite(m.eps)) items.push(["EPS (TTM)", fmtNumber(m.eps)]);
    if (isFinite(m.volume)) items.push(["Volume", fmtNumber(m.volume, 0)]);
    if (isFinite(m.averageVolume)) items.push(["Avg volume", fmtNumber(m.averageVolume, 0)]);
  }
  if (q) {
    if (isFinite(q.o)) items.push(["Open", fmtNative(q.o, cur)]);
    if (isFinite(q.h)) items.push(["Day high", fmtNative(q.h, cur)]);
    if (isFinite(q.l)) items.push(["Day low", fmtNative(q.l, cur)]);
    if (isFinite(q.pc)) items.push(["Prev close", fmtNative(q.pc, cur)]);
  }

  if (!items.length) {
    $("stats").hidden = true;
    return;
  }
  $("stats-kv").innerHTML = items
    .map(
      ([k, v]) =>
        `<div class="item"><span class="k">${k}</span><span class="v">${v}</span></div>`,
    )
    .join("");
  $("stats").hidden = false;
}

/* ------------------------- chart ------------------------- */

function themeColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartThemeOptions() {
  return {
    layout: {
      background: { color: "transparent" },
      textColor: themeColor("--text-secondary"),
      fontFamily: "Inter, sans-serif",
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: themeColor("--chart-grid") },
    },
    crosshair: {
      vertLine: {
        color: themeColor("--chart-crosshair"),
        labelBackgroundColor: themeColor("--bg-elev-2"),
      },
      horzLine: {
        color: themeColor("--chart-crosshair"),
        labelBackgroundColor: themeColor("--bg-elev-2"),
      },
    },
  };
}

function seriesThemeOptions(isUp) {
  return {
    lineColor: themeColor(isUp ? "--up" : "--down"),
    topColor: themeColor(isUp ? "--up-area" : "--down-area"),
    bottomColor: "rgba(0, 0, 0, 0)",
  };
}

function ensureChart() {
  if (state.chart) return state.chart;
  const container = $("chart");
  const chart = LightweightCharts.createChart(container, {
    width: container.clientWidth,
    height: container.clientHeight || 320,
    ...chartThemeOptions(),
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, timeVisible: false, secondsVisible: false },
    handleScroll: false,
    handleScale: false,
  });
  state.chart = chart;
  window.addEventListener("resize", () => {
    chart.applyOptions({ width: container.clientWidth });
  });
  return chart;
}

function setSeries(points, isUp) {
  const chart = ensureChart();
  if (state.series) {
    chart.removeSeries(state.series);
    state.series = null;
  }
  const series = chart.addAreaSeries({
    ...seriesThemeOptions(isUp),
    lineWidth: 2,
    priceLineVisible: false,
    lastValueVisible: false,
  });
  series.setData(points);
  state.series = series;
  state.seriesIsUp = isUp;
  chart.timeScale().fitContent();
}

function clearChartOverlay() {
  const container = $("chart");
  const existing = container.querySelector(".chart-empty");
  if (existing) existing.remove();
}

function setChartOverlay(message) {
  const chart = ensureChart();
  if (state.series) {
    chart.removeSeries(state.series);
    state.series = null;
  }
  clearChartOverlay();
  const container = $("chart");
  container.style.position = "relative";
  const empty = document.createElement("div");
  empty.className = "chart-empty empty";
  empty.style.position = "absolute";
  empty.style.inset = "0";
  empty.style.display = "flex";
  empty.style.alignItems = "center";
  empty.style.justifyContent = "center";
  empty.textContent = message;
  container.appendChild(empty);
}

function setActiveTimeframe(tf, isUp) {
  state.timeframe = tf;
  const buttons = $("timeframes").querySelectorAll("button");
  buttons.forEach((b) => {
    b.classList.toggle("active", b.dataset.tf === tf);
    b.classList.toggle("down-active", b.dataset.tf === tf && isUp === false);
  });
}

async function loadChart(tf) {
  const { range, interval } = timeframeToRange(tf);
  setActiveTimeframe(tf);

  let result;
  try {
    const r = await getCandles(state.symbol, range, interval);
    result = r.value;
  } catch (e) {
    console.warn("Candle fetch failed:", e.message);
    setChartOverlay("Chart data unavailable.");
    return;
  }

  if (!result || !result.points || result.points.length < 2) {
    setChartOverlay("No data for this period.");
    return;
  }

  const points = result.points;
  const isUp = points[points.length - 1].value >= points[0].value;
  clearChartOverlay();
  setSeries(points, isUp);
  setActiveTimeframe(tf, isUp);
}

function bindTimeframes() {
  $("timeframes").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tf]");
    if (!btn) return;
    loadChart(btn.dataset.tf);
  });
}

/* ------------------------- reports (note + attachments) ------------------------- */

const FILE_ICON_SVG = `<svg class="attachment-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 7V3.5L18.5 9H13z"/></svg>`;

function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatBytes(n) {
  if (!isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// List the files inside `reports/{symbol}/` for the current page.
//
// On a public github.io site the GitHub Contents API gives us a directory
// listing without auth. CORS works, 60 req/hour unauth — fine for personal
// browsing.
//
// On localhost / non-pages hosts we can't list; instead we just probe
// note.md so the Note section still renders during local dev.
async function loadReports(sym) {
  const host = window.location.hostname;
  if (host.endsWith(".github.io")) {
    const owner = host.replace(/\.github\.io$/, "");
    const url = `https://api.github.com/repos/${owner}/${owner}.github.io/contents/reports/${encodeURIComponent(sym)}`;
    try {
      const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
      if (res.ok) {
        const items = await res.json();
        return items
          .filter((it) => it.type === "file")
          .map((it) => ({ name: it.name, size: it.size }));
      }
    } catch { /* fall through to local probe */ }
  }
  try {
    const probe = await fetch(`reports/${encodeURIComponent(sym)}/note.md`, { method: "HEAD" });
    if (probe.ok) return [{ name: "note.md", size: 0 }];
  } catch {}
  return [];
}

async function renderNote(sym, files) {
  const section = $("note");
  const body = $("note-body");
  const note = files.find((f) => f.name === "note.md");
  if (!note) { section.hidden = true; return; }
  try {
    const res = await fetch(`reports/${encodeURIComponent(sym)}/note.md?t=${Date.now()}`, { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    body.textContent = (await res.text()).trim();
    section.hidden = false;
  } catch {
    section.hidden = true;
  }
}

function renderAttachments(sym, files) {
  const section = $("attachments");
  const list = $("attachments-list");
  const attachments = files.filter((f) => f.name !== "note.md");
  if (!attachments.length) { section.hidden = true; return; }
  list.innerHTML = attachments.map((f) => {
    const href = `reports/${encodeURIComponent(sym)}/${encodeURIComponent(f.name)}`;
    const sizeText = formatBytes(f.size);
    return (
      `<li><a href="${href}" target="_blank" rel="noopener noreferrer">` +
        FILE_ICON_SVG +
        `<span class="attachment-name">${escapeText(f.name)}</span>` +
        (sizeText ? `<span class="attachment-size">${sizeText}</span>` : "") +
      `</a></li>`
    );
  }).join("");
  section.hidden = false;
}

/* ------------------------- main ------------------------- */

async function main() {
  bindTimeframes();
  ensureChart();

  // Load the matching CSV in parallel so the detail panel follows its source.
  const csvPromise = state.mode === "monitoring"
    ? loadMonitored().catch(() => [])
    : loadHoldings().catch(() => []);
  // Pull FX rates out of the cron-refreshed snapshot — no extra API call here.
  const snapshotPromise = loadSnapshot().catch(() => null);

  const onUpdate = () => {
    Promise.all([
      getQuote(state.symbol),
      getProfile(state.symbol),
      getMetric(state.symbol),
    ])
      .then(([q, p, m]) => {
        state.quote = q.value;
        state.profile = p.value;
        state.metric = m.value;
        renderHeader();
        renderPosition();
        renderAbout();
        renderStats();
      })
      .catch(() => {});
  };

  try {
    const [quote, profile, metric, holdings, snapshot] = await Promise.all([
      getQuote(state.symbol, { onUpdate }),
      getProfile(state.symbol, { onUpdate }),
      getMetric(state.symbol, { onUpdate }),
      csvPromise,
      snapshotPromise,
    ]);
    state.quote = quote.value;
    state.profile = profile.value;
    state.metric = metric.value;
    if (state.mode === "monitoring") {
      state.monitored = holdings.find((entry) => entry.symbol === state.symbol) || null;
    } else {
      state.holding = aggregateHoldingLots(holdings, state.symbol, state.owner);
      if (state.holding) state.owner = state.holding.owner;
    }

    // Fill in the holding's USD rate from the snapshot (cron-written) so
    // P/L and "≈ $X USD" line up. No live FX call on stock-page load —
    // FX only refreshes via cron / Refresh / Parse Data on the index page.
    if (state.holding && state.holding.currency !== "USD") {
      const rate = snapshot?.fxRates?.[state.holding.currency];
      if (isFinite(rate) && rate > 0) {
        state.holding.usdRate = rate;
        state.holding.totalCostUsd = state.holding.totalCostNative * rate;
      }
    }
  } catch (e) {
    showBanner(`Failed to load ${state.symbol}: ${e.message}`);
  }

  renderHeader();
  renderPosition();
  renderAbout();
  renderStats();
  loadChart(state.timeframe);

  // Note + Attachments — load reports/{symbol}/ contents in the background;
  // sections stay hidden if the folder doesn't exist or returns no files.
  loadReports(state.symbol).then(async (files) => {
    await renderNote(state.symbol, files);
    renderAttachments(state.symbol, files);
  }).catch(() => { /* silent: empty folder, rate limit, etc. */ });
}
