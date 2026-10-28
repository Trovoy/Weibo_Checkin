**English** | [简体中文](NOTIFICATIONS.zh-CN.md)

# Telegram reports and alerts

The dashboard can send one daily report at **13:00 UTC+8** (editable), an alert when a platform fails, and a recovery message when it subsequently completes. Identical platform/error categories are notified once per day. A report is a snapshot, so unfinished tasks can keep retrying after it is sent. Ordinary failures do not block the next day's new check-in plan. Huya orders with uncertain results require reconciliation before another gift.

## Connect your Bot

1. In Telegram, open the official `@BotFather`, use `/newbot`, and create your own Bot. Keep its Token private.
2. Open a private conversation with your Bot and send `/start`. Bots cannot start private conversations with users themselves.
3. Get your numeric Telegram user ID (for example via `@userinfobot`) and use it as the Chat ID for this private conversation. For groups, use the group's numeric ID and add the Bot with permission to send messages.
4. In the unlocked dashboard, open **Notification settings**. Fill in the Token and Chat ID; save, then click **Send test message**. Do not post Tokens in chat, issues, or GitHub.
5. Check delivery in Telegram, enable automatic notifications, and save. Daily reports and anomaly alerts have independent switches. New deployments default to automatic notifications off.

Blank credential fields retain saved values. The API returns only a masked Chat ID and never returns the Token. Disconnecting removes saved Bot credentials and disables notifications. Use the explicit current-report button to inspect a report without changing daily deduplication.

## Delivery and privacy

The Worker calls only the official [`sendMessage` Bot API](https://core.telegram.org/bots/api#sendmessage), with escaped HTML for a bold heading, compact platform rows and a completion footer, disabled link previews and protected-content mode. Messages contain platform names, completion counts, rewards and fixed error categories. They omit upstream Cookies, account IDs, room details and management secrets; upstream error bodies are never copied into messages. These summary results are shared with Telegram and the configured recipient. Protected-content mode is not an end-to-end confidentiality guarantee.

Bot Token and Chat ID are encrypted together using the existing `ENCRYPTION_KEY` in an independent SQLite `NotificationCenter` Durable Object (`NOTIFICATIONS`, migration `v4`). Back up that key and preserve all prior migrations. No public webhook or inbound Bot command endpoint is created. Do not enable request-URL logging for Telegram subrequests: the Bot API includes its Token in the URL.

Minute cron reads local platform state only; notification polling never launches a browser or performs a check-in/gift. It persists a delivery claim before sending. Confirmed Telegram 429/5xx rejections retry after at least 15 minutes (respecting `retry_after`), with at most three attempts that day. Network timeouts, unreadable responses and interrupted sends remain unknown and are not automatically resent; inspect Telegram and the dashboard delivery history before manually sending again. The dashboard keeps a bounded recent delivery history. Failed notification delivery never rolls back a completed platform task.

If a test fails, check that the Bot Token is current, `/start` has been sent, the numeric Chat ID is correct, and the Bot is not blocked. No paid broadcast option is used.
