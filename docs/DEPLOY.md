# 自行部署到 Cloudflare

本教程为你自己的个人签到工作台服务。仓库只提供代码，不提供公共面板或共享登录服务。微博、NodeSeek 和虎牙都在同一 Worker 中运行，各自使用独立存储。NodeSeek 使用与旧实例迁移参见 [平台教程](PLATFORMS.md)，虎牙接入参见 [虎粮赠送教程](HUYA.md)。

## 准备

- 安装 [Node.js](https://nodejs.org/) 24 或更新版本，以及 [Git](https://git-scm.com/)。安装 Node.js 时保留 npm。
- 注册并登录 [Cloudflare](https://dash.cloudflare.com/)，开通 Workers；首次使用时按后台提示设置自己的 `workers.dev` 子域。
- 准备微博 App，以便扫码确认登录。无需把微博密码提供给本项目。
- 若想在自己的 GitHub 账号保存项目，可先 Fork 本仓库，再克隆自己的 Fork。Fork 不会自动部署，也不包含原作者的线上数据。

在 Windows PowerShell、macOS Terminal 或 Linux 终端中检查：

```sh
node --version
npm --version
git --version
```

Windows 如遇到 `npm.ps1` 无法运行，可使用命令提示符（cmd），或把下面的 `npm` / `npx` 分别写成 `npm.cmd` / `npx.cmd`；不必为部署关闭系统执行策略。

## 获取代码并安装依赖

```sh
git clone https://github.com/Trovoy/Weibo_Checkin.git
cd Weibo_Checkin
npm ci
```

如果已经 Fork，把克隆地址替换为自己的仓库。使用 GitHub 下载 ZIP 也可以，解压后进入包含 `package.json` 的目录再运行 `npm ci`。

## 登录 Cloudflare 并检查配置

```sh
npx wrangler login
npx wrangler whoami
```

Wrangler 会打开浏览器完成 Cloudflare 授权。确认 `whoami` 显示的是准备部署的账号。若你有多个 Cloudflare 账号，先确认目标账号再部署。

默认配置在 `wrangler.jsonc`：

| 配置 | 默认值与用途 |
| --- | --- |
| `name` | `weibo-checkin`，Worker 名称。首次部署前确认没有需要保留的同名服务。 |
| `workers_dev` | `true`，使用 Cloudflare 提供的访问地址。 |
| `preview_urls` | `false`，不提供版本预览入口。 |
| `durable_objects` / `migrations` | 存储账号和签到状态，由 Wrangler 创建；保留原配置。 |
| `triggers.crons` | `0 1 * * *` 只触发微博；`* * * * *` 检查 NodeSeek 与虎牙各自的到期计划。 |
| `browser` | NodeSeek 使用 Cloudflare Browser Run；需账号可用并遵守其当前配额和计费。 |

无需手工创建数据库、KV、R2 或绑定。无需 GitHub Actions 部署 Token；仓库中的 Actions 只检查代码，不会部署到 Cloudflare。

## 生成密钥、发布代码

```sh
node scripts/secrets.mjs
npm run deploy
node scripts/secrets.mjs --upload
```

按顺序执行：先在本地生成密钥，再创建 Worker，最后通过 Cloudflare Secret 上传密钥。代码刚发布、密钥尚未上传时，面板 API 返回“请先设置 ADMIN_TOKEN…”是正常的；上传完成后刷新页面。

密钥脚本生成本地 `.dev.vars`，已有文件不会被覆盖，密钥也不会打印到终端。请用文本编辑器打开文件：

- `ADMIN_TOKEN`：面板登录密码，复制等号后面的值解锁控制台。不是微博密码。
- `ENCRYPTION_KEY`：服务端用来加密微博 Cookie 的密钥。不要填到面板登录框。
- `NODESEEK_CREDENTIAL_KEY`：NodeSeek Cookie 加密及随机计划使用的独立密钥。迁移旧实例时先填写旧 `CREDENTIAL_KEY`；新实例由脚本生成。

请把 `.dev.vars` 备份到自己的密码管理器或其他安全位置；不要提交 Git、上传 Issue 或发给别人。`.dev.vars.example` 只有格式示例，其中的文字不能直接用作密钥。

部署结束会输出类似 `https://weibo-checkin.<你的子域>.workers.dev` 的地址。打开这个地址，输入自己的 `ADMIN_TOKEN`。每次更换域名或管理会话过期后需要重新解锁，已保存的微博会话不会因此删除。

## 连接微博并完成一次签到

1. 在“微博账号”页面生成二维码，用微博 App 扫描并确认。二维码过期就刷新，不要扫描他人提供的登录二维码。
2. 登录成功后核对昵称与 UID。登录信息保存在服务端，重新打开面板不需要每次扫码。
3. 在“我的超话”点击“读取我的关注与等级”。首次读取个人等级时还需要按提示补充一次手机网页扫码，并使用同一个微博账号。
4. 从关注列表选择加入签到，或者按名称搜索添加，点击“保存设置”。读取关注列表不会自动全部加入签到。
5. 回到“签到概览”，点击“立即签到”，在“签到记录”核对成功或当日已签。签到是真实操作。
6. 如需每天自动执行，再到“我的超话”开启“每日自动签到”并保存。默认关闭。
7. 次日 09:00（UTC+8）后核对记录。Cloudflare Cron 在后台运行，不需要一直开着浏览器或电脑；Cron 配置传播和实际触发可能有延迟。

一次处理一个超话，间隔 10 秒。遇到登录失效、验证、网络异常或未知结果会停止本轮。先解决提示的问题，再手动重试；结果未知的签到请求不会自动反复提交。

## 自定义域名（可选）

域名需要托管在同一个 Cloudflare 账号中。先确认准备使用的子域没有现有服务，避免覆盖 DNS 或域名绑定。

为了避免把自己的域名提交到公开仓库，复制一份本地配置：

Windows PowerShell：

```powershell
Copy-Item wrangler.jsonc wrangler.local.jsonc
```

macOS / Linux：

```sh
cp wrangler.jsonc wrangler.local.jsonc
```

用编辑器打开 `wrangler.local.jsonc`，在顶层增加 `routes`；把示例替换为自己的子域。保留文件里的其他字段，尤其是现有 Worker 的 `name`、Durable Object 绑定和迁移：

```jsonc
"workers_dev": true,
"preview_urls": false,
"routes": [{ "pattern": "panel.example.com", "custom_domain": true }],
```

然后运行：

```sh
npm run deploy:local
```

Wrangler 会处理自定义域名和证书。若提示与已有 DNS 或服务冲突，先核对已有用途，不要直接确认覆盖。证书生效后通过 HTTPS 打开新地址并解锁。

确认新地址可用后，如果只想保留自定义域名，把本地文件中的 `workers_dev` 改为 `false`，再次运行 `npm run deploy:local`。旧 `workers.dev` 地址将不能再打开面板。

此后发布代码和上传密钥要使用同一份本地配置：

```sh
npm run deploy:local
node scripts/secrets.mjs --upload --config wrangler.local.jsonc
```

`wrangler.local.jsonc` 已被 Git 忽略。为同一个 Worker 绑定域名无需重新生成密钥；不要因更换访问地址而更换 Worker 名称。域名是公开地址，不提供额外身份验证；可按需在前面再配置 Cloudflare Access。

## 升级与备份

使用默认配置部署的 Git 克隆：

```sh
git pull --ff-only
npm ci
npm run check
npm test
npm run deploy
```

使用自定义域名配置时，最后一步改为 `npm run deploy:local`。先对照新版公开配置，把必要的新字段更新到本地配置；私有域名继续保存在本地文件。若 `git pull` 提示有本地改动，先备份并查看差异，不要直接覆盖。

同名 Worker 的正常更新会保留 Durable Object 数据和已上传的 Secrets。升级时不要删除 Worker、修改绑定身份或重新生成加密密钥。保留已存在的迁移，并按新配置增加 `NodeSeekAccount` 的 `v2`、`HuyaAccount` 的 `v3` 迁移及 `NODESEEK`、`HUYA`、`BROWSER` 绑定和分钟 Cron；不要覆盖自己的域名。更换 Worker / Cloudflare 账号属于迁移，不能假定旧数据会自动跟随。

需要保留的内容：

- `.dev.vars`：管理密钥、加密密钥、可选通知地址及平台服务密钥。
- `wrangler.local.jsonc`：如有，包含自己的域名和部署选项。
- 签到列表：可另外记录超话名称与 ID。服务端记录保留最近 200 条，不等于完整备份。

仓库和源码 ZIP 不包含线上数据库、微博 Cookie 或密钥，无法用它们恢复登录。当前不提供凭证导出功能；删除 Worker / Durable Object 或丢失加密密钥后，需要重新登录和配置。

修改 `ADMIN_TOKEN` 会使旧面板会话失效；修改 `ENCRYPTION_KEY` 会使旧凭证无法解密。若确需更换加密密钥，先在面板断开微博账号，再更新密钥并重新扫码。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 提示缺少管理 / 加密密钥 | 确认已经执行 `--upload`，并且使用与部署相同的 Worker 名和配置文件。 |
| 管理密钥不正确 | 使用本地 `.dev.vars` 的 `ADMIN_TOKEN` 值，去掉等号和空格；不要用 `ENCRYPTION_KEY` 或示例占位文字。 |
| 找不到 `.dev.vars` | 它在项目根目录，部分文件管理器会隐藏点开头文件；它不会出现在 GitHub 仓库中。 |
| Cloudflare 授权过期 / 权限不足 | 重新执行 `npx wrangler login`，通过 `whoami` 核对账号后重试。 |
| Durable Object 迁移失败 | 检查账户是否开通 Workers、绑定和迁移配置是否完整；不要通过删除现有数据库试错。 |
| 自定义域名未生效 | 核对域名账号、DNS 冲突和证书状态，等待 DNS / 证书生效；用正确的本地配置部署。 |
| 二维码过期 / 扫码失败 | 刷新二维码后及时确认。若微博要求安全验证，在官方 App 完成；必要时用面板的 Cookie 备用入口。 |
| 关注读到了，等级没有 | 电脑网页和手机网页登录域不同，按提示补充个人等级扫码，并确认同一账号；接口未提供的等级会显示未知。 |
| Cookie 又失效 | 登录有效期由微博控制，项目不能保证永不过期；重新扫码或手动更新 Cookie。 |
| 09:00 没有自动签到 | 核对开关已保存、超话已保存、登录有效、Cron 配置存在。首次配置稍等传播；手动签到过的条目当天会跳过。 |
| GitHub Actions 通过但面板没更新 | Actions 只运行检查，仍需在自己的本地执行部署命令。 |

无法解决时，按 [隐私与反馈说明](../SECURITY.md) 提交脱敏信息。
