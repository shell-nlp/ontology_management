/**
 * 平台库（schema `ontology_platform`）的表注释与字段注释。
 *
 * 两条规矩：
 * 1. **表注释**一句话说清「一行代表什么」；**字段注释**写「是什么 / 取值 / null 含义 / 指向哪张表」。
 *    只描述作用，**不写改动史、背景与用户口径**，也别啰嗦。
 * 2. 这里是唯一出处：迁移 `0006` 用它生成 `COMMENT ON TABLE / COLUMN`（幂等）。新增表或列时先在这里补一条。
 *    PG 专有列（`search_doc` / `embedding`）不在这里 —— 注释写在创建它们的代码里。
 */

/** 表 -> 一句话说明。 */
export const PLATFORM_TABLE_COMMENTS: Record<string, string> = {
  roles: "角色 = 一组权限点。一行一个角色；内置三档（管理员 / 编辑者 / 查看者）不可改删。用户通过 users.role_id 挂角色。",
  users: "平台账号。一行一个可登录账号：邮箱、密码哈希、所属角色。",
  graph_targets: "图引擎连接登记（本体的落点）。一行一个图引擎：内置类型图或外部 Jena。",
  data_sources: "数据资源。一行一个可被对象类型绑定的外部关系库，只读使用。",
  ontologies: "本体。一行一个本体，也是隔离单位（target_id 唯一，一个本体一份图数据）。",
  embedded_graphs: "内置类型图的已发布图数据。一行一个本体存储，整份快照存 jsonb。",
  ontology_versions: "本体版本。一行一个版本：本体定义、元数据与实例快照都在这一行。",
  ontology_concepts: "定义里概念的检索索引。一行一个概念（对象类型 / 属性 / 关系类型 / 接口 / 动作 / 规则 / 分组 / 指标）。",
  audit_entries: "审计流水。一行一条已发生的事：本体、版本、动作决策、数据资源、工具开关、账号与角色。",
  platform_settings: "平台级设置。一行一个 key，值存 jsonb。",
  reasoning_conversations: "智能问答的对话。一行一段对话。",
  reasoning_messages: "一轮问答。一行一次提问：问题、回答、思考过程与运行记录。",
  object_entries: "对象索引。一行一个对象实例，用于检索、分页与按类型统计。",
  column_profiles: "列画像缓存。一行一张表，存采样出来的列表征。",
};

