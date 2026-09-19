# 本体管理平台的容器镜像 —— 只打平台本体。
#
# PostgreSQL（平台库）与 Apache Jena Fuseki（本体存储）都是**外部依赖**，不进这个镜像；
# 业务数据源（Oracle / PostgreSQL / MySQL）同样是被读取的外部系统，在界面里登记。
#
# 依赖只联网安装一次：deps 装全量依赖，builder 构建，prod-deps 从同一份
# store 离线裁剪出生产依赖，runner 只复制产物、不再联网安装。
#
# 为什么不用 `output: "standalone"`：next.config.ts 刻意把 oracledb / typeorm / pg / mysql2
# 交给 Node 运行时从 node_modules 加载（serverExternalPackages），而 oracledb 是按平台拼文件名
# 去 require 预编译二进制（build/Release/oracledb-<版本>-<平台>-<架构>.node）的，Nft 的文件追踪
# 容易漏掉它 —— 那会变成"装得上、连不上 Oracle"。直接带一份 node_modules 更笨，但原生驱动一定在。

# 拉不动 Docker Hub 时用镜像站覆盖，例如：docker build --build-arg NODE_IMAGE=docker.1ms.run/node:24-bookworm-slim .
ARG NODE_IMAGE=node:24-bookworm-slim
# 依赖从哪个源装。国内网络直连 registry.npmjs.org 时会有一半包超时，装依赖这一步直接失败
# （主机上通常已经配了镜像源，但镜像里读不到那个配置，所以这里要显式给）：
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=

# Oracle Instant Client（Linux x64）。要连的 Oracle 服务端较旧，Thin 模式会被服务端拒掉
# （NJS-138），必须 Thick 模式；这一段单独装，再把结果拷进 runner —— 下载用的工具不进运行镜像。
FROM ${NODE_IMAGE} AS oracle-client
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates unzip \
 && rm -rf /var/lib/apt/lists/*
COPY docker/oracle /docker/oracle
RUN bash /docker/oracle/install-instantclient.sh

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ARG NPM_REGISTRY
ENV COREPACK_NPM_REGISTRY=${NPM_REGISTRY}
RUN corepack enable
# 依赖清单先单独拷：改业务代码时这一层的缓存还能复用。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=ontology-pnpm-store,target=/pnpm/store,sharing=locked \
    if [ -n "${NPM_REGISTRY}" ]; then pnpm config set registry "${NPM_REGISTRY}"; fi \
 && pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile

FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
# 密钥不进镜像：.dockerignore 把 .env / .env.* 挡在构建上下文之外，运行时由 compose 注入。
COPY . .
RUN pnpm build

FROM deps AS prod-deps
# 全量依赖已经在 deps 的 store 里；这里禁止联网，只保留生产依赖。
# 与 builder 并行时对同一 store 加锁，避免重复下载或同时改写缓存。
RUN --mount=type=cache,id=ontology-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prod --offline \
 && rm -rf node_modules/.pnpm/playwright* node_modules/.pnpm/@playwright*

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
# tzdata：容器里要按 Asia/Shanghai 显示时间；libaio1：Oracle Thick 模式（挂了 Instant Client）需要。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata libaio1 \
 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 只复制离线裁剪后的 node_modules：pnpm/Corepack 缓存与完整开发依赖不进最终镜像。
# @next/swc-linux-x64-gnu 必须保留，next start 运行时仍会加载它。
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
# 本体技能（仓库根的 skills/）：运行时按需读盘，不拷进来「本体技能」页就是空的。
# 它们是数据不是源码，所以直接从 builder 阶段的同一份拷，构建上下文只多带几十 KB。
COPY --from=builder --chown=node:node /app/skills ./skills
# next start 会读配置：少了它，serverExternalPackages 这类设置就丢了。
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
# 接口文档的静态产物：public/openapi.json 与 public/swagger-ui/（构建阶段 `pnpm build` 里强制重新生成，见 scripts/openapi-fresh.mjs）。
# 少了这一行 `/docs` 打不开、`/openapi.json` 也 404。
COPY --from=builder --chown=node:node /app/public ./public
# Oracle Thick 模式要的客户端（含 instantclient -> instantclient_23_4 的软链）。
COPY --from=oracle-client --chown=node:node /opt/oracle /opt/oracle
ENV ORACLE_CLIENT_LIB_DIR=/opt/oracle/instantclient
# Linux 下必须给动态加载器指路：libclntsh.so 自己不带 $ORIGIN，找不到同目录的 libnnz.so /
# libclntshcore.so 就会报 DPI-1047（只设 ORACLE_CLIENT_LIB_DIR 不够）。
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient
# 版本快照的落盘目录（compose 把它挂成卷）。容器以 node 用户跑，先把目录建好、换属主。
RUN mkdir -p /data/ontology-versions && chown -R node:node /data
USER node
EXPOSE 3000
# 直接起 next 而不是 `pnpm start`：PID 1 能收到 SIGTERM，`docker compose stop` 是干净退出。
CMD ["node", "node_modules/next/dist/bin/next", "start"]
