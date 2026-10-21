import { In } from "typeorm";
import type { OntologyDefinition } from "@/lib/ontology";
import type { OdsVersionChanges } from "@/lib/infrastructure/ods/types";
import { OdsSourceEntity, platformRepo } from "@/lib/infrastructure/persistence/postgres";

export type OdsPublishBlocker = {
  entityTypeId: string;
  entityType: string;
  dataSourceId: string;
  schema: string;
  table: string;
  reason: string;
  status?: string;
};

export class OdsPublishBlockedError extends Error {
  readonly blockers: OdsPublishBlocker[];

  constructor(blockers: OdsPublishBlocker[]) {
    super(`有 ${blockers.length} 个对象类型缺少可发布的 READY ODS 镜像。`);
    this.name = "OdsPublishBlockedError";
    this.blockers = blockers;
  }
}

function sourceKey(dataSourceId: string, schema: string, table: string) {
  return [dataSourceId, schema, table].map((value) => String(value ?? "").trim().toUpperCase()).join("\u0000");
}

/** 本地 CRUD 涉及的对象类型必须在发布前具备完整、可读的 ODS 来源。 */
export async function assertOdsReadyForPublishedChanges(definition: OntologyDefinition, changes: OdsVersionChanges) {
  const affected = new Set<string>();
  for (const change of changes.objects) affected.add(change.entityTypeId);
  for (const change of changes.relationships) {
    affected.add(change.sourceEntityTypeId);
    affected.add(change.targetEntityTypeId);
  }
  if (!affected.size) return;

  const types = definition.entityTypes.filter((type) => affected.has(type.id));
  const relationshipTypes = new Map(definition.relationshipTypes.map((type) => [type.id, type]));
  const sourceIds = [...new Set([
    ...types.flatMap((type) => (type.sources ?? []).map((source) => source.dataSourceId).filter(Boolean)),
    ...changes.relationships.map((change) => relationshipTypes.get(change.relationshipTypeId)).flatMap((type) => {
      const source = type?.linkSource;
      return source?.dataSourceId ? [source.dataSourceId] : [];
    }),
  ])];
  const configs = sourceIds.length
    ? await platformRepo(OdsSourceEntity).then((repo) => repo.find({ where: { dataSourceId: In(sourceIds) } }))
    : [];
  const byKey = new Map(configs.map((config) => [sourceKey(config.dataSourceId, config.schemaName, config.tableName), config]));
  const blockers: OdsPublishBlocker[] = [];

  for (const type of types) {
    const sources = (type.sources ?? []).filter((source) => source.dataSourceId && source.view);
    if (!sources.length) {
      blockers.push({
        entityTypeId: type.id,
        entityType: type.name,
        dataSourceId: "",
        schema: "",
        table: "",
        reason: "对象类型没有绑定可镜像的数据来源。",
      });
      continue;
    }
    for (const source of sources) {
      const base = {
        entityTypeId: type.id,
        entityType: type.name,
        dataSourceId: source.dataSourceId,
        schema: source.schema ?? "",
        table: source.view,
      };
      if (source.kind !== "PHYSICAL" || (source.sql ?? "").trim()) {
        blockers.push({ ...base, reason: "取数口径来源不能承载发布后的本地 CRUD；请绑定物理表或视图。" });
        continue;
      }
      if (source.readMode === "DIRECT") {
        blockers.push({ ...base, reason: "来源读取路径为 DIRECT，会绕过发布版本变更集；请改为 AUTO 或 ODS。" });
        continue;
      }
      const config = byKey.get(sourceKey(source.dataSourceId, source.schema ?? "", source.view));
      if (!config || !config.enabled || config.status !== "READY") {
        blockers.push({
          ...base,
          reason: config
            ? !config.enabled
              ? "ODS 镜像已停用。"
              : `ODS 镜像状态为 ${config.status}，不是 READY。`
            : "还没有配置 ODS 镜像。",
          ...(config ? { status: config.status } : {}),
        });
        continue;
      }
      const mirrored = new Set((Array.isArray(config.columns) ? config.columns : [])
        .map((column) => String((column as { name?: unknown }).name ?? "").trim().toUpperCase())
        .filter(Boolean));
      const required = new Set(source.primaryKey.map((column) => column.trim()).filter(Boolean));
      for (const change of changes.objects.filter((item) => item.entityTypeId === type.id && item.operation !== "DELETE")) {
        for (const propertyName of change.changedProperties) {
          const property = type.properties.find((item) => item.name === propertyName);
          if (!property) continue;
          const owner = (property.sourceId ?? "").trim() || type.sources?.[0]?.id || "";
          if (owner !== source.id) continue;
          const column = (property.sourceField || property.name).trim();
          if (!column) {
            blockers.push({ ...base, reason: `本地修改属性「${property.name}」没有映射到来源列，不能进入 ODS 版本变更集。` });
            continue;
          }
          required.add(column);
        }
      }
      const missing = [...required].filter((column) => !mirrored.has(column.toUpperCase()));
      if (missing.length) {
        blockers.push({ ...base, reason: `ODS 镜像缺少对象属性映射列：${missing.join("、")}。`, status: config.status });
      }
    }
  }
  for (const change of changes.relationships) {
    const type = relationshipTypes.get(change.relationshipTypeId);
    const endpoint = definition.entityTypes.find((item) => item.id === change.sourceEntityTypeId);
    const base = {
      entityTypeId: change.sourceEntityTypeId,
      entityType: endpoint?.name ?? change.sourceEntityTypeId,
      dataSourceId: type?.linkSource?.dataSourceId ?? "",
      schema: type?.linkSource?.schema ?? "",
      table: type?.linkSource?.view ?? "",
    };
    if (!type) {
      blockers.push({ ...base, reason: `关系类型「${change.relationshipType}」已不在当前定义中。` });
      continue;
    }
    if (type.linkSource?.mode !== "JOIN_TABLE" || !type.linkSource.dataSourceId || !type.linkSource.view) {
      blockers.push({ ...base, reason: `本地关系变更「${type.name}」目前只支持连接表式关系；请先配置关系连接表。` });
      continue;
    }
    const config = byKey.get(sourceKey(type.linkSource.dataSourceId, type.linkSource.schema ?? "", type.linkSource.view));
    if (!config || !config.enabled || config.status !== "READY") {
      blockers.push({
        ...base,
        reason: config
          ? !config.enabled ? "关系连接表的 ODS 镜像已停用。" : `关系连接表 ODS 状态为 ${config.status}，不是 READY。`
          : "关系连接表还没有配置 ODS 镜像。",
        ...(config ? { status: config.status } : {}),
      });
      continue;
    }
    const mirrored = new Set((Array.isArray(config.columns) ? config.columns : [])
      .map((column) => String((column as { name?: unknown }).name ?? "").trim().toUpperCase())
      .filter(Boolean));
    const required = [...type.sourceKeyMappings, ...type.targetKeyMappings]
      .map((mapping) => mapping.linkProperty.trim())
      .filter(Boolean);
    const missing = [...new Set(required.filter((column) => !mirrored.has(column.toUpperCase())))];
    if (missing.length) {
      blockers.push({ ...base, reason: `关系连接表 ODS 缺少键映射列：${missing.join("、")}。`, status: config.status });
    }
  }
  if (blockers.length) throw new OdsPublishBlockedError(blockers);
}
