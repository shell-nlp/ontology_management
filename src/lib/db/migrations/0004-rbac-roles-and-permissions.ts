import type { QueryRunner } from "typeorm";
import { BUILTIN_ROLES } from "@/lib/permissions";

/**
 * RBAC（2026-10-09 用户口径：做「用户管理 + 角色与权限」两档）。
 *
 * 之前只有 `users.role` 一列（`ADMIN` / `VIEWER`）+ 70 处 `requireRole()`，表达不了
 * "能改本体但不能碰数据资源"。这一支把授权模型立起来：
 *
 * 1. 新表 `roles`：角色 = 一组权限点（jsonb 数组），`builtin` 标记内置角色；
 * 2. 内置三档（管理员 / 编辑者 / 查看者）**每次启动按 `@/lib/permissions` 的定义同步进库** ——
 *    所以以后新增权限点，`ADMIN` 会自动拿到，不用再写一支数据迁移；
 * 3. `users`：加 `role_id`（外键指向 roles）与 `disabled_at`，**直接删掉老的 `role` 列**
 *    （用户明确要求"迁移完直接删"，代码里也不再有任何地方读它）；
 * 4. 指向 `users` 的 4 条外键改成 **`ON DELETE SET NULL`** —— 用户要能删（用户明确要求），
 *    而这四列本来就是可空的。代价说清楚：删掉一个人之后，他历史上那些审计记录的 `actor_id`
 *    会变成空，所以删除时**单独写一条 `USER_DELETED` 审计**，里面记着被删账号的邮箱，
 *    人名还能从那条里追回来（见 `src/lib/users.ts`）。
 *
 * 幂等：可以反复跑（每支迁移在启动时都会执行）。
 */
export class RbacRolesAndPermissions0004 {
  name = "RbacRolesAndPermissions0004";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ontology_platform.roles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        builtin BOOLEAN NOT NULL DEFAULT FALSE,
        permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 内置角色：按代码定义同步（只在这里 upsert，界面上它们是只读的）。
    for (const role of BUILTIN_ROLES) {
      await queryRunner.query(
        `INSERT INTO ontology_platform.roles (id, name, description, builtin, permissions)
         VALUES ($1, $2, $3, TRUE, $4::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET name = EXCLUDED.name,
               description = EXCLUDED.description,
               builtin = TRUE,
               permissions = EXCLUDED.permissions,
               updated_at = NOW()`,
        [role.id, role.name, role.description, JSON.stringify(role.permissions)],
      );
    }

    const hasColumn = async (table: string, column: string) => {
      const rows = await queryRunner.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'ontology_platform' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      return Array.isArray(rows) && rows.length > 0;
    };

    /*
     * users：加 role_id → 按老的 role 回填 → 收紧成 NOT NULL → 删掉 role 列。
     *
     * **回填必须挂在"role 列还在不在"上**：这支迁移每次启动都会跑一遍，
     * 第一次跑完 role 列就没了；第二次再执行那条 UPDATE 会直接 `column "role" does not exist`，
     * 而它抛在建库阶段 —— 表现是整个平台 500、连登录都进不去（2026-10-09 真踩过）。
     */
    const hasLegacyRoleColumn = await hasColumn("users", "role");
    if (!(await hasColumn("users", "role_id"))) {
      await queryRunner.query(`ALTER TABLE ontology_platform.users ADD COLUMN role_id TEXT`);
    }
    if (hasLegacyRoleColumn) {
      await queryRunner.query(`
        UPDATE ontology_platform.users
           SET role_id = CASE WHEN role = 'ADMIN' THEN 'admin' ELSE 'viewer' END
         WHERE role_id IS NULL AND role IS NOT NULL
      `);
    }
    // 兜底：任何来路不明的账号都给最小权限，不给管理员。
    await queryRunner.query(`UPDATE ontology_platform.users SET role_id = 'viewer' WHERE role_id IS NULL`);
    await queryRunner.query(`ALTER TABLE ontology_platform.users ALTER COLUMN role_id SET NOT NULL`);

    const rows: Array<{ constraint_name: string }> = await queryRunner.query(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_schema = 'ontology_platform' AND table_name = 'users' AND constraint_name = 'users_role_id_fkey'`,
    );
    if (!Array.isArray(rows) || !rows.length) {
      // RESTRICT：角色上还挂着人就不许删（界面上据此提示"先把这个角色的人换掉"）。
      await queryRunner.query(`
        ALTER TABLE ontology_platform.users
          ADD CONSTRAINT users_role_id_fkey FOREIGN KEY (role_id)
          REFERENCES ontology_platform.roles(id) ON DELETE RESTRICT
      `);
    }

    if (hasLegacyRoleColumn) {
      // 老列上有 `CHECK (role IN ('ADMIN','VIEWER'))`，删列会一起带走；显式先删约束更稳。
      await queryRunner.query(`ALTER TABLE ontology_platform.users DROP CONSTRAINT IF EXISTS users_role_check`);
      await queryRunner.query(`ALTER TABLE ontology_platform.users DROP COLUMN role`);
    }

    if (!(await hasColumn("users", "disabled_at"))) {
      await queryRunner.query(`ALTER TABLE ontology_platform.users ADD COLUMN disabled_at TIMESTAMPTZ`);
    }

    /*
     * 删除用户：4 条指向 users 的外键改成 SET NULL（这些列都可空）。
     * 不改的话删不掉（外键拦），改成 CASCADE 又会连带删掉审计与对话 —— 那更糟。
     */
    const relax: Array<[string, string, string]> = [
      ["audit_entries", "actor_id", "audit_entries_actor_id_fkey"],
      ["ontologies", "created_by", "ontologies_created_by_fkey"],
      ["platform_settings", "updated_by", "platform_settings_updated_by_fkey"],
      ["reasoning_conversations", "created_by", "reasoning_conversations_created_by_fkey"],
    ];
    for (const [table, column, constraint] of relax) {
      await queryRunner.query(`ALTER TABLE ontology_platform.${table} DROP CONSTRAINT IF EXISTS ${constraint}`);
      await queryRunner.query(`
        ALTER TABLE ontology_platform.${table}
          ADD CONSTRAINT ${constraint} FOREIGN KEY (${column})
          REFERENCES ontology_platform.users(id) ON DELETE SET NULL
      `);
    }
  }
}