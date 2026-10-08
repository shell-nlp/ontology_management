import { entitySources } from "@/lib/ontology-sources";
import { ColumnProfileEntity, jsonValue, platformRepo } from "@/lib/db";
import type { DataSourceRecord } from "@/lib/data-source/types";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 列画像（column profile）：一张表里每列大概长什么样 —— 有多少种取值、空值多少、
 * **低基数列的取值有哪些**。
 *
 * 为什么要有它（2026-10-08）：模型答「状态正常的互联网专线」这类问题时，得先知道
 * `ZX_FLAG` 里到底有没有「互联网专线」这一档、对应哪个码值。以前只能一轮轮手写 GROUP BY 去探，
 * 一次问答要跑十几次 SQL。有了列画像，码值直接摆在表结构里。
 *
 * 三条成本红线（用户口径：「Oracle 大表 COUNT(DISTINCT) 很贵」）：
 * 1. **只对被对象类型绑定的表做**：没有被任何对象类型绑定的表根本不采（表只能通过对象类型到达）；
 * 2. **只采样、不精确统计**：`SELECT 列… WHERE ROWNUM <= 1000`（PG 是 LIMIT）看前 1000 行，
 *    不做全表 COUNT(DISTINCT)；采样里种数超过 50 的列按「高基数列」处理，不存取值；
 * 3. **按天缓存**：一份画像写完 24 小时内直接复用，只有显式 `refresh` 才回源库重采。
 *
 * 这里不引驱动：真正采样时才动态 import `@/lib/data-sources`（与 reasoning/tools.ts 同一套路），
 * 读缓存这条路径因此不需要连业务库。
 */

/** 采样行数。够看出码值，又不至于把大表扫到底。 */
export const PROFILE_SAMPLE_ROWS = 1000;
/** 采样里取值种数超过它就按高基数列处理（不存取值）。 */
export const PROFILE_MAX_VALUES = 50;
/** 一张表一次最多采这么多列：SELECT 列表太长，Oracle 的绑定与网络往返都不划算。 */
export const PROFILE_MAX_COLUMNS = 40;
/** 画像有效期：一天。 */
export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

export type ProfileColumn = {
  name: string;
  /** 采样里出现的取值种数（**不是**全表 distinct，别当精确统计用）。 */
  distinct: number;
  /** 采样里的空值比例（0~1）。 */
  nullRate: number;
  /** 低基数列的取值，按出现次数降序；高基数列为空数组。 */
  values: string[];
  /** 采样里取值种数就超过了 PROFILE_MAX_VALUES：这是高基数列（主键、编号、金额…），别拿它当码值。 */
  highCardinality: boolean;
};

export type ColumnProfile = {
  sourceId: string;
  schema: string;
  table: string;
  /** 采样时间（ISO）。缓存按它算是否过期。 */
  sampledAt: string;
  /** 实际采到多少行（空表是 0）。 */
  sampleSize: number;
  columns: ProfileColumn[];
};

/** 表键：`模式.表`，统一大写 —— Oracle 报上来是大写，模型写小写也要能对上。 */
export function profileTableKey(schema: string, table: string) {
  return `${(schema ?? "").trim()}.${(table ?? "").trim()}`.toUpperCase();
}

/** 表 → 列 → 取值。search_schema 的「取值命中」用它，纯内存、不连库。 */
export type ColumnValueIndex = Map<string, Map<string, string[]>>;

export function columnValueOf(index: ColumnValueIndex | null | undefined, schema: string, table: string, column: string): string[] {
  return index?.get(profileTableKey(schema, table))?.get(column.trim().toUpperCase()) ?? [];
}

/**
 * 这张表上**被对象类型映射到的列**有哪些。
 *
 * 这是「只对绑定表做画像」的落点：没有对象类型引用它，就返回空数组，调用方据此跳过采样。
 * 一份来源里 `sourceId` 留空的属性按主来源算（与 `entitySources` 的读法一致）。
 */
export function mappedColumnsFor(definition: OntologyDefinition, dataSourceId: string, schema: string, table: string): string[] {
  const wanted = profileTableKey(schema, table);
  const columns = new Set<string>();
  for (const entity of definition.entityTypes) {
    for (const source of entitySources(entity)) {
      if (source.dataSourceId !== dataSourceId) continue;
      if (profileTableKey(source.schema, source.view) !== wanted) continue;
      for (const property of entity.properties) {
        if (!property.sourceField) continue;
        if (property.sourceId && property.sourceId !== source.id) continue;
        columns.add(property.sourceField.trim());
      }
    }
  }
  return [...columns].filter(Boolean).slice(0, PROFILE_MAX_COLUMNS);
}

/** 驱动返回的行按列名大小写不一定和请求一致（Oracle 会给大写），取值要按大小写不敏感找。 */
function valueOfRow(row: Record<string, unknown>, column: string): unknown {
  if (column in row) return row[column];
  const upper = column.toUpperCase();
  if (upper in row) return row[upper];
  const lower = column.toLowerCase();
  if (lower in row) return row[lower];
  const hit = Object.keys(row).find((key) => key.toUpperCase() === upper);
  return hit ? row[hit] : undefined;
}

