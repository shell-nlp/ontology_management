"use client";

import { Children, type ReactNode, useCallback, useState } from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { useSplitPane } from "@/components/split-pane";
import { type OntologySummary } from "@/components/ontology-studio";
import { api } from "@/lib/framework/api-client";
import { can, type Permission } from "@/lib/platform/permissions";
import { graphTargetKindInfo, type GraphTargetKind } from "@/lib/framework/graph/types";
import { entitySources, sourceName, type Definition, type EntityType, type Property } from "@/lib/ontology/draft";





export type User = { id: string; email: string; roleId: string; roleName: string; permissions: Permission[] };

/**
 * "这个人有没有这个权限点"。界面用它决定按钮可见 / 可点 —— 但这**只是体验**：
 * 真正的边界在服务端的 requirePermission，界面藏起来的按钮直接调接口照样 403。
 */

export function may(user: User, code: Permission): boolean {
  return can(user.permissions, code);
}
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

export type View = "overview" | "ontology" | "actions" | "rules" | "qa" | "mcp" | "skills" | "graph" | "entities" | "relations" | "data" | "settings";

export type EntityRow = { id: string; labels: string[]; properties: Record<string, unknown> };

export type RelationshipRow = { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown>; sourceLabels?: string[]; sourceProperties?: Record<string, unknown>; targetLabels?: string[]; targetProperties?: Record<string, unknown> };

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

/**
 * 行内提示：长在内容里的那种（登录卡片）。工作台里的全局提示走下面的 `Toast`。
 */

export function Notice({ message, error, onDismiss }: { message: string | null; error?: boolean; onDismiss?: () => void }) {
  if (!message) return null;
  return <div className={error ? "notice error" : "notice"}>{error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}{message}{onDismiss && <button className="notice-close" onClick={onDismiss}><X size={14} /></button>}</div>;
}

/**
 * 全局提示：**底部居中的浮层吐司**。用户口径（2026-10-10）：「当前账号没有这个权限。最好是弹出的，
 * 而不是在最上面」—— 压在页头会把内容往下顶，而且滚到页面下半截就看不见了。
 *
 * 成功类提示由 `notify()` 的 5 秒计时器收起；错误（`error`）等用户自己关，权限类的话要让人读完。
 * z-index 比 `.dialog-backdrop`（120）高：在弹窗里保存失败时也要看得见。
 *
 * 位置别挪回右下角：Next.js 开发模式那个圆形 dev 按钮就压在右下角，会盖住关闭按钮。
 */

export function Toast({ message, error, onDismiss }: { message: string | null; error?: boolean; onDismiss?: () => void }) {
  if (!message) return null;
  return <div className="toast-stack" role="status" aria-live="polite">
    <div className={error ? "toast error" : "toast"}>
      {error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
      <span>{message}</span>
      {onDismiss && <button type="button" className="toast-close" title="关闭" onClick={onDismiss}><X size={14} /></button>}
    </div>
  </div>;
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


export type GraphSettings = { nodeLimit: number; maxNeighbors: number; recordLimit: number };

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = { nodeLimit: 300, maxNeighbors: 200, recordLimit: 5000 };

export const GRAPH_SETTINGS_KEY = "atlas.graph-settings";


export function clampLimit(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}


export function loadGraphSettings(): GraphSettings {
  if (typeof window === "undefined") return DEFAULT_GRAPH_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(GRAPH_SETTINGS_KEY) ?? "{}") as Partial<GraphSettings>;
    return {
      nodeLimit: clampLimit(parsed.nodeLimit, DEFAULT_GRAPH_SETTINGS.nodeLimit, 1, 10000),
      maxNeighbors: clampLimit(parsed.maxNeighbors, DEFAULT_GRAPH_SETTINGS.maxNeighbors, 1, 10000),
      recordLimit: clampLimit(parsed.recordLimit, DEFAULT_GRAPH_SETTINGS.recordLimit, 1, 100000),
    };
  } catch { return DEFAULT_GRAPH_SETTINGS; }
}


