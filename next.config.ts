import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 驱动类依赖要么带原生二进制、要么在自己的代码里动态 require 驱动包，
  // 一律交给 Node 在运行时从 node_modules 加载，不参与打包。
  serverExternalPackages: ["pg", "typeorm", "mysql2", "oracledb", "reflect-metadata"],
  /*
   * Next 的 dev server 默认只认 localhost：用机器 IP / 主机名打开时，跨来源的 dev 资源会被拦
   * （表现是页面永远停在「正在加载 Ontology...」，HMR websocket 报 ERR_INVALID_HTTP_RESPONSE）。
   * AGENTS 要求界面改动在 localhost 与 IP 两个入口各验一遍，所以这里放开本机内网来源。
   * 只影响 `next dev`；生产构建（`next build` / `next start`、Docker）不看这一项。
   */
  allowedDevOrigins: ["127.*.*.*", "192.168.*.*", "10.*.*.*", "172.*.*.*", "*.lan", "*.local"],
};

export default nextConfig;
