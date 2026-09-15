import { readPlatformSetting, writePlatformSetting } from "@/lib/platform-db";
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
 */
export type ToolPolicy = { disabledTools: string[] };

export const TOOL_POLICY_KEY = "reasoning.toolPolicy";

/** 能被用户开关的工具：平台自己停用的那几个不算（它们恒为关）。 */
export function togglableToolNames(): string[] {
  return REASONING_TOOLS.filter((spec) => !spec.disabled).map((spec) => spec.name);
}

export function emptyToolPolicy(): ToolPolicy {
  return { disabledTools: [] };
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

export async function loadToolPolicy(): Promise<ToolPolicy> {
  try {
    return normalizeToolPolicy(await readPlatformSetting<unknown>(TOOL_POLICY_KEY));
  } catch {
    // 读不到（库还没建表 / 连接断了）就按"全部可用"走：工具开关不该把问答整死。
    return emptyToolPolicy();
  }
}

export async function saveToolPolicy(policy: ToolPolicy, actorId?: string): Promise<ToolPolicy> {
  const normalized = normalizeToolPolicy(policy);
  await writePlatformSetting(TOOL_POLICY_KEY, normalized, actorId);
  return normalized;
}

/** 这个工具现在能不能给模型用。 */
export function toolIsEnabled(policy: ToolPolicy, name: string, platformDisabled = false) {
  return !platformDisabled && !policy.disabledTools.includes(name);
}

/** 现在放给模型的工具名（服务端两处：智能问答与 MCP 的 tools/list）。 */
export function enabledToolNames(policy: ToolPolicy): string[] {
  return togglableToolNames().filter((name) => toolIsEnabled(policy, name));
}