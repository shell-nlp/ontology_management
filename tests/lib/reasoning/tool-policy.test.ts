import { describe, expect, it } from "vitest";
import { callMcpTool, mcpToolCatalog, mcpTools } from "@/lib/reasoning/mcp";
import { applyPinnedOntology } from "@/lib/reasoning/mcp-endpoint";
import { emptyToolPolicy, normalizeToolPolicy, resolveToolPolicy, togglableToolNames, toolPolicyKey, TOOL_POLICY_KEY } from "@/lib/reasoning/tool-policy";

/**
 * 工具开关的**两个层级**（2026-10-08 用户口径：「工具的开关配置会根据不同的本体而不同吗」→ 要做）。
 *
 * 规则只有一条，但必须钉死：**有本体覆盖就按覆盖，没有就跟着全局默认**。
 * 之所以把 `resolveToolPolicy` 做成纯函数，就是为了不用连库也能把这条规则测穿
 * （`loadResolvedToolPolicy` 只是把两行设置读出来喂给它）。
 */
describe("toolPolicyKey", () => {
  it("不传本体 = 全局那一条；传了本体 = 它的覆盖行", () => {
    expect(toolPolicyKey()).toBe(TOOL_POLICY_KEY);
    expect(toolPolicyKey(null)).toBe(TOOL_POLICY_KEY);
    expect(toolPolicyKey("")).toBe(TOOL_POLICY_KEY);
    expect(toolPolicyKey("  ")).toBe(TOOL_POLICY_KEY);
    expect(toolPolicyKey("11111111-1111-4111-8111-111111111111")).toBe(`${TOOL_POLICY_KEY}:11111111-1111-4111-8111-111111111111`);
    expect(toolPolicyKey(" 11111111-1111-4111-8111-111111111111 ")).toBe(`${TOOL_POLICY_KEY}:11111111-1111-4111-8111-111111111111`);
  });
});

describe("resolveToolPolicy", () => {
  it("有覆盖就按覆盖走（覆盖优先于全局）", () => {
    const resolved = resolveToolPolicy({ disabledTools: ["list_actions"] }, { disabledTools: ["run_sql"] });
    expect(resolved.source).toBe("ONTOLOGY");
    expect(resolved.policy.disabledTools).toEqual(["run_sql"]);
  });

  it("覆盖写成空列表也是**覆盖**：那代表这个本体明确什么都不关，不该悄悄回落到全局", () => {
    const resolved = resolveToolPolicy({ disabledTools: ["list_actions"] }, { disabledTools: [] });
    expect(resolved.source).toBe("ONTOLOGY");
    expect(resolved.policy.disabledTools).toEqual([]);
  });

  it("没有覆盖就跟着全局默认", () => {
    const resolved = resolveToolPolicy({ disabledTools: ["run_sql"] }, null);
    expect(resolved.source).toBe("GLOBAL");
    expect(resolved.policy.disabledTools).toEqual(["run_sql"]);
  });

  it("两层都没配 = 全开（DEFAULT）", () => {
    expect(resolveToolPolicy(null, null)).toEqual({ policy: emptyToolPolicy(), source: "DEFAULT" });
    expect(resolveToolPolicy(undefined, undefined).source).toBe("DEFAULT");
  });

  it("脏数据会被归一化：不认识的工具名进不来，重复的去掉", () => {
    const resolved = resolveToolPolicy(null, { disabledTools: ["run_sql", "run_sql", "查无此工具", 42] });
    expect(resolved.policy.disabledTools).toEqual(["run_sql"]);
    expect(normalizeToolPolicy("不是对象")).toEqual({ disabledTools: [] });
  });
});

describe("applyPinnedOntology（本体级 MCP 端点）", () => {
  const pinned = "11111111-1111-4111-8111-111111111111";

  it("把 ontology_id 钉在 URL 指定的本体上", () => {
    expect(applyPinnedOntology({ query: "客户" }, pinned)).toEqual({ query: "客户", ontology_id: pinned });
  });

  it("客户端自己传了别的本体也以 URL 为准 —— 一条配置对应一个本体，避免查错", () => {
    expect(applyPinnedOntology({ query: "客户", ontology_id: "22222222-2222-4222-8222-222222222222" }, pinned).ontology_id).toBe(pinned);
  });

  it("平台级端点（没钉本体）原样透传参数", () => {
    const args = { query: "客户", ontology_id: "22222222-2222-4222-8222-222222222222" };
    expect(applyPinnedOntology(args, null)).toEqual(args);
  });
});

/**
 * `list_ontologies` 是**只在 MCP 目录里**的工具（不在 `REASONING_TOOLS` 里），
 * 2026-10-08 用户报「这个 tool 为什么关不了」：界面把名字发上来，`normalizeToolPolicy`
 * 拿 `togglableToolNames()` 当白名单，而那份白名单原来只认 `REASONING_TOOLS`，
 * 于是这条被当脏数据丢掉，开关自己弹回去。下面三条把这个坑钉住。
 */
describe("list_ontologies 也要能开关", () => {
  it("它在白名单里", () => {
    expect(togglableToolNames()).toContain("list_ontologies");
  });

  it("关掉它能存下来，不会被归一化丢掉", () => {
    const resolved = resolveToolPolicy(null, { disabledTools: ["list_ontologies", "run_sql"] });
    expect(resolved.policy.disabledTools).toEqual(["list_ontologies", "run_sql"]);
  });

  it("关掉之后 tools/list 里没有它，tools/call 也调不动", async () => {
    expect(mcpToolCatalog().map((tool) => tool.name)).toContain("list_ontologies");
    expect(mcpTools(["list_ontologies"]).map((tool) => tool.name)).not.toContain("list_ontologies");
    expect(mcpTools().map((tool) => tool.name)).toContain("list_ontologies");
    await expect(callMcpTool("list_ontologies", {}, ["list_ontologies"])).rejects.toThrow();
  });
});
