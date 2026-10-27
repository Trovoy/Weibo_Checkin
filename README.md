**English** | [简体中文](README.zh-CN.md)

# Daily Check-in Workbench

A self-hosted, single-user dashboard for **Weibo Super Topics, NodeSeek and Huya**, built with Cloudflare Workers and SQLite Durable Objects. All platforms share one Worker and interface while keeping credentials, storage and execution isolated.

[Deployment guide](docs/DEPLOY.md) · [NodeSeek, migration and platforms](docs/PLATFORMS.md) · [Privacy and reporting](SECURITY.md)

## What it does

- **Weibo:** QR-code sign-in, followed Super Topics and personal levels, topic search, up to 30 configured topics, manual runs and daily scheduling.
- **Huya:** official-app QR sign-in, encrypted Cookie capture, all available ordinary backpack tiger food sent to one configured room, daily scheduling and verified receipts. See the [Huya guide](docs/HUYA.md).
- **NodeSeek:** Cookie checks, a stable daily time within a selected random window, a 14:00 catch-up check, reward records and bounded ledger reconciliation.
- **One dashboard:** grouped platform navigation, an all-platform log, today's completion ring and a seven-day stacked chart. Counts use UTC+8 and count each confirmed daily item once; unknown data stays unknown.
- **Browser extension:** pair Chrome/Edge with your own dashboard to synchronize NodeSeek cookies. Its token can synchronize credentials only; management still requires a dashboard session.
- **Protected access:** an admin token, expiring HttpOnly sessions, same-origin write checks and encrypted platform credentials. No account password is collected.
- **Controlled execution:** serialized operations, daily deduplication, stop/retry controls, explicit failures and optional failure-summary webhooks.

This is the rewrite of the 2023 Python script. The old script remains in `legacy/weibo_checkin.py`; it is not the current entry point. The interface is currently Chinese; these documents are available in both languages.

## Deploy your own instance

You need Git, **Node.js 24+ with npm**, and a Cloudflare account with Workers enabled. NodeSeek and Huya QR sign-in additionally require access to **Cloudflare Browser Run**. Check Cloudflare's current [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) and Browser Run allowances before enabling scheduled use. A domain or always-on server is not required.

Follow the [full deployment guide](docs/DEPLOY.md) for Windows instructions, custom domains, upgrades and troubleshooting.

```sh
git clone https://github.com/Trovoy/Weibo_Checkin.git
cd Weibo_Checkin
npm ci
npx wrangler login
node scripts/secrets.mjs
npm run deploy
node scripts/secrets.mjs --upload
```

The default Worker name is `weibo-checkin`. Before the first deploy, check that it does not replace an existing service in your account; change `name` in `wrangler.jsonc` if necessary. Wrangler creates the configured SQLite Durable Object bindings and migrations. Do not create KV, D1 or R2 manually for a new instance.

Open the deployed `https://weibo-checkin.<your-subdomain>.workers.dev` address. Read the generated local `.dev.vars` with a text editor and enter **`ADMIN_TOKEN`** to unlock the dashboard. It is the dashboard password, not a Weibo password. **`ENCRYPTION_KEY` is a server-side encryption key, not a login value.** The placeholders in `.dev.vars.example` are not usable secrets.

### First Weibo run

1. Generate a QR code, scan it with the Weibo app and confirm the account.
2. Read followed topics and personal levels, or search for topics. You may also add a topic URL/ID: `100808` followed by 32 hexadecimal characters.
3. Select the topics, save, run a manual check-in and inspect the result.
4. Enable daily scheduling only after a successful manual run. **New installations default to off.**

The Weibo cron is `0 1 * * *` (09:00 UTC+8). Each alarm handles one topic, with a ten-second interval. Saved daily completions are skipped.

The desktop and mobile Weibo sites use different login domains. Personal levels may require a second QR connection to the mobile site using the **same account**. The server checks matching UIDs before merging mobile-domain cookies. It never substitutes public topic popularity or another person's level for your personal level. Reading followed topics does not follow new topics or automatically add every result to check-in.

If QR sign-in is unavailable, the fallback accepts the full **Request `Cookie` header** from an authenticated `weibo.com` request. It must contain `SUB`; retain related values such as `SUBP` and `XSRF-TOKEN`. Do not paste a `Set-Cookie` response header. New credentials replace the saved session only after validation; saved cookies are not returned to the browser.

### NodeSeek

Use the NodeSeek settings to save a Cookie and the User-Agent used to obtain it, or pair the browser extension. Test the Cookie and a manual check-in before enabling scheduling. The minute cron checks due NodeSeek plans; opening the dashboard does not launch a remote browser. See the [platform guide](docs/PLATFORMS.md) for extension permissions, daily timing and migration from an older standalone Worker.

