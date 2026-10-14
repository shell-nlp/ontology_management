import { describe, expect, it } from "vitest";
import { readStoredTokens, tokenStatus, MCP_TOKEN_NAME_MAX } from "@/lib/mcp/token";

/**
 * MCP 访问令牌的**共享判断**（2026-10-14 用户口径：令牌必须代表一个平台账号）。
 *
 * 这里只测纯函数：清单的容错解析（老数据没有归属）、以及"这条令牌现在能不能用"。
 * 端点侧的 `resolveMcpToken` 要回库取账号与权限，属于集成路径，不在这里连库。
 *
 * 为什么这两条必须钉死：界面清单与 MCP 端点**共用同一套判断** ——
 * 一旦两边各写一份，就会出现"界面说能用、端点说不能用"这种最难查的问题。
 */

const cipher = "v1:aaaa:bbbb:cccc";

describe("readStoredTokens", () => {
  it("老数据没有 ownerUserId 也照读，归属记成 null（由 tokenStatus 判成不可用）", () => {
    const tokens = readStoredTokens({
      tokens: [{ id: "t1", name: "老令牌", ciphertext: cipher, createdAt: "2026-01-01T00:00:00.000Z", createdBy: null }],
    });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ id: "t1", name: "老令牌", ownerUserId: null });
  });

  it("带归属的那条读出来", () => {
    const tokens = readStoredTokens({
      tokens: [{ id: "t2", name: "张三的笔记本", ciphertext: cipher, ownerUserId: "user-1" }],
    });
    expect(tokens[0].ownerUserId).toBe("user-1");
  });

  it("空串 / 空白归属当没绑，不写进清单", () => {
    const tokens = readStoredTokens({ tokens: [{ id: "t3", name: "x", ciphertext: cipher, ownerUserId: "   " }] });
    expect(tokens[0].ownerUserId).toBeNull();
  });

  it("坏记录丢掉，但不牵连别的条目", () => {
    const tokens = readStoredTokens({
      tokens: [{ id: "bad" }, "不是对象", null, { id: "ok", name: "好的", ciphertext: cipher, ownerUserId: "user-1" }],
    });
    expect(tokens.map((token) => token.id)).toEqual(["ok"]);
  });

  it("缺 id 的补一个 uuid，名字兜底并截断", () => {
    const tokens = readStoredTokens({ tokens: [{ ciphertext: cipher, name: `   ` }] });
    expect(tokens[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens[0].name).toBe("未命名令牌");

    const long = readStoredTokens({ tokens: [{ ciphertext: cipher, name: "名".repeat(200) }] });
    expect(long[0].name).toHaveLength(MCP_TOKEN_NAME_MAX);
  });

  it("不是清单形状（null / 字符串 / 缺 tokens）一律当空清单", () => {
    expect(readStoredTokens(null)).toEqual([]);
    expect(readStoredTokens("x")).toEqual([]);
    expect(readStoredTokens({ tokens: "x" })).toEqual([]);
  });
});

describe("tokenStatus", () => {
  const owner = { id: "user-1", email: "a@example.com", roleName: "编辑者", disabled: false };

  it("没绑账号：不可用，并说清下一步", () => {
    const status = tokenStatus({ bound: false, owner: null });
    expect(status.usable).toBe(false);
    expect(status.blockedReason).toContain("重新生成");
  });

  it("没绑账号时可以换成自己的说法（环境变量那条用）", () => {
    const status = tokenStatus({ bound: false, owner: null, unboundReason: "加一行 MCP_API_TOKEN_USER" });
    expect(status.blockedReason).toBe("加一行 MCP_API_TOKEN_USER");
  });

  it("账号被删：不可用", () => {
    const status = tokenStatus({ bound: true, owner: null });
    expect(status.usable).toBe(false);
    expect(status.blockedReason).toContain("已被删除");
  });

  it("账号被停用：不可用，原因里带上邮箱", () => {
    const status = tokenStatus({ bound: true, owner: { ...owner, disabled: true } });
    expect(status.usable).toBe(false);
    expect(status.blockedReason).toContain("a@example.com");
  });

  it("正常账号：可用，没有原因", () => {
    expect(tokenStatus({ bound: true, owner })).toEqual({ usable: true, blockedReason: null });
  });
});
