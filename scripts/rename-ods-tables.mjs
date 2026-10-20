import { odsTableName } from "../src/lib/infrastructure/ods/naming.ts";
import pg from "pg";

const { Pool } = pg;
const apply = process.argv.includes("--apply");

function clickHouseUrl(query) {
  const url = new URL(process.env.CLICKHOUSE_URL ?? "");
  url.searchParams.set("database", process.env.CLICKHOUSE_DATABASE ?? "ontology_index");
  url.searchParams.set("query", query);
  return url;
}

function clickHouseHeaders() {
  const username = process.env.CLICKHOUSE_USER ?? "";
  const password = process.env.CLICKHOUSE_PASSWORD ?? "";
  return username
    ? { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` }
    : {};
}

async function clickHouse(query) {
  const response = await fetch(clickHouseUrl(query), { method: "POST", headers: clickHouseHeaders() });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `ClickHouse HTTP ${response.status}`);
  return text;
}

function quote(value) {
  return `\`${String(value).replace(/`/g, "``")}\``;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function validIdentifier(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

const platform = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const database = process.env.CLICKHOUSE_DATABASE ?? "ontology_index";
  const result = await platform.query(
    `SELECT id, data_source_id, schema_name, table_name, ch_table
       FROM ontology_platform.ods_sources
      ORDER BY created_at`,
  );

  const changes = result.rows.map((row) => ({
    row,
    next: odsTableName(row.data_source_id, row.schema_name, row.table_name),
  })).filter(({ row, next }) => row.ch_table !== next);

  if (!changes.length) {
    console.log("所有 ODS 表名已经是可读格式，无需迁移。");
  } else {
    for (const { row, next } of changes) {
      console.log(`${row.ch_table} -> ${next}  (${row.schema_name}.${row.table_name})`);
    }

    if (!apply) {
      console.log(`\n当前为预演。确认后使用 --apply 执行 ${changes.length} 项改名。`);
    } else {
      for (const { row, next } of changes) {
        if (!validIdentifier(row.ch_table) || !validIdentifier(next)) {
          throw new Error(`ODS 表名含不支持的字符，拒绝迁移：${row.ch_table} -> ${next}`);
        }
        const existing = await clickHouse(
          `SELECT name FROM system.tables WHERE database = ${quoteLiteral(database)} AND name IN (${quoteLiteral(row.ch_table)}, ${quoteLiteral(next)}) FORMAT JSONEachRow`,
        );
        const names = new Set(existing.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line).name));
        if (!names.has(row.ch_table)) {
          if (names.has(next)) {
            await platform.query("UPDATE ontology_platform.ods_sources SET ch_table = $1, updated_at = NOW() WHERE id = $2", [next, row.id]);
            console.log(`已修复配置引用：${row.ch_table} -> ${next}（目标表已存在）`);
            continue;
          }
          throw new Error(`ClickHouse 中找不到旧表 ${row.ch_table}`);
        }
        if (names.has(next)) throw new Error(`目标表已存在，拒绝覆盖：${next}`);

        await clickHouse(
          `RENAME TABLE ${quote(database)}.${quote(row.ch_table)} TO ${quote(database)}.${quote(next)}`,
        );
        try {
          const sourceName = row.schema_name ? `${row.schema_name}.${row.table_name}` : row.table_name;
          const comment = `${sourceName} 的 ODS 派生镜像；按主键去重，可重建，不保存本体版本实例`.replace(/'/g, "\\'");
          await clickHouse(`ALTER TABLE ${quote(database)}.${quote(next)} MODIFY COMMENT '${comment}'`);
          await platform.query("UPDATE ontology_platform.ods_sources SET ch_table = $1, updated_at = NOW() WHERE id = $2", [next, row.id]);
        } catch (error) {
          // 元数据更新失败时尽量回到旧表名，避免平台配置与 ClickHouse 失配。
          await clickHouse(`RENAME TABLE ${quote(database)}.${quote(next)} TO ${quote(database)}.${quote(row.ch_table)}`).catch(() => undefined);
          throw error;
        }
        console.log(`已迁移：${row.ch_table} -> ${next}`);
      }
    }
  }
} finally {
  await platform.end();
}