export function useGraphSettings() {
  const [settings, setSettings] = useState<GraphSettings>(loadGraphSettings);
  const update = useCallback((patch: Partial<GraphSettings>) => {
    setSettings((current) => {
      const next: GraphSettings = {
        nodeLimit: clampLimit(patch.nodeLimit, current.nodeLimit, 1, 10000),
        maxNeighbors: clampLimit(patch.maxNeighbors, current.maxNeighbors, 1, 10000),
        recordLimit: clampLimit(patch.recordLimit, current.recordLimit, 1, 100000),
      };
      try { window.localStorage.setItem(GRAPH_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const reset = useCallback(() => { try { window.localStorage.removeItem(GRAPH_SETTINGS_KEY); } catch { /* ignore */ } setSettings(DEFAULT_GRAPH_SETTINGS); }, []);
  return { settings, update, reset };
}


export type DisplaySettings = { entityLimit: number; relationshipLimit: number };

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = { entityLimit: 200, relationshipLimit: 200 };

export const DISPLAY_SETTINGS_KEY = "atlas.display-settings";


export function loadDisplaySettings(): DisplaySettings {
  if (typeof window === "undefined") return DEFAULT_DISPLAY_SETTINGS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISPLAY_SETTINGS_KEY) ?? "{}") as Partial<DisplaySettings>;
    return {
      entityLimit: clampLimit(parsed.entityLimit, DEFAULT_DISPLAY_SETTINGS.entityLimit, 1, 10000),
      relationshipLimit: clampLimit(parsed.relationshipLimit, DEFAULT_DISPLAY_SETTINGS.relationshipLimit, 1, 10000),
    };
  } catch { return DEFAULT_DISPLAY_SETTINGS; }
}


export function useDisplaySettings() {
  const [settings, setSettings] = useState<DisplaySettings>(loadDisplaySettings);
  const update = useCallback((patch: Partial<DisplaySettings>) => {
    setSettings((current) => {
      const next: DisplaySettings = {
        entityLimit: clampLimit(patch.entityLimit, current.entityLimit, 1, 10000),
        relationshipLimit: clampLimit(patch.relationshipLimit, current.relationshipLimit, 1, 10000),
      };
      try { window.localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);
  const reset = useCallback(() => { try { window.localStorage.removeItem(DISPLAY_SETTINGS_KEY); } catch { /* ignore */ } setSettings(DEFAULT_DISPLAY_SETTINGS); }, []);
  return { settings, update, reset };
}


export const MANAGER_SPLIT_MIN_LEFT = 380;

export const MANAGER_SPLIT_MIN_DETAIL = 380;

export const MANAGER_SPLIT_MAX_LEFT = 900;

export const MANAGER_SPLIT_DEFAULT_LEFT = 520;

/** 对象页的两栏：左边清单、右边详情，中间是可拖的分隔条（拖拽逻辑与概念分组共用 split-pane.ts）。 */

export function ResizableManagerGrid({ children, defaultWidth = MANAGER_SPLIT_DEFAULT_LEFT, storageKey }: { children: ReactNode; defaultWidth?: number; storageKey: string }) {
  const { containerRef, containerStyle, handleProps } = useSplitPane({
    storageKey,
    defaultWidth,
    minLeft: MANAGER_SPLIT_MIN_LEFT,
    minDetail: MANAGER_SPLIT_MIN_DETAIL,
    maxLeft: MANAGER_SPLIT_MAX_LEFT,
    label: "拖动调整列表宽度，双击恢复默认",
  });
  const items = Children.toArray(children);
  return <section className="manager-grid instance-manager-grid" ref={containerRef} style={containerStyle}>
    {items[0]}
    <div {...handleProps}><span aria-hidden="true" /></div>
    {items.slice(1)}
  </section>;
}


export function nodeDisplayName(labels: string[] | undefined, properties: Record<string, unknown> | undefined, definition: Definition | null): string {
  if (!properties) return "";
  const entityType = definition?.entityTypes.find((item) => labels?.includes(item.name));
  const primary = entityType?.displayProperty;
  if (primary && properties[primary] != null) return String(properties[primary]);
  for (const key of ["name", "名称", "title", "label"]) if (properties[key] != null) return String(properties[key]);
  return "";
}


export function relationshipEndpoints(row: RelationshipRow, definition: Definition | null) {
  return { source: nodeDisplayName(row.sourceLabels, row.sourceProperties, definition), target: nodeDisplayName(row.targetLabels, row.targetProperties, definition) };
}
