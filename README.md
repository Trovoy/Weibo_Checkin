# 每日 · Weibo Check-in

个人微博超话签到工具，使用 **Cloudflare Workers + SQLite Durable Objects**，不需要常驻服务器。

这是对 2023 年 Python 版本的重写。旧脚本保留在 `legacy/weibo_checkin.py`，不再作为运行入口。

## 功能

- 单账号控制台：扫码登录优先，完整 Cookie 导入备用，不收集账号密码。
- 按域名、路径和有效期维护 Cookie，接收 `Set-Cookie` 更新，固定 User-Agent。
- Cookie 与扫码临时状态使用 AES-256-GCM 加密后存储，前端无法读取已保存的 Cookie。
- 管理密钥解锁，使用有时限的 HttpOnly / SameSite 会话，写接口校验请求来源。
- 按名称搜索并选择超话，最多 30 个，每天 09:00（UTC+8）自动签到，支持手动执行、停止和重试。
- 读取当前账号关注的超话，按需加入签到列表；个人等级通过手机网页关注卡片读取，未提供时显示未知。
- Alarm 每次处理一个超话，间隔 10 秒；按 UTC+8 日期跳过已完成项。
- 登录失效、风控、网络异常或未知响应时停止本轮任务，记录原因。签到 POST 结果未知时不自动重试。
- 最近 200 条记录；可选失败 Webhook，只发送摘要，同一提示成功通知后不重复发送。

**登录状态由微博控制，无法保证 Cookie 永不过期。** 接收新 Cookie 不等于自动续期。扫码、检测和签到使用非公开网页接口，微博可以修改或限制接口，Cloudflare 出口也可能被拒绝。遇到验证请在微博官方客户端完成，再重新扫码或更新 Cookie。项目不包含验证码绕过、密码自动登录或代理切换。

## 部署到 Cloudflare

