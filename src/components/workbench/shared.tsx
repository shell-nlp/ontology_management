"use client";

import { type OntologySummary } from "@/components/ontology-studio";
import { can, type Permission } from "@/lib/platform/permissions";
import { graphTargetKindInfo, type GraphTargetKind } from "@/lib/infrastructure/graph/types";
import { entitySources, sourceName, type Definition, type EntityType, type Property } from "@/lib/ontology/draft";
import type { EntityRow, Target, User } from "./types";

export * from "./types";
export * from "./feedback";
export * from "./settings";
export * from "./manager-grid";

/** 界面可见性判断；真正的安全边界仍在服务端 route guard。 */
export function may(user: User, code: Permission): boolean {
  return can(user.permissions, code);
}





export function targetFromStorage(storage: OntologySummary["storage"]): Target | null {
  if (!storage) return null;
  return {
    id: storage.id,
    name: storage.name,
    kind: storage.kind as GraphTargetKind,
    kindLabel: storage.kindLabel,
    queryLanguage: "sparql",
    uri: storage.uri,
    databaseName: "",
    username: "",
    options: {},
  };
}


export function graphNoun(target: Target | null | undefined) {
  return target ? graphTargetKindInfo(target.kind).label : "图数据库";
}

/** 对象实际生效的属性就是它那个类自己定义的属性（类之间没有继承，2026-09-16 起）。 */

export function effectivePropertiesFor(definition: Definition | null, labels: string[]): Property[] | null {
  const type = definition?.entityTypes.find((item) => labels.includes(item.name));
  return type ? type.properties : null;
}

export function sourceSummary(entity: EntityType) {
  const sources = entitySources(entity);
  if (!sources.length) return "未绑定";
  const primary = sourceName(sources[0]);
  return sources.length > 1 ? `${primary} +${sources.length - 1}` : primary;
}

export function entityTitle(node: Pick<EntityRow, "labels" | "properties">, definition: Definition | null = null) {
  const entityType = definition?.entityTypes.find((item) => node.labels.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && node.properties[primary] != null) return String(node.properties[primary]);
  const preferred = ["name", "名称", "title", "id"].map((key) => node.properties[key]).find((value) => typeof value === "string" || typeof value === "number");
  return String(preferred ?? node.labels[0] ?? "未命名");
}


export function propertySummary(properties: Record<string, unknown>, limit = 3) {
  const entries = Object.entries(properties).filter(([key]) => key !== "fx" && key !== "fy");
  return entries.slice(0, limit).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ");
}
