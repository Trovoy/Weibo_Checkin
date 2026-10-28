**English** | [简体中文](SECURITY.zh-CN.md)

# Privacy and reporting

This is a self-hosted, single-user tool. Public repository files must not contain real account settings, private domains, login QR codes, credentials or database snapshots.

## Data ownership and access

- The static login page can be public. Profiles, avatars, followed topics/levels and records require a management session; mutations also validate the request origin.
- Weibo/Huya cookies and temporary QR state use AES-256-GCM in your Cloudflare Durable Object; saved cookies are not returned to the browser. Profiles, configuration and check-in logs are also hosted by Cloudflare, without additional application-level encryption.
- Admin/encryption keys reside in your Cloudflare Secrets. A Worker administrator with the keys can read the data; this is not end-to-end encryption.
- The Worker contacts Weibo on the account's behalf for QR login, validation, levels and check-ins. A notification webhook runs only when configured.
- The dashboard loads no third-party analytics, external scripts or fonts. Weibo QR images use its official image host. Huya QR sign-in opens the official Huya page in Cloudflare Browser Run, serves the login image through an authenticated dashboard endpoint and closes the temporary browser on completion, cancellation or expiry.
- The admin token controls enabled platforms. Each platform has independent SQLite Durable Object state and encrypted credentials, and APIs expose allowlisted fields. A separate extension pairing token can only synchronize NodeSeek credentials; management still requires the panel session and same-origin requests. Public pairing/sync endpoints do not accept the panel Cookie as sync authorization.
- Optional Telegram notifications encrypt the Bot Token and Chat ID with `ENCRYPTION_KEY`, never return the Token, and send only summary counts, rewards and fixed status categories to the configured recipient. Telegram receives those summaries; protected-content mode is not end-to-end encryption. See [notification privacy and delivery](docs/NOTIFICATIONS.md).

The upstream download toolchain in Cloudflare Puppeteer 1.4.0 still has an `extract-zip` audit advisory without a published fix. This project uses remote Browser Run connections, not browser download/extraction APIs or user-uploaded archives. `basic-ftp` has been upgraded to a fixed version. This does not mean all dependency advisories are resolved; review upstream notices when upgrading.

A domain name is not a password, and search-indexing directives are not access control. Protect the admin token, Cloudflare account and backups; add Cloudflare Access if another gate is needed.

## Keep out of GitHub

- `.dev.vars`, real Secrets, Cloudflare API tokens and OAuth configuration.
- Weibo cookies, `SUB`, `SUBP`, complete request headers, HAR files, login tickets and valid QR codes.
- Unredacted profiles, followed lists, UIDs, records, logs or hosted databases.
- Your ignored `wrangler.local.jsonc`, which may contain private deployment domains.

For a bug report, provide steps, the error message, Node/Wrangler versions and checks already attempted. Redact nicknames, UIDs, domains, QR codes and credentials from screenshots, then inspect them again before publishing. Tests must use fictional credentials and IDs.

Run `npm run check:public` before committing; Actions also runs it. It checks public deployment config and tracked private-file paths, but cannot detect every sensitive value. Review the diff and history yourself.

## Suspected credential exposure

1. **Admin token:** replace/upload `ADMIN_TOKEN`; existing panel sessions become invalid.
2. **Weibo Cookie:** revoke affected devices/sessions in Weibo's official security settings, then reconnect. Deleting a GitHub file does not revoke a leaked login.
3. **Encryption key and ciphertext:** treat this as a Weibo/Huya credential leak. Disconnect affected accounts in the panel, replace the key and reconnect.
4. **Cloudflare token:** revoke it in Cloudflare and review Worker, domain and Secrets changes.

Do not publish exploitable account-access details or credentials in an issue. Check whether this repository offers GitHub's private vulnerability reporting first. If it does not, a public issue is not a substitute for a private channel for sensitive information.
