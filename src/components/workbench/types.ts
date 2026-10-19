import type { Permission } from "@/lib/platform/permissions";
import type { GraphTargetKind } from "@/lib/infrastructure/graph/types";
import type { Definition } from "@/lib/ontology/draft";

export type User = { id: string; email: string; roleId: string; roleName: string; permissions: Permission[] };

/** `/api/links` 返回的一条边（对象服务那边叫 ObjectLinkRecord）。 */

export type BusinessLink = {
  relationshipType: string;
  linkRef: string;
  properties: Record<string, unknown>;
  source: { entityType: string; objectId: string; primaryKey: Record<string, string>; objectRef: string };
  target: { entityType: string; objectId: string; primaryKey: Record<string, string>; objectRef: string };
};
/**
 * 节点 id → 它的业务主键。
 * 只有"从业务库读来的对象"才会登记：对象 id 是从 (对象类型, 主键) 哈希出来的、**不可逆**，
 * 点节点做一跳展开时得靠它还原主键，才能去问关系类型的数据来源（D2）。
 */

export type NodeKeyMap = Record<string, { entityType: string; primaryKey: Record<string, string> }>;

export type Target = { id: string; name: string; kind: GraphTargetKind; kindLabel: string; queryLanguage: "sparql"; uri: string; databaseName: string; username: string; options: Record<string, unknown> };

export type Version = { id: string; target_id: string; version_number: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: Definition; artifact_path?: string | null; entity_count?: number; relationship_count?: number; content_hash?: string | null };

export type View = "overview" | "ontology" | "qa" | "mcp" | "skills" | "graph" | "entities" | "relations" | "data" | "settings";

export type EntityRow = { id: string; labels: string[]; properties: Record<string, unknown> };

export type RelationshipRow = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown>; sourceLabels?: string[]; sourceProperties?: Record<string, unknown>; targetLabels?: string[]; targetProperties?: Record<string, unknown> };

