import { describe, expect, it } from "vitest";
import { publicOrigin } from "@/lib/public-origin";

/** 只造出 `publicOrigin` 用到的三个字段，不必真起一个 NextRequest。 */
function request(headers: Record<string, string>, url = "http://localhost:3001/api/skills") {
  return {
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    url,
    nextUrl: { origin: "http://localhost:3001" },
  };
}

describe("对外地址（publicOrigin）", () => {
  it("用请求自己的 Host，而不是服务端认的 localhost", () => {
    // 就是 2026-09-18 用户报的那一幕：用机器 IP 访问，页面上却写着 localhost，复制出去换台机器就废了。
    expect(publicOrigin(request({ host: "192.168.1.5:3001" }))).toBe("http://192.168.1.5:3001");
    expect(publicOrigin(request({ host: "ontology.example.com" }))).toBe("http://ontology.example.com");
  });

  it("代理后面认 x-forwarded-host 与 x-forwarded-proto，且只看第一段", () => {
    expect(publicOrigin(request({
      host: "app:3000",
      "x-forwarded-host": "ontology.example.com, inner",
      "x-forwarded-proto": "https, http",
    }))).toBe("https://ontology.example.com");
  });

  it("x-forwarded-proto 只认 http / https（大小写不敏感），别的忽略", () => {
    expect(publicOrigin(request({ host: "h:1", "x-forwarded-proto": "HTTPS" }))).toBe("https://h:1");
    expect(publicOrigin(request({ host: "h:1", "x-forwarded-proto": "ftp" }))).toBe("http://h:1");
  });

  it("两个头都没有才退回 nextUrl.origin（没有 nextUrl 就用请求自己的 url）", () => {
    expect(publicOrigin(request({}))).toBe("http://localhost:3001");
    expect(publicOrigin({ headers: { get: () => null }, url: "https://x/y" })).toBe("https://x");
  });
});
