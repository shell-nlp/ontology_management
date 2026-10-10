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
  /**
   * 这个对象的**对象类型**名（不是接口名）。多标签节点取定义里的那个对象类型，
   * 索引里的唯一键、按类型统计与对象服务都靠它。
   */
  entityType: string;
  /**
   * 对象键 = (对象类型, 主键) 的唯一表示（`@/lib/object-identity` 的 `objectKeyOf`）。
   * 没有主键时退回 `id:<objectId>`：索引行仍然唯一，但它**不构成身份**。
   */
  objectKey: string;
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
  entityType: string;
  objectKey: string;
  labels: string[];
  title: string;
  properties: Record<string, unknown>;
  primaryKey: Record<string, string>;
  score: number;
};

/** 一次增量同步的结果：写进去多少、删掉多少、这个本体存储同步后总共有多少。 */
export type ObjectIndexSyncResult = {
  upserted: number;
  deleted: number;
  total: number;
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
  /**
   * 增量写入：按**对象键**（对象类型 + 主键）upsert。
   *
   * 这是发布与"改一行同步一行"走的路：不整表替换，没变的行原样留着。
   * `prune` 为真时，把这次没出现的键删掉（发布时用：快照才是权威）；为假时只增不删（同步单行用）。
   */
  syncTargetObjects(
    targetId: string,
    entries: ObjectIndexEntry[],
    options?: { versionId?: string | null; prune?: boolean },
  ): Promise<ObjectIndexSyncResult>;
  /**
   * 按对象键读一条原始条目（对象服务按主键定位对象用）。
   * 走唯一键，不经过全文检索，也不受检索行数上限影响。
   */
  readObject(targetId: string, objectKey: string): Promise<ObjectIndexEntry | null>;
  /** 按对象键批量删除，返回实际删除的行数。 */
  deleteObjects(targetId: string, objectKeys: string[]): Promise<number>;
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