需要 Node.js 24+、npm，以及已开通 Workers 的 Cloudflare 账号。SQLite Durable Objects 可用于 Workers Free；以 [Cloudflare 当前配额与定价](https://developers.cloudflare.com/durable-objects/platform/pricing/) 为准。

```sh
npm ci
npx wrangler login
# 首次生成管理密钥和加密密钥；不打印密钥。
node scripts/secrets.mjs
# 首次部署新 Worker，然后上传 Secret。
npm run deploy
node scripts/secrets.mjs --upload
```

默认 Worker 名为 `weibo-checkin`。若已有同名服务，请先修改 `wrangler.jsonc` 的 `name`，避免覆盖。无需 KV、D1 或 R2。

打开 Wrangler 返回的 `https://weibo-checkin.<你的子域>.workers.dev`，用本地 `.dev.vars` 中的 `ADMIN_TOKEN` 解锁。

1. 生成二维码，用微博 App 扫码并确认。微博拒绝请求时，可使用 Cookie 备用入口。
2. 点击「读取我的关注与等级」，或输入名称搜索，选择结果加入列表。也可通过 `https://weibo.com/p/100808...` 链接或 ID 添加；ID 为 `100808` 后接 32 位十六进制字符。
3. 保存设置，先点击「立即签到」，查看真实结果。
4. 成功后开启「每日自动签到」并保存。**首次部署默认关闭。**

Cron 为 `0 1 * * *`（UTC），即 UTC+8 的 09:00。修改 `wrangler.jsonc` 后需重新部署，Cron 传播可能需要数分钟。

### 关注列表与个人等级

电脑网页接口提供关注列表；个人等级来自手机网页 `m.weibo.cn` 的关注卡片，二者登录域不同。首次读取等级时，按提示点击「扫码连接个人等级」，使用同一个微博账号补充扫码。服务端核对账号 UID 一致后，仅合并手机网页域的 Cookie，保留已验证的电脑网页会话。登录凭证仍加密保存，不回显到浏览器。

读取支持分页，不会自动关注超话或把所有关注项加入签到。只有卡片明确提供的个人 `LV` 才作为等级展示，超话公开热度、粉丝数或发帖者等级不会被当作个人等级。手机网页登录失效或接口不可用时，仍可读取电脑网页关注列表，等级显示暂未提供。

### Cookie 备用登录

浏览器登录 `https://weibo.com`，开发者工具 → Network → 发往 `weibo.com` 的请求 → 复制 Request Headers 中完整的 `Cookie` 值，到控制台备用入口粘贴。必须包含 `SUB`，建议保留 `SUBP`、`XSRF-TOKEN` 等。不要复制 `Set-Cookie`，不要把 Cookie 发到 Issue、聊天或 Git。

新 Cookie 会先经过登录检测，成功后才替换现有会话。控制台不回显 Cookie；传输到服务端和导入时仍为敏感登录凭证，请保护管理密钥和 Cloudflare 账号。

### 密钥与通知

| Secret | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 至少 32 字符，建议随机生成。修改后所有控制台会话失效。 |
| `ENCRYPTION_KEY` | 32 字节随机数据的 Base64。用于加密 Cookie 与扫码状态。请备份，丢失后无法解密原登录。 |
| `NOTIFY_WEBHOOK_URL` | 可选 HTTPS 地址，接收 POST JSON `{ "title": "微博签到需要处理", "content": "失败摘要" }`，不包含 Cookie。 |

用 `npx wrangler secret put NAME` 更新单个 Secret，或修改 `.dev.vars` 后运行 `node scripts/secrets.mjs --upload`。脚本会上传文件里的所有 Secret。`.dev.vars` 已被 Git 忽略，不能提交。替换加密密钥前先在控制台断开账号，换密钥后重新登录。

## 本地开发与验证

```sh
npm ci
node scripts/secrets.mjs
npm run dev
npm run check
npm test
npm run build
```

本地运行也会真实访问微博；测试使用模拟网络，不操作真实账号。覆盖 Cookie 隔离与更新、加密、会话校验、扫码协议、关注分页、个人等级解析及跨域账号一致性、成功/已签响应、并发去重、失效停止、跨日和对象重建恢复。`npm run build` 是 Wrangler dry-run，不发布。前端无需额外构建。

## 运行方式和限制

```text
浏览器 → Worker（管理会话 / 同源检查 / 静态控制台）
                   ↓
       一个 SQLite Durable Object
         ├─ 加密 Cookie、扫码临时状态
         ├─ 配置、每日去重、最近记录
         └─ Alarm → 检测登录 → 逐个超话签到
                   ↑
           Cron 每天触发（默认关闭）
```

- 只将 `100000` 识别为成功，`382004` 识别为当日已签，兼容数字与字符串。未知代码不会显示成功。
- 签到使用 `POST /ajax_proxy/chaohua/page/checkin`，登录检测使用 `/ajax/setting/getPrivacy`，扫码使用新浪 SSO。
- 停止任务需要等当前网络请求完成；每次请求超时 15 秒。
- Alarm 至少一次投递。本地会跳过已完成项；若微博已处理但在持久化前进程中断，无法保证网络请求恰好一次，后续依赖微博「已签到」响应。
- 任一超话失败即停止本轮。修复后可手动重试，跳过完成项；失效或风控需先重新登录 / 检测。Cron 没有当日自动补签重试。
- 去重日期保留 7 天，历史最多 200 条。跨日旧任务停止，次日 Cron 或手动运行新任务。
- 本版面向一个人的一个账号，不提供公开注册或多人隔离。更换微博账号前请先断开旧账号。
- 关闭自动签到可停止每日任务。删除 Durable Object 数据会清除配置和登录状态。

## 参考与验证边界

参考 [原始项目](https://github.com/Trovoy/Weibo_Checkin)、[近期签到接口说明](https://github.com/88lin/weibo-checkin/blob/main/weibo_checkin.py)、[新浪扫码流程](https://github.com/CharlesPikachu/DecryptLogin/blob/master/DecryptLogin/modules/core/weibo.py) 及 [Cloudflare Alarms 文档](https://developers.cloudflare.com/durable-objects/api/alarms/)。微博端点是非公开接口，模拟测试通过不能代替真实账号验收。

上线后须在实际 Cloudflare 出口验证：生成二维码 → 手机确认 → 状态检测有效 → 超话签到成功 / 已签 → Cron 自动执行。**没有真实登录及签到结果前，本版属于待实测版本。**
