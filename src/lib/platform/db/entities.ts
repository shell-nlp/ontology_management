import { Column, Entity, PrimaryColumn } from "typeorm";

/**
 * jsonb 列的 TypeScript 类型。
 *
 * TypeORM 对写入值做的是"深度可选"映射（`QueryDeepPartialEntity`），`Record<string, unknown>`
 * 这种带索引签名的类型套进去会推不动（`unknown` 不满足递归约束）。社区通行做法就是这里写 `any`，
 * 由调用方在**领域边界**转成具体类型（本仓库所有实体 -> 领域对象的转换都在各自的 mapper 里做）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonColumn = any;

/**
 * 平台库（PostgreSQL，schema `ontology_platform`）的 TypeORM 实体。
 *
 * **为什么整层都走 ORM**（要求：操作数据库必须用 ORM，不直接写 SQL）：
 * 手写 SQL 把表名、方言、占位符、类型转换散在业务代码里，换一个库（或换一个存储实现）
 * 就得把每一处都翻一遍。实体 + 仓储把这件事收敛到一处：业务代码只说"要哪些行"，
 * 由驱动决定怎么问库。
 *
 * 表结构本身**不由 synchronize 生成**：`ontology_concepts` 上有 tsvector / pgvector / GIN
 * 这类 TypeORM 表达不了的列，交给 `synchronize` 会被当成"多余的列"删掉。
 * 建表与改列统一放 `migrations/`，由 `runMigrations()` 执行。
 */

/** 角色 = 一组权限点。内置三档由 `@/lib/platform/permissions` 定义并在启动时同步。 */
@Entity({ schema: "ontology_platform", name: "roles" })
export class RoleEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text") name!: string;
  @Column("text") description!: string;
  @Column("boolean") builtin!: boolean;
  @Column("jsonb") permissions!: JsonColumn;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/** 平台账号。密码只存 bcrypt 哈希；权限不落在人身上，落在 `role_id` 指的角色上。 */
@Entity({ schema: "ontology_platform", name: "users" })
export class PlatformUserEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { unique: true }) email!: string;
  @Column("text", { name: "password_hash" }) passwordHash!: string;
  @Column("text", { name: "role_id" }) roleId!: string;
  /** 停用时间；非空即停用（令牌在下一次请求就失效，因为每次都会回库核对）。 */
  @Column("timestamptz", { name: "disabled_at", nullable: true }) disabledAt!: Date | null;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
}

/** 本体存储（图库连接）。内置类型图是虚拟入口，不占这张表。 */
@Entity({ schema: "ontology_platform", name: "graph_targets" })
export class GraphTargetEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { unique: true }) name!: string;
  @Column("text") kind!: string;
  @Column("text") uri!: string;
  @Column("text", { name: "database_name" }) databaseName!: string;
  @Column("text") username!: string;
  @Column("text", { name: "credential_secret" }) credentialSecret!: string;
  @Column("jsonb") options!: JsonColumn;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
}

/** 数据资源（业务数据从哪来）。`catalog` 是结构缓存，见 `structure-cache`。 */
@Entity({ schema: "ontology_platform", name: "data_sources" })
export class DataSourceEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { unique: true }) name!: string;
  @Column("text") kind!: string;
  @Column("text") host!: string;
  @Column("int") port!: number;
  @Column("text", { name: "database_name" }) databaseName!: string;
  @Column("text", { name: "schema_name" }) schemaName!: string;
  @Column("text") username!: string;
  @Column("text", { name: "credential_secret" }) credentialSecret!: string;
  @Column("jsonb") options!: JsonColumn;
  @Column("boolean") enabled!: boolean;
  @Column("jsonb") catalog!: JsonColumn;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
}

