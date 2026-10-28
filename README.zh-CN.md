[English](README.md) | **简体中文**

# 每日 · 签到工作台

个人多平台签到工作台，使用 **Cloudflare Workers + SQLite Durable Objects**，不需要常驻服务器。微博、NodeSeek 与虎牙的签到、记录、配置、调度及扩展同步均在同一项目、同一个 Worker 中，后续平台也直接加入本项目。

这是对 2023 年 Python 版本的重写。旧脚本保留在 `legacy/weibo_checkin.py`，不再作为运行入口。

## 功能

- 原生多平台：微博和 NodeSeek 分别使用独立 SQLite Durable Object，手动与自动操作串行处理。NodeSeek 无须部署另一个 Worker 或面板，支持旧 KV 数据一次性迁移。
- 单账号控制台：扫码登录优先，完整 Cookie 导入备用，不收集账号密码。
- 分组工作台：总览只展示全平台统计和各平台摘要；微博签到下分签到与状态、超话管理和账号；NodeSeek 下分签到记录、设置、扩展同步；全部记录位于外层。官网入口仅在对应平台页面显示。展开收起与页面切换使用本地 GSAP，遵循减少动态效果设置，字体与布局适配不同屏幕。
- 外观模式：顶部可选择跟随系统、浅色或深色，全站页面和图表同步适配；选择保存在当前浏览器，刷新时预先应用，避免主题闪烁。
- 概览进度环：按每天的签到项目统计完成率，微博每个已配置超话计一项，已配置的 NodeSeek 账号计一项；状态未读全时显示待确认。圆环使用本地 GSAP 动画，支持减少动态效果。
- 概览同时显示今日分段圆环与近 7 天面积曲线；点击微博、NodeSeek 或虎牙可联动筛选，滑动日期可查看每天的平台明细。数值滚动、圆环和曲线过渡均使用 GSAP，并尊重系统的减少动态效果设置。同一天同一项目只计一次，失败和重试不增加数量。微博使用每日完成集合并补充保留的成功记录，NodeSeek 自动读取跨月记录；未知记录不当作零值，部分读取失败时明确标注并可重试。统计时区为 UTC+8。
- 按域名、路径和有效期维护 Cookie，接收 `Set-Cookie` 更新，固定 User-Agent。
- Cookie 与扫码临时状态使用 AES-256-GCM 加密后存储，前端无法读取已保存的 Cookie。
- 管理密钥解锁，使用有时限的 HttpOnly / SameSite 会话，写接口校验请求来源。
- 按名称搜索并选择超话，最多 30 个，每天在 08:00–12:00（UTC+8）随机首签，支持手动执行、停止和安全补查。
- 读取当前账号关注的超话，按需加入签到列表；个人等级通过手机网页关注卡片读取，未提供时显示未知。
- Alarm 每次处理一个超话，间隔 10 秒；按 UTC+8 日期跳过已完成项。
- 登录失效、风控、网络异常或未知响应时停止本轮任务，记录原因。签到 POST 结果未知时不自动重试。
- 最近 200 条记录；可选失败 Webhook，只发送摘要，同一提示成功通知后不重复发送。

NodeSeek 原生支持上午随机签到、安全补查、Cookie 健康检测、鸡腿记录与账单补全、浏览器扩展自动同步。首次安装默认关闭自动签到。参见 [NodeSeek 使用、迁移与扩展新平台](docs/PLATFORMS.zh-CN.md)。

**登录状态由微博控制，无法保证 Cookie 永不过期。** 接收新 Cookie 不等于自动续期。扫码、检测和签到使用非公开网页接口，微博可以修改或限制接口，Cloudflare 出口也可能被拒绝。遇到验证请在微博官方客户端完成，再重新扫码或更新 Cookie。项目不包含验证码绕过、密码自动登录或代理切换。

虎牙支持 App 扫码自动加密保存 Cookie，将当前背包内全部普通免费虎粮赠送至指定直播间。独立账号设置与记录，默认关闭自动执行；结果不明时暂停，空库存不计续期成功。参见 [虎粮赠送教程](docs/HUYA.zh-CN.md)。

## 部署到 Cloudflare

