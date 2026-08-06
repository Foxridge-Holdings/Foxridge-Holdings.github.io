# Foxridge-Holdings.github.io

Personal portfolio and research-monitoring tracker — a static GitHub Pages site
that reads CSV data and renders live quotes, fundamentals, multi-currency
totals, threshold alerts, and historical line charts for US and international
stocks. No backend, no build step.

Live site: <https://foxridge-holdings.github.io/>

## How quotes refresh

Two paths feed data into the page:

| Path                              | When                                           | Cost                          |
|-----------------------------------|------------------------------------------------|-------------------------------|
| **Snapshot** (`data/snapshot.json`) | Auto-refreshed every 3 hours by GitHub Actions | Server-side; visitors pay nothing |
| **Live API** (Refresh button)     | When *you* click Refresh                       | Hits Finnhub / RapidAPI from browser |

Visitors loading the page never call any quote API directly — they read the
already-committed snapshot. The "Updated 2 hours ago" pill next to the
Refresh button shows snapshot freshness, with the exact timestamp on hover.

This setup keeps the RapidAPI free quota (500/month) safe even if multiple
people visit:

- Cron runs: 8/day × ~30 days = **~240 RapidAPI requests/month** (1 batched
  intl quote per run). Well under the 500 ceiling.
- Each manual Refresh click costs 1 batched intl quote + N Finnhub quotes.

### Setting up the cron (one-time)

Required for the auto-refresh to work after you clone or fork:

1. **Allow Actions to write** (Repo → Settings → Actions → General → Workflow permissions): set to "Read and write permissions". This is required to commit the snapshot file back.
2. **Optional:** Add `RAPIDAPI_KEY` under Repo → Settings → Secrets and variables → Actions → New repository secret to override the public browser key in `js/config.js`.
3. The workflow at [.github/workflows/refresh-quotes.yml](.github/workflows/refresh-quotes.yml) runs on:
   - cron `0 */3 * * *` (every 3 hours)
   - any push that touches `data/holdings.csv` or `data/monitored.csv`
   - manual trigger (Repo → Actions → Refresh quotes snapshot → Run workflow)

`scripts/refresh.mjs` is the script the Action runs — it reads both stock CSVs,
deduplicates their symbols, makes one shared quote request, and writes
`data/snapshot.json`.

## Data sources

| Asset class                | Provider                                                 | Free tier             |
|----------------------------|----------------------------------------------------------|-----------------------|
| US stock quotes/profile/metric | [Finnhub](https://finnhub.io)                          | 60 calls/min          |
| International stock quotes | [apidojo Yahoo Finance via RapidAPI](https://rapidapi.com/apidojo/api/yahoo-finance1) | 500/month |
| Historical chart (all)     | apidojo Yahoo Finance via RapidAPI                       | 500/month             |

Browser-side keys live in [js/config.js](js/config.js) — visible in source, but
both providers explicitly support browser usage of free-tier keys, and rate
limiting is the protection. The scheduled refresh uses the `RAPIDAPI_KEY`
GitHub Actions secret when configured and otherwise falls back to that public
browser key.

## Updating holdings

Edit [data/holdings.csv](data/holdings.csv). Schema:

```csv
symbol,unit_cost,shares,currency,market,owner,client,platform,note,link
FLY,27.70,37,USD,US,Michael,false,Robinhood,,https://au.finance.yahoo.com/quote/FLY/
2330.TW,950.00,200,TWD,Taiwan,Michael,false,Yuanta,TSMC,https://au.finance.yahoo.com/quote/2330.TW/
IQE.L,28.50,1500,GBp,UK,Alice,true,IBKR,quoted in pence,https://au.finance.yahoo.com/quote/IQE.L/
```

Required: `symbol`, `unit_cost`, `shares`. Optional with sensible defaults:

- `currency` → `USD`
- `market` → inferred from the suffix (`.TW`/`.TWO`→Taiwan, `.L`→UK,
  `.DE`→Germany, `.ST`→Sweden, `.HK`→Hong Kong, `.T`→Japan, etc.)
- `owner` → `Michael`. Owner names generate the portfolio tabs.
- `client` → `false`. Set to `true` for shares held on behalf of a client.
  Client holdings are marked with a blue verified-checkmark in the UI.
- `platform`, `note` → blank
- `link` → the symbol's Yahoo Finance page

Cash belongs to an owner as well. Edit [data/cash.csv](data/cash.csv) using:

```csv
date,amount,currency,owner
2026-05-06,9377,USD,Michael
```

## Updating monitored stocks

Edit [data/monitored.csv](data/monitored.csv). Schema:

```csv
symbol,buy_threshold,currency,market,note,link
POOL,180,USD,US,Sample monitored stock,https://au.finance.yahoo.com/quote/POOL/
```

- `symbol` and a positive `buy_threshold` are required.
- Enter the threshold in the stock's native quote currency.
- `currency` defaults to `USD`; `market` and `link` use the same inference and
  fallback behavior as holdings.
- Position versus threshold is calculated from the current quote and is never
  stored in the CSV.
- A symbol may appear in both the holdings and monitored files.

### Currency notes

- `unit_cost` is in the **native currency** of the listing, not USD.
- Native-to-USD rates come from the refreshed Yahoo Finance snapshot.
- **London Stock Exchange quotes most stocks in pence (`GBp`)**, not pounds.
  Yahoo reports London prices in `GBp` natively, and the site applies the
  pounds-to-dollars rate with the required pence conversion automatically.

## How the UI works

- **Portfolio total** is always in USD (sum of `price × shares × usd_rate`).
- **Per-row price** is shown in native currency; USD market value and USD
  total return appear beneath it (with `≈` prefix when converted).
- **Owner tabs** show `All` followed by every owner found in the holdings and
  cash CSV files. Each tab shows that owner's complete USD subtotal.
- **Country filter** sits beneath the tabs and uses the holdings `market`
  values. It updates the portfolio summary, overview, and holdings list
  together. Cash appears only under `All countries`.
- **Monitoring page** is a separate page reached through the navigation button,
  not a portfolio tab. It shows current price, research buy threshold, exact
  distance from threshold, and a centered visual meter.
- **Monitoring status** is green at or below the threshold, amber above it, and
  gray when a current price is unavailable. Buy-zone stocks appear first,
  followed by the closest monitoring candidates.
- **Theme switch** uses daylight mode by default and remembers a visitor's light
  or dark preference in their browser.
- **Verified checkmark** appears next to the company name on every
  client-owned row, both on the list and the detail page.
- **Portfolio detail page** (`stock.html?symbol=…&owner=…`) — Robinhood-style line chart with
  timeframe buttons (1D / 1W / 1M / 3M / 1Y / 5Y), position info in both
  native and USD, company info, and key statistics. Multiple lots for the same
  symbol and owner are combined into one position.
- **Monitoring detail mode** (`stock.html?symbol=…&mode=monitoring`) reuses the
  chart and company statistics while replacing portfolio P/L with research
  threshold status.

## Local development

The page uses `fetch` to load CSV/JSON, so it must be served over HTTP (not
opened as `file://`):

```bash
python -m http.server 8000
# open http://localhost:8000
```

To regenerate the snapshot locally:

```bash
node scripts/refresh.mjs
```

Set `RAPIDAPI_KEY=...` to override the public browser key for a local run.

## Deploying

`git push` to `main`. GitHub Pages auto-publishes the repo root since this is
a user-page repo (`<user>.github.io`). The first push also kicks off the quote
workflow because its `push` trigger watches both stock CSV files.
