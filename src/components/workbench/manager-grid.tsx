"use client";

import { Children, type ReactNode } from "react";
import { useSplitPane } from "@/components/split-pane";
import type { Definition } from "@/lib/ontology/draft";
import type { RelationshipRow } from "./types";

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