/** 表 -> 列 -> 一句话说明。 */
export const PLATFORM_COLUMN_COMMENTS: Record<string, Record<string, string>> = {
  roles: {
    id: "角色 id（UUID）；内置为 admin / editor / viewer。",
    name: "角色名，唯一。",
    description: "角色用途说明。",
    builtin: "内置角色标记；true 时界面只读、不可改删。",
    permissions: "权限点数组（见 src/lib/platform/permissions.ts）；admin 恒为全部权限。",
    created_at: "创建时间。",
    updated_at: "最后修改时间。",
  },
  users: {
    id: "用户 id（UUID）。",
    email: "登录邮箱，唯一，存小写。",
    password_hash: "bcrypt 密码哈希。",
    role_id: "所属角色（roles.id）；权限挂在角色上，不挂在人上。",
    disabled_at: "停用时间；null = 正常。停用后旧令牌立即失效。",
    created_at: "创建时间。",
  },
  graph_targets: {
    id: "连接 id（UUID）；本体 / 版本 / 对象索引的 target_id 都指向它。",
    name: "连接名。",
    kind: "引擎类型：EMBEDDED 内置类型图 / JENA 外部 Jena。",
    uri: "连接地址；内置图为空。",
    database_name: "数据集名；内置图为空。",
    username: "连接用户名。",
    credential_secret: "加密后的密码（AES-256-GCM），不回明文。",
    options: "额外连接参数；Jena 可带 namedGraph。",
    created_at: "登记时间。",
  },
  data_sources: {
    id: "资源 id（UUID）；对象类型的来源绑定与 column_profiles 引用它。",
    name: "资源名；工具输出里的 data_source 就是它。",
    kind: "库类型：POSTGRES / MYSQL / ORACLE，决定 SQL 方言。",
    host: "主机名或 IP。",
    port: "端口。",
    database_name: "库名；Oracle 为服务名。",
    schema_name: "默认模式。",
    username: "连接账号，只读使用。",
    credential_secret: "加密后的密码（AES-256-GCM），只写不读。",
    options: "额外连接参数。",
    enabled: "是否启用；false 时不读结构、不取数。",
    catalog: "结构清单缓存（表与字段）；只有刷新结构才回源库。",
    created_at: "登记时间。",
  },
  ontologies: {
    id: "本体 id（UUID）。",
    identifier: "短标识（URL / 导出用），唯一，改名不变。",
    name: "本体显示名。",
    description: "本体说明。",
    color: "强调色；空 = 按名称自动配色。",
    tags: "标签数组，最多 12 个。",
    target_id: "实际写入的图存储（graph_targets.id），唯一。",
    owner_target_id: "用户挑选的存储资源；受管记录靠它归组。",
    namespace: "命名图（Jena 为 urn:ontology:<id>）；内置图为空。",
    created_by: "创建人（users.id），可空。",
    created_at: "创建时间。",
    updated_at: "最后修改时间。",
  },
  embedded_graphs: {
    target_id: "本体存储 id（graph_targets.id），主键。",
    snapshot: "整份已发布图数据（类型层 + 实例节点与边）。",
    updated_at: "最后写入时间。",
  },
  ontology_versions: {
    id: "版本 id（UUID）。",
    target_id: "本体存储（graph_targets.id）。",
    version_number: "版本号，从 1 递增，与 target_id 组成唯一约束。",
    status: "DRAFT 草稿 / PUBLISHED 当前生效 / ARCHIVED 历史版本。",
    definition: "本体定义：对象类型、关系类型、接口、指标、动作、规则、概念分组。",
    snapshot: "实例快照 { nodes, relationships }，用于版本回滚；null = 无快照。",
    created_by: "创建人（users.id）。",
    created_at: "创建时间。",
    published_at: "发布时刻；未发布为 null。",
    entity_count: "快照里的对象条数。",
    relationship_count: "快照里的关系条数。",
    content_hash: "内容指纹 sha256(定义 + 节点 + 关系)，读快照时校验；null = 无快照。",
    updated_at: "最后写入时间。",
  },
  ontology_concepts: {
    version_id: "所属版本（ontology_versions.id）。",
    target_id: "所属本体存储（graph_targets.id）。",
    kind: "概念类别：OBJECT_TYPE / PROPERTY / RELATION_TYPE / INTERFACE / ACTION / RULE / GROUP / METRIC。",
    name: "概念名；属性写作「对象类型.属性名」。",
    object_type: "所属对象类型；关系类型为「起点 ↔ 终点」；分组为空。",
    search_text: "检索文本：名字 + 说明 + 落点（表 / 列 / 端点 / 维度 / 取值）。",
    updated_at: "写入时间。",
  },
  audit_entries: {
    id: "审计 id（UUID）。",
    actor_id: "操作人（users.id）；用户被删后置空。",
    target_id: "相关本体存储（graph_targets.id）；与本体无关时为空。",
    action: "动作码，如 VERSION_PUBLISHED / USER_CREATED。",
    version_id: "相关版本（ontology_versions.id），可空。",
    details: "细节（jsonb），随 action 不同。",
    created_at: "发生时间。",
  },
  platform_settings: {
    key: "设置键，如 reasoning.toolPolicy、mcp.apiTokens。",
    value: "设置值（jsonb）。",
    updated_by: "最后修改人（users.id），可空。",
    updated_at: "最后修改时间。",
  },
  reasoning_conversations: {
    id: "对话 id（UUID）。",
    ontology_id: "所属本体（ontologies.id）。",
    target_id: "本体存储（graph_targets.id）。",
    title: "对话标题。",
    created_by: "发起人（users.id）。",
    created_at: "创建时间。",
    updated_at: "最后问答时间。",
    history_summary: "上下文压缩后的历史摘要。",
    history_summary_through: "摘要已覆盖到的消息位置。",
  },
  reasoning_messages: {
    id: "消息 id（UUID）。",
    conversation_id: "所属对话（reasoning_conversations.id）。",
    question: "用户问题。",
    answer: "模型回答（Markdown）。",
    thinking: "思考过程。",
    thinking_on: "本轮是否输出思考过程。",
    run: "运行记录：步骤、证据、token 用量（jsonb）。",
    error: "失败信息；成功为 null。",
    created_at: "提问时间。",
  },
  object_entries: {
    target_id: "本体存储（graph_targets.id）。",
    object_id: "对象 id，与图库节点 id 一致。",
    entity_type: "对象类型名。",
    object_key: "业务主键拼成的键，用于回源取数。",
    labels: "节点标签数组。",
    title: "展示标题。",
    properties: "对象全部属性（列名 -> 值）。",
    primary_key: "主键列与值。",
    search_text: "检索文本（标题 + 主要属性值）。",
    version_id: "来自哪一版（ontology_versions.id）。",
    updated_at: "重建索引时间。",
  },
  column_profiles: {
    source_id: "数据资源 id（data_sources.id）。",
    table_key: "表的稳定键（schema.table）。",
    schema_name: "模式名。",
    table_name: "表名 / 视图名。",
    profile: "列画像（jsonb）：类型、取值样例、null 比例、min/max。",
    sampled_at: "采样时间，默认按天复用。",
  },
};

