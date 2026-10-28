**English** | [简体中文](SCHEDULING.zh-CN.md)

# Daily schedules and safe retries

All dates and times use UTC+8. Weibo, NodeSeek and Huya independently select one first-attempt minute within **08:00 inclusive–12:00 exclusive** each day. NodeSeek can use a narrower window inside these hours. The draw is derived from the date, platform and private encryption key, so refreshing the page or restarting the Worker does not redraw it.

The shared `* * * * *` cron only checks whether a plan is due. Before upstream I/O, the platform persists its attempt and the next randomly delayed check, **45–75 minutes later**, rounded up to a minute boundary. Safe unfinished work can continue after noon until the end of that UTC+8 day. No retry carries into the next day; a new morning plan takes over. Cloudflare can deliver cron late, so these are due times rather than exact delivery guarantees.

| Platform | Retry behavior | Completion / pause |
| --- | --- | --- |
| Weibo | Retry a temporary validation GET failure; skip topics already completed that day. | Stop on expired login/challenges. A pending or uncertain check-in POST blocks automatic submission, for the rest of that day; verify before manually resuming. The next day starts a fresh check-in plan if the login remains valid. Manual stop pauses the rest of the day. |
| NodeSeek | Retry temporary network/server/browser/limit failures. After an ambiguous write, read the ledger before another POST; incomplete evidence permits only more reads. | Confirmed daily success prevents further check-ins. Authentication, challenge and configuration failures need operator action. |
| Huya | Re-read after an empty backpack or a failure before sending; each send uses the current free tiger-food inventory. | One successful delivery per day. Persisted pending orders or uncertain receipts pause gifting across days until explicit reconciliation. No paid fallback. |

Schedules require their platform's switch to be enabled and credentials/configuration to be ready. New installations default to off. Manual runs share daily deduplication; they do not bypass Huya's pending-order lock. The dashboard shows the next due time or a pause message. Once today's work succeeds it shows the next morning plan.

Upgrading preserves credentials, history, platform switches and room configuration. Existing Huya failures/empty attempts seed a retry from their recorded time; the legacy fixed-time field remains readable for API compatibility but no longer controls automatic execution. NodeSeek's valid saved morning window is retained; windows outside 08:00–12:00 fall back to the full morning window.
