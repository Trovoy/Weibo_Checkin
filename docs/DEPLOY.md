**English** | [简体中文](DEPLOY.zh-CN.md)

# Deploy to Cloudflare

This guide creates **your own single-user check-in dashboard**. The repository provides code, not a shared hosted panel. Weibo, NodeSeek and Huya run in the same Worker, each with independent storage. For NodeSeek setup and migration, use the [platform guide](PLATFORMS.md); Huya setup is covered in the [gifting guide](HUYA.md).

## Prerequisites

- [Node.js](https://nodejs.org/) 24+ with npm, and [Git](https://git-scm.com/).
- A [Cloudflare account](https://dash.cloudflare.com/) with Workers enabled and a `workers.dev` subdomain. NodeSeek and Huya QR sign-in require Browser Run access under its current quotas and pricing.
- The Weibo mobile app to confirm QR sign-in; the project does not need your account password.
- Optionally fork this repository first. Forking does not deploy a service or copy the author's hosted data.

Check your terminal:

```sh
node --version
npm --version
git --version
```

On Windows, if PowerShell blocks `npm.ps1`, use Command Prompt or replace `npm` / `npx` with `npm.cmd` / `npx.cmd`. You do not need to disable the system execution policy.

## 1. Install and authenticate

```sh
git clone https://github.com/Trovoy/Weibo_Checkin.git
cd Weibo_Checkin
npm ci
npx wrangler login
npx wrangler whoami
```

Use your fork's URL if applicable. A downloaded ZIP also works: extract it and enter the directory containing `package.json`. Confirm that `whoami` shows the intended Cloudflare account before deploying.

## 2. Review the Worker configuration

| Field in `wrangler.jsonc` | Meaning |
| --- | --- |
| `name` | Defaults to `weibo-checkin`. Avoid overwriting an existing service. |
| `workers_dev` | `true`: enable the Cloudflare-provided hostname. |
| `preview_urls` | `false`: disable version preview URLs. |
| `durable_objects`, `migrations` | Wrangler provisions account/state storage. Preserve these bindings and migrations, including the `v4` / `NOTIFICATIONS` notification store. |
| `triggers.crons` | `* * * * *` checks due durable plans for all three platforms. |
| `browser` | Cloudflare Browser Run binding for NodeSeek execution and Huya QR sign-in. |

No manual database, KV, R2 or GitHub Actions deployment token is needed for a new installation. Repository Actions validate code; they do not deploy your Cloudflare Worker.

## 3. Generate secrets and deploy

```sh
node scripts/secrets.mjs
npm run deploy
node scripts/secrets.mjs --upload
```

Keep this order: generate local secrets, create the Worker, then upload secrets. A missing-secret message between deployment and upload is expected. Refresh after upload.

The generator writes local `.dev.vars`, preserves an existing file and does not print secrets. Open it with a text editor:

- `ADMIN_TOKEN`: dashboard password; paste only the value after `=` into the unlock form.
- `ENCRYPTION_KEY`: Weibo/Huya Cookie and Telegram notification encryption key; never use it as the dashboard password.
- `NODESEEK_CREDENTIAL_KEY`: separate NodeSeek encryption key and stable random-plan seed. When migrating, preserve the old `CREDENTIAL_KEY` instead of generating a replacement.

Back up `.dev.vars` privately, such as in a password manager. It is ignored by Git. Never upload it to an issue or share it. Values in `.dev.vars.example` are placeholders.

Open the deployed `https://weibo-checkin.<your-subdomain>.workers.dev` and unlock it. A different hostname or expired management session requires another unlock; saved upstream sessions are not deleted.

## 4. Verify one Weibo check-in

1. Generate a fresh QR code in the account page and confirm it in your Weibo app. Do not scan someone else's login QR code.
2. Check the displayed nickname and UID.
3. Read followed topics and levels. Personal levels may require a second mobile-site QR login with the same account.
4. Select topics from the list or search, then save. Reading follows does not automatically add all of them.
5. Run a manual check-in and inspect the records for success/already checked in. This makes real account changes.
6. If desired, enable daily scheduling and save. New instances default to off.
7. Check the displayed next attempt, randomly selected within 08:00–12:00 UTC+8 each day. Cron runs without an open browser or computer, but configuration propagation and execution may be delayed.

Weibo handles one topic per alarm, ten seconds apart. Login expiry, challenges, network errors and unknown results stop the run. Temporary validation-read failures retry after 45–75 minutes; authentication/challenge failures need action. An ambiguous check-in POST pauses the current day; inspect before manually resuming, or wait for the next daily plan. See [scheduling rules](SCHEDULING.md).

## Custom domain (optional)

Use a domain in the same Cloudflare account. Check for existing DNS/services before binding a hostname.

Create a private local copy:

```powershell
# Windows PowerShell
Copy-Item wrangler.jsonc wrangler.local.jsonc
```

```sh
# macOS / Linux
cp wrangler.jsonc wrangler.local.jsonc
```

Add a top-level `routes` field while retaining the other fields, especially the existing Worker's name, bindings and migrations:

```jsonc
"workers_dev": true,
"preview_urls": false,
"routes": [{ "pattern": "panel.example.com", "custom_domain": true }],
```

```sh
npm run deploy:local
```

Wrangler manages the domain and certificate. Investigate existing DNS/service conflicts before confirming a replacement. Once HTTPS works, unlock the new address. To use only the custom domain, set `workers_dev` to `false` in the local file and redeploy; the previous `workers.dev` entrance will stop serving the panel.

Always use the same configuration for code and secrets:

```sh
npm run deploy:local
node scripts/secrets.mjs --upload --config wrangler.local.jsonc
```

Do not change the Worker name or regenerate secrets just because its access address changes. The domain is public and is not authentication; Cloudflare Access can provide an additional gate.

## Upgrade and back up

```sh
git pull --ff-only
npm ci
npm run check
npm test
npm run deploy
```

For custom-domain installations, use `npm run deploy:local` last. Compare the new public config with your private local copy and incorporate required changes. Back up and inspect local changes if Git refuses a fast-forward update.

Normal updates to the same Worker retain Durable Object data and uploaded secrets. Preserve existing migrations and add the NodeSeek `v2`, Huya `v3` and NotificationCenter `v4` migrations, `NODESEEK` / `HUYA` / `NOTIFICATIONS` / `BROWSER` bindings and minute cron when upgrading from an older Weibo-only deployment. Do not delete the Worker, replace binding identities or regenerate encryption keys. A new Worker/account is a migration, not an automatic copy of old data.

Back up `.dev.vars`, any `wrangler.local.jsonc`, and an independent list of your configured topics. The last 200 log entries are not a database backup. Git and source ZIPs do not contain hosted cookies, databases or secrets. Credentials cannot currently be exported; deleting data or losing the encryption key requires reconnecting and reconfiguring.

Changing `ADMIN_TOKEN` invalidates dashboard sessions. Before replacing `ENCRYPTION_KEY`, disconnect Weibo, Huya and the Telegram Bot in the dashboard, update the key, then sign in again.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Missing admin/encryption secret | Upload secrets to the same Worker and configuration used for deployment. |
| Admin password rejected | Use the local `ADMIN_TOKEN` value, without `=`/extra spaces; not the encryption key or placeholder. |
| Cannot find `.dev.vars` | Look in the project root, including hidden files. It is not stored on GitHub. |
| Cloudflare login expired / denied | Repeat `wrangler login` and verify the account with `whoami`. |
| Durable Object migration fails | Check Workers availability, bindings and migrations. Do not delete production data to experiment. |
| Custom domain unavailable | Check the account, DNS conflict and certificate status; deploy the correct local configuration. |
| QR expired / challenge required | Generate a new QR code; complete verification in the official app, or use the Cookie fallback. |
| Follows work, levels missing | Connect the mobile site using the same account. Levels absent from upstream remain unknown. |
| Cookie expires again | Upstream controls expiry; reconnect or update the Cookie. |
| No morning run | Check the saved switch, topic list, login and cron. Completed topics are skipped that day. |
| Actions passed but dashboard unchanged | CI does not deploy. Run the deployment command in your own environment. |

Report only redacted information according to [Privacy and reporting](../SECURITY.md).
