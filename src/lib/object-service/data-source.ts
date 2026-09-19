import type { DataSourceRowFilter, DataSourceRows } from "@/lib/data-source/types";
import type { OntologyDefinition } from "@/lib/ontology";
import type { ObjectPrimaryKey } from "@/lib/object-identity";
import { objectIdOf, objectRefOf, primaryKeyColumns, primaryKeyFromProperties, propertyForColumn } from "@/lib/object-identity";
import { getDataSource, openDataSource } from "@/lib/data-sources";
import type { ObjectQuery, ObjectRecord, ObjectSource, ObjectSourceQuery, ObjectSourceRead } from "@/lib/object-service/types";

/**
 * 「数据资源」这个对象来源的实现（S2 的默认实现）。
 *
 * 它只做三件事：
 * 1. 把对象类型上的**属性映射**（`properties[].sourceField` + `sources[]`）翻译成"取哪些列"；
 * 2. 通过连接器的 `selectRows` / `countRows` 取行（连接器负责 SQL 与方言，见 data-source/sql.ts）；
 * 3. 把行翻回对象（含多来源 MDO 的逐列合并）。
 *
 * 于是"对象放在哪"变得可替换：将来接物化对象层 / Elasticsearch / REST，
 * 只要另写一个 `ObjectSource`，本文件不动，对象服务与界面也不用改。
 */

/** 单次回源最多取多少行：对象服务是交互式读取，不做批量导出。 */
export const MAX_SOURCE_ROWS = 500;
const DEFAULT_SOURCE_ROWS = 50;
/** 文本检索最多铺几列，避免一条语句里出现上百个 LIKE。 */
const MAX_SEARCH_COLUMNS = 20;
/** 可下推到数据源的过滤算子；其余的如实告知不支持。 */
const SUPPORTED_OPERATORS = new Set(["EQ", "NE", "CONTAINS", "IN"]);

type EntityType = OntologyDefinition["entityTypes"][number];

function findEntityType(definition: OntologyDefinition, name: string): EntityType | null {
  return definition.entityTypes.find((item) => item.name === name) ?? null;
}

/** 对象类型上绑定的数据来源（主来源在前）。 */
function sourcesOf(entityType: EntityType) {
  return (entityType.sources ?? []).filter((source) => source.dataSourceId || source.view);
}

/** 某一份来源要取的列：映射到它的属性列 + 它的主键列 + 标题列。 */
export function sourceColumns(entityType: EntityType, sourceId: string): string[] {
  const columns = new Set<string>();
  const mainSourceId = entityType.sources?.[0]?.id ?? "";
  for (const column of entityType.sources?.find((item) => item.id === sourceId)?.primaryKey ?? []) {
    if (column?.trim()) columns.add(column.trim());
  }
  const title = entityType.sources?.find((item) => item.id === sourceId)?.titleField?.trim();
  if (title) columns.add(title);
  for (const property of entityType.properties) {
    const field = (property.sourceField ?? "").trim();
    if (!field) continue;
    // 属性没写 sourceId 就按**主来源**算；写了就只归那一份来源。
    const owner = (property.sourceId ?? "").trim() || mainSourceId;
    if (owner !== sourceId) continue;
    columns.add(field);
  }
  return [...columns];
}

/** 一行（列名大小写由库决定）-> 对象属性：按属性的 sourceField / 同名匹配。 */
export function rowProperties(entityType: EntityType, row: Record<string, unknown>): Record<string, unknown> {
  const byLower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  const properties: Record<string, unknown> = {};
  for (const property of entityType.properties) {
    const field = (property.sourceField ?? property.name).trim();
    if (!field) continue;
    const key = field.toLowerCase();
    if (byLower.has(key)) properties[property.name] = byLower.get(key);
  }
  return properties;
}

