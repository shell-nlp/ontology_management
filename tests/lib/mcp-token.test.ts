import { describe, expect, it } from "vitest";
import { generateMcpToken, mcpTokenHint, mcpTokenMatches, MCP_TOKEN_NAME_MAX, MCP_TOKEN_PREFIX, normalizeTokenName } from "@/lib/mcp-token";

/**
 * MCP 访问令牌的**纯函数**部分（2026-10-08 用户要求）：令牌要能在界面上**生成多条 / 查看 / 撤销**。
 * 落库那两条（`saveMcpToken` / `resolveMcpToken`）要连平台库，这里不碰；
 * 生成格式、遮挡显示、恒定时间比较、名字归一化这四条不依赖环境，钉死它们就够。
 */
describe("MCP 访问令牌", () => {
  it("生成的一定带 mcp_ 前缀，且每次都不一样（CSPRNG，不是时间戳凑的）", () => {
    const a = generateMcpToken();
    const b = generateMcpToken();
    expect(a.startsWith(MCP_TOKEN_PREFIX)).toBe(true);
    expect(a.length).toBeGreaterThan(20);
    expect(a).not.toBe(b);
    // base64url：没有 + / = 这些在 header 里会出问题的字符。
    expect(a).toMatch(/^mcp_[A-Za-z0-9_-]+$/);
  });

  it("只露出尾巴四位：够确认是哪一条，又不把明文摆出来", () => {
    expect(mcpTokenHint("mcp_abcdefghijklmnop")).toBe("mcp_…mnop");
  });

  it("名字是给人看的标签：空名字有兜底，过长的截断（别把清单撑坏）", () => {
    expect(normalizeTokenName("  Claude Desktop  ")).toBe("Claude Desktop");
    expect(normalizeTokenName("")).toBe("未命名令牌");
    expect(normalizeTokenName(undefined)).toBe("未命名令牌");
    expect(normalizeTokenName(42 as unknown as string)).toBe("未命名令牌");
    expect(normalizeTokenName("x".repeat(200))).toHaveLength(MCP_TOKEN_NAME_MAX);
  });

  it("比较只在完全一致时为真（长度不同直接否）", () => {
    const token = generateMcpToken();
    expect(mcpTokenMatches(token, token)).toBe(true);
    expect(mcpTokenMatches(token.slice(0, -1), token)).toBe(false);
    expect(mcpTokenMatches(`${token}x`, token)).toBe(false);
  });
});