/** 从采样行里算每列的画像。纯函数，单测直接喂假数据。 */
export function profileFromRows(rows: readonly Record<string, unknown>[], columns: readonly string[]): ProfileColumn[] {
  return columns.map((column) => {
    const counts = new Map<string, number>();
    let nulls = 0;
    for (const row of rows) {
      const raw = valueOfRow(row, column);
      if (raw === null || raw === undefined) { nulls += 1; continue; }
      const text = typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      // 超长文本不是"码值"，省掉它们，别把画像撑成一张数据表。
      const key = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const distinct = counts.size;
    const highCardinality = distinct > PROFILE_MAX_VALUES;
    const values = highCardinality
      ? []
      : [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")).map(([value]) => value);
    return { name: column, distinct, nullRate: rows.length ? nulls / rows.length : 0, values, highCardinality };
  });
}

/** 读缓存的画像；没有就返回 null。 */
export async function readColumnProfile(sourceId: string, tableKey: string): Promise<ColumnProfile | null> {
  const repo = await platformRepo(ColumnProfileEntity);
  const row = await repo.findOne({ where: { sourceId, tableKey } });
  const stored = row?.profile as ColumnProfile | null | undefined;
  if (!stored || typeof stored !== "object" || !Array.isArray(stored.columns)) return null;
  return { ...stored, sourceId, sampledAt: new Date(row!.sampledAt).toISOString() };
}

/** 写画像（同表覆盖）。采样时间以传入的 sampledAt 为准，界面与 TTL 都读它。 */
export async function writeColumnProfile(profile: ColumnProfile): Promise<void> {
  const repo = await platformRepo(ColumnProfileEntity);
  const row = {
    sourceId: profile.sourceId,
    tableKey: profileTableKey(profile.schema, profile.table),
    schemaName: profile.schema,
    tableName: profile.table,
    profile: jsonValue(profile),
    sampledAt: new Date(profile.sampledAt),
  };
  await repo.upsert(row, ["sourceId", "tableKey"]);
}

export function profileIsFresh(profile: ColumnProfile, now = Date.now()) {
  const at = Date.parse(profile.sampledAt);
  return Number.isFinite(at) && now - at < PROFILE_TTL_MS;
}

/**
 * 取一张表的列画像：命中缓存（且没过期）就直接用，否则采样一次并写回缓存。
 *
 * `refresh` = true 时**跳过缓存**重采（界面上「刷新结构」那种明确动作才用它）。
 * 表没被任何对象类型绑定时不做采样，`profile` 为 null 并带一句人话原因 —— 这是刻意的：
 * 平台不提供"直接枚举库表"的能力，表只能通过对象类型到达。
 */
export async function ensureColumnProfile(input: {
  definition: OntologyDefinition;
  record: DataSourceRecord;
  view: { schema?: string; name: string };
  refresh?: boolean;
}): Promise<{ profile: ColumnProfile | null; cached: boolean; warning?: string }> {
  const schema = (input.view.schema ?? input.record.schema_name ?? "").trim();
  const table = input.view.name.trim();
  const label = [schema, table].filter(Boolean).join(".");
  const columns = mappedColumnsFor(input.definition, input.record.id, schema, table);
  if (!columns.length) {
    return { profile: null, cached: false, warning: `「${label}」没有被任何对象类型绑定，按约定不做列画像（本平台里表只能通过对象类型到达）。` };
  }
  if (!input.refresh) {
    const hit = await readColumnProfile(input.record.id, profileTableKey(schema, table));
    if (hit && profileIsFresh(hit)) return { profile: hit, cached: true };
  }
  const { openDataSource } = await import("@/lib/data-sources");
  const connector = await openDataSource(input.record);
  if (!connector.selectRows) return { profile: null, cached: false, warning: `数据资源「${input.record.name}」不支持按列取行，无法做列画像。` };
  const page = await connector.selectRows({ view: { schema: schema || undefined, name: table }, columns, limit: PROFILE_SAMPLE_ROWS });
  const profile: ColumnProfile = {
    sourceId: input.record.id,
    schema,
    table,
    sampledAt: new Date().toISOString(),
    sampleSize: page.rows.length,
    columns: profileFromRows(page.rows, columns),
  };
  await writeColumnProfile(profile);
  return { profile, cached: false };
}

/**
 * 把本体内**所有绑定表**的已缓存画像拼成检索用的取值索引（不回源库、不采样）。
 *
 * search_schema 每次都会调它，所以这里只读平台库；没有画像的表就是没有，
 * 工具会如实告诉模型"想按码值检索就先 get_table_ddl 看一眼那张表"。
 */
export async function cachedColumnValueIndex(definition: OntologyDefinition): Promise<ColumnValueIndex> {
  const wanted = new Map<string, { sourceId: string; schema: string; table: string }>();
  for (const entity of definition.entityTypes) {
    for (const source of entitySources(entity)) {
      if (!source.dataSourceId || !source.view) continue;
      const key = profileTableKey(source.schema, source.view);
      if (!wanted.has(key)) wanted.set(key, { sourceId: source.dataSourceId, schema: source.schema, table: source.view });
    }
  }
  const index: ColumnValueIndex = new Map();
  if (!wanted.size) return index;
  const repo = await platformRepo(ColumnProfileEntity);
  const rows = await repo.find({ where: [...new Set([...wanted.values()].map((item) => item.sourceId))].map((sourceId) => ({ sourceId })) });
  for (const row of rows) {
    const stored = row.profile as ColumnProfile | null | undefined;
    if (!stored || !Array.isArray(stored.columns)) continue;
    const columns = new Map<string, string[]>();
    for (const column of stored.columns) {
      if (column.highCardinality || !column.values.length) continue;
      columns.set(column.name.trim().toUpperCase(), column.values);
    }
    if (columns.size) index.set(row.tableKey, columns);
  }
  return index;
}
