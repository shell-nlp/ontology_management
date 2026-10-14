import { describe, expect, it } from "vitest";
import { authorizationServerMetadata, protectedResourceMetadata, unauthorizedHeader } from "@/lib/oauth/metadata";
import { codeChallengeFor, verifyPkce } from "@/lib/oauth/pkce";
import { MCP_SCOPE, normalizeClientName, normalizeRedirectUris, normalizeScope, redirectUriAllowed, redirectUriShapeOk } from "@/lib/oauth/rules";

/**
 * OAuth 授权服务器里那些"判得对不不过"的纯规则。
 *
 * 这一层是安全边界，所以必须能单测：PKCE、回调地址精确匹配、范围白名单 ——
 * 任何一条松了都是真漏洞，不能靠"界面上点一遍看着没问题"。
 */

// RFC 7636 附录 B 的官方样例：verifier / challenge 都是它规定的值。
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE", () => {
  it("对得上 RFC 7636 的样例", () => {
    expect(codeChallengeFor(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  it("正确的 verifier 通过", () => {
    expect(verifyPkce({ method: "S256", challenge: RFC_CHALLENGE, verifier: RFC_VERIFIER })).toBe(true);
  });

  it("verifier 不对就不过", () => {
    expect(verifyPkce({ method: "S256", challenge: RFC_CHALLENGE, verifier: "x".repeat(43) })).toBe(false);
  });

  it("只认 S256：plain 一律拒（降级就是绕过）", () => {
    expect(verifyPkce({ method: "plain", challenge: RFC_VERIFIER, verifier: RFC_VERIFIER })).toBe(false);
    expect(verifyPkce({ method: "", challenge: RFC_CHALLENGE, verifier: RFC_VERIFIER })).toBe(false);
    expect(verifyPkce({ method: undefined, challenge: RFC_CHALLENGE, verifier: RFC_VERIFIER })).toBe(false);
  });

  it("verifier 太短 / 太长 / 带非法字符都不过", () => {
    expect(verifyPkce({ method: "S256", challenge: codeChallengeFor("a".repeat(42)), verifier: "a".repeat(42) })).toBe(false);
    expect(verifyPkce({ method: "S256", challenge: codeChallengeFor("a".repeat(129)), verifier: "a".repeat(129) })).toBe(false);
    expect(verifyPkce({ method: "S256", challenge: RFC_CHALLENGE, verifier: "a".repeat(42) + "!" })).toBe(false);
  });

  it("challenge 形状不对也不进比较", () => {
    expect(verifyPkce({ method: "S256", challenge: "短", verifier: RFC_VERIFIER })).toBe(false);
    expect(verifyPkce({ method: "S256", challenge: "", verifier: RFC_VERIFIER })).toBe(false);
  });
});

describe("回调地址", () => {
  it("只收 https；本机回环允许 http", () => {
    expect(redirectUriShapeOk("https://client.example.com/cb")).toBe(true);
    expect(redirectUriShapeOk("http://localhost:7777/callback")).toBe(true);
    expect(redirectUriShapeOk("http://127.0.0.1/cb")).toBe(true);
    expect(redirectUriShapeOk("http://client.example.com/cb")).toBe(false);
    expect(redirectUriShapeOk("client://cb")).toBe(false);
  });

  it("相对地址、带 fragment 的一律拒", () => {
    expect(redirectUriShapeOk("/callback")).toBe(false);
    expect(redirectUriShapeOk("https://client.example.com/cb#token")).toBe(false);
  });

  it("匹配必须一字不差（不做前缀、不做通配）", () => {
    const registered = ["https://client.example.com/cb"];
    expect(redirectUriAllowed(registered, "https://client.example.com/cb")).toBe(true);
    expect(redirectUriAllowed(registered, "https://client.example.com/cb2")).toBe(false);
    expect(redirectUriAllowed(registered, "https://client.example.com/cb/../evil")).toBe(false);
    expect(redirectUriAllowed(registered, "https://client.example.com")).toBe(false);
  });

  it("注册清单会丢掉非法项并去重，最多 10 条", () => {
    const list = normalizeRedirectUris([
      "https://a.example.com/cb",
      "https://a.example.com/cb",
      "http://evil.example.com/cb",
      "/relative",
      42,
      "https://b.example.com/cb",
    ]);
    expect(list).toEqual(["https://a.example.com/cb", "https://b.example.com/cb"]);
    expect(normalizeRedirectUris(Array.from({ length: 20 }, (_, i) => "https://c" + i + ".example.com/cb"))).toHaveLength(10);
    expect(normalizeRedirectUris("https://a.example.com/cb")).toEqual([]);
  });
});

describe("范围", () => {
  it("不传就是默认范围", () => {
    expect(normalizeScope(undefined)).toBe(MCP_SCOPE);
    expect(normalizeScope("")).toBe(MCP_SCOPE);
    expect(normalizeScope("   ")).toBe(MCP_SCOPE);
  });

  it("支持的范围照收，重复去重", () => {
    expect(normalizeScope("mcp.read")).toBe("mcp.read");
    expect(normalizeScope("mcp.read mcp.read")).toBe("mcp.read");
  });

  it("要了不支持的范围就整条拒（不许偷偷降级）", () => {
    expect(normalizeScope("mcp.write")).toBeNull();
    expect(normalizeScope("mcp.read offline_access")).toBeNull();
  });
});

describe("客户端名字", () => {
  it("空的给兜底，长的截断", () => {
    expect(normalizeClientName("")).toBe("未命名客户端");
    expect(normalizeClientName(123)).toBe("未命名客户端");
    expect(normalizeClientName("名".repeat(200))).toHaveLength(80);
  });
});

describe("两份发现文档", () => {
  const origin = "https://ontology.example.com";

  it("受保护资源：resource 指向 MCP 端点，授权服务器可替换", () => {
    const doc = protectedResourceMetadata(origin, "https://sso.example.com");
    expect(doc.resource).toBe(origin + "/api/mcp");
    expect(doc.authorization_servers).toEqual(["https://sso.example.com"]);
    expect(doc.scopes_supported).toContain("mcp.read");
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  it("授权服务器：三个端点齐全，只声明 S256 与公开客户端", () => {
    const doc = authorizationServerMetadata(origin);
    expect(doc.issuer).toBe(origin);
    expect(doc.authorization_endpoint).toBe(origin + "/api/oauth/authorize");
    expect(doc.token_endpoint).toBe(origin + "/api/oauth/token");
    expect(doc.registration_endpoint).toBe(origin + "/api/oauth/register");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("401 上那句要带上元数据地址（客户端靠它触发 OAuth）", () => {
    const header = unauthorizedHeader(origin);
    expect(header).toContain("resource_metadata=\"" + origin + "/.well-known/oauth-protected-resource\"");
    expect(header).toContain("scope=\"mcp.read\"");
  });
});
