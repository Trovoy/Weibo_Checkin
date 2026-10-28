[English](NOTIFICATIONS.md) | **简体中文**

# Telegram 每日汇报与异常提醒

面板可在每天 **13:00（UTC+8，可修改）** 发送一次累计汇报，平台异常时提醒，之后完成时发送恢复通知。同一天相同平台、相同异常类别只提醒一次。汇报是发送时的快照，未完成任务之后仍继续补查。普通失败不会阻止次日新一轮签到；虎牙已发出但结果不明的订单仍需先核对，才能再次赠送。

## 连接自己的 Bot

1. 在 Telegram 打开官方 `@BotFather`，用 `/newbot` 创建自己的 Bot，私下保管 Token。
2. 打开与自己 Bot 的私聊，发送 `/start`；Bot 无法主动开启与用户的私聊。
3. 查询自己的数字 Telegram 用户 ID（例如通过 `@userinfobot`），作为该私聊的 Chat ID。群组应使用群组数字 ID，并先加入 Bot、允许其发送消息。
4. 解锁面板，进入「通知设置」，填写 Token 和 Chat ID，保存后点击「发送测试消息」。Token 不要发送到聊天、Issue 或 GitHub。
5. 核对 Telegram 收到消息后，勾选自动通知并保存。每日汇报、异常提醒可分别开关；新部署默认关闭自动通知。

凭证输入框留空保留原值。接口只回显脱敏 Chat ID，不回显 Token。「断开 Bot」删除保存的凭证并关闭通知。「发送当前汇报」用于检查当前结果，不改变每日汇报的去重。

## 发送与隐私

Worker 只调用官方 [`sendMessage` Bot API](https://core.telegram.org/bots/api#sendmessage)，使用经过转义的 HTML 区分加粗标题、平台状态行和完成汇总，关闭链接预览并开启内容保护。消息包含平台名称、完成数量、奖励和固定异常类别，不包含上游 Cookie、账号 ID、房间资料或管理密钥，也不复制上游原始报错。这些汇总结果会传给 Telegram 和配置的接收会话；内容保护不代表端到端保密。

Token 与 Chat ID 使用现有 `ENCRYPTION_KEY` 一起加密，存放在独立 SQLite `NotificationCenter` Durable Object（`NOTIFICATIONS`，迁移 `v4`）。升级时保留旧迁移并追加 v4，备份加密密钥。没有新增公开 Webhook 或入站 Bot 命令端点。不要开启 Telegram 子请求 URL 日志，因为官方 Bot API 将 Token 放在 URL 中。

分钟 Cron 只读取平台本地状态，通知检查不会启动浏览器、签到或赠送。发送前先保存去重标记。Telegram 明确返回 429 或 5xx 拒绝时，至少等 15 分钟并遵守 `retry_after` 后重试，当天最多三次。网络超时、响应不可读、进程中断等结果不明的发送不自动重复；请先核对 Telegram 与面板发送记录，再手动发送。面板保留有上限的近期通知记录。通知失败不会回滚已完成任务。

测试失败时，核对 Token、数字 Chat ID、是否向 Bot 发过 `/start`，以及 Bot 是否被屏蔽。没有开启付费广播。