/** 本体：平台的隔离单位，一个本体占一份图数据。 */
@Entity({ schema: "ontology_platform", name: "ontologies" })
export class OntologyEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { unique: true }) identifier!: string;
  @Column("text") name!: string;
  @Column("text") description!: string;
  @Column("text") color!: string;
  @Column("text", { array: true }) tags!: string[];
  @Column("text", { name: "target_id", unique: true }) targetId!: string;
  @Column("text", { name: "owner_target_id", nullable: true }) ownerTargetId!: string | null;
  @Column("text", { nullable: true }) namespace!: string | null;
  @Column("text", { name: "created_by", nullable: true }) createdBy!: string | null;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/** 内置类型图的已发布视图：一行一个本体存储，整份快照存在 jsonb 里。 */
@Entity({ schema: "ontology_platform", name: "embedded_graphs" })
export class EmbeddedGraphEntity {
  @PrimaryColumn("text", { name: "target_id" }) targetId!: string;
  @Column("jsonb") snapshot!: JsonColumn;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/**
 * 本体版本记录：一行一个版本，**本体定义（OntologyDefinition）与实例快照各占一列**。
 */
@Entity({ schema: "ontology_platform", name: "ontology_versions" })
export class OntologyVersionEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { name: "target_id" }) targetId!: string;
  @Column("integer", { name: "version_number" }) versionNumber!: number;
  @Column("text") status!: string;
  @Column("jsonb") definition!: JsonColumn;
  /** 实例快照（nodes + relationships）；null = 这个版本还没有快照。 */
  @Column("jsonb", { nullable: true }) snapshot!: JsonColumn | null;
  @Column("text", { name: "created_by", default: "" }) createdBy!: string;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
  @Column("timestamptz", { name: "published_at", nullable: true }) publishedAt!: Date | null;
  @Column("integer", { name: "entity_count", default: 0 }) entityCount!: number;
  @Column("integer", { name: "relationship_count", default: 0 }) relationshipCount!: number;
  @Column("text", { name: "content_hash", nullable: true }) contentHash!: string | null;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/**
 * 定义里概念的检索索引：一行一个概念（对象类型 / 属性 / 关系类型 / 接口 / 指标 / 动作 / 规则 / 分组）。
 *
 * 文本列是 `search_text`；全文列 `search_doc`（tsvector 生成列）与 pgvector 的 `embedding` 列
 * 是 PG 专有列，由 `@/lib/platform/version-records` 在库支持时补建，注释也写在那边 ——
 * **不在实体里声明**（交给 synchronize 会被当成多余列删掉）。
 */
@Entity({ schema: "ontology_platform", name: "ontology_concepts" })
export class OntologyConceptEntity {
  @PrimaryColumn("text", { name: "version_id" }) versionId!: string;
  @PrimaryColumn("text") kind!: string;
  @PrimaryColumn("text") name!: string;
  @Column("text", { name: "target_id" }) targetId!: string;
  @Column("text", { name: "object_type", default: "" }) objectType!: string;
  @Column("text", { name: "search_text", default: "" }) searchText!: string;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/** 审计：发布、失败、动作决策、数据资源变更都落这里。 */
@Entity({ schema: "ontology_platform", name: "audit_entries" })
export class AuditEntryEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { name: "actor_id", nullable: true }) actorId!: string | null;
  @Column("text", { name: "target_id", nullable: true }) targetId!: string | null;
  @Column("text") action!: string;
  /** 关联的本体版本；写入时从 details 里提出来单独存一列，查询就不必拆 jsonb。 */
  @Column("text", { name: "version_id", nullable: true }) versionId!: string | null;
  @Column("jsonb") details!: JsonColumn;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
}

