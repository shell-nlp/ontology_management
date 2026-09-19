import { PlatformSchema0001 } from "@/lib/db/migrations/0001-platform-schema";
import { AuditVersionColumn0002 } from "@/lib/db/migrations/0002-audit-version-column";

/**
 * 平台库迁移清单：**按数组顺序执行，每支都必须幂等**。
 * 新增结构改动 = 追加一支迁移类，不要在业务代码里写 DDL。
 */
export const PLATFORM_MIGRATIONS = [new PlatformSchema0001(), new AuditVersionColumn0002()];
