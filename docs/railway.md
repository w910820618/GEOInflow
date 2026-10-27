# Railway 部署

本文说明如何把 GEOInflow 部署到 [Railway](https://railway.com)。Railway 按服务分别构建和运行，与 `scripts/liekan-deploy.sh` 使用的单机 Docker Compose 不同：服务之间不能共享卷，也不保证启动顺序。以下配置针对这两点做了调整。

Railway 是公有云平台，机房位于美国、欧洲和新加坡。访客主要在中国大陆或数据需要留在境内时，使用[部署指南](deployment.md)中的单机方式。

## 服务组成

在同一个 Railway 项目中创建五个服务。三个应用服务使用同一个 GitHub 仓库和 `Dockerfile.railway`。

| 服务 | 来源 | 启动命令 | 公网域名 |
| --- | --- | --- | --- |
| `Postgres` | Railway PostgreSQL 模板 | 模板默认 | 不需要 |
| `Redis` | Railway Redis 模板 | 模板默认 | 不需要 |
| `app` | GitHub 仓库 | 镜像默认（`sh scripts/liekan-start.sh`） | 需要，目标端口 3000 |
| `log-worker` | GitHub 仓库 | `sh scripts/liekan-worker-start.sh dist/liekan-worker.mjs` | 不需要 |
| `analytics-worker` | GitHub 仓库 | `sh scripts/liekan-worker-start.sh dist/liekan-analytics-worker.mjs` | 不需要 |

`app` 启动时依次检查数据库、执行迁移、导入官方示例并初始化队列。两个 worker 通过 `scripts/liekan-worker-start.sh` 等待这些步骤完成后再启动，每 5 秒检查一次，默认最长等待 3600 秒（`LIEKAN_WAIT_READY_TIMEOUT_SECONDS`）。

## 准备密钥

在本机生成以下密钥，保存到密码管理器，不要提交到 Git：

```sh
openssl rand -hex 32      # APP_SECRET
openssl rand -hex 32      # TWO_FACTOR_ENCRYPTION_KEY
openssl rand -base64 32   # LIEKAN_LOG_CREDENTIALS_KEY
openssl rand -hex 32      # LIEKAN_AI_ENCRYPTION_KEY（启用 AI 时）
```

`APP_SECRET` 决定既有统计标识，部署后保持不变。三个应用服务必须使用相同的 `APP_SECRET` 和 `LIEKAN_LOG_CREDENTIALS_KEY`，建议放在 Railway 的共享变量（Shared Variables）中引用。

## 部署步骤

1. 在 Railway 新建项目，添加 PostgreSQL 和 Redis 模板。
2. 选择 “Deploy from GitHub repo”，连接本仓库并选择要部署的分支，服务命名为 `app`。
3. 为 `app` 设置变量（见下表），在 Settings 中完成：
   - Networking：生成公网域名或绑定自定义域名，目标端口 3000。
   - Deploy → Healthcheck Path：`/api/heartbeat`。首次安装需要执行全部迁移并导入示例数据，将健康检查超时调到界面允许的最大值；完成首次部署后可以恢复默认。
   - Deploy → Restart Policy：`On Failure`。
4. 部署 `app`，等待日志出现迁移、示例和队列完成的信息，并通过健康检查。
5. 在同一项目中再添加两个来自同一仓库的服务 `log-worker` 和 `analytics-worker`。设置各自变量，在 Settings → Deploy → Custom Start Command 中填写上表的启动命令，重启策略设为 `On Failure`，不要配置公网域名和健康检查路径。
6. 打开 `app` 的域名，用初始账号 `admin` / `liekan` 登录并立即修改密码。

三个服务也可以同时创建。worker 会显示 `Waiting for application initialization`，直到 `app` 初始化完成。

## 变量

`${{...}}` 为 Railway 引用变量写法，服务名按实际名称调整。

### app

| 变量 | 值 |
| --- | --- |
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.railway` |
| `PORT` | `3000` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `LIEKAN_ANALYTICS_REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `APP_SECRET` | 共享变量 |
| `TWO_FACTOR_ENCRYPTION_KEY` | 生成的 64 位十六进制 |
| `LIEKAN_LOG_CREDENTIALS_KEY` | 共享变量 |
| `LIEKAN_PUBLIC_URL` | `https://` 加 app 的公网域名 |
| `CLIENT_IP_HEADER` | `x-real-ip` |
| `DEFAULT_LOCALE` | `zh-CN` |
| `DISABLE_TELEMETRY` | `1` |
| `LIEKAN_AI_ENABLED` / `LIEKAN_AI_ENCRYPTION_KEY` | 启用 AI 时设置，见 [AI](ai.md) |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | 使用 Cloudflare 自动日志时设置 |

### log-worker

| 变量 | 值 |
| --- | --- |
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.railway` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `APP_SECRET` | 共享变量 |
| `LIEKAN_LOG_CREDENTIALS_KEY` | 共享变量 |
| `LIEKAN_PUBLIC_URL` | 与 app 相同 |
| `DISABLE_TELEMETRY` | `1` |
| `CLOUDFLARE_OAUTH_CLIENT_ID` / `CLOUDFLARE_OAUTH_CLIENT_SECRET` | 与 app 相同（如使用） |

### analytics-worker

| 变量 | 值 |
| --- | --- |
| `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.railway` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `LIEKAN_ANALYTICS_REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `APP_SECRET` | 共享变量 |
| `DISABLE_TELEMETRY` | `1` |

## 与单机部署的差异

- **地理库**：Railway 卷只能挂载到一个服务，不设置 `LIEKAN_GEO_DIRECTORY` 和 `LIEKAN_GEO_UPDATER`。应用使用构建时写入镜像的 DB-IP City Lite（`geo/GeoLite2-City.mmdb`），重新部署时随构建刷新。地理库不可用时事件采集照常进行，见[地理位置](geography.md)。
- **访客 IP**：Railway 边缘代理通过 `X-Real-IP` 传递访客地址。部署后在网站的流量质量或安装检查中确认访客地区和身份指标正常；如果所有访客显示为同一地址，检查该请求头。
- **启动顺序**：worker 等待 `app` 完成上游迁移、Liekan 迁移和队列初始化。升级时三个服务一起重新部署，新 worker 同样等待新版本迁移完成。
- **构建资源**：Railway 使用 `Dockerfile.railway` 构建，该文件与 `Dockerfile.liekan` 的差别只有去掉了 Railway 不支持的缓存挂载，由 `tests/liekan/railway.test.mjs` 保持一致。构建阶段为 Node 分配 3 GB 内存，构建时间较长。构建因内存失败时，升级 Railway 套餐或改为在其他环境构建镜像后由 Railway 拉取。
- **备份**：在 Railway 的 PostgreSQL 服务中开启备份。不要重置已接入的数据库。

## 升级

推送到 Railway 跟踪的分支后，三个应用服务会使用同一提交分别重新构建。新版本 worker 在迁移完成前保持等待；旧版本 worker 在新部署生效前继续运行，可能与新版本 `app` 的迁移同时进行。

包含新增迁移的版本按以下顺序升级，与 `scripts/liekan-deploy.sh` 在迁移期间保持后台服务停止的做法一致：

1. 备份 PostgreSQL，并阅读[升级说明](upgrade.md)。
2. 将 `log-worker` 和 `analytics-worker` 的副本数调为 0，或在 Railway 中移除其当前部署。
3. 部署 `app`，等待迁移完成并通过健康检查。
4. 恢复两个 worker 的副本数并重新部署。
