# 连接 NodeSeek 与扩展平台

工作台将界面和管理会话统一，各平台保留自己的凭证、数据和执行方式。微博仍由本项目的 Durable Object 运行；NodeSeek 通过 Cloudflare Service Binding 连接到同账号下已有的 Worker。工作台不会另建一套 NodeSeek Cron，也不会因打开页面而执行签到。

## NodeSeek 连接器兼容范围

当前连接器适配具备以下管理 API 的 NodeSeek 单账号 Worker，不是任意签到脚本的通用兼容层：

| 原服务接口 | 工作台用途 |
| --- | --- |
| `GET /status` | `{ date, record }`，当日签到结果 |
| `GET /config` | 登录配置摘要、`cookieHealth`、随机奖励模式、`schedule`、扩展配对状态 |
| `GET /history?month=YYYY-MM` | `{ records }`，当月每日记录与鸡腿数量 |
| `POST /run`、`POST /health` | 手动签到、只读检测 Cookie |
| `POST /config` | `{ random, cookie?, userAgent? }`，更新设置 |
| `POST /schedule` | `{ start, end }`，设置随机签到时段 |
| `POST /reconcile` | `{ month }`，从账单补全记录 |

原服务必须支持 `Authorization: Bearer <该服务管理员密钥>`。连接器不向浏览器回传该密钥、Cookie 或密文；不允许指定任意目标 URL，也不代理扩展同步、配对授权或任意其他路径。原 NodeSeek 服务及浏览器扩展由其部署者独立维护，本仓库不包含一套新的 NodeSeek 执行引擎。

## 配置步骤

1. 确认已有 NodeSeek Worker 正常运行，记下 Worker 的服务名称及管理员密钥。服务名称是在 Cloudflare Workers 列表中显示的名称，不是域名。
2. 按 [自部署教程](DEPLOY.md#自定义域名可选) 复制 `wrangler.local.jsonc`。即使用 `workers.dev`，也可以用这份本地配置保存私有服务绑定。
3. 在本地配置顶层添加下面的绑定，替换为自己的服务名称，保留现有 Durable Object 配置：

```jsonc
"services": [{ "binding": "NODESEEK_SERVICE", "service": "your-nodeseek-worker" }],
```

4. 在本地 `.dev.vars` 加一行 `NODESEEK_ADMIN_TOKEN=...`，值为 NodeSeek 服务已有的管理员密钥。不要使用本工作台的 `ADMIN_TOKEN`，也不要使用浏览器扩展的 `SYNC_TOKEN` 或配对令牌。
5. 发布并上传 Secret：

```sh
npm run deploy:local
node scripts/secrets.mjs --upload --config wrangler.local.jsonc
```

6. 刷新并解锁工作台，在“NodeSeek”核对原有记录与设置。先检查状态，再按需检测或手动签到。已经成功的当天记录会显示“今日已签到”；工作台不会自动额外补跑。

连接后，同一把面板管理密钥即可管理微博和 NodeSeek，因此它具有两个平台的管理能力。原 NodeSeek 的公开入口、Cloudflare Access 和同步扩展不需要更改，原有随机时段、14:00 检查补签仍由原服务执行。后续日常操作可以在工作台完成；扩展首次配对或恢复配对仍使用原服务的授权流程。

NodeSeek 页面支持状态、当月记录、鸡腿、Cookie 检测、随机时段、领取模式、手动凭证更新及账单补全。未知收益不会显示为零，未提供领取时间时会明确显示“未提供”。账单补全是查询操作，不是签到。

## 接入更多平台

适配器注册入口为 `src/platforms.ts` 的 `platforms` 数组。每个适配器定义：

- 唯一 `id`、显示名称、简介和页面标识。
- `available(env)`：判断自己的绑定 / 密钥是否齐全；可选平台缺配置不能影响其他平台。
- `handle(request, action, env)`：实现固定的操作白名单和输入 / 输出校验。不要接收任意 URL、透传浏览器凭证，或向前端暴露原始上游响应。

新增适配器后在 `public/app.js` 注册页面，在 `public/index.html` 加入对应功能区，并在 `public/platforms.js` 中补充状态与记录呈现。概览的平台注册卡片由 `/api/platforms` 自动生成；平台差异仍由各适配器和页面处理，不支持上传并执行任意脚本。

统一入口在分发前验证管理会话、写请求来源和 JSON 体积。适配器还要负责自己的业务校验、超时、敏感字段过滤和失败隔离。手动执行结果未知时先刷新原平台记录，工作台不会盲目重试；接入现有执行服务时也应核对该服务自己的重试语义。

各平台的调度由各自服务负责。需要迁移某个平台的 Cron 时，应先设计一次性切换和重复执行保护，再停用旧调度；仅连接工作台不构成调度迁移。

发布前运行 `npm run check`、`npm test`、`npm run check:public` 和 `npm run build`。私有绑定保存在被忽略的本地文件中，公开提交只使用示例名称。
