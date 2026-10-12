/**
 * 对象检索层的公共契约。
 *
 * 背景（2026-09-12 决定）：平台原先让图库同时承担三件事——权威存储、关系遍历、
 * 属性检索。Palantir 的做法是把它们拆开（元数据服务 + 对象存储/搜索索引 + 查询编排），
 * 图只是上面的应用层。这里落地其中的「检索索引」那一层。
 *
 * 检索索引是**派生数据**：任何时刻都能从数据源与已发布快照重建，索引坏了不影响本体正确性。
 * 现在的后端是 ClickHouse（列存：过滤 + 聚合 + 全文 + 暴力向量），本体定义与版本仍在平台库
 * PostgreSQL 里。将来要接别的后端（OpenSearch / 专用对象库…）时，实现这里的 ObjectIndex 即可，
 * 上层只认这个接口。
 */
export type ObjectIndexKind = "CLICKHOUSE";

/**
 * 索引行的**来源**。
 *
 * - `SNAPSHOT`：随版本快照走的对象（手工建的、动作写进草稿的、取进草稿的业务对象）；
 * - `MATERIALIZED`：按对象类型从业务库**整份物化**进来的对象。
 *
 * 两者必须分得清：发布与「重建索引」只替换 `SNAPSHOT` 那一份，**不许把物化数据清掉**；
 * 反过来整份物化只动 `MATERIALIZED` 那一份，不碰本体自己建的对象。
 */
export type ObjectIndexOrigin = "SNAPSHOT" | "MATERIALIZED";

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

/**
 * 某个对象类型的**物化清单**：最近一次整份物化的结果。
 *
 * 存在的理由就一条：**半份必须报数**（用户口径 2026-10-12）。索引里有多少条、源里扫了多少条、
 * 是不是撞到上限被截断，都要能查得到 —— 否则页面会显示成"这个类型只有 N 个对象"，看起来像数据少了，
 * 实际是只物化了一部分。
 */
export type ObjectIndexMaterialization = {
  targetId: string;
  entityType: string;
  /** 写进索引的条数。 */
  rows: number;
  /** 从源里读过的行数（撞上限时 = 上限）。 */
  scanned: number;
  /** 撞到上限、源里可能还有更多。 */
  truncated: boolean;
  /** 读了多少页。 */
  pages: number;
  completedAt: string;
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
   * `pruneLabel` 把 prune 收窄到**一个对象类型**：整份物化是「一个类型一批」跑的，
   * 不收窄的话，物化 A 会把 B 的物化数据一起删掉（2026-10-12 真踩过）。发布快照这种
   * 「整份都在这一批里」的场景不传它，语义就是「这个本体的这一来源以这批为准」。
   */
  syncTargetObjects(
    targetId: string,
    entries: ObjectIndexEntry[],
    options?: { versionId?: string | null; prune?: boolean; origin?: ObjectIndexOrigin; pruneLabel?: string },
  ): Promise<ObjectIndexSyncResult>;
  /**
   * 按对象键读一条原始条目（对象服务按主键定位对象用）。
   * 走唯一键，不经过全文检索，也不受检索行数上限影响。
   */
  readObject(targetId: string, objectKey: string): Promise<ObjectIndexEntry | null>;
  /** 按对象键批量删除，返回实际删除的行数。 */
  deleteObjects(targetId: string, objectKeys: string[]): Promise<number>;
  /**
   * 只删**某个对象类型**索引行（可按来源再收窄），返回实际删除的行数。
   * 用途：把某个类型的物化数据清掉（保留快照对象），或按类型重来一遍。
   */
  deleteTypeObjects(targetId: string, entityType: string, options?: { origin?: ObjectIndexOrigin }): Promise<number>;
  /** 只删**某一来源**的全部索引行（例如"把整库的物化数据清掉、保留快照"），返回删除的行数。 */
  deleteOriginObjects(targetId: string, origin: ObjectIndexOrigin): Promise<number>;
  /** 用给定对象整体替换该本体存储的索引；失败时旧索引保持可用。 */
  replaceTargetObjects(
    targetId: string,
    entries: ObjectIndexEntry[],
    options?: { versionId?: string | null; origin?: ObjectIndexOrigin },
  ): Promise<{ indexed: number }>;
  searchObjects(query: ObjectSearchQuery): Promise<ObjectSearchResult>;
  deleteTargetObjects(targetId: string): Promise<void>;
  stats(targetId: string): Promise<ObjectIndexStats>;
  /** 这个本体存储下各对象类型的物化清单（没有整份物化过的类型不在里面）。 */
  listMaterializations(targetId: string): Promise<ObjectIndexMaterialization[]>;
  /** 记下（覆盖）一个对象类型的物化清单。 */
  saveMaterialization(record: ObjectIndexMaterialization): Promise<void>;
  /** 删掉某个对象类型的物化清单（连同它的物化数据一起清时用）。 */
  deleteMaterialization(targetId: string, entityType: string): Promise<void>;
  capabilities(): Promise<ObjectIndexCapabilities>;
}
