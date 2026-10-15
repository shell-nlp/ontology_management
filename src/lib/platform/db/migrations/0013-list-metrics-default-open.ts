import type { QueryRunner } from "typeorm";

/**
 * `list_metrics` 默认打开（2026-10-15 用户口径）。
 *
 * 它本身不在 `DEFAULT_DISABLED_TOOLS` 里；旧版本曾经保存过一份全局 / 本体策略，
 * 把 `list_metrics` 写进 `disabledTools` 后就会一直覆盖代码默认，MCP 调试页里也一直灰着。
 *
 * 这支迁移只做一次：先把历史策略里的 `list_metrics` 去掉，再写一个完成标记。
 * 之后管理员仍然可以手动关掉它 —— 这里只修正“旧默认留下来的存量配置”，不是永久强制打开。
 */
const MARKER_KEY = "migration.listMetricsDefaultOpen";
const TOOL_NAME = "list_metrics";

export class ListMetricsDefaultOpen0013 {
  name = "ListMetricsDefaultOpen0013";

  async up(queryRunner: QueryRunner): Promise<void> {
    const marker = await queryRunner.query(
      "SELECT key FROM ontology_platform.platform_settings WHERE key = $1 LIMIT 1",
      [MARKER_KEY],
    );
    if (marker.length) return;

    await queryRunner.query(
      `
        UPDATE ontology_platform.platform_settings
           SET value = jsonb_set(
                 value,
                 '{disabledTools}',
                 COALESCE(
                   (
                     SELECT jsonb_agg(item ORDER BY ordinality)
                       FROM jsonb_array_elements(COALESCE(value->'disabledTools', '[]'::jsonb))
                         WITH ORDINALITY AS tools(item, ordinality)
                      WHERE item <> to_jsonb($1::text)
                   ),
                   '[]'::jsonb
                 ),
                 false
               ),
               updated_at = NOW()
         WHERE key LIKE 'reasoning.toolPolicy%'
           AND value->'disabledTools' @> to_jsonb($1::text)
      `,
      [TOOL_NAME],
    );

    await queryRunner.query(
      `
        INSERT INTO ontology_platform.platform_settings (key, value, updated_at)
        VALUES ($1, jsonb_build_object('done', true), NOW())
        ON CONFLICT (key) DO NOTHING
      `,
      [MARKER_KEY],
    );
  }
}