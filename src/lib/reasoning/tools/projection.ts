import { ToolContext } from "./registry";
import { effectiveInterfaceLinkConstraints, implementsIdsOf, implementersOf } from "@/lib/ontology/interfaces";
import { type DataSourceRecord } from "@/lib/datasource/types";
import { entitySources, sourceRoleLabel } from "@/lib/ontology/sources";
import { keyMappingLabel, keyMappingRows, type KeyMapping } from "@/lib/ontology/relationship-keys";
import { sourceTableBinding, type SourceTableBinding } from "@/lib/datasource/column-profile";
import { type EntityRecord } from "@/lib/framework/graph/types";
import { type OntologyDefinition } from "@/lib/ontology";
import { type ObjectContext, type ObjectRecord } from "@/lib/instance/object-service/types";

export function titleOf(definition: OntologyDefinition, node: EntityRecord) {
  const type = definition.entityTypes.find((item) => node.labels.includes(item.name));
  const display = type?.displayProperty?.trim();
  if (display && node.properties[display] != null) return String(node.properties[display]);
  for (const key of ["名称", "name", "title", "编号"]) {
    if (node.properties[key] != null) return String(node.properties[key]);
  }
  return node.id.slice(0, 8);
}

export function identityOf(definition: OntologyDefinition, node: EntityRecord) {
  const objectType = node.labels.find((label) => definition.entityTypes.some((item) => item.name === label)) ?? node.labels[0] ?? "";
  return { object_type: objectType, object_id: node.id, title: titleOf(definition, node) };
}

/**
 * 实例工具的上下文：目标本体存储 + 已发布定义。
 *
 * `versionId` 留空是有意的 —— 读路径（索引 / 回源）不需要它，只有往索引里写才用得上，
 * 而工具是只读的。所以这里不必再去查一次版本记录。
 */
export function objectContextOf(context: ToolContext): ObjectContext {
  return { targetId: context.store.target.id, definition: context.definition, versionId: null };
}

/** 对象服务返回的对象 -> 工具的实例形状（与图库那条路径保持同一个形状）。 */
export function instanceOf(record: ObjectRecord) {
  return {
    _instance_identity: { object_type: record.entityType, object_id: record.objectId, title: record.title },
    labels: [record.entityType],
    properties: record.properties,
    _origin: record.origin,
    _primary_key: record.primaryKey,
  };
}

/** 属性里的布局信息（fx/fy）对推理没有意义，去掉能省不少 token。 */
export function businessProperties(node: EntityRecord) {
  return Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "fx" && key !== "fy"));
}

/**
 * 一条关系类型声明过的键映射（连接属性 → 该端对象类型的属性）；两端都没配就是 null。
 *
 * get_object_type 的一跳与 traverse_object_types 的边共用这一份 —— 多跳时模型同样需要连接键，
 * 以前只在 get_object_type 里给，走 2 跳以上就只能猜列名，猜错是**静默错数**。
 */
export function keyMappingsOf(relation: { sourceKeyMappings?: readonly KeyMapping[]; targetKeyMappings?: readonly KeyMapping[] }) {
  const source = keyMappingRows(relation.sourceKeyMappings).map(keyMappingLabel);
  const target = keyMappingRows(relation.targetKeyMappings).map(keyMappingLabel);
  if (!source.length && !target.length) return null;
  return { source, target };
}

/**
 * 一张表可能属于哪些已登记的数据资源。纯函数，不连库。
 *
 * get_table_ddl 在模型没给 data_source 时用它自动定位 —— 模型常常只拿到一个表名，
 * 硬要它先反查出资源名是多一轮往返。判据与来源绑定一致：先看有没有对象类型绑到这张表，
 * 都没有就退一步按模式名匹配（来源还没补齐绑定时就靠这条兜底）。
 */
export function dataSourcesForTable(definition: OntologyDefinition, dataSources: readonly DataSourceRecord[], schema: string, table: string): DataSourceRecord[] {
  const wantTable = (table ?? "").trim().toUpperCase();
  if (!wantTable) return [];
  const wantSchema = (schema ?? "").trim().toUpperCase();
  const ids = new Set<string>();
  let mentioned = false;
  for (const entity of definition.entityTypes) {
    for (const source of entitySources(entity)) {
      if ((source.view ?? "").trim().toUpperCase() !== wantTable) continue;
      const sourceSchema = (source.schema ?? "").trim().toUpperCase();
      if (wantSchema && sourceSchema && sourceSchema !== wantSchema) continue;
      mentioned = true;
      const id = (source.dataSourceId ?? "").trim();
      if (id) ids.add(id);
    }
  }
  const bound = dataSources.filter((item) => ids.has(item.id));
  if (bound.length) return bound;
  /*
   * 只有「表名确实被某条来源引用、但那条来源没绑资源（或绑飞了）」才走模式名兜底。
   * 表名谁都没引用时返回空 —— 那多半是表名写错了，该让调用方报「定位不出」，别硬塞一个资源去连。
   */
  if (!mentioned || !wantSchema) return [];
  return dataSources.filter((item) => (item.schema_name ?? "").trim().toUpperCase() === wantSchema);
}

/**
 * 一张表被哪些对象类型绑着、各自映射了哪些列。
 *
 * 为什么要有它：表的可达路径一直是"对象类型 → 它绑的表"，模型拿一张表名进来时
 * **查不到这张表是什么**（清单里没有"枚举库表"这种能力，也不该有）。
 * 反过来给一份"这张表被谁用、哪几列被映射了"，模型立刻能判断"是不是表名写错了 / 该看哪个对象类型"。
 * 纯函数：只读定义，不连库。
 */
