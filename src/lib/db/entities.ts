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
 * **为什么整层都走 ORM**（2026-09-19 用户要求："操作数据库一定要用 ORM，不能直接写 SQL"）：
 * 手写 SQL 把表名、方言、占位符、类型转换散在业务代码里，换一个库（或换一个存储实现）
 * 就得把每一处都翻一遍。实体 + 仓储把这件事收敛到一处：业务代码只说"要哪些行"，
 * 由驱动决定怎么问库。
 *
 * 表结构本身**不由 synchronize 生成**：`object_entries` 上有 tsvector / pgvector / GIN
 * 这类 TypeORM 表达不了的列，交给 `synchronize` 会被当成"多余的列"删掉。
 * 建表与改列统一放 `migrations/`，由 `runMigrations()` 执行。
 */

/** 平台账号。密码只存 bcrypt 哈希。 */
@Entity({ schema: "ontology_platform", name: "users" })
export class PlatformUserEntity {
  @PrimaryColumn("text") id!: string;
  @Column("text", { unique: true }) email!: string;
  @Column("text", { name: "password_hash" }) passwordHash!: string;
  @Column("text") role!: string;
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
 * 对象检索索引（物化层）。
 *
 * `entity_type` / `object_key` 是对象身份（对象类型 + 主键）的落库形态：
 * 唯一键是 `(target_id, object_key)`，增量同步按它 upsert，不再整表替换。
 * `search_doc`（tsvector）与 `embedding`（pgvector）是 PG 专有列，实体里不声明 ——
 * 这两列的写入走 `object-index/postgres.ts` 里那一处显式 SQL。
 */
@Entity({ schema: "ontology_platform", name: "object_entries" })
export class ObjectEntryEntity {
  @PrimaryColumn("text", { name: "target_id" }) targetId!: string;
  @PrimaryColumn("text", { name: "object_id" }) objectId!: string;
  @Column("text", { name: "entity_type" }) entityType!: string;
  @Column("text", { name: "object_key" }) objectKey!: string;
  @Column("text", { array: true }) labels!: string[];
  @Column("text") title!: string;
  @Column("jsonb") properties!: JsonColumn;
  @Column("jsonb", { name: "primary_key" }) primaryKey!: JsonColumn;
  @Column("text", { name: "search_text" }) searchText!: string;
  @Column("text", { name: "version_id", nullable: true }) versionId!: string | null;
  @Column("timestamptz", { name: "updated_at" }) updatedAt!: Date;
}
