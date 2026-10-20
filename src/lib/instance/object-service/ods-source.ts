import { In } from "typeorm";
import type { OntologyDefinition } from "@/lib/ontology";
import { objectIdOf, objectRefOf, primaryKeyFromProperties, type ObjectPrimaryKey } from "@/lib/ontology/object-identity";
import { getOdsStore } from "@/lib/infrastructure/ods";
import { OdsSourceEntity, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import type { DataSourceRowFilter } from "@/lib/shared/common/data-source-kind";
import { createDataSourceObjectSource, sourceColumns, sourceRowProperties, titleOf } from "@/lib/instance/object-service/data-source";
import type { ObjectQuery, ObjectRecord, ObjectSource, ObjectSourceQuery, ObjectSourceRead } from "@/lib/instance/object-service/types";

type EntityType = OntologyDefinition["entityTypes"][number];
type EntitySource = NonNullable<EntityType["sources"]>[number];

type RoutedSource = { source: EntitySource; ods: OdsSourceEntity };

function findEntity(definition: OntologyDefinition, name: string) {
  return definition.entityTypes.find((item) => item.name === name) ?? null;
}

function sourceKey(source: Pick<EntitySource, "dataSourceId" | "schema" | "view">) {
  return `${source.dataSourceId}|${source.schema}|${source.view}`;
}

function recordOf(entityType: EntityType, properties: Record<string, unknown>, warnings: string[]): ObjectRecord {
  const primaryKey = primaryKeyFromProperties(entityType, properties).primaryKey;
  return {
    objectId: objectIdOf(entityType.name, primaryKey),
    entityType: entityType.name,
    primaryKey,
    title: titleOf(entityType, properties, primaryKey),
    properties,
    origin: "source",
    objectRef: objectRefOf(entityType.name, primaryKey),
    warnings,
  };
}

async function routedSources(definition: OntologyDefinition, entityType: EntityType): Promise<{ routed: RoutedSource[] | null; explicit: boolean; reason?: string }> {
  const sources = (entityType.sources ?? []).filter((source) => source.dataSourceId && source.view);
  if (!sources.length) return { routed: null, explicit: false };
  const explicit = sources.some((source) => source.readMode === "ODS");
  if (sources.some((source) => source.kind !== "PHYSICAL" || source.readMode === "DIRECT")) return { routed: null, explicit };
  const repo = await platformRepo(OdsSourceEntity);
  const configs = await repo.find({ where: { dataSourceId: In([...new Set(sources.map((source) => source.dataSourceId))]), enabled: true } });
  const bySource = new Map(configs.map((config) => [sourceKey({ dataSourceId: config.dataSourceId, schema: config.schemaName, view: config.tableName }), config]));
  const routed: RoutedSource[] = [];
  for (const source of sources) {
    const ods = bySource.get(sourceKey(source));
    if (!ods || ods.status !== "READY") {
      return {
        routed: null,
        explicit,
        reason: explicit
          ? `对象类型「${entityType.name}」要求读取 ODS，但来源「${source.schema ? `${source.schema}.` : ""}${source.view}」没有可用的 READY 镜像。请先同步 ODS，或把来源读取路径改为 AUTO / DIRECT。`
          : undefined,
      };
    }
    const available = new Set((Array.isArray(ods.columns) ? ods.columns : []).map((column) => String((column as { name?: unknown }).name ?? "").toLowerCase()));
    const missing = sourceColumns(entityType, source.id).filter((column) => !available.has(column.toLowerCase()));
    if (missing.length) {
      return {
        routed: null,
        explicit,
        reason: explicit
          ? `ODS「${ods.chTable}」缺少对象属性映射列：${missing.join(", ")}。请重新配置并同步 ODS 后再切换读取路径。`
          : undefined,
      };
    }
    routed.push({ source, ods });
  }
  return { routed, explicit };
}

function mappedFilter(entityType: EntityType, propertyName: string, mainId: string) {
  const property = entityType.properties.find((item) => item.name === propertyName);
  if (!property) throw new Error(`属性「${propertyName}」不存在。`);
  const column = (property.sourceField ?? property.name).trim();
  const sourceId = (property.sourceId ?? "").trim() || entityType.sources?.[0]?.id || "";
  if (sourceId !== mainId) throw new Error(`属性「${propertyName}」来自补充来源，当前 ODS 虚拟查询不能跨来源下推过滤或排序。`);
  return column;
}

function mainFilters(entityType: EntityType, mainId: string, filters: ObjectQuery["filters"]): DataSourceRowFilter[] {
  return (filters ?? []).map((filter) => ({
    column: mappedFilter(entityType, filter.property, mainId),
    operator: filter.operator,
    ...(filter.operator === "EXISTS" ? {} : { value: filter.value as string | number | boolean | string[] }),
  }));
}

async function readOds(input: {
  routed: RoutedSource[];
  entityType: EntityType;
  columns: string[];
  filters: DataSourceRowFilter[];
  keyGroups?: DataSourceRowFilter[][];
  text?: string;
  sort?: { column: string; direction: "ASC" | "DESC" }[];
  limit: number;
  offset?: number;
  count?: boolean;
}) {
  const [main, ...extras] = input.routed;
  if (!main) throw new Error("没有可读的 ODS 来源。");
  const result = await getOdsStore().read({
    sourceId: main.ods.id,
    tableName: main.ods.chTable,
    columns: input.columns,
    filters: input.filters,
    keyGroups: input.keyGroups,
    ...(input.text ? { search: { text: input.text, columns: input.columns } } : {}),
    ...(input.sort?.length ? { sort: input.sort } : {}),
    limit: input.limit,
    offset: input.offset,
    count: input.count,
  });
  const warnings: string[] = [];
  if (result.truncated) warnings.push(`ODS 命中超过 ${input.limit} 行，只返回前 ${input.limit} 行。`);
  const records = result.rows.map((row) => recordOf(input.entityType, sourceRowProperties(input.entityType, main.source.id, row), warnings));
  for (const extra of extras) {
    if (!records.length) break;
    const keyColumns = extra.source.primaryKey.map((column) => column.trim()).filter(Boolean);
    const mainKeys = main.source.primaryKey.map((column) => column.trim()).filter(Boolean);
    if (keyColumns.length !== mainKeys.length) continue;
    const filters: DataSourceRowFilter[] = keyColumns.map((column, index) => {
      const values = [...new Set(records.map((record) => record.primaryKey[mainKeys[index]]).filter(Boolean))];
      return values.length === 1 ? { column, operator: "EQ", value: values[0] } : { column, operator: "IN", value: values };
    });
    const extraRows = await getOdsStore().read({ sourceId: extra.ods.id, tableName: extra.ods.chTable, columns: sourceColumns(input.entityType, extra.source.id), filters, limit: 20000 });
    const rawByKey = new Map<string, Record<string, unknown>[]>();
    for (const row of extraRows.rows) {
      const values = keyColumns.map((column) => {
        const match = Object.keys(row).find((name) => name.toLowerCase() === column.toLowerCase());
        return match ? String(row[match] ?? "").trim() : "";
      });
      const key = JSON.stringify(values);
      const list = rawByKey.get(key) ?? [];
      list.push(row);
      rawByKey.set(key, list);
    }
    for (const record of records) {
      const key = JSON.stringify(keyColumns.map((_column, index) => String(record.primaryKey[mainKeys[index]] ?? "").trim()));
      const row = rawByKey.get(key)?.[0];
      if (row) record.properties = { ...sourceRowProperties(input.entityType, extra.source.id, row), ...record.properties };
    }
  }
  return { records, total: result.total, warnings };
}

export function createOdsFirstObjectSource(): ObjectSource {
  const direct = createDataSourceObjectSource();
  return {
    kind: "ODS_FIRST",
    async readByKey(definition, entityTypeName, primaryKey): Promise<ObjectSourceRead> {
      const entityType = findEntity(definition, entityTypeName);
      if (!entityType) return direct.readByKey(definition, entityTypeName, primaryKey);
      const route = await routedSources(definition, entityType);
      if (!route.routed) {
        if (route.explicit) throw new Error(route.reason ?? "ODS 不可用。");
        return direct.readByKey(definition, entityTypeName, primaryKey);
      }
      const main = route.routed[0];
      const keyFilters: DataSourceRowFilter[] = main.source.primaryKey.map((column) => ({ column, operator: "EQ", value: primaryKey[column] ?? "" }));
      const result = await readOds({ routed: route.routed, entityType, columns: sourceColumns(entityType, main.source.id), filters: keyFilters, limit: 1, count: false });
      return { record: result.records[0] ?? null, warnings: result.warnings };
    },
    async query(definition, entityTypeName, query): Promise<ObjectSourceQuery> {
      // Whole-source jobs need the source connector's keyset cursor, not an interactive ODS page.
      if (query.paging || query.cursor) return direct.query(definition, entityTypeName, query);
      const entityType = findEntity(definition, entityTypeName);
      if (!entityType) return direct.query(definition, entityTypeName, query);
      const route = await routedSources(definition, entityType);
      if (!route.routed) {
        if (route.explicit) throw new Error(route.reason ?? "ODS 不可用。");
        return direct.query(definition, entityTypeName, query);
      }
      const main = route.routed[0];
      const filters = mainFilters(entityType, main.source.id, query.filters);
      if (query.keys?.length) {
        for (const column of main.source.primaryKey) {
          const values = [...new Set(query.keys.map((key) => key[column]).filter((value): value is string => Boolean(value)))];
          if (values.length) filters.push(values.length === 1 ? { column, operator: "EQ", value: values[0] } : { column, operator: "IN", value: values });
        }
      }
      const sort = (query.sort ?? []).map((item) => ({ column: mappedFilter(entityType, item.property, main.source.id), direction: item.direction }));
      const result = await readOds({
        routed: route.routed,
        entityType,
        columns: sourceColumns(entityType, main.source.id),
        filters,
        keyGroups: query.keys?.map((key) => main.source.primaryKey.map((column) => {
          if (!key[column]) throw new Error(`复合主键缺少列「${column}」。`);
          return { column, operator: "EQ", value: key[column] };
        })),
        text: query.text,
        sort,
        limit: Math.min(20000, Math.max(1, query.limit ?? 50)),
        offset: query.offset,
        count: query.count,
      });
      const wanted = query.keys?.length ? new Set(query.keys.map((key) => JSON.stringify(main.source.primaryKey.map((column) => String(key[column] ?? "").trim())))) : null;
      const records = wanted ? result.records.filter((record) => wanted.has(JSON.stringify(main.source.primaryKey.map((column) => String(record.primaryKey[column] ?? "").trim())))) : result.records;
      return { rows: records, total: wanted ? records.length : result.total, warnings: result.warnings, limit: Math.min(20000, Math.max(1, query.limit ?? 50)) };
    },
  };
}
