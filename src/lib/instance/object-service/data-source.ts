import type { DataSourceRowFilter, DataSourceRows } from "@/lib/datasource/types";
import type { OntologyDefinition } from "@/lib/ontology";
import type { ObjectPrimaryKey } from "@/lib/ontology/object-identity";
import { objectIdOf, objectRefOf, primaryKeyColumns, primaryKeyFromProperties, propertyForColumn } from "@/lib/ontology/object-identity";
import { getDataSource, openDataSource } from "@/lib/datasource/sources";
import type { ObjectQuery, ObjectRecord, ObjectSource, ObjectSourceQuery, ObjectSourceRead } from "@/lib/instance/object-service/types";
import { MAX_MATERIALIZE_PAGE_SIZE } from "@/lib/instance/materialize-limits";

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

/**
 * 单次回源最多取多少行。
 *
 * 交互式读取默认只要几十行（`DEFAULT_SOURCE_ROWS`），但**整份物化**会按页大小来要
 * （默认 2000、上限 20000，见 `materialize-limits`）—— 这个上限必须跟它对齐，
 * 否则物化要 2000 行、这里只给 500 行，读循环会以为"源读完了"，反而报"只读到 500 行"。
 */
export const MAX_SOURCE_ROWS = MAX_MATERIALIZE_PAGE_SIZE;
const DEFAULT_SOURCE_ROWS = 50;
/** 文本检索最多铺几列，避免一条语句里出现上百个 LIKE。 */
const MAX_SEARCH_COLUMNS = 20;
/** 可下推到数据源的过滤算子；其余的如实告知不支持。 */
const SUPPORTED_OPERATORS = new Set(["EQ", "NE", "CONTAINS", "GT", "LT", "IN", "EXISTS"]);

type EntityType = OntologyDefinition["entityTypes"][number];

function findEntityType(definition: OntologyDefinition, name: string): EntityType | null {
  return definition.entityTypes.find((item) => item.name === name) ?? null;
}

/** 对象类型上绑定的数据来源（主来源在前）。 */
function sourcesOf(entityType: EntityType) {
  // 口径来源（DERIVED）没有 view，只有 sql —— 也要算「接了数据」，否则它会被当成纯类型层建模。
  return (entityType.sources ?? []).filter((source) => source.dataSourceId || source.view || source.sql);
}

/**
 * 来源 → 连接器要的「数据来源引用」。
 *
 * 有**取数口径**（DERIVED）时优先用口径：不查数据字典，直接把这段时间当子查询；
 * 否则就是老样子 —— 按 `schema.view` 定位表 / 视图。
 */