/** 标题：优先展示属性，其次 name，再次主键值，最后退回对象类型名。 */
export function titleOf(entityType: EntityType, properties: Record<string, unknown>, primaryKey: ObjectPrimaryKey): string {
  const display = entityType.displayProperty?.trim();
  const candidates = [display, "name", "名称", ...Object.keys(primaryKey)].filter(Boolean) as string[];
  for (const key of candidates) {
    const value = properties[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
    if (typeof value === "number") return String(value);
  }
  return Object.values(primaryKey).join(" / ") || entityType.name;
}

function recordOf(entityTypeName: string, entityType: EntityType, properties: Record<string, unknown>, warnings: string[]): ObjectRecord {
  const primaryKey = primaryKeyFromProperties(entityType, properties).primaryKey;
  return {
    objectId: objectIdOf(entityTypeName, primaryKey),
    entityType: entityTypeName,
    primaryKey,
    title: titleOf(entityType, properties, primaryKey),
    properties,
    origin: "source",
    objectRef: objectRefOf(entityTypeName, primaryKey),
    warnings,
  };
}

async function connectorFor(dataSourceId: string) {
  const record = await getDataSource(dataSourceId);
  if (!record) throw new Error("对象类型绑定的数据资源不存在，请到数据资源里检查。");
  if (!record.enabled) throw new Error(`数据资源「${record.name}」已停用，无法按主键取对象。`);
  return { connector: await openDataSource(record), label: record.name };
}

async function selectRowsBy(
  dataSourceId: string,
  source: { schema: string; view: string },
  columns: string[],
  filters: DataSourceRowFilter[],
  options: { limit: number; search?: { text: string; columns: string[] } },
  warnings: string[],
): Promise<DataSourceRows> {
  const { connector, label } = await connectorFor(dataSourceId);
  if (!connector.selectRows) {
    throw new Error(`数据资源「${label}」不支持结构化取行，无法按主键读对象。`);
  }
  const result = await connector.selectRows({
    view: { schema: source.schema || undefined, name: source.view },
    columns,
    filters,
    ...(options.search ? { search: options.search } : {}),
    limit: options.limit,
  });
  if (result.truncated) warnings.push(`命中行数超过 ${result.rowLimit} 行，只返回了前 ${result.rowLimit} 行。`);
  return result;
}

export function createDataSourceObjectSource(): ObjectSource {
  return {
    kind: "DATA_SOURCE",

    async readByKey(definition, entityTypeName, primaryKey): Promise<ObjectSourceRead> {
      const entityType = findEntityType(definition, entityTypeName);
      if (!entityType) return { record: null, warnings: [`本体里没有对象类型「${entityTypeName}」。`] };
      const sources = sourcesOf(entityType);
      if (!sources.length) {
        return { record: null, warnings: [`对象类型「${entityTypeName}」没有绑定数据资源，只能读本体里已有的对象。`] };
      }
      const main = sources[0];
      const keyColumns = primaryKeyColumns(entityType);
      if (!keyColumns.length) {
        return { record: null, warnings: [`对象类型「${entityTypeName}」没有配主键，无法按主键取对象。`] };
      }
      const warnings: string[] = [];
      const filters: DataSourceRowFilter[] = keyColumns.map((column) => ({ column, operator: "EQ", value: primaryKey[column] ?? "" }));
      const rows = await selectRowsBy(
        main.dataSourceId,
        main,
        sourceColumns(entityType, main.id),
        filters,
        { limit: 1 },
        warnings,
      );
      const row = rows.rows[0];
      if (!row) return { record: null, warnings: [...warnings, `数据资源里没有主键为「${objectRefOf(entityTypeName, primaryKey)}」的记录。`] };

      let properties = rowProperties(entityType, row);
      // 多来源对象类型（MDO）：补充来源按主键**位置对齐**连接，只补属性，主来源优先。
      const keyValues = keyColumns.map((column) => primaryKey[column]);
      for (const extra of sources.slice(1)) {
        const extraColumns = extra.primaryKey.map((column) => column?.trim()).filter(Boolean);
        const extraFilters: DataSourceRowFilter[] = extraColumns.map((column, index) => ({ column, operator: "EQ", value: keyValues[index] ?? "" }));
        if (extraFilters.length !== keyColumns.length) {
          warnings.push(`补充来源「${extra.view}」的主键列数与主来源对不上，已跳过。`);
          continue;
        }
        const extraRows = await selectRowsBy(
          extra.dataSourceId,
          extra,
          sourceColumns(entityType, extra.id),
          extraFilters,
          { limit: 1 },
          warnings,
        );
        if (extraRows.rows[0]) properties = { ...rowProperties(entityType, extraRows.rows[0]), ...properties };
      }
      return { record: recordOf(entityTypeName, entityType, properties, warnings), warnings };
    },

    async query(definition, entityTypeName, query): Promise<ObjectSourceQuery> {
      const entityType = findEntityType(definition, entityTypeName);
      if (!entityType) return { rows: [], total: null, warnings: [`本体里没有对象类型「${entityTypeName}」。`] };
      const sources = sourcesOf(entityType);
      if (!sources.length) {
        return { rows: [], total: null, warnings: [`对象类型「${entityTypeName}」没有绑定数据资源，无法回源取数。`] };
      }
      const main = sources[0];
      const warnings: string[] = [];
      const columns = sourceColumns(entityType, main.id);
      const filters: DataSourceRowFilter[] = [];
      for (const filter of query.filters ?? []) {
        const property = entityType.properties.find((item) => item.name === filter.property);
        const column = (property?.sourceField ?? (property ? property.name : "")).trim();
        if (!column) { warnings.push(`筛选字段「${filter.property}」没有映射到数据列，已忽略。`); continue; }
        if (!SUPPORTED_OPERATORS.has(filter.operator)) {
          warnings.push(`筛选「${filter.property}」用了 ${filter.operator}，回源查询暂不支持，已忽略。`);
          continue;
        }
        filters.push({ column, operator: filter.operator as DataSourceRowFilter["operator"], value: filter.value as DataSourceRowFilter["value"] });
      }
      const limit = Math.min(MAX_SOURCE_ROWS, Math.max(1, Math.floor(query.limit ?? DEFAULT_SOURCE_ROWS)));
      const search = query.text?.trim()
        ? { text: query.text.trim(), columns: columns.slice(0, MAX_SEARCH_COLUMNS) }
        : undefined;
      const rows = await selectRowsBy(main.dataSourceId, main, columns, filters, { limit, search }, warnings);
      const records = rows.rows.map((row) => recordOf(entityTypeName, entityType, rowProperties(entityType, row), warnings));

      let total: number | null = null;
      try {
        const { connector } = await connectorFor(main.dataSourceId);
        if (connector.countRows) {
          total = await connector.countRows({
            view: { schema: main.schema || undefined, name: main.view },
            filters,
            ...(search ? { search } : {}),
          });
        }
      } catch (error) {
        // 总数拿不到不影响结果本身：如实说明，不把整次查询判失败。
        warnings.push(`总数统计失败：${error instanceof Error ? error.message : "未知错误"}`);
      }
      return { rows: records, total, warnings };
    },
  };
}

export { propertyForColumn };
export type { ObjectQuery };
