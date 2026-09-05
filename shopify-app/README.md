# ARLing Asistent for Shopify

The Shopify App Store distribution of [ARLing Asistent](../README.md): an AI
shopping assistant chat widget that answers customer questions from a shop's
own product catalogue, stores no conversation content, and runs on
Cloudflare Workers.

This directory is a second, independent Cloudflare Worker plus a Shopify
theme app extension. It does not change anything in `../worker/` (the core
ARLing Asistent API): it is a *client* of that API, the same way
`../wordpress-plugin/` is, translating Shopify's install/billing/webhook
model into calls against the existing `POST /v1/tenants` /
`GET /v1/tenants/:id/status` contract documented in `../README.md`.

## Status

The owner (ARLing s. r. o.) has a Shopify Partners account but **has not
created an app in it yet**. Nothing here is deployed, and nothing can be
deployed until that app exists (Partners issues the client id/secret this
worker needs as `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`). Everything below
is built and tested against mocks, exactly like the rest of this product
before its own Cloudflare account existed (see `../README.md` "Testovanie
lokálne"): `npm test` runs 75 tests / 246 assertions with `node --test` and
no network access at all.

## Files

```
shopify-app/
├── shopify.app.toml              Shopify CLI app config: scopes, URLs, webhooks, app proxy
├── shopify-worker/               Cloudflare Worker: OAuth, billing, webhooks, admin API
│   ├── wrangler.toml
│   ├── schema.sql                D1 schema (one "shops" table)
│   └── src/
│       ├── index.js              fetch() router
│       ├── crypto-utils.js       HMAC/signature/JWT primitives (OAuth, webhooks, app proxy, session tokens)
│       ├── oauth.js              /auth, /auth/callback, code-for-token exchange
│       ├── webhooks.js           app/uninstalled + the 3 mandatory compliance webhooks
│       ├── session-token.js      App Bridge session token verification for /app/api/*
│       ├── billing.js            appSubscriptionCreate (Billing GraphQL API)
│       ├── shops.js              D1-backed shop records
│       ├── tenant-client.js      client for the existing ARLing Asistent tenant API
│       ├── products-feed.js      picks products.json vs. Admin GraphQL fallback
│       ├── app-proxy.js          GET /proxy/settings.json for the theme extension
│       └── admin-page.js         embedded admin HTML (App Bridge, status, plans, settings)
├── extensions/asistent-widget/   Theme app extension
│   ├── shopify.extension.toml
│   └── blocks/asistent.liquid    app embed block (injects the widget <script>)
├── tests/                        node --test, 9 files, no network
└── README.md                     this file
```

## Research notes (shopify.dev, fetched 2026-09-05)

Everything below was read directly from shopify.dev before writing any
code, not assumed:

- **OAuth flow, HMAC verification, state/nonce**: [shopify.dev/docs/apps/auth/oauth](https://shopify.dev/docs/apps/auth/oauth) — authorization code grant, verify the callback by removing `hmac`, sorting the rest, HMAC-SHA256 hex compare; store the nonce in a signed cookie for the state check.
- **Session tokens for embedded apps**: [shopify.dev/docs/apps/auth/session-tokens](https://shopify.dev/docs/apps/auth/session-tokens) — App Bridge issues a short-lived (60s) HS256 JWT (`shopify.idToken()`), backend verifies signature + `exp`/`nbf`/`aud`/`iss`/`dest`.
- **Mandatory compliance webhooks**: [shopify.dev/docs/apps/build/compliance/privacy-law-compliance](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance) — `customers/data_request`, `customers/redact`, `shop/redact` payload shapes, 30-day response window, `shopify.app.toml` declares them under one `[[webhooks.subscriptions]] compliance_topics = [...]` entry with a single `uri`, dispatched by the `X-Shopify-Topic` header.
- **Theme app extensions replace ScriptTags**: [shopify.dev/docs/apps/build/online-store/theme-app-extensions](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions) and its [configuration](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration) page — app embed blocks (`"target": "body"` in `{% schema %}`), `shopify.extension.toml` (`type = "theme"`), `{{ app.metafields.* }}` in Liquid. ScriptTags are legacy/deprecated for Online Store 2.0 themes; an app embed block is the documented replacement.
- **App proxy signature verification**: [shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies) — drop `signature`, comma-join multi-valued params, sort by key, concatenate with **no** separator (unlike the OAuth callback's `&`-joined message), hex HMAC-SHA256 compare.
- **Billing**: [shopify.dev/docs/apps/launch/billing](https://shopify.dev/docs/apps/launch/billing) and the [appSubscriptionCreate mutation reference](https://shopify.dev/docs/api/admin-graphql/latest/mutations/appSubscriptionCreate) — recurring charges via `appSubscriptionCreate` (`lineItems[].plan.appRecurringPricingDetails.price{amount,currencyCode}`, `interval: EVERY_30_DAYS`, `test: Boolean`, response `confirmationUrl` + `userErrors`). **Note**: Shopify's current docs recommend "Shopify App Pricing" (prices declared once in the Partner Dashboard, no billing code at all) as the default for *new* public apps, and explicitly say not to call `appSubscriptionCreate` when using it. This app implements the GraphQL Billing API directly instead, because the task calls for it explicitly, it is fully unit-testable with mocks today (Shopify App Pricing cannot be configured or tested until the Partners app exists), and it still works — see "Known gaps" below for the tradeoff.
- **App Store requirements / review checklist**: [shopify.dev/docs/apps/launch/app-requirements-checklist](https://shopify.dev/docs/apps/launch/app-requirements-checklist) — embedded apps must use App Bridge and session tokens (no cookies/localStorage for auth), Shopify-provided billing, listing content limits (name ≤30 chars, 100-char intro, 500-char details, up to 6 features ≤80 chars, 3-6 screenshots 1600×900), a demo store or setup instructions, privacy policy and support contact required. No fixed review-time SLA is published on this page; the Partner Dashboard shows its own current estimate at submission time.
- **CLI app configuration format**: [shopify.dev/docs/apps/build/cli-for-apps/app-configuration](https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration) — `shopify.app.toml` fields used in this directory's `shopify.app.toml`.

## Local testing (no Partners app, no Cloudflare account needed)

```bash
cd shopify-app
npm test                     # node --test tests/*.test.mjs — 75 tests, 246 assert.* calls, no network
node --check shopify-worker/src/*.js
```

What the tests cover: OAuth callback HMAC verification (valid + tampered,
cross-checked against an independent `node:crypto` computation, not just
self-consistency), webhook body HMAC verification and the three compliance
webhooks' responses, app proxy signature verification, App Bridge session
token verification (valid/expired/wrong audience/wrong signature/malformed),
the tenant API client (including the live worker's idempotent 200 +
`existing: true` response for a resubmitted domain), the Billing GraphQL
mutation's exact payload shape for both paid plans, the products.json vs.
Admin GraphQL feed fallback (including a round-trip through the parent
product's own `parseShopifyJson` to prove the reshaped GraphQL data parses
identically to Shopify's real `/products.json`), and the full HTTP router
wired end to end with real `Request`/`Response` objects.

Once a Partners app exists, `shopify-worker/` can also run standalone
against Cloudflare's local emulators, same as the parent worker:

```bash
cd shopify-worker
npx wrangler dev
```

## What I (Claude/this repo) deploy vs. what the owner must do

I can build, test, and prepare every file in this directory, but I **cannot**
create the Shopify app itself (that requires signing in interactively to
the Partners dashboard) and nothing can go live until that exists. Once it
does, deploying `shopify-worker/` and pushing `shopify.app.toml` is a normal
`wrangler` / `shopify` CLI job I can run.

### Partners dashboard steps (the owner, andrej@arling.sk)

1. **Create the app.** Partners dashboard → *Apps* → *Create app*. Choose
   the option to build with the Shopify CLI ("Create app manually" /
   connect an existing codebase) rather than the no-code template, since
   this app already has a `shopify.app.toml`. Name it "ARLing Asistent".
2. **Get the client id and secret.** App → *Client credentials* (or
   *API access*, dashboard naming varies by account). Copy the **Client
   ID** (public) and **Client secret** (keep private).
3. **Set the app URLs**, once `shopify-worker` has a real deployed URL:
   - App URL: `https://<your-worker-domain>/app`
   - Allowed redirection URL(s): `https://<your-worker-domain>/auth/callback`
   - App proxy: prefix `apps`, subpath `asistent`, URL `https://<your-worker-domain>/proxy` (this can also be set by `shopify app config push` reading `shopify.app.toml`, see below, instead of by hand)
4. **Create a development store** (Partners → *Stores* → *Add store* → *Development store*) to install and test the app before submitting it — this is required; apps cannot be tested on a live merchant store pre-review, and a development store is free.
5. **Hand me (or run) the deploy commands** once the above exists:
   ```bash
   # Cloudflare side
   cd shopify-app/shopify-worker
   npm install -g wrangler   # if not already installed
   wrangler login
   wrangler d1 create asistent-shopify        # paste the returned database_id into wrangler.toml
   wrangler d1 execute asistent-shopify --file=schema.sql --remote
   wrangler secret put SHOPIFY_API_SECRET     # paste the client secret from step 2
   # edit wrangler.toml: SHOPIFY_API_KEY = client id, APP_URL = the worker's real URL
   wrangler deploy

   # Shopify side (from shopify-app/, needs Shopify CLI: npm install -g @shopify/cli)
   shopify auth login
   shopify app config link      # links this shopify.app.toml to the app created in step 1
   shopify app config push      # registers the webhook subscriptions and app proxy from shopify.app.toml
   shopify app deploy           # publishes the theme app extension (extensions/asistent-widget)
   ```
6. **Install on the development store** via the install link `shopify app dev` prints, or Partners dashboard → app → *Test on development store*. Walk through: OAuth consent screen → redirected to `/app` inside Shopify admin → status shows "Building your assistant..." then "Ready" once the product feed is embedded → open the theme editor, *App embeds*, turn on "ARLing Asistent", set position/colour/language → view the storefront and confirm the chat bubble appears and answers a question.
7. **Test billing** with `BILLING_TEST_MODE = "true"` in `wrangler.toml` (the default): choosing Starter or Pro in the admin page creates a Shopify **test** charge (never actually billed), which the development store's owner still has to approve on Shopify's confirmation screen, same UX as a real charge. Set it to `"false"` before submitting for review.
8. **Test the compliance webhooks** before submitting: `shopify app webhook trigger --topic=customers/data_request` (and `customers/redact`, `shop/redact`) sends a real signed test payload to the deployed worker; confirm each returns 200. Uninstalling the app from the dev store exercises `app/uninstalled` for real.
9. **Submit for review**: Partners dashboard → app → *Distribution* → *Shopify App Store*, fill in the listing (see below), attach the demo store URL and setup instructions, and submit. Keep developer contact info current, since Shopify contacts that address about review feedback.

## App Store listing text (draft — the owner should review/adjust the tone before submitting)

**Name** (≤30 chars): `ARLing Asistent`

**Tagline / app introduction** (≤100 chars):
`AI chat that answers shopping questions from your own product catalogue.`

**App details** (≤500 chars):
> ARLing Asistent adds an AI shopping assistant to your storefront. Shoppers
> ask questions in their own words ("do you have a waterproof jacket under
> 80 euros?") and the assistant answers using only your store's own product
> catalogue, with links to matching products. Setup takes minutes: install,
> and the assistant builds itself from your public product feed, no coding
> and no theme edits. Supports Slovak, Czech, English and German. Stores no
> conversation content, only anonymous daily usage counters.

**Key features** (≤80 chars each, up to 6):
1. Chat widget answers shopping questions from your product catalogue
2. Understands Slovak, Czech, English and German, auto-detected per message
3. Shows up to three matching products with price and a link
4. Refreshes its product knowledge automatically
5. No coding, no theme edits: one toggle in the theme editor
6. No conversation content stored, only anonymous daily counters

**Pricing plans text**:
| Plan | Price | Limit |
|---|---|---|
| Free | $0/month | Up to 100 conversations/month |
| Starter | $19/month | Up to 1,000 conversations/month |
| Pro | $39/month | Up to 5,000 conversations/month |

*(All plans billed through Shopify. No card required for the Free plan.
Upgrading or downgrading takes effect immediately from the app's own admin
page, no reinstall or support ticket needed, per the App Store requirement
that plan changes not require contacting support.)*

**Privacy details** (for the listing's data-use disclosure, mirrors
`../wordpress-plugin/arling-asistent/readme.txt`'s "External services"
section, which is the existing, reviewed wording for this same backend):

> On install, this app sends your store's domain and public product feed
> URL (from `/products.json`, or from the Admin API's product list if that
> endpoint is disabled) to the ARLing Asistent service (ARLing s. r. o.,
> Bratislava, Slovakia) to build your assistant's product knowledge. No
> customer data and no order data is ever sent or accessed: the app only
> requests the `read_products` scope. When a shopper uses the chat widget,
> their question and the assistant's reply are processed by this same
> service to generate an answer; the service does not store that
> conversation content, only anonymous daily counters used to enforce your
> plan's monthly quota. Uninstalling stops the widget immediately.

Support contact: andrej@arling.sk. Privacy policy: https://arling.sk/gdpr/
and https://arling.sk/privacy/ (existing pages, reused as-is).

## Design choice: app proxy vs. metafields for the tenant id

The task allowed either. This app uses the **app proxy**
(`GET /proxy/settings.json`, see `shopify-worker/src/app-proxy.js` and
`extensions/asistent-widget/blocks/asistent.liquid`), not shop metafields,
because:

- The signature-verification algorithm is fully documented and cited above,
  so it could be implemented and unit-tested with confidence; the exact
  scope/permission Shopify requires to write and read *app-owned* shop
  metafields from Liquid was less clearly pinned down in the same research
  pass, and getting that wrong would silently fail on the storefront rather
  than failing a test.
- It reuses the exact same D1 row the embedded admin page already reads and
  writes (`shops.tenant_id`, see `shopify-worker/src/shops.js`) with no
  second write path (a metafield sync on every settings save) to keep
  consistent.
- It keeps the OAuth scope to `read_products` only — no `write_products` or
  a metafields-specific scope needed just to hand the storefront one string.

The tradeoff (see "Known gaps" below): the theme editor's own block
settings (position/colour/language/title/greeting) are what the widget
actually uses on the storefront; the embedded admin page's own
language/colour/position fields are saved but not currently read by the
block, since the block already gets those from the merchant directly in the
theme editor with no round trip needed. Only the tenant id has to come from
the proxy, since it cannot be a theme-editor setting.

## Known gaps

- **Plan changes do not update the ARLing tenant's quota.** Choosing
  Starter/Pro in the embedded admin page creates a real Shopify recurring
  charge and records the plan locally (`shops.plan`), but the ARLing tenant
  record on the main worker (`../worker/src/tenants.js`, `monthly_quota`)
  is not updated automatically, since that API has no such endpoint yet
  (the parent product's own README lists the same gap for its direct
  Stripe flow: "Zmena plánu/kvóty existujúceho tenanta sa dnes robí len
  priamym zápisom do D1"). Needs either a `PATCH /v1/tenants/:id` endpoint
  on the main worker, or a manual D1 update per upgrade until then.
- **No `appSubscriptionCancel` on downgrade to Free.** Choosing "Free" after
  being on a paid plan updates the local row but does not cancel the active
  Shopify subscription; the merchant would need to cancel it from Shopify's
  own subscription management, or this needs a follow-up `billing.js`
  function.
- **The GraphQL-fallback feed cache is never refreshed after install.**
  When a shop's `/products.json` is disabled, `resolveFeed()` fetches the
  catalogue once via Admin GraphQL and caches it (`shops.feed_cache`,
  served at `/feed/:shop.json`); the main worker's daily cron re-fetches
  that URL, so it *looks* live, but nothing in `shopify-worker` ever calls
  `fetchProductsViaGraphQL` again to refresh the cache itself. A shop on
  this path needs a scheduled trigger added to `shopify-worker/wrangler.toml`
  to stay current; shops with `/products.json` enabled (the common case)
  do not have this problem, since the main worker fetches that URL fresh
  every time.
- **GraphQL fallback fetches only the first 250 products** (`products(first:
  250)`), no pagination. A large catalogue on a shop with `/products.json`
  disabled would be truncated.
- **`shop/redact` cannot delete the ARLing tenant or its Vectorize
  embeddings.** It purges this app's own local shop row, but the tenant API
  has no delete endpoint (same gap the parent README already lists: "Žiadny
  prehľad tenantov... mimo priameho dotazu do D1").
- **Compliance webhooks have nothing to disclose or redact by design**,
  since this app (like the rest of ARLing Asistent) never stores
  conversation content or customer-identifying data — see
  `shopify-worker/src/webhooks.js`. This is a property of the architecture,
  not an unfinished feature, but it is worth stating explicitly for review.
- **Shopify App Pricing was not used** in favour of the GraphQL Billing API
  directly (see "Research notes" above) — this is a deliberate choice for
  testability today, but means the owner should reconsider whether to
  migrate to Shopify App Pricing once the Partners app exists and the
  Partner Dashboard's own pricing UI is available, since Shopify positions
  it as the default going forward.
- **No automated end-to-end test against a real development store.** Every
  test here runs against mocks; the Partners-dashboard steps above include
  the manual pass needed once an app and a dev store exist.