准备 Git、Node.js 24+（含 npm）和已开通 Workers 的 Cloudflare 账号。默认使用 Cloudflare 提供的 `workers.dev` 地址，无需购买域名、租服务器或配置 GitHub Secrets。SQLite Durable Objects 可用于 Workers Free；以 [Cloudflare 当前配额与定价](https://developers.cloudflare.com/durable-objects/platform/pricing/) 为准。

**第一次部署请看 [完整自部署教程](docs/DEPLOY.zh-CN.md)**，包含 Windows 操作、密钥说明、自定义域名、升级备份和常见故障。

```sh
git clone https://github.com/Trovoy/Weibo_Checkin.git
cd Weibo_Checkin
npm ci
npx wrangler login
# 首次生成管理密钥和加密密钥；不打印密钥。
node scripts/secrets.mjs
# 首次部署新 Worker，然后上传 Secret。
npm run deploy
node scripts/secrets.mjs --upload
```

默认 Worker 名为 `weibo-checkin`。首次部署前确认账号下没有需要保留的同名 Worker；若有，先修改 `wrangler.jsonc` 的 `name`，避免覆盖。Wrangler 会创建代码所需的 Durable Object 绑定与迁移，无需手工创建 KV、D1 或 R2。

打开部署输出的 `https://weibo-checkin.<你的子域>.workers.dev`。用文本编辑器打开本地 `.dev.vars`，复制 `ADMIN_TOKEN=` 后的值到面板解锁框。**管理密钥是面板密码，不是微博密码；`ENCRYPTION_KEY` 是服务端加密密钥，不用于登录。** 不要直接使用 `.dev.vars.example` 中的占位文字。

公开配置不包含任何个人域名或 Cloudflare 账号 ID。需要自定义域名时，使用被 Git 忽略的 `wrangler.local.jsonc`，按 [自定义域名说明](docs/DEPLOY.zh-CN.md#自定义域名可选) 配置。

1. 生成二维码，用微博 App 扫码并确认。微博拒绝请求时，可使用 Cookie 备用入口。
2. 点击「读取我的关注与等级」，或输入名称搜索，选择结果加入列表。也可通过 `https://weibo.com/p/100808...` 链接或 ID 添加；ID 为 `100808` 后接 32 位十六进制字符。
3. 保存设置，先点击「立即签到」，查看真实结果。
4. 成功后开启「每日自动签到」并保存。**首次部署默认关闭。**

共享 Cron 为 `* * * * *`，只检查各平台持久化计划是否到期。三个平台每天独立在 08:00–12:00（UTC+8）随机首签；安全的未完成任务间隔 45–75 分钟补查，持续到当天结束，已完成项跳过。详见 [调度与重试规则](docs/SCHEDULING.zh-CN.md)。可选 [Telegram 通知](docs/NOTIFICATIONS.zh-CN.md)，每天 13:00 汇报并发送去重的异常与恢复提醒。修改 Cron 后需重新部署，配置传播和实际触发可能有延迟。

### 关注列表与个人等级

电脑网页接口提供关注列表；个人等级来自手机网页 `m.weibo.cn` 的关注卡片，二者登录域不同。首次读取等级时，按提示点击「扫码连接个人等级」，使用同一个微博账号补充扫码。服务端核对账号 UID 一致后，仅合并手机网页域的 Cookie，保留已验证的电脑网页会话。登录凭证仍加密保存，不回显到浏览器。

读取支持分页，不会自动关注超话或把所有关注项加入签到。只有卡片明确提供的个人 `LV` 才作为等级展示，超话公开热度、粉丝数或发帖者等级不会被当作个人等级。手机网页登录失效或接口不可用时，仍可读取电脑网页关注列表，等级显示暂未提供。

### Cookie 备用登录

浏览器登录 `https://weibo.com`，开发者工具 → Network → 发往 `weibo.com` 的请求 → 复制 Request Headers 中完整的 `Cookie` 值，到控制台备用入口粘贴。必须包含 `SUB`，建议保留 `SUBP`、`XSRF-TOKEN` 等。不要复制 `Set-Cookie`，不要把 Cookie 发到 Issue、聊天或 Git。

新 Cookie 会先经过登录检测，成功后才替换现有会话。控制台不回显 Cookie；传输到服务端和导入时仍为敏感登录凭证，请保护管理密钥和 Cloudflare 账号。

### 面板隐私

域名是公开地址，不是访问凭证。未登录可访问静态登录界面，但账号资料、头像、关注及等级、签到记录与操作接口都要求有效管理会话。会话 Cookie 仅限当前主机，使用 Secure、HttpOnly、SameSite=Strict，12 小时后过期；写请求还校验完整 Origin，其他同站子域不能代为提交操作。

线上强制 HTTPS，响应禁止缓存、嵌入和搜索引擎收录；不加载外部统计、字体或脚本。禁止收录只是给搜索引擎的声明，不能替代鉴权。微博、虎牙 Cookie 与扫码临时状态加密保存，账号资料及签到配置仍由 Cloudflare 托管；能够控制 Worker 代码及密钥的 Cloudflare 账户管理员具备读取能力，因此不属于端到端加密。若需在登录页前再限制访问，可额外配置 Cloudflare Access。

### 密钥与通知

| Secret | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 至少 32 字符，建议随机生成。修改后所有控制台会话失效。 |
| `ENCRYPTION_KEY` | 32 字节随机数据的 Base64。用于加密 Cookie 与扫码状态。请备份，丢失后无法解密原登录。 |
| `NOTIFY_WEBHOOK_URL` | 可选 HTTPS 地址，接收 POST JSON `{ "title": "微博签到需要处理", "content": "失败摘要" }`，不包含 Cookie。 |
| `NODESEEK_CREDENTIAL_KEY` | NodeSeek 独立加密密钥，至少 32 字符；新实例由脚本生成，迁移旧实例须保留其原 `CREDENTIAL_KEY`。 |

用 `npx wrangler secret put NAME` 更新单个 Secret，或修改 `.dev.vars` 后运行 `node scripts/secrets.mjs --upload`。脚本只上传上表中的配置，不上传其他变量。使用本地部署配置时，追加 `--config wrangler.local.jsonc`，确保密钥与代码上传到同一个 Worker。`.dev.vars` 已被 Git 忽略，不能提交。替换加密密钥前先在控制台断开账号，换密钥后重新登录。

## 本地开发与验证

```sh
npm ci
node scripts/secrets.mjs
npm run dev
npm run check
npm run check:public
npm test
npm run build
```

本地运行也会真实访问微博；测试使用模拟网络，不操作真实账号。覆盖 Cookie 隔离与更新、加密、会话校验、扫码协议、关注分页、个人等级解析及跨域账号一致性、成功/已签响应、并发去重、失效停止、跨日和对象重建恢复。`npm run build` 是 Wrangler dry-run，不发布。前端无需额外构建。

GSAP 固定为 npm 依赖中的版本，发布资源保存在 `public/vendor/`，保留原始许可声明，不从外部 CDN 加载。升级 GSAP 后运行 `node scripts/vendor.mjs` 更新静态文件。账号头像通过有管理会话保护的同源端点读取，第三方图片不可用时显示昵称首字母。

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
- Alarm 至少一次投递。微博请求发送前会保存待确认标记，中断后阻止自动重复提交；当天需核对平台结果后手动恢复，次日重新开始每日签到。这无法保证上游请求恰好执行一次。
- 任一超话失败即停止本轮。修复后可手动重试，跳过完成项；失效或风控需先重新登录 / 检测。Cron 没有当日自动补签重试。
- 去重日期保留 7 天，历史最多 200 条。跨日旧任务停止，次日 Cron 或手动运行新任务。
- 本版面向一个人的一个账号，不提供公开注册或多人隔离。更换微博账号前请先断开旧账号。
- 关闭自动签到可停止每日任务。删除 Durable Object 数据会清除配置和登录状态。

## 参考与验证边界

参考 [原始项目](https://github.com/Trovoy/Weibo_Checkin)、[近期签到接口说明](https://github.com/88lin/weibo-checkin/blob/main/weibo_checkin.py)、[新浪扫码流程](https://github.com/CharlesPikachu/DecryptLogin/blob/master/DecryptLogin/modules/core/weibo.py) 及 [Cloudflare Alarms 文档](https://developers.cloudflare.com/durable-objects/api/alarms/)。微博端点是非公开接口，模拟测试通过不能代替真实账号验收。

本版本已在实际 Cloudflare 环境验证电脑网页扫码、手机网页补充扫码、账号资料、关注与个人等级读取，以及手动超话签到。每个自行部署的实例仍需完成自己的验收：生成二维码 → 手机确认 → 状态检测有效 → 超话签到成功 / 已签 → 开启自动签到 → 次日检查结果。Cron 定时执行和长期登录稳定性需要运行观察。

提交问题前请阅读 [隐私与问题反馈说明](SECURITY.zh-CN.md)，不要附带 Cookie、密钥、登录二维码或完整请求头。
