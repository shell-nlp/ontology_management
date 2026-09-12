/**
 * 对象检索层的公共契约。
 *
 * 背景（2026-09-12 决定）：平台原先让图库同时承担三件事——权威存储、关系遍历、
 * 属性检索。Palantir 的做法是把它们拆开（元数据服务 + 对象存储/搜索索引 + 查询编排），
 * 图只是上面的应用层。这里落地其中的「检索索引」那一层。
 *
 * 检索索引是**派生数据**：任何时刻都能从已发布快照重建，索引坏了不影响本体正确性。
 * 当前只实现 PostgreSQL 一种后端（全文 + 模糊 + 向量），能力上暂时替代原计划的
 * Elasticsearch，换来的是零额外集群、零双写协调成本。将来要接 OpenSearch / Solr 时，
 * 实现这里的 ObjectIndex 即可，上层只认这个接口。
 */
export type ObjectIndexKind = "POSTGRES";

/** 一条进入检索索引的对象。objectId 是平台身份，primaryKey 是业务主键（M1 落位后成为真身份）。 */
export type ObjectIndexEntry = {
  objectId: string;
  labels: string[];
  title: string;
  properties: Record<string, unknown>;
  /** 业务主键值：列名 -> 值，来自 sources[0].primaryKey 与属性的 sourceField 映射。 */
  primaryKey: Record<string, string>;
  /** 供全文与模糊检索使用的合并文本。 */
  searchText: string;
  /** 可选向量；没有 embedding 提供方时为 null。 */
  embedding?: number[] | null;
};

export type ObjectFilterOperator = "EQ" | "NE" | "CONTAINS" | "GT" | "LT" | "IN" | "EXISTS";

export type ObjectSearchFilter = {
  property: string;
  operator: ObjectFilterOperator;
  value?: string | number | boolean | string[];
};

export type ObjectSearchQuery = {
  targetId: string;
  /** 限定类；空数组表示不限。 */
  labels?: string[];
  /** 关键字，走全文 + 模糊双通道。 */
  text?: string;
  filters?: ObjectSearchFilter[];
  limit?: number;
  offset?: number;
  /** 有向量时以向量相似度为主要排序信号。 */
  vector?: number[];
};

export type ObjectSearchHit = {
  objectId: string;
  labels: string[];
  title: string;
  properties: Record<string, unknown>;
  primaryKey: Record<string, string>;
  score: number;
};

export type ObjectSearchResult = {
  hits: ObjectSearchHit[];
  total: number;
  tookMs: number;
  /** 实际用到的检索通道，便于前端提示与排障。 */
  textMode: "fulltext+trigram" | "fulltext" | "none";
  vectorUsed: boolean;
};

export type ObjectIndexStats = {
  entries: number;
  byLabel: { label: string; count: number }[];
  updatedAt: string | null;
};

export type ObjectIndexCapabilities = {
  available: boolean;
  fullText: boolean;
  trigram: boolean;
  vector: boolean;
  embeddingDim: number | null;
  reason?: string;
};

export interface ObjectIndex {
  readonly kind: ObjectIndexKind;
  /** 用给定对象整体替换该本体存储的索引；失败时旧索引保持可用。 */
  replaceTargetObjects(
    targetId: string,
    entries: ObjectIndexEntry[],
    options?: { versionId?: string | null },
  ): Promise<{ indexed: number }>;
  searchObjects(query: ObjectSearchQuery): Promise<ObjectSearchResult>;
  deleteTargetObjects(targetId: string): Promise<void>;
  stats(targetId: string): Promise<ObjectIndexStats>;
  capabilities(): Promise<ObjectIndexCapabilities>;
}
