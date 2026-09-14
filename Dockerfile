# 本体管理平台的容器镜像 —— 只打平台本体。
#
# PostgreSQL（平台库）与 Apache Jena Fuseki（本体存储）都是**外部依赖**，不进这个镜像；
# 业务数据源（Oracle / PostgreSQL / MySQL）同样是被读取的外部系统，在界面里登记。
#
# 两段：
#   builder —— 装全量依赖并做生产构建，产物是 `.next`；
#   runner  —— 只装生产依赖，带上构建产物，用 `next start` 启动。
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

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NPM_REGISTRY
RUN corepack enable
# 依赖清单先单独拷：改业务代码时这一层的缓存还能复用。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN if [ -n "${NPM_REGISTRY}" ]; then pnpm config set registry "${NPM_REGISTRY}"; fi
RUN pnpm install --frozen-lockfile
# 密钥不进镜像：.dockerignore 把 .env / .env.* 挡在构建上下文之外，运行时由 compose 注入。
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
ARG NPM_REGISTRY
# tzdata：容器里要按 Asia/Shanghai 显示时间；libaio1：Oracle Thick 模式（挂了 Instant Client）需要。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata libaio1 \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN if [ -n "${NPM_REGISTRY}" ]; then pnpm config set registry "${NPM_REGISTRY}"; fi
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder --chown=node:node /app/.next ./.next
# next start 会读配置：少了它，serverExternalPackages 这类设置就丢了。
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
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
