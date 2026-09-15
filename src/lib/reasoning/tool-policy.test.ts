import { describe, expect, it } from "vitest";
import { enabledToolNames, emptyToolPolicy, normalizeToolPolicy, toolIsEnabled, togglableToolNames } from "@/lib/reasoning/tool-policy";

describe("tool policy", () => {
  it("只接受可开关的工具名：平台停用的、编造的名字都进不来", () => {
    const names = togglableToolNames();
    expect(names).toContain("list_interfaces");
    expect(names).not.toContain("query_object_instance");
    const policy = normalizeToolPolicy({ disabledTools: ["list_interfaces", "query_object_instance", "  ", "nope", "list_interfaces"] });
    expect(policy.disabledTools).toEqual(["list_interfaces"]);
  });

  it("脏数据一律当'全开'，不会把工具误关", () => {
    expect(normalizeToolPolicy(null)).toEqual(emptyToolPolicy());
    expect(normalizeToolPolicy({ disabledTools: "list_interfaces" })).toEqual(emptyToolPolicy());
    expect(normalizeToolPolicy("nope")).toEqual(emptyToolPolicy());
  });

  it("开关生效：关掉的既不在 enabledToolNames 里，toolIsEnabled 也是 false", () => {
    const policy = { disabledTools: ["run_sql"] };
    expect(toolIsEnabled(policy, "run_sql")).toBe(false);
    expect(toolIsEnabled(policy, "get_table_ddl")).toBe(true);
    expect(enabledToolNames(policy)).not.toContain("run_sql");
    // 平台自己停用的工具，谁也别想开
    expect(toolIsEnabled(emptyToolPolicy(), "query_object_instance", true)).toBe(false);
  });
});