function viewRefOf(source: { schema: string; view: string; sql?: string }) {
  const sql = (source.sql ?? "").trim();
  return { schema: source.schema || undefined, name: source.view, ...(sql ? { sql } : {}) };
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

/** 只映射某一份来源自己的属性；批次补齐补充来源时不能让同名列串到别的来源上。 */
export function sourceRowProperties(entityType: EntityType, sourceId: string, row: Record<string, unknown>): Record<string, unknown> {
  const mainSourceId = entityType.sources?.[0]?.id ?? "";
  const byLower = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]));
  const properties: Record<string, unknown> = {};
  for (const property of entityType.properties) {
    const owner = (property.sourceId ?? "").trim() || mainSourceId;
    if (owner !== sourceId) continue;
    const field = (property.sourceField ?? property.name).trim();
    if (!field || !byLower.has(field.toLowerCase())) continue;
    properties[property.name] = byLower.get(field.toLowerCase());
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

function sourceOfProperty(entityType: EntityType, propertyName: string) {
  const property = entityType.properties.find((item) => item.name === propertyName);
  if (!property) throw new Error(`对象类型「${entityType.name}」没有属性「${propertyName}」，不能用于筛选或排序。`);
  const column = (property.sourceField ?? property.name).trim();
  if (!column) throw new Error(`属性「${propertyName}」没有映射到数据列，不能在业务库查询中筛选或排序。`);
  const sourceId = (property.sourceId ?? "").trim() || entityType.sources?.[0]?.id || "";
  const source = entityType.sources?.find((item) => item.id === sourceId);
  if (!source) throw new Error(`属性「${propertyName}」指向的数据来源「${sourceId || "主来源"}」不存在。`);
  return { property, column, source, sourceId };
}

function rawValue(row: Record<string, unknown>, column: string): unknown {
  const key = Object.keys(row).find((item) => item.toLowerCase() === column.toLowerCase());
  return key ? row[key] : undefined;
}

function keyOfSourceRow(source: NonNullable<EntityType["sources"]>[number], row: Record<string, unknown>): string | null {
  const values = source.primaryKey.map((column) => rawValue(row, column));
  if (!values.length || values.some((value) => value === null || value === undefined || String(value).trim() === "")) return null;
  return JSON.stringify(values.map((value) => String(value).trim()));
}

function keyOfPrimaryKey(source: NonNullable<EntityType["sources"]>[number], mainSource: NonNullable<EntityType["sources"]>[number], primaryKey: ObjectPrimaryKey): string | null {
  const values = source.primaryKey.map((column, index) => primaryKey[column] ?? primaryKey[mainSource.primaryKey[index]]);
  if (!values.length || values.some((value) => value === null || value === undefined || String(value).trim() === "")) return null;
  return JSON.stringify(values.map((value) => String(value).trim()));
}

export async function connectorFor(dataSourceId: string) {
  const record = await getDataSource(dataSourceId);
  if (!record) throw new Error("这个对象类型的数据来源还没绑到数据资源（或绑的资源已被删除）：请在「对象」页点「补齐数据资源绑定」。");
  if (!record.enabled) throw new Error(`数据资源「${record.name}」已停用，无法按主键取对象。`);
  return { connector: await openDataSource(record), label: record.name };
}

export async function selectRowsBy(
  dataSourceId: string,
  source: { schema: string; view: string; sql?: string },
  columns: string[],
  filters: DataSourceRowFilter[],
  options: {
    limit: number;
    offset?: number;
    search?: { text: string; columns: string[] };
    orderBy?: string[];
    sort?: { column: string; direction: "ASC" | "DESC" }[];
    after?: unknown[];
    paging?: boolean;
    keyGroups?: DataSourceRowFilter[][];
  },
  warnings: string[],
): Promise<DataSourceRows> {
  const { connector, label } = await connectorFor(dataSourceId);
  if (!connector.selectRows) {
    throw new Error(`数据资源「${label}」不支持结构化取行，无法按主键读对象。`);
  }
  const result = await connector.selectRows({
    view: viewRefOf(source),
    columns,
    filters,
    ...(options.keyGroups ? { keyGroups: options.keyGroups } : {}),
    ...(options.search ? { search: options.search } : {}),
    limit: options.limit,
    offset: Math.max(0, Math.floor(options.offset ?? 0)),
    ...(options.orderBy?.length ? { orderBy: options.orderBy } : {}),
    ...(options.sort?.length ? { sort: options.sort } : {}),
    ...(options.after?.length ? { after: options.after } : {}),
  });
  // 整份物化自己在翻页（paging）时这不叫截断：下一页会接着读，报出来只会刷一排假告警。
  if (result.truncated && !options.paging) warnings.push(`命中行数超过 ${result.rowLimit} 行，只返回了前 ${result.rowLimit} 行。`);
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

      let properties = sourceRowProperties(entityType, main.id, row);
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
        if (extraRows.rows[0]) properties = { ...sourceRowProperties(entityType, extra.id, extraRows.rows[0]), ...properties };
      }
      return { record: recordOf(entityTypeName, entityType, properties, warnings), warnings };
    },

    async query(definition, entityTypeName, query): Promise<ObjectSourceQuery> {
      const entityType = findEntityType(definition, entityTypeName);
      if (!entityType) return { rows: [], total: null, warnings: [`本体里没有对象类型「${entityTypeName}」。`], limit: 0 };
      const sources = sourcesOf(entityType);
      if (!sources.length) {
        return { rows: [], total: null, warnings: [`对象类型「${entityTypeName}」没有绑定数据资源，无法回源取数。`], limit: 0 };
      }
      const main = sources[0];
      const warnings: string[] = [];
      const columns = sourceColumns(entityType, main.id);
      const filters: DataSourceRowFilter[] = [];
      const mainKeyColumns = main.primaryKey.map((column) => column.trim()).filter(Boolean);
      if (query.keys?.length && !mainKeyColumns.length) throw new Error("按主键批量取对象必须先配置主键列。");
      const keyGroups: DataSourceRowFilter[][] | undefined = query.keys?.map((key) => mainKeyColumns.map((column) => {
        if (!key[column]) throw new Error(`复合主键缺少列「${column}」。`);
        return { column, operator: "EQ", value: key[column] };
      }));
      if (query.keys?.length) {
        for (const column of mainKeyColumns) {
          const values = [...new Set(query.keys.map((key) => key[column]).filter((value): value is string => Boolean(value)))];
          if (!values.length) continue;
          filters.push(values.length === 1
            ? { column, operator: "EQ", value: values[0] }
            : { column, operator: "IN", value: values });
        }
      }
      for (const filter of query.filters ?? []) {
        const mapped = sourceOfProperty(entityType, filter.property);
        if (!SUPPORTED_OPERATORS.has(filter.operator)) {
          throw new Error(`筛选「${filter.property}」用了 ${filter.operator}，业务库回源暂不支持这个算子。`);
        }
        if (mapped.sourceId !== main.id) {
          throw new Error(
            `筛选「${filter.property}」来自补充来源「${mapped.source.view || mapped.sourceId}」。` +
            `当前虚拟查询不能跨来源下推过滤；请把它做成对象类型的取数口径（DERIVED SQL），或把该类型切到物化索引。`,
          );
        }
        filters.push({
          column: mapped.column,
          operator: filter.operator,
          ...(filter.operator === "EXISTS" ? {} : { value: filter.value as string | number | boolean | string[] }),
        });
      }
      const sort = (query.sort ?? []).map((item) => {
        const mapped = sourceOfProperty(entityType, item.property);
        if (mapped.sourceId !== main.id) {
          throw new Error(
            `排序「${item.property}」来自补充来源「${mapped.source.view || mapped.sourceId}」。` +
            `当前虚拟查询不能跨来源下推排序；请把它做成对象类型的取数口径（DERIVED SQL），或把该类型切到物化索引。`,
          );
        }
        return { column: mapped.column, direction: item.direction };
      });
      const limit = Math.min(MAX_SOURCE_ROWS, Math.max(1, Math.floor(query.limit ?? DEFAULT_SOURCE_ROWS)));
      /*
       * 翻页偏移**必须传下去**：连接器的 selectRows 已经支持 offset（Oracle 用 ROWNUM 条件限行、
       * PG/MySQL 用 LIMIT/OFFSET）。以前这里把 query.offset 丢了，于是每一页都返回同一段第一页 ——
       * 整份物化会永远翻不到下一页（2026-10-12：837 行的表被报成 28000 条）。
       */
      const offset = Math.max(0, Math.floor(query.offset ?? 0));
      const search = query.text?.trim()
        ? { text: query.text.trim(), columns: columns.slice(0, MAX_SEARCH_COLUMNS) }
        : undefined;
      if (search && sources.length > 1) {
        warnings.push("文本检索只覆盖主来源的映射列；补充来源里的属性没有参与本次关键字匹配。");
      }
      // 游标翻页：列是**源列**，与 offset 互斥（给了排序就不再用 offset）。第一页只有 columns、没有 values。
      const cursor = query.cursor?.columns?.length ? query.cursor : null;
      const rows = await selectRowsBy(
        main.dataSourceId,
        main,
        columns,
        filters,
        cursor
          ? { limit, offset: 0, search, orderBy: cursor.columns, after: cursor.values, paging: query.paging }
          : { limit, offset, search, sort, paging: query.paging, keyGroups },
        warnings,
      );
      const wantedKeys = query.keys?.length
        ? new Set(query.keys.map((key) => JSON.stringify(mainKeyColumns.map((column) => String(key[column] ?? "").trim()))))
        : null;
      const records = rows.rows
        .map((row) => recordOf(entityTypeName, entityType, sourceRowProperties(entityType, main.id, row), warnings))
        .filter((record) => !wantedKeys || wantedKeys.has(JSON.stringify(mainKeyColumns.map((column) => String(record.primaryKey[column] ?? "").trim()))));

      /*
       * 补充来源按本页主键批量补齐：每份来源只问一次，不按行做 N+1 查询。
       * 这里仍然是查询时投影，不把补充属性复制成另一份对象；跨来源过滤与排序则在上面明确拒绝，
       * 避免把补充来源的列悄悄套到主表上得到错误结果。
       */
      for (const extra of sources.slice(1)) {
        if (!records.length) break;
        const keyColumns = extra.primaryKey.map((column) => column.trim()).filter(Boolean);
        if (keyColumns.length !== main.primaryKey.length) {
          warnings.push(`补充来源「${extra.view || extra.id}」的主键列数与主来源对不上，本页没有补齐它的属性。`);
          continue;
        }
        const values = keyColumns.map((_column, index) => {
          const mainColumn = main.primaryKey[index];
          return [...new Set(records.map((record) => record.primaryKey[mainColumn]).filter((value): value is string => Boolean(value)))];
        });
        if (values.some((items) => !items.length)) {
          warnings.push(`补充来源「${extra.view || extra.id}」的主键在当前页不完整，本页没有补齐它的属性。`);
          continue;
        }
        const extraFilters: DataSourceRowFilter[] = records.length <= 200 ? keyColumns.map((column, index) => values[index].length === 1
          ? { column, operator: "EQ", value: values[index][0] }
          : { column, operator: "IN", value: values[index] }) : [];
        const extraGroups: DataSourceRowFilter[][] = records.map((record) => keyColumns.map((column, index) => ({ column, operator: "EQ", value: record.primaryKey[main.primaryKey[index]] })));
        const extraRows = await selectRowsBy(
          extra.dataSourceId,
          extra,
          sourceColumns(entityType, extra.id),
          extraFilters,
          { limit: MAX_SOURCE_ROWS, paging: true, keyGroups: extraGroups },
          warnings,
        );
        if (extraRows.truncated) {
          warnings.push(`补充来源「${extra.view || extra.id}」超过 ${extraRows.rowLimit} 行，本页只补齐了已读到的行。`);
        }
        const byKey = new Map<string, Record<string, unknown>[]>();
        for (const row of extraRows.rows) {
          const key = keyOfSourceRow(extra, row);
          if (!key) continue;
          const bucket = byKey.get(key) ?? [];
          bucket.push(row);
          byKey.set(key, bucket);
        }
        let duplicated = 0;
        for (const record of records) {
          const key = keyOfPrimaryKey(extra, main, record.primaryKey);
          const matches = key ? byKey.get(key) ?? [] : [];
          if (matches.length > 1) duplicated += matches.length - 1;
          const row = matches[0];
          if (!row) continue;
          record.properties = { ...sourceRowProperties(entityType, extra.id, row), ...record.properties };
        }
        if (duplicated) warnings.push(`补充来源「${extra.view || extra.id}」有 ${duplicated} 行主键重复，已按第一条补齐属性。`);
      }
      // 连接器那边还夹了一层自己的硬上限（Oracle 那条是 5000），回传给调用方：它拿这个数判断"这一页读满了没有"。
      const effectiveLimit = rows.rowLimit ?? limit;

      let total: number | null = null;
      /*
       * 总数是可选的：对象页要它（分页 / 总量），**整份物化不要** —— 物化每翻一页都 COUNT(*) 一次
       * 是白白的开销（几百行的小表会变成几十次 COUNT）。所以调用方可以传 count: false 关掉。
       */
      if (wantedKeys) {
        total = records.length;
      } else if (query.count !== false) {
        try {
          const { connector } = await connectorFor(main.dataSourceId);
          if (connector.countRows) {
            total = await connector.countRows({
              view: viewRefOf(main),
              filters,
              ...(search ? { search } : {}),
            });
          }
        } catch (error) {
          // 总数拿不到不影响结果本身：如实说明，不把整次查询判失败。
          warnings.push(`总数统计失败：${error instanceof Error ? error.message : "未知错误"}`);
        }
      }
      return { rows: records, total, warnings, limit: effectiveLimit };
    },
  };
}

export { propertyForColumn };
export type { ObjectQuery };
