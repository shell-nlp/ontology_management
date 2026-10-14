import { createHash, timingSafeEqual } from "node:crypto";

/**
 * PKCE（RFC 7636）。**只做 S256**。
 *
 * OAuth 2.1 里公开客户端必须用 PKCE，而且明确不许 `plain`：改成 plain 就等于把
 * "授权码被截获也没用"这条保护退化成"码就是密码"。所以这里收到 plain 一律拒绝，
 * 不做"兼容旧客户端"的降级 —— 降级本身就是最经典的绕过手法。
 *
 * 两个形状约束来自 RFC 7636：verifier 是 43~128 个 unreserved 字符，
 * challenge 是 SHA-256 的 base64url（恒 43 字符）。
 */
export const PKCE_METHOD = "S256";
export const PKCE_VERIFIER_MIN = 43;
export const PKCE_VERIFIER_MAX = 128;

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 由 verifier 算出 challenge。客户端自己算，这里只给测试与排障用。 */
export function codeChallengeFor(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier, "ascii").digest());
}

export function pkceVerifierShapeOk(verifier: string): boolean {
  if (verifier.length < PKCE_VERIFIER_MIN || verifier.length > PKCE_VERIFIER_MAX) return false;
  return /^[A-Za-z0-9\-._~]+$/.test(verifier);
}

export function pkceChallengeShapeOk(challenge: string): boolean {
  return /^[A-Za-z0-9\-_]{43}$/.test(challenge);
}

/**
 * 校验 PKCE。**恒定时间比较**，别写 `===`。
 * 任何一项不满足都返回 false（方法不是 S256、形状不对、对不上），不给分层原因 ——
 * 调用方只会回一句 invalid_grant，说太细反而给攻击者做二分。
 */
export function verifyPkce(input: { method: unknown; challenge: unknown; verifier: unknown }): boolean {
  const method = typeof input.method === "string" ? input.method : "";
  const challenge = typeof input.challenge === "string" ? input.challenge : "";
  const verifier = typeof input.verifier === "string" ? input.verifier : "";
  if (method !== PKCE_METHOD) return false;
  if (!pkceChallengeShapeOk(challenge) || !pkceVerifierShapeOk(verifier)) return false;
  const expected = Buffer.from(codeChallengeFor(verifier), "ascii");
  const actual = Buffer.from(challenge, "ascii");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
