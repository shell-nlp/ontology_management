/**
 * 审计动作目录（backlog U2）。
 *
 * `audit_entries.action` 存的是英文码，写入方散在十几个路由与 `version-publication.ts` 里；
 * **界面文案与筛选范围只定义在这一处**，API 与页面共用，避免"列表显示一套、筛选又是另一套"。
 *
 * 两条约定：
 * 1. 目录里没有的码**不会被吞掉** —— 标签退回显示原始码，也照样能按它筛出来
 *    （新增审计点忘了登记，界面上最多少一个中文名，不会"记录不见了"）。
 * 2. 「范围」是给高频噪音留的出口：`REASONING_RUN` / `GRAPH_QUERY_READ` 一次提问就好几条，
 *    默认的「变更记录」范围把它们排除在外，需要时切到「全部记录」。
 */

export type AuditScope = "changes" | "all" | "actions" | "reads";

export type AuditGroup = "ontology" | "version" | "draft" | "index" | "graph" | "data" | "action" | "read";

export type AuditActionInfo = {
  code: string;
  label: string;
  group: AuditGroup;
  /** 失败类记录：界面上标红，方便一眼找到出问题的那次操作。 */
  failure?: boolean;
};

export const AUDIT_ACTIONS: readonly AuditActionInfo[] = [
  { code: "ONTOLOGY_CREATED", label: "新建本体", group: "ontology" },
  { code: "ONTOLOGY_UPDATED", label: "修改本体", group: "ontology" },
  { code: "ONTOLOGY_IMPORTED", label: "导入本体包", group: "ontology" },
  { code: "ONTOLOGY_SOURCES_BOUND", label: "补齐数据资源绑定", group: "ontology" },
  { code: "ONTOLOGY_DELETED", label: "删除本体", group: "ontology" },

  { code: "VERSION_DRAFT_CREATED", label: "创建草稿", group: "version" },
  { code: "VERSION_DEFINITION_UPDATED", label: "修改草稿定义", group: "version" },
  { code: "VERSION_PUBLISH_STARTED", label: "开始发布", group: "version" },
  { code: "VERSION_PUBLISHED", label: "发布成功", group: "version" },
  { code: "VERSION_PUBLISH_FAILED", label: "发布失败", group: "version", failure: true },
  { code: "VERSION_ACTIVATED", label: "激活历史版本", group: "version" },
  { code: "VERSIONS_RESET", label: "重置版本记录", group: "version" },

  { code: "DRAFT_ENTITY_CREATED", label: "新建对象", group: "draft" },
  { code: "DRAFT_ENTITY_UPDATED", label: "修改对象", group: "draft" },
  { code: "DRAFT_ENTITY_DELETED", label: "删除对象", group: "draft" },
  { code: "DRAFT_RELATIONSHIP_CREATED", label: "新建关系", group: "draft" },
  { code: "DRAFT_RELATIONSHIP_UPDATED", label: "修改关系", group: "draft" },
  { code: "DRAFT_RELATIONSHIP_DELETED", label: "删除关系", group: "draft" },
  { code: "DRAFT_POSITIONS_UPDATED", label: "调整图布局", group: "draft" },

  { code: "OBJECT_INDEX_REBUILT", label: "重建对象索引", group: "index" },
  { code: "OBJECT_INDEX_SYNCED", label: "同步对象索引", group: "index" },

  { code: "TARGET_CREATED", label: "新建图引擎", group: "graph" },
  { code: "TARGET_UPDATED", label: "修改图引擎", group: "graph" },
  { code: "TARGET_DELETED", label: "删除图引擎", group: "graph" },
  { code: "TARGET_GRAPH_CLEARED", label: "清空图库", group: "graph" },
  { code: "TARGET_INDEX_CLEAR_FAILED", label: "清空图库失败", group: "graph", failure: true },
  { code: "TARGET_INDEX_CLEANUP_FAILED", label: "清理索引失败", group: "graph", failure: true },

  { code: "DATA_SOURCE_CREATED", label: "新建数据资源", group: "data" },
  { code: "DATA_SOURCE_UPDATED", label: "修改数据资源", group: "data" },
  { code: "DATA_SOURCE_DELETED", label: "删除数据资源", group: "data" },

  { code: "ACTION_EXECUTED", label: "执行动作", group: "action" },
  { code: "ACTION_DRY_RUN", label: "干跑动作", group: "action" },
  { code: "ACTION_BLOCKED", label: "动作被拦截", group: "action", failure: true },

  { code: "REASONING_RUN", label: "智能问答", group: "read" },
  { code: "REASONING_TOOL_POLICY_UPDATED", label: "修改模型工具开关", group: "read" },
  { code: "GRAPH_QUERY_READ", label: "图查询（SPARQL / Cypher）", group: "read" },
];

const BY_CODE = new Map(AUDIT_ACTIONS.map((item) => [item.code, item]));

/** 目录里没有的码原样返回：宁可露一个英文码，也不要让记录看起来"没有动作"。 */
export function auditActionLabel(code: string): string {
  return BY_CODE.get(code)?.label ?? code;
}

export function isAuditFailure(code: string): boolean {
  return BY_CODE.get(code)?.failure === true;
}

export const AUDIT_SCOPE_OPTIONS: readonly { value: AuditScope; label: string; hint: string }[] = [
  { value: "changes", label: "变更记录", hint: "本体 / 版本 / 图引擎 / 数据资源 / 对象草稿的写操作，不含问答与查询" },
  { value: "all", label: "全部记录", hint: "一条不落，包含每次问答与图查询" },
  { value: "actions", label: "动作记录", hint: "执行 / 干跑 / 被拦截，与动作页的决策记录同源" },
  { value: "reads", label: "问答与查询", hint: "智能问答、图查询与模型工具开关" },
];

const SCOPE_GROUPS: Record<AuditScope, readonly AuditGroup[]> = {
  changes: ["ontology", "version", "draft", "index", "graph", "data"],
  all: ["ontology", "version", "draft", "index", "graph", "data", "action", "read"],
  actions: ["action"],
  reads: ["read"],
};

export function normalizeAuditScope(value: string | null | undefined): AuditScope {
  return AUDIT_SCOPE_OPTIONS.some((option) => option.value === value) ? (value as AuditScope) : "changes";
}

/**
 * 这个范围要筛哪些动作码。返回 `undefined` = 不加动作过滤。
 * 注意返回的是**目录里的码**：范围是本目录定义的，不在目录里的码只可能出现在「全部记录」里
 * （那时不过滤，自然也能看到）。
 */
export function auditActionsForScope(scope: AuditScope): string[] | undefined {
  if (scope === "all") return undefined;
  const groups = new Set<AuditGroup>(SCOPE_GROUPS[scope]);
  return AUDIT_ACTIONS.filter((item) => groups.has(item.group)).map((item) => item.code);
}
