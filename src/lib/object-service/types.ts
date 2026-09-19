import type { OntologyDefinition } from "@/lib/ontology";
import type { ObjectPrimaryKey } from "@/lib/object-identity";
import type { ObjectSearchFilter } from "@/lib/object-index/types";

/**
 * 对象服务的公共契约（S2）。
 *
 * 三件事在这里被固定下来，之后换中间件的代价就只是"换一个适配器"：
 * 1. **上层只认 `(本体, 对象类型, 主键)`**，不认图库、不认索引表、不认业务表；
 * 2. **对象从哪来由 `origin` 决定**：`index` = 物化索引里有（快），`source` = 按需回源（全）；
 * 3. **对象来源是一个端口（`ObjectSource`）**，当前实现是"数据资源连接器"，
 *    将来要接物化对象层 / ES / REST，只加一个实现，门面与界面都不用改。
 */

export type ObjectOrigin = "index" | "source";

/** 一次对象访问的上下文：本体存储 + 定义（已发布版本，或指定的草稿版本）。 */
export type ObjectContext = {
  targetId: string;
  definition: OntologyDefinition;
  versionId: string | null;
};

/** 一个对象在服务层的统一形态。 */
export type ObjectRecord = {
  /**
   * 对象身份 = (对象类型, 主键) 推导出来的确定性 id（`@/lib/object-identity`）。
   * 主键不全时为 `""` —— 这种对象没有稳定身份，调用方按"只有快照里那一份"处理。
   */
  objectId: string;
  entityType: string;
  primaryKey: ObjectPrimaryKey;
  title: string;
  properties: Record<string, unknown>;
  origin: ObjectOrigin;
  /** 稳定引用串：`对象类型/主键串`，界面与工具之间传引用用它，不用内部 id。 */
  objectRef: string;
  /** 读取过程中的如实告知（没绑来源、来源不支持、被截断等），不挡结果。 */
  warnings: string[];
};

export type ObjectQuery = {
  entityType: string;
  text?: string;
  filters?: ObjectSearchFilter[];
  limit?: number;
  offset?: number;
  /** auto = 索引里有这个对象类型的条目就用索引，否则回源。 */
  origin?: "auto" | ObjectOrigin;
};

export type ObjectQueryResult = {
  entityType: string;
  rows: ObjectRecord[];
  /** 索引侧给得出精确总数；回源侧拿不到时是 null，不编造。 */
  total: number | null;
  origin: ObjectOrigin | "none";
  warnings: string[];
  tookMs: number;
};

export type ObjectSourceRead = {
  record: ObjectRecord | null;
  warnings: string[];
};

export type ObjectSourceQuery = {
  rows: ObjectRecord[];
  total: number | null;
  warnings: string[];
};

/**
 * 对象来源端口。**换来源 = 换实现**：
 * 当前是"数据资源连接器"（`data-source.ts`），将来接物化对象层 / Elasticsearch 时，
 * 新实现只要满足这三件事，`object-service/index.ts` 与所有上层调用点一行都不用动。
 */
export interface ObjectSource {
  readonly kind: string;
  readByKey(definition: OntologyDefinition, entityTypeName: string, primaryKey: ObjectPrimaryKey): Promise<ObjectSourceRead>;
  query(definition: OntologyDefinition, entityTypeName: string, query: ObjectQuery): Promise<ObjectSourceQuery>;
}
