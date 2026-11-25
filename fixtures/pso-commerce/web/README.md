# PSO Commerce - Cloud Validation Playground

A browser client for the PSO Commerce application running on the validation server. Plain HTML, CSS and JavaScript (native `fetch` and `WebSocket`), no framework, no build step, no dependency. It is **not** part of PSO Studio and **not** part of the framework: it belongs to this fixture and is shipped inside the gateway's release.

## What it is for

Open it in a browser, authenticate with a short-lived token, and use the real application: create a customer and a product, place an order, and watch the distributed chain (gateway, orders, outbox, RabbitMQ, catalog, back) decide it, with the real HTTP request and response of every step and the real WebSocket events. Nothing is mocked or simulated; every number comes from a response.

## Files

| File | Role |
|---|---|
| `index.html`, `styles.css` | page and dark theme (no inline script or style, no emoji, SVG icons) |
| `app.js` | sections, forms, the order observer, token handling |
| `http.js` | the only way the page talks HTTP: same origin, published routes only |
| `channels.js` | PSO Channels wire protocol over a native WebSocket, with bounded reconnection |
| `ui.js`, `icons.js` | DOM helpers (text only, never `innerHTML`) and icons |

## How it is served

PSO has no native static-site deployment. The files are copied into the gateway release (`<release>/web`) by `fixtures/pso-cloud-validation/scenarios/package-gateway.mjs`, and the gateway serves them from public `GET /playground` and `GET /playground/:asset` routes (a fixed list of names, no path traversal). So the page, the API and the WebSocket share **one origin**, and the page is deployed, switched and rolled back with the gateway by the normal PSO engine. `GET /playground/routes.json` is built from the release's own `pso-release.json`, so the page lists exactly the routes the release publishes.

Open `https://<server>/playground` (without a trailing slash).

## Security model

- Requests can go only to the origin the page was loaded from, and only to a method and path the release publishes (`http.js` refuses anything else). There is no URL field and no proxy.
- The bearer token is typed or pasted into a password field, kept in a JavaScript variable, sent only to this origin, and never shown, logged or stored, unless you tick "remember for this tab" (session storage, gone when the tab closes).
- Nothing received from the network is parsed as HTML. The content security policy forbids inline script and style and any third-party origin; `connect-src` is this origin.
- State-changing requests need an explicit click, and the manual request form needs a confirmation tick.
- The page and its assets carry no data and no credential, so they are public; **every API call needs a token**, so access to the application is decided by the identity provider. Who can reach the page at all is decided by the network (restrict inbound 443 to your own address).
- No administrative credential, signing key, SSH key or secret exists in these files.

## Authentication

The deployment trusts tokens signed by the fixture's identity provider (`../pso-cloud-validation/dev-token.mjs`, issuer `https://pso-cloud-validation.local`, audience `shop-api`). Its signing key stays on the owner's machine. Mint a token there:

```bash
cd fixtures/pso-cloud-validation
node dev-token.mjs "customers:read customers:write catalog:read catalog:write orders:read orders:write"
```

Paste it into **Overview, Authentication**. Tokens are short-lived; mint another when it expires. A token without a scope sees the server's real 403.

## Published API (from the deployed release)

`POST /customers`, `GET /customers/:id`, `POST /products`, `GET /products/:id`, `POST /orders`, `GET /orders/:id`, `GET /overview/orders/:id`. There is no list endpoint, so the page offers none. The WebSocket channel is `order.<order id>` (scope `orders:read`).

## Validation

`fixtures/pso-cloud-validation/scenarios/playground-browser.mjs` drives this page in a real browser against the real server (loading, 401 without a token, token handling, customer, product, order, asynchronous confirmation, stock, composed view, real WebSocket event, request guardrails). `playground-reconnect.mjs` redeploys the gateway while the page holds a subscribed WebSocket and verifies the reconnection.
