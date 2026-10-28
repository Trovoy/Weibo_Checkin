**English** | [简体中文](PLATFORMS.zh-CN.md)

# NodeSeek and platform integration

Weibo, NodeSeek and Huya share this repository, Worker, management UI and scheduler. Each platform owns a separate SQLite Durable Object and serializes manual and scheduled operations through the same instance. No second dashboard or Service Binding is required.

Huya has its own grouped pages, encrypted QR sessions, backpack-only gifting and daily schedule. See the [Huya guide](HUYA.md).

## Start using NodeSeek

Follow the [deployment guide](DEPLOY.md). The default configuration includes the `NodeSeekAccount` migration, `NODESEEK` binding, `BROWSER` binding and minute cron. Your account must support Cloudflare Browser Run under its current quotas/pricing. Opening the dashboard alone does not start a remote browser.

The secret generator adds `NODESEEK_CREDENTIAL_KEY` without overwriting existing keys. This encrypts NodeSeek cookies and seeds stable random schedules; back it up.

1. Open NodeSeek → settings in the sidebar.
2. Save your Cookie and the User-Agent used to obtain it, or connect the extension below. Password-based automatic login is not provided.
3. Check the Cookie, confirm the result and try a manual check-in.
4. Choose the time window and random/fixed reward mode. Enable daily check-in only if wanted; new instances default to off.

A stable first-attempt minute is selected each day within 08:00–12:00 UTC+8 (or a narrower saved morning window). Temporary unfinished work retries after 45–75 minutes until the day ends. Confirmed daily records skip further check-ins and have no TTL. After ambiguous writes, the ledger must establish the result before another POST; incomplete evidence allows only further reads. Authentication, challenges and configuration failures need operator action. See [scheduling rules](SCHEDULING.md).

Ledger reconciliation reads at most five pages and saves check-in amounts/timestamps, not balances or unrelated spending. Unknown rewards and times remain explicitly unknown.

## Browser synchronization extension

Download and extract the ZIP from the dashboard's extension page. Enable developer mode in Chrome/Edge's extension manager and load the extracted directory; the repository's `extension/` directory also works.

Enter **your own HTTPS panel root**, such as `https://panel.example.com`, connect and grant access to that address. The extension opens the dashboard: unlock it with your admin token, approve pairing in the extension page, then check the connection from the extension. Cookies are subsequently synchronized on changes, NodeSeek visits and periodic checks.

Update older extensions and re-pair after a domain change. Browser host permission must be granted explicitly. Existing migrated cloud cookies may remain valid; pairing does not require another check-in.

Pairing uses a ten-minute random challenge and verifier proof, approved only by an unlocked management session. The synchronization token can update NodeSeek credentials but cannot read account data, edit schedules or trigger check-in. A new pairing replaces the previous browser; disconnecting the extension can retain saved cloud cookies.

The extension reads NodeSeek cookies only. HTTP host permission allows access to non-Secure site cookies; network synchronization still uses HTTPS. Dashboard host permission is requested for the address you enter rather than every website. Do not connect to a dashboard you do not control.

`npm run build`, `npm run deploy` and `npm run deploy:local` generate `public/extension.zip`. It contains no personal address, cookies or secrets and requires no domain-specific source edits.

## Migrate an older standalone Worker

Back up the old configuration, secrets and KV data. Stop its cron and freeze synchronization writes before the new instance reads the final data. Never run both engines simultaneously. When updating the same dashboard, preserve its Worker name, Weibo bindings and existing migrations.

1. Temporarily add the old KV as an import binding in ignored `wrangler.local.jsonc`:

```jsonc
"kv_namespaces": [{ "binding": "NODESEEK_LEGACY_STATE", "id": "replace-with-old-kv-id" }],
```

2. Copy the old `CREDENTIAL_KEY` value to `NODESEEK_CREDENTIAL_KEY` and upload it. Do not generate a different key.
3. Deploy. First activation imports encrypted config, daily records, time windows, health state and extension-pairing digests. Temporary pending pairings are excluded. Cookie decryption is checked before the transaction commits; a failure does not mark the import complete.
4. Verify dates, rewards, claim times/counts, Cookie health and today's deduplication. Migrated enabled schedules remain enabled; fresh installations default to off.
5. Remove `NODESEEK_LEGACY_STATE`, redeploy and verify. Completed imports never overwrite newer data again.
6. Update and reconnect the extension. Retire the old Worker, entry point, old management secret and dedicated Access application only after independent operation is confirmed. Delete the old KV only after checking other consumers and a recoverable backup.

`NODESEEK_SERVICE` and `NODESEEK_ADMIN_TOKEN` are no longer used. Remove those obsolete bindings/secrets after migration. Never publish real KV IDs, private domains or credentials.

## Add another platform

1. Implement its execution, state and credential storage in `src/<platform>/`, using a separate Durable Object shared by its manual/scheduled operations.
2. Register its ID, name, availability and dispatch in `src/platforms.ts`. Use fixed API paths, validated inputs and allowlisted output fields; never accept arbitrary URLs or uploaded scripts.
3. Register pages in `public/app.js` and navigation/controls in `public/index.html`. Overview cards come from platform registration. Use local GSAP and respect reduced motion.
4. Dispatch from the shared scheduler in `src/index.ts`; update Wrangler bindings/migrations. Reuse the dashboard.
5. Add authentication, credential-isolation, ambiguous-outcome, deduplication and persistence-recovery tests, then run checks, tests, public-config checks and build.

Each platform still needs its own protocol and scheduling rules. This is not a no-code plugin system or arbitrary script host.