## Secrets and privacy

| Secret | Purpose |
| --- | --- |
| `ADMIN_TOKEN` | Random dashboard password, at least 32 characters. Changing it invalidates existing dashboard sessions. |
| `ENCRYPTION_KEY` | Base64-encoded 32 random bytes for Weibo/Huya Cookie and QR-state encryption. Back it up. |
| `NODESEEK_CREDENTIAL_KEY` | Separate NodeSeek credential key, at least 32 characters. Preserve the old `CREDENTIAL_KEY` value during migration. |
| `NOTIFY_WEBHOOK_URL` | Optional HTTPS endpoint receiving JSON `{ "title": "…", "content": "…" }` failure summaries, without cookies. |

Update one secret with `npx wrangler secret put NAME`, or upload the supported local values with `node scripts/secrets.mjs --upload`. For a local deployment configuration, use the same `--config wrangler.local.jsonc` for both code and secret uploads. Never commit `.dev.vars` or your private local configuration.

The login page is public; account information, avatars, followed topics, levels, records and operations require a management session. Sessions are host-only, Secure, HttpOnly and SameSite=Strict, expire after 12 hours, and writes validate the full Origin. Production requires HTTPS. Responses disable caching, embedding and search indexing; indexing directives do not replace authentication. External analytics, fonts and scripts are not loaded.

Weibo/Huya cookies and temporary QR state use AES-256-GCM. Other account data, configuration and logs are hosted by Cloudflare. A Cloudflare administrator controlling the Worker and its keys can read the data: this is **not end-to-end encryption**. You can place Cloudflare Access in front of the dashboard if needed. Disconnect the affected account before replacing its encryption key, then reconnect.

## Develop and validate

```sh
npm ci
node scripts/secrets.mjs
npm run dev
npm run check
npm run check:public
npm test
npm run build
```

Local development can make real upstream requests. Tests use simulated networks; `npm run build` is a Wrangler dry run and does not deploy. The frontend does not need a separate build. GSAP is served from `public/vendor/` with its notices; after upgrading the npm dependency, run `node scripts/vendor.mjs`. Deploy/build commands also create a generic `public/extension.zip` without personal domains or credentials.

| Path | Contents |
| --- | --- |
| `src/` | Shared Worker, Weibo account engine and platform registry |
| `src/huya/` | Huya QR sessions, bounded protocol codec and isolated gifting state |
| `src/nodeseek/` | NodeSeek engine and isolated account state |
| `public/` | Dashboard and locally served frontend dependencies |
| `extension/` | NodeSeek browser synchronization extension |
| `test/` | Protocol, storage, authentication and interface checks |
| `legacy/` | Historical Python implementation |

## Operational limits

- Upstream websites control login validity. Cookie updates do not guarantee renewal; QR login, level retrieval and check-ins use non-public web interfaces that may change or reject Cloudflare traffic. Complete challenges in the official application and reconnect. There is no CAPTCHA bypass, password automation or proxy switching.
- Weibo recognizes `100000` as success and `382004` as already checked in, including numeric/string forms. Unknown codes never become success. Login checks use `/ajax/setting/getPrivacy`, check-ins use `POST /ajax_proxy/chaohua/page/checkin`, and QR login uses Sina SSO.
- A failed topic stops the Weibo run. Resolve it and retry manually; confirmed completions are skipped. Unknown POST outcomes are not automatically retried. Cancellation waits for the current request; requests time out after 15 seconds. The Weibo cron has no additional same-day catch-up retry.
- Durable Object alarms are delivered at least once. Daily deduplication cannot guarantee exactly-once upstream requests if execution stops after the remote check-in but before local persistence.
- Weibo keeps seven days of deduplication dates and at most 200 log records. An old run stops when the date changes. NodeSeek uses its own records and reconciliation rules described in the platform guide.
- The dashboard is for one person and one account per platform, with no public registration or multi-user isolation. Disconnect before changing accounts. Deleting Worker/Durable Object data removes saved configuration and login state.

Real Cloudflare checks have covered Weibo desktop/mobile QR connections, profiles, followed topics, personal levels and manual check-in. Every deployment still needs its own acceptance run and next-day schedule check; mocked tests cannot prove long-term login or upstream stability.

References: [earlier check-in implementation](https://github.com/88lin/weibo-checkin/blob/main/weibo_checkin.py), [Sina QR flow](https://github.com/CharlesPikachu/DecryptLogin/blob/master/DecryptLogin/modules/core/weibo.py), and [Cloudflare Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

Before reporting a problem, read [Privacy and reporting](SECURITY.md). Never attach cookies, secrets, usable QR codes or complete request headers.
