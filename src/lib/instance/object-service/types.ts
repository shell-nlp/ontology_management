import type { OntologyDefinition } from "@/lib/ontology";
import type { ObjectPrimaryKey } from "@/lib/ontology/object-identity";
export type ObjectSearchFilter = {
  property: string;
  operator: "EQ" | "NE" | "CONTAINS" | "GT" | "LT" | "IN" | "EXISTS";
  value?: string | number | boolean | string[];
};

/**
 * 对象服务的公共契约（S2）。
 *
 * 三件事在这里被固定下来，之后换中间件的代价就只是"换一个适配器"：
 * 1. **上层只认 `(本体, 对象类型, 主键)`**，不认图库、不认索引表、不认业务表；
 * 2. **普通读取统一虚拟化**：按来源 readMode 读取 ODS / 业务源，合并版本编辑；
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
  editMode?: "LOCAL" | "OVERRIDE";
  /** 稳定引用串：`对象类型/主键串`，界面与工具之间传引用用它，不用内部 id。 */
  objectRef: string;
  /** 读取过程中的如实告知（没绑来源、来源不支持、被截断等），不挡结果。 */
  warnings: string[];
};

export type ObjectQuery = {
  /** 交互请求取消后停止后续读取，不影响后台问答或同步任务。 */
  signal?: AbortSignal;
  entityType: string;
  text?: string;
  filters?: ObjectSearchFilter[];
  /** 批量按主键取对象；供图谱补齐一跳邻居等场景使用，不能与文本检索形成双重语义。 */
  keys?: ObjectPrimaryKey[];
  /** 按属性排序；属性必须映射到主来源的列，排序会下推到数据源。 */
  sort?: { property: string; direction: "ASC" | "DESC" }[];
  limit?: number;
  offset?: number;
  /** 兼容旧入参；普通读取始终按当前版本来源投影对象。 */
  origin?: "auto" | ObjectOrigin;
  /** 回源时是否顺带统计总数（默认 true）。整份物化逐页翻时传 false，省掉每页一次 COUNT(*)。 */
  count?: boolean;
  /**
   * 调用方**自己在翻页**（整份物化就是）：这一页被行数上限截断是常态，不是"数据丢了一部分"。
   * 传 true 就不报「命中行数超过 N 行」那条 —— 否则整份物化会刷一串假告警（实测 4 页刷 3 条）。
   */
  paging?: boolean;
  /**
   * 键集（游标）翻页：按这些**源列**升序排；给了 `values` 就只取排序键严格大于它的行。
   * **第一页也要带 `columns`**（不带 values）—— 不然第一页是无序的，游标会从中间插进去，既漏行又重复读。
   * 整份物化读深表用它（`columns` 就是主键列）—— 比 OFFSET 稳、也不再受 Oracle 深翻页上限限制。
   */
  cursor?: { columns: string[]; values?: unknown[] };
};

export type ObjectQueryResult = {
  entityType: string;
  rows: ObjectRecord[];
  /** 精确总数无法取得（例如版本墓碑覆盖）时为 null，不编造。 */
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
  /**
   * 这次**实际**向连接器要了多少行（过了所有上限之后的数）。
   *
   * 调用方用它判断"这一页是否读满"，而不是拿请求值猜测连接器上限。
   */
  limit: number;
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
