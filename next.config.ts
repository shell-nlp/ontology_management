import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 驱动类依赖要么带原生二进制、要么在自己的代码里动态 require 驱动包，
  // 一律交给 Node 在运行时从 node_modules 加载，不参与打包。
  serverExternalPackages: ["neo4j-driver", "pg", "typeorm", "mysql2", "oracledb", "reflect-metadata"],
};

export default nextConfig;