export function objectTypesBoundTo(definition: OntologyDefinition, dataSourceId: string, schema: string, table: string, knownSourceIds?: readonly string[]) {
  const bindings: { object_type: string; source_role: string; primary_key: string[]; mapped_columns: string[]; mapped_column_count: number; binding: SourceTableBinding }[] = [];
  for (const entity of definition.entityTypes) {
    entitySources(entity).forEach((source, index) => {
      const binding = sourceTableBinding(source, { dataSourceId, schema, table, knownSourceIds });
      if (!binding) return;
      const columns = [...new Set(entity.properties
        .filter((property) => property.sourceField && (!property.sourceId || property.sourceId === source.id))
        .map((property) => property.sourceField as string))];
      bindings.push({
        object_type: entity.name,
        source_role: sourceRoleLabel(index),
        primary_key: source.primaryKey.filter(Boolean),
        /*
         * **给全，不截断**（2026-10-10 用户口径：「列清单不要设上限把尾巴砍掉」）。
         * 以前只列前 30 列，结果 51 列的表里从第 31 列起（含 U_TYPE 这种关键口径列）永远看不见，
         * 模型只能再调一次 get_object_type 反查 —— 省了小钱、赔了一次往返。
         */
        mapped_columns: columns,
        mapped_column_count: columns.length,
        binding,
      });
    });
  }
  return bindings;
}

export function clamp(value: unknown, fallback: number, max: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(max, Math.floor(numeric));
}

/** 多跳查询的默认跳数与上限（用户口径：默认 3，最多 5）。 */
export const DEFAULT_TRAVERSE_HOPS = 3;

export const MAX_TRAVERSE_HOPS = 5;

export type TypeGraphNode = {
  name: string;
  group: string;
  /** 距离起点最近的跳数；起点自己是 0。 */
  hop: number;
  description: string;
  /** 绑定的表（`SCHEMA.TABLE`），没绑就是空数组。 */
  bound_tables: string[];
};

/**
 * 一条边（关系类型）。`from` / `to` 是定义里的起点与终点；两个方向都能走，所以它同时表示反向那条。
 * `via_interface` 只在"这条关系是接口带出来的"时出现 —— 见 `interfaceDerivedLinks`。
 */
/** 边的基数只在"这条边来自关系类型本身"时才有：接口承接的关系由接口约束描述，不带这一项。 */
export type TypeGraphEdge = { relation: string; from: string; to: string; hop: number; via_interface?: string; cardinality?: string; key_mapping?: { source: string[]; target: string[] } };

/**
 * 接口带来的关系（Palantir 的 interface link type 语义）：对象类型实现了接口，
 * 接口的每条关系约束就由它落地 —— 实现方必须能走到约束里的对端。
 *
 * 为什么工具也要算这一层：接口的关系约束落在**影子对象类型**身上（提取为接口时原样保留），
 * 实现方自己在 `relationshipTypes` 里一条边都没有。不补这一层，工具会如实回答
 * "集团客户一跳内没有任何关系类型"，模型就只能答"走不到"，而画布上明明连着。
 *
 * 对端写的是"另一个接口"时，取那个接口的实现方（含实现它子接口的对象类型）。
 */
export function interfaceDerivedLinks(definition: OntologyDefinition): { name: string; fromId: string; toId: string; viaInterface: string }[] {
  const interfaces = definition.interfaces ?? [];
  if (!interfaces.length) return [];
  const interfaceNameById = new Map(interfaces.map((item) => [item.id, item.name]));
  const knownEntityIds = new Set(definition.entityTypes.map((item) => item.id));
  const links: { name: string; fromId: string; toId: string; viaInterface: string }[] = [];
  const seen = new Set<string>();
  for (const entity of definition.entityTypes) {
    for (const interfaceId of implementsIdsOf(entity)) {
      // effectiveInterfaceLinkConstraints 已经把继承来的父接口约束算进去了，这里只看这个接口。
      const viaInterface = interfaceNameById.get(interfaceId) ?? "";
      for (const constraint of effectiveInterfaceLinkConstraints(interfaces, interfaceId)) {
        if (!constraint.name) continue;
        const targets = constraint.targetKind === "INTERFACE"
          ? implementersOf(interfaces, definition.entityTypes, constraint.targetId).map((item) => item.id)
          : [constraint.targetId];
        for (const targetId of targets) {
          if (!targetId || targetId === entity.id || !knownEntityIds.has(targetId)) continue;
          const key = `${entity.id}|${constraint.name}|${targetId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          links.push({ name: constraint.name, fromId: entity.id, toId: targetId, viaInterface });
        }
      }
    }
  }
  return links;
}

/** 遍历方向：`both` 两个方向都走（默认），`forward` 只沿"起点→终点"，`backward` 只沿"终点→起点"。 */
export type TraverseDirection = "both" | "forward" | "backward";

export function parseTraverseDirection(value: unknown): TraverseDirection {
  return value === "forward" || value === "backward" ? value : "both";
}

export type TypeGraphTraversal = {
  hops: number;
  /** 本次实际生效的方向（没传或传了不认识的值就是 `both`）。 */
  direction: TraverseDirection;
  starts: string[];
  nodes: TypeGraphNode[];
  edges: TypeGraphEdge[];
  /** 起点没写对时，这条名字会被原样报回去（不猜）。 */
  unknown_start: string;
  /** object_types / relationship_types 里本体没有的名字。 */
  unknown_names: string[];
  filters: { object_types: string[]; relationship_types: string[] };
};
