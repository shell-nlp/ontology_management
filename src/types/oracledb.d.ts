/**
 * node-oracledb 不自带类型声明，而平台只用它一个入口：把进程切到 Thick 模式。
 * 这里只声明真正会调用的那部分，避免为了一行调用引入一整份类型包。
 */
declare module "oracledb" {
  export function initOracleClient(options?: { libDir?: string; configDir?: string; driverName?: string }): void;
}
