import { deletePlatformSetting, readPlatformSetting, writePlatformSetting } from "@/lib/platform-db";
import { REASONING_TOOLS } from "@/lib/reasoning/tools";

/**
 * 工具开关：哪些工具**这个大模型不能用**。
 *
 * 两层含义分开：
 * - `REASONING_TOOLS[].disabled`：平台自己停用的工具（这一版不查实例），谁都开不了；
 * - 这里的 `disabledTools`：用户关掉的工具。关了之后，**平台内的智能问答与外部 MCP 客户端都看不到它**，
 *   模型自然不会用 —— 只关界面上的某个按钮而服务端还发出去，等于没关。
 *
 * 存在平台库里（不是浏览器本地）：MCP 端点在外部客户端手里，服务端猜不到你浏览器里的偏好。
 *
 * **两个层级（2026-10-08 用户要求）**：
 * - `reasoning.toolPolicy`：**全局默认**，所有本体的基底；
 * - `reasoning.toolPolicy:<ontologyId>`：某个本体的**覆盖**。有覆盖就按覆盖走，没有就跟着全局 ——
 *   这样"平时一套默认、个别本体例外"不需要在两处重复维护。界面上把这件事写成「跟随全局 / 当前本体单独配置」。
 */
export type ToolPolicy = { disabledTools: string[] };

export const TOOL_POLICY_KEY = "reasoning.toolPolicy";

/** 某个本体的覆盖行 key；不传本体就是全局那一条。 */
export function toolPolicyKey(ontologyId?: string | null): string {
  const id = (ontologyId ?? "").trim();
  return id ? `${TOOL_POLICY_KEY}:${id}` : TOOL_POLICY_KEY;
}

/** 这份策略是哪来的：本体自己的覆盖 / 全局默认 / 谁都没配（等于全开）。 */
export type ToolPolicySource = "ONTOLOGY" | "GLOBAL" | "DEFAULT";

export type ResolvedToolPolicy = {
  /** 最终生效的那一份（覆盖优先）。 */
  policy: ToolPolicy;
  source: ToolPolicySource;
  /** 查询时带的本体 id；没带就是 null（只看全局）。 */
  ontologyId: string | null;
  /** 全局那一份（界面用它显示"继承的是什么"）。 */
  global: ToolPolicy;
  /** 本体自己的覆盖；没有覆盖就是 null（界面据此显示「跟随全局」）。 */
  override: ToolPolicy | null;
};

/** 能被用户开关的工具：平台自己停用的那几个不算（它们恒为关）。 */
export function togglableToolNames(): string[] {
  return REASONING_TOOLS.filter((spec) => !spec.disabled).map((spec) => spec.name);
}

export function emptyToolPolicy(): ToolPolicy {
  return { disabledTools: [] };
}

/** 全局行 / 覆盖行都存在时的取值规则。纯函数，单测直接喂值。 */
export function resolveToolPolicy(globalValue: unknown, overrideValue: unknown | null): { policy: ToolPolicy; source: ToolPolicySource } {
  if (overrideValue !== null && overrideValue !== undefined) {
    // 覆盖行**存在**就算数：哪怕它写的是空列表，那也代表"这个本体明确不关任何工具"。
    return { policy: normalizeToolPolicy(overrideValue), source: "ONTOLOGY" };
  }
  if (globalValue !== null && globalValue !== undefined) {
    return { policy: normalizeToolPolicy(globalValue), source: "GLOBAL" };
  }
  return { policy: emptyToolPolicy(), source: "DEFAULT" };
}

/** 归一化：只保留"确实存在、且可以开关"的名字，顺手去重。脏数据不会把工具误关。 */
export function normalizeToolPolicy(value: unknown): ToolPolicy {
  const known = new Set(togglableToolNames());
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? (value as { disabledTools?: unknown }).disabledTools
    : null;
  if (!Array.isArray(raw)) return emptyToolPolicy();
  const names = [...new Set(raw.map((item) => String(item ?? "").trim()).filter((name) => known.has(name)))];
  return { disabledTools: names };
}

/**
 * 读某一层的原始设置；读不到（库还没建表 / 连接断了）按"这一层没配"处理 ——
 * 工具开关不该把问答整死。`null` = 这一层没有这一行（区别于"写了一个空列表"）。
 */
async function readPolicyRow(ontologyId?: string | null): Promise<ToolPolicy | null> {
  try {
    const value = await readPlatformSetting<unknown>(toolPolicyKey(ontologyId));
    return value === null || value === undefined ? null : normalizeToolPolicy(value);
  } catch {
    return null;
  }
}

/** 某个本体最终生效的策略（不带本体 = 看全局）。签名保持兼容：老的调用不传参数就是全局。 */
export async function loadToolPolicy(ontologyId?: string | null): Promise<ToolPolicy> {
  return (await loadResolvedToolPolicy(ontologyId)).policy;
}

/** 带来源信息的完整解析：界面要显示"跟随全局 / 当前本体单独配置"，靠的就是它。 */
export async function loadResolvedToolPolicy(ontologyId?: string | null): Promise<ResolvedToolPolicy> {
  const id = (ontologyId ?? "").trim() || null;
  const global = await readPolicyRow(null);
  const override = id ? await readPolicyRow(id) : null;
  const resolved = resolveToolPolicy(global, override);
  return {
    policy: resolved.policy,
    source: resolved.source,
    ontologyId: id,
    global: global ?? emptyToolPolicy(),
    override,
  };
}

/**
 * 保存开关：不传本体 = 写全局默认；传了本体 = 写这个本体的覆盖。
 * 返回最终生效的那一份（写覆盖时就是覆盖的内容）。
 */
export async function saveToolPolicy(policy: ToolPolicy, actorId?: string, ontologyId?: string | null): Promise<ToolPolicy> {
  const normalized = normalizeToolPolicy(policy);
  await writePlatformSetting(toolPolicyKey(ontologyId), normalized, actorId);
  return normalized;
}

/** 撤销某个本体的覆盖，让它回到"跟随全局"。没有覆盖时调用也不会出错。 */
export async function clearToolPolicyOverride(ontologyId: string): Promise<void> {
  const id = ontologyId.trim();
  if (!id) throw new Error("要撤销覆盖就得说是哪个本体。");
  await deletePlatformSetting(toolPolicyKey(id));
}

/** 这个工具现在能不能给模型用。 */
export function toolIsEnabled(policy: ToolPolicy, name: string, platformDisabled = false) {
  return !platformDisabled && !policy.disabledTools.includes(name);
}

/** 现在放给模型的工具名（服务端两处：智能问答与 MCP 的 tools/list）。 */
export function enabledToolNames(policy: ToolPolicy): string[] {
  return togglableToolNames().filter((name) => toolIsEnabled(policy, name));
}
