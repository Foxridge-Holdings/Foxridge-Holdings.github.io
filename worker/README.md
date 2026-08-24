# Yahoo Finance proxy (Cloudflare Worker)

Foxridge's quota-free Parse Data backend. The Worker validates requests,
forwards them to Yahoo Finance's chart endpoint, retries transient failures,
and adds strict CORS headers for the production site and local development.

The selected personal Cloudflare account is pinned in `wrangler.toml`. Local
Wrangler account caches are ignored and must never be committed.

## One-time account login

Wrangler must be authenticated to the Foxridge personal Cloudflare account,
not the Tinnox account:

```sh
wrangler logout
wrangler login
wrangler whoami
```

Confirm that `wrangler whoami` lists the account pinned in `wrangler.toml`
before deploying.

## Deploy and configure

From this directory:

```sh
wrangler deploy
```

The current deployment is:

`https://foxridge-holdings-yahoo-proxy.wolfholdings-yahoo-proxy.workers.dev`

Keep that public URL in sync with `PARSE_PROXY_BASE` in `../js/config.js` if a
future deployment changes it.

Run `wrangler deploy` again whenever `yahoo-proxy.js` or `wrangler.toml`
changes. No Cloudflare API token is stored in this repository.

## Endpoints

- `GET /health`
- `GET /quote?symbol=POOL&interval=1m&range=1d`
- `OPTIONS` for CORS preflight

Only the production GitHub Pages origin and the documented local origins are
accepted from browsers. Requests with no `Origin` header remain available for
command-line smoke tests.

## Smoke tests

```sh
curl 'https://foxridge-holdings-yahoo-proxy.wolfholdings-yahoo-proxy.workers.dev/health'
curl 'https://foxridge-holdings-yahoo-proxy.wolfholdings-yahoo-proxy.workers.dev/quote?symbol=POOL&interval=1m&range=1d'
curl -I -H 'Origin: https://foxridge-holdings.github.io' \
  'https://foxridge-holdings-yahoo-proxy.wolfholdings-yahoo-proxy.workers.dev/health'
```

Expected results:

- Health returns `{"ok":true,"service":"foxridge-yahoo-proxy"}`.
- Quote returns `{"ok":true,"symbol":"POOL","data":{"chart":...}}`.
- The CORS response includes
  `Access-Control-Allow-Origin: https://foxridge-holdings.github.io`.

The Worker caches successful Yahoo responses for 30 seconds. With three
concurrent browser requests, the current portfolio and monitoring lists remain
well within the Cloudflare Workers free-plan request limits.
