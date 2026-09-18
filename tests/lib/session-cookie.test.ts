import { describe, expect, it } from "vitest";
import { sessionCookieSecure } from "@/lib/session-cookie";

describe("sessionCookieSecure", () => {
  it("直连 http 不发 Secure（否则浏览器会丢 cookie，登录后立刻被踢回登录页）", () => {
    expect(sessionCookieSecure({ protocol: "http:" })).toBe(false);
    expect(sessionCookieSecure({ protocol: "http:", forwardedProto: null })).toBe(false);
    expect(sessionCookieSecure({})).toBe(false);
  });

  it("直连 https 发 Secure", () => {
    expect(sessionCookieSecure({ protocol: "https:" })).toBe(true);
  });

  it("TLS 终止在反向代理后面时看 x-forwarded-proto", () => {
    expect(sessionCookieSecure({ protocol: "http:", forwardedProto: "https" })).toBe(true);
    // 代理链可能是一串，只看第一段。
    expect(sessionCookieSecure({ protocol: "http:", forwardedProto: "https, http" })).toBe(true);
    // 本机连着 https 时恒为 Secure：这个头是客户端可伪造的，不许它把已经安全的会话降级。
    expect(sessionCookieSecure({ protocol: "https:", forwardedProto: "http" })).toBe(true);
    // 大小写与空白不该影响判断。
    expect(sessionCookieSecure({ protocol: "http:", forwardedProto: " HTTPS " })).toBe(true);
  });

  it("AUTH_COOKIE_SECURE 显式覆盖优先", () => {
    expect(sessionCookieSecure({ protocol: "http:", override: "true" })).toBe(true);
    expect(sessionCookieSecure({ protocol: "https:", override: "false" })).toBe(false);
    expect(sessionCookieSecure({ protocol: "http:", override: " True " })).toBe(true);
    // 认不出来的值当没填，回落自动判断。
    expect(sessionCookieSecure({ protocol: "http:", override: "yes" })).toBe(false);
  });
});
