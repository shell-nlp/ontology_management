import { describe, expect, it } from "vitest";
import { ensurePlatformSchema, withPlatformQueryRunner } from "@/lib/platform/db";

/**
 * 表与字段注释的契约测试（用户要求：建库必须有表注释与字段注释，一个都不能缺）。
 *
 *   pnpm test:schema-comments
 *   # = node --env-file=.env.local vitest run tests/lib/platform-schema-comments.contract.test.ts
 *
 * 需要平台库；`pnpm test`（没有 DATABASE_URL）时整块跳过。
 * 顺带也会把迁移 0006（补注释）跑到最新 —— `ensurePlatformSchema()` 是它的入口。
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("平台库的表与字段注释", () => {
  it("每张表都有表注释、每一列都有字段注释，且注释里没有改动史", async () => {
    await ensurePlatformSchema();
    const rows = await withPlatformQueryRunner((runner) =>
      runner.query(`
        SELECT c.table_name, c.column_name,
               obj_description(pgc.oid) AS table_comment,
               col_description(pgc.oid, c.ordinal_position) AS column_comment
        FROM information_schema.columns c
        JOIN pg_class pgc ON pgc.relname = c.table_name
        JOIN pg_namespace n ON n.oid = pgc.relnamespace AND n.nspname = c.table_schema
        WHERE c.table_schema = 'ontology_platform'
      `) as Promise<{ table_name: string; column_name: string; table_comment: string | null; column_comment: string | null }[]>,
    );

    const missingTables = [...new Set(rows.filter((row) => !row.table_comment).map((row) => row.table_name))];
    const missingColumns = rows.filter((row) => !row.column_comment).map((row) => row.table_name + "." + row.column_name);
    expect(missingTables, "这些表没有表注释").toEqual([]);
    expect(missingColumns, "这些字段没有字段注释").toEqual([]);

    // 注释只描述作用：不许出现日期与改动史措辞。
    const banned = ["2026-", "之前", "以前", "现已", "原来", "用户口径"];
    const offenders = rows.flatMap((row) => {
      const text = `${row.table_comment ?? ""} ${row.column_comment ?? ""}`;
      return banned.filter((marker) => text.includes(marker)).map((marker) => row.table_name + "." + row.column_name + " → " + marker);
    });
    expect(offenders, "注释里出现了改动史用词").toEqual([]);
  });
});

if (!databaseUrl) {
  describe("平台库的表与字段注释", () => {
    it.skip("需要 DATABASE_URL：用 `pnpm test:schema-comments` 跑完整契约", () => {});
  });
}