/** 生成 `COMMENT ON TABLE / COLUMN` 语句（幂等；单引号按 PG 规则转义）。 */
export function platformCommentStatements(schema = "ontology_platform"): string[] {
  const literal = (value: string) => "'" + value.replace(/'/g, "''") + "'";
  const statements: string[] = [];
  for (const [table, comment] of Object.entries(PLATFORM_TABLE_COMMENTS)) {
    statements.push(`COMMENT ON TABLE ${schema}.${table} IS ${literal(comment)}`);
    for (const [column, columnComment] of Object.entries(PLATFORM_COLUMN_COMMENTS[table] ?? {})) {
      statements.push(`COMMENT ON COLUMN ${schema}.${table}.${column} IS ${literal(columnComment)}`);
    }
  }
  return statements;
}

/**
 * 由**代码**补建的 PG 专有列（全文生成列与 pgvector）。
 *
 * 它们可能在迁移跑的时候还不存在（扩展没装、功能没用过），所以迁移里要**先查存在再补注释**；
 * 创建它们的那段代码也用这份常量，保证两处文案一致。
 */
export const PLATFORM_PG_ONLY_COLUMN_COMMENTS: { table: string; column: string; comment: string }[] = [
  { table: "object_entries", column: "search_doc", comment: "全文检索列：由 search_text 生成的 tsvector，内容与 search_text 始终一致。" },
  { table: "object_entries", column: "embedding", comment: "对象向量（pgvector），供相似度检索；为空表示这条还没有向量。" },
  { table: "ontology_concepts", column: "search_doc", comment: "全文检索列：由 search_text 生成的 tsvector。" },
  { table: "ontology_concepts", column: "embedding", comment: "概念向量（pgvector），供相似度检索；为空表示这条还没有向量。" },
];

/** 取某张表某个 PG 专有列的注释文案（没有就返回空串）。 */
export function pgOnlyColumnComment(table: string, column: string): string {
  return PLATFORM_PG_ONLY_COLUMN_COMMENTS.find((item) => item.table === table && item.column === column)?.comment ?? "";
}
