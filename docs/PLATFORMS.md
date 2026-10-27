# 原生 NodeSeek 与平台扩展

微博、NodeSeek 与虎牙的执行代码、管理界面和调度都在本仓库、同一个 Worker 中。每个平台使用自己的 SQLite Durable Object 保存状态并串行执行操作，不依赖另一个签到面板或 Service Binding。NodeSeek 支持浏览器扩展同步；虎牙支持扫码获取 Cookie，使用说明见 [虎粮赠送教程](HUYA.md)。

## NodeSeek 首次使用

按 [自部署教程](DEPLOY.md) 部署。默认配置包含 `NodeSeekAccount` 迁移、`NODESEEK` 绑定、`BROWSER` 浏览器绑定及分钟 Cron。Cloudflare 账号须可使用 Browser Run，按官方当前配额和计费运行；打开工作台不会启动云端浏览器。

密钥脚本会生成独立 `NODESEEK_CREDENTIAL_KEY`，与面板密钥一起上传。已有密钥不覆盖；缺少 NodeSeek 密钥时只补充这一项。这个密钥加密 NodeSeek Cookie，也作为随机计划的稳定种子，请备份。

1. 展开左侧“NodeSeek”，进入“签到设置”。
2. 手动保存 NodeSeek Cookie 和取得 Cookie 时的 User-Agent，或按下一节连接扩展。不使用账号密码自动登录。
3. 在“签到与记录”检测 Cookie，核对结果后按需手动签到。
4. 设置随机时段、随机或固定奖励；需要定时执行时勾选“每日自动签到”并保存。新实例默认关闭。

每天在所选时段内按日期生成一个稳定执行时间（UTC+8），14:00–14:05 检查未完成项。分钟 Cron 只负责到期检测；同一天、同一时段不反复启动。每日记录成功后跳过请求，记录不设 TTL。网络中断或不明确的服务器错误不重试签到 POST；再次执行前先通过账单确认结果，账单不足以确认时停止。

“从账单补全”只查询最多 5 页收益，保存签到对应的数量和时间，不保存余额或无关消费记录。未知收益和时间明确显示未知，不编造零收益或领取时间。

## 同步扩展

在“扩展同步”下载 ZIP 并解压。在 Chrome / Edge 扩展管理页开启开发者模式，加载解压目录。也可以直接加载本仓库 `extension/` 目录。

在扩展中填写你自己的 HTTPS 面板根地址，如 `https://panel.example.com`，点击“连接面板”，允许扩展访问该地址。扩展会打开工作台；使用管理密钥解锁后，在“扩展同步”确认连接。回到扩展点击“检查连接”，成功后会同步 Cookie。以后 Cookie 变化、访问 NodeSeek 和周期检测会自动触发同步。

旧版扩展需要更新并重新连接新域名；不能在未获得浏览器授权时替用户增加域名访问权限。迁移后的云端 Cookie 可继续使用，重新配对不要求重新签到。

配对使用 10 分钟随机挑战和验证者证明。只有已解锁管理会话可以批准；同步令牌只能更新 NodeSeek Cookie，不能查询账号数据、修改时段或触发签到。新的配对替换旧浏览器；工作台可随时断开扩展，保留已有云端 Cookie。

扩展只读取 NodeSeek 站点 Cookie。HTTP 主机权限用于读取站点的非 Secure 登录 Cookie，所有网络同步仍使用 HTTPS。面板域名权限按用户填写的地址请求，不默认授权访问所有网站。不要填写不受自己控制的面板。

`npm run build` / `npm run deploy` / `npm run deploy:local` 会生成通用 `public/extension.zip`。ZIP 不含个人地址、Cookie 或密钥，无须为域名修改源码。

## 从旧独立 Worker 迁移

先备份旧 Worker 配置、Secrets 和 KV 数据。停止旧 Cron 并冻结同步写入，再让新实例读取最终数据；不要让两套引擎同时签到。若修改同一个工作台的配置，保留其 Worker 名、微博绑定和既有迁移。

1. 在被忽略的 `wrangler.local.jsonc` 顶层临时添加旧 KV 的只读导入绑定：

```jsonc
"kv_namespaces": [{ "binding": "NODESEEK_LEGACY_STATE", "id": "替换为旧_KV_ID" }],
```

2. 将旧实例 `CREDENTIAL_KEY` 的原值保存为新实例的 `NODESEEK_CREDENTIAL_KEY`，不要重新生成；上传 Secret。
3. 发布新代码。首次激活 `NodeSeekAccount` 时导入加密配置、每日记录、时段、健康状态和扩展配对摘要。临时配对请求不导入。先验证 Cookie 可以解密，再以事务提交；失败不会标记完成。
4. 核对全部历史的日期、收益、领取时间和次数，验证 Cookie 检测与今日已签去重。迁入的旧自动计划保持开启；新安装默认关闭。
5. 从本地配置移除 `NODESEEK_LEGACY_STATE` 后再次发布并验证。已完成的导入不会再次覆盖新数据。
6. 更新扩展地址并重新连接。确认新实例独立运行后退役旧 Worker、旧入口、旧管理 Secret 及其专用 Access 应用；确认 KV 无其他使用者且备份可恢复后，再删除旧 KV。

新版不再使用 `NODESEEK_SERVICE` / `NODESEEK_ADMIN_TOKEN`。迁移完成后删除旧服务绑定和这把过时 Secret。公开仓库不要包含真实 KV ID、域名或密钥。

## 加入其他签到平台

后续功能直接加入这个仓库：

1. 在 `src/<platform>/` 实现执行、状态和凭证存储；使用独立 Durable Object 串行化，同一平台的手动操作与定时操作共用实例。
2. 在 `src/platforms.ts` 的 `platforms` 注册 ID、名称、可用性判断和操作分发。接口只接受固定路径与校验过的输入，输出使用允许字段，不接受任意 URL 或执行上传脚本。
3. 在 `public/app.js` 注册页面、`public/index.html` 添加平台导航分组和控件；概览卡片从注册信息生成。动画使用本地 GSAP，并尊重减少动态效果设置。
4. 在 `src/index.ts` 的共享调度入口分发到平台自己的实例，更新 Wrangler 绑定和迁移。不要为新平台再建独立面板。
5. 添加鉴权、凭证隔离、未知结果、去重和持久化恢复测试；运行检查、测试、公开配置检查和构建。

平台仍需实现自己的协议和调度规则，当前没有任意脚本上传或无需代码的通用插件功能。
