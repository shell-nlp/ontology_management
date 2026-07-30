import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["neo4j-driver", "pg"],
};

export default nextConfig;
