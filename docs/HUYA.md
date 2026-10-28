**English** | [简体中文](HUYA.zh-CN.md)

# Huya free backpack tiger food

Huya runs natively in the shared Worker with an isolated HUYA / HuyaAccount SQLite Durable Object. Upgrades retain v1/v2 migrations and append v3; existing Weibo and NodeSeek storage is preserved. No separate dashboard, service token or extension permission is needed.

## Connect and use

1. Unlock the dashboard and open Huya → account/settings in the grouped sidebar.
2. Enter the target room number. Saving resolves the public Huya room page and records its broadcaster UID/name; arbitrary URLs and redirect rooms are rejected.
3. Generate a login QR code and scan/confirm it in the Huya app. A cloud browser opens the official login page and captures the resulting Cookie, then closes. QR sign-in does not send gifts.
4. Open tiger food/records, read the backpack, check the displayed recipient, then send all free tiger food.
5. Verify a successful real delivery before enabling the daily schedule. Fresh installs default to off, with an editable default time of 09:30 UTC+8.

Inventory is a timestamped snapshot. Opening the Huya page refreshes snapshots older than one minute; while the page stays open, normal polling also refreshes stale inventory. The refresh-status button always reads the backpack again without sending gifts. A failed read displays unknown inventory, not zero. The previous task result is shown with its own time; an earlier empty result does not mean newly detected stock is empty. The once-per-day automatic attempt remains unchanged; after an empty scheduled attempt, inspect the new stock and send manually if needed.

Local browser logins do not automatically synchronize to the Worker. QR sign-in requires the BROWSER binding. Temporary sessions/images are encrypted with AES-256-GCM, accessible only after dashboard unlock and cleaned up on completion, cancellation or a three-minute expiry. Reloading the page can resume an active QR session. Saved Cookies use the existing ENCRYPTION_KEY and are not returned to the browser.

If QR sign-in requires a challenge, complete it on the official site or use the Cookie fallback. In a logged-in desktop Huya page, open developer tools → Network, refresh, and copy the Request Cookie header value from a huya.com request, without the Cookie: prefix. Paste it only into your dashboard. Never share Cookies in chat, logs or GitHub. Huya controls expiry; QR capture does not make a Cookie permanent. Reconnect when it expires.

## Delivery boundaries

- Only ordinary backpack tiger food with item ID 4 and the exact name 虎粮 is eligible. Other gifts and super-fan tiger food are excluded.
- Each run reads the full inventory count, including values above the UI's 999+ display, and sends that snapshot quantity to one configured broadcaster. The broadcaster UID is rechecked against the public room page before delivery.
- Requests use the official package page's consumeGiftSafe with fixed iPayPloy=2, the backpack policy. There is no purchase, recharge or fallback to paid balances.
- Before sending, the engine persists the order ID, recipient and count. Success requires matching order, item, count, recipient, zero payment and a second inventory read confirming zero remaining stock.
- Lost responses, unknown codes, changed receipts, inconsistent deductions or interrupted execution pause further delivery. No new order is automatically retried. Check Huya's backpack and gift ledger before manually clearing the pause; automatic execution remains off after reconciliation.
- At most one successful delivery per UTC+8 date; manual and scheduled calls share deduplication. The daily plan attempts once, without minute-by-minute retries after failures or empty inventory. A manual attempt remains possible after inspection.
- Empty stock does not count as success or prove fan-badge renewal. Successful delivery confirms the gift only; this integration does not read or guarantee badge expiry dates.
- The last 200 operations are retained. Overview statistics count successful delivery days, one item per day; gift quantities appear separately in the Huya page.

## Protocol and deployment notes

The implementation uses fields from the official https://hd.huya.com/web/webPackageV2/index.html page (observed bundle umi.0b4ee0c1.js): getPackageGift, getSequence and consumeGiftSafe. No third-party check-in script is executed or bundled. The project's WUP v3 codec bounds response size, nesting, collection counts and integer precision, rejects duplicate fields and stops on unrecognized responses.

MD5 application constants in the source are public web-client protocol constants, not deployment secrets. Personal rooms, broadcaster UIDs, credentials and records stay in private Durable Object storage. These non-public interfaces and Cloudflare egress availability may change; test your own account before enabling scheduling. Mocked tests cannot prove upstream behavior or long-term login validity.