/** 平台级设置（跟着部署走的那一类，例如模型工具开关）。 */
@Entity({ schema: "ontology_platform", name: "platform_settings" })
export class PlatformSettingEntity {
  @PrimaryColumn("text") key!: string;
  @Column("jsonb") value!: JsonColumn;
  @Column("text", { name: "updated_by", nullable: true }) updatedBy!: string | null;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/** 智能问答的一轮对话归属。 */
@Entity({ schema: "ontology_platform", name: "reasoning_conversations" })
export class ConversationEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { name: "ontology_id", nullable: true }) ontologyId!: string | null;
  @Column("text", { name: "target_id", nullable: true }) targetId!: string | null;
  @Column("text") title!: string;
  @Column("text", { name: "created_by", nullable: true }) createdBy!: string | null;
  @Column("text", { name: "history_summary", nullable: true }) historySummary!: string | null;
  @Column("text", { name: "history_summary_through", nullable: true }) historySummaryThrough!: string | null;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}

/** 一轮问答：问题、结论、思考过程，以及当次运行的完整结果。 */
@Entity({ schema: "ontology_platform", name: "reasoning_messages" })
export class ConversationMessageEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { name: "conversation_id" }) conversationId!: string;
  @Column("text") question!: string;
  @Column("text") answer!: string;
  @Column("text") thinking!: string;
  @Column("boolean", { name: "thinking_on" }) thinkingOn!: boolean;
  @Column("jsonb", { nullable: true }) run!: JsonColumn;
  @Column("text", { nullable: true }) error!: string | null;
  @Column("timestamptz", { name: "created_at" }) createdAt!: Date;
}

/**
 * 整份物化的**后台任务**（历史与状态落库）。
 *
 * 为什么落库：物化一个类型可能跑几分钟到几十分钟，任务状态只放内存的话，进程重启（含改代码热更新）
 * 就什么都看不见了。落库之后：`GET` 能翻历史，重启时把遗留的 QUEUED/RUNNING 标成 INTERRUPTED
 * （物化幂等，用户重新排队即可），`scanned/rows/pages` 也留了痕。
 *
 * `scanned` / `rows` 用 bigint：一次"不限制"的物化可能读到上亿行，integer 会溢出；
 * 读出来是字符串，业务层用 `Number()` 转（JS 安全整数上限 2^53，够用）。
 */
@Entity({ schema: "ontology_platform", name: "materialization_jobs" })
export class MaterializationJobEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { name: "target_id" }) targetId!: string;
  @Column("text", { name: "entity_type" }) entityType!: string;
  /** QUEUED / RUNNING / DONE / CANCELLED / FAILED / INTERRUPTED（进程重启遗留）。 */
  @Column("text") status!: string;
  @Column("bigint", { default: 0 }) scanned!: string;
  @Column("bigint", { default: 0 }) rows!: string;
  @Column("integer", { default: 0 }) pages!: number;
  @Column("boolean", { default: false }) truncated!: boolean;
  /** 结束原因 / 失败信息；正常完成为 null。 */
  @Column("text", { nullable: true }) message!: string | null;
  @Column("timestamptz", { name: "queued_at" }) queuedAt!: Date;
  @Column("timestamptz", { name: "started_at", nullable: true }) startedAt!: Date | null;
  @Column("timestamptz", { name: "finished_at", nullable: true }) finishedAt!: Date | null;
  @Column("text", { name: "created_by", nullable: true }) createdBy!: string | null;
}

/**
 * 列画像缓存（采样结果，按天复用）。见 `@/lib/column-profile`。
 *
 * 主键是 `(数据资源, 模式.表)`：同一个数据资源下换表就换一行。
 * 画像本体（每列的取值 / 空值率）整个存 jsonb —— 它是一份快照，按列拆表反而要 join 才能读回一份。
 */
@Entity({ schema: "ontology_platform", name: "column_profiles" })
export class ColumnProfileEntity {
  @PrimaryColumn("text", { name: "source_id" }) sourceId!: string;
  @PrimaryColumn("text", { name: "table_key" }) tableKey!: string;
  @Column("text", { name: "schema_name" }) schemaName!: string;
  @Column("text", { name: "table_name" }) tableName!: string;
  @Column("jsonb") profile!: JsonColumn;
  @Column("timestamptz", { name: "sampled_at" }) sampledAt!: Date;
}
