import { createAccessToken, MCP_ACCESS_TTL_SECONDS } from "@/lib/platform/auth";
import { findSessionUser, type PlatformUserView } from "@/lib/platform/platform-db";
import { PKCE_METHOD, pkceChallengeShapeOk, verifyPkce } from "@/lib/oauth/pkce";
import { normalizeScope, redirectUriAllowed } from "@/lib/oauth/rules";
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  createAuthorizationCode,
  createRefreshToken,
  findClient,
  touchClient,
  type OAuthClientRecord,
} from "@/lib/oauth/store";

/**
 * 授权码流程的两半：**授权**（用户点允许 → 换出一枚码）与**换令牌**（码 → 访问令牌 + 刷新令牌）。
 *
 * 这一层是"流程逻辑"，不碰 HTTP：路由只负责读参数、把 `OAuthError` 翻成 error/error_description。
 * 好处是这些判断（谁能回跳、码能不能再换、PKCE 过不过）全都能单测。
 */

/** 按 RFC 6749 的形状回错：`{ error, error_description }`。 */
export class OAuthError extends Error {
  readonly code: string;

  constructor(code: string, description: string) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
  }
}

export type AuthorizationParams = {
  clientId: string;
  redirectUri: string;
  responseType: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readAuthorizationParams(source: Record<string, unknown>): AuthorizationParams {
  return {
    clientId: text(source.client_id),
    redirectUri: text(source.redirect_uri),
    responseType: text(source.response_type),
    scope: text(source.scope),
    state: text(source.state),
    codeChallenge: text(source.code_challenge),
    codeChallengeMethod: text(source.code_challenge_method),
  };
}

export type AuthorizationCheck =
  | { ok: true; client: OAuthClientRecord; redirectUri: string; scope: string; codeChallenge: string }
  | { ok: false; error: string; description: string; redirect: string | null };

/**
 * 检查授权请求。
 *
 * **要不要回跳是分开判的**：只有"客户端认识、且回调地址与注册值一字不差"时才敢把错误带回 redirect_uri；
 * 其余情况必须把错误摆在页面上 —— 把错误回跳到一个没验证过的地址，本身就是开放重定向。
 */
export async function checkAuthorizationRequest(params: AuthorizationParams): Promise<AuthorizationCheck> {
  const client = params.clientId ? await findClient(params.clientId) : null;
  if (!client) {
    return { ok: false, error: "invalid_client", description: "认不出这个 client_id：先注册客户端（POST /api/oauth/register），或到「MCP 调试 → MCP 接入」核对地址。", redirect: null };
  }
  if (client.disabled) {
    return { ok: false, error: "invalid_client", description: "这个客户端已被停用：让管理员在「MCP 调试 → MCP 接入」里删掉重注册。", redirect: null };
  }
  if (!params.redirectUri) {
    return { ok: false, error: "invalid_request", description: "缺少 redirect_uri。", redirect: null };
  }
  if (!redirectUriAllowed(client.redirectUris, params.redirectUri)) {
    return { ok: false, error: "invalid_request", description: "redirect_uri 与注册时登记的不一致（必须一字不差，不支持通配）。", redirect: null };
  }
  // 到这里回调地址可信了，后面的错都按规范回跳给客户端。
  if (params.responseType !== "code") {
    return { ok: false, error: "unsupported_response_type", description: "只支持 response_type=code（授权码模式）。", redirect: params.redirectUri };
  }
  if (!params.codeChallenge || params.codeChallengeMethod !== PKCE_METHOD || !pkceChallengeShapeOk(params.codeChallenge)) {
    return { ok: false, error: "invalid_request", description: "公开客户端必须带 code_challenge，且 code_challenge_method=S256。", redirect: params.redirectUri };
  }
  const scope = normalizeScope(params.scope);
  if (scope === null) {
    return { ok: false, error: "invalid_scope", description: "不支持这个范围：MCP 只读，scope 只能是 mcp.read。", redirect: params.redirectUri };
  }
  return { ok: true, client, redirectUri: params.redirectUri, scope, codeChallenge: params.codeChallenge };
}

/** 拼回跳地址：保留回调地址上原有的 query（不少客户端会带自己的参数）。 */
export function appendQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** 用户点了「允许」：签发授权码（60 秒、一次性），返回要把浏览器送去哪儿。 */
export async function approveAuthorization(input: {
  check: Extract<AuthorizationCheck, { ok: true }>;
  params: AuthorizationParams;
  user: PlatformUserView;
}): Promise<string> {
  const code = await createAuthorizationCode({
    clientId: input.check.client.id,
    redirectUri: input.check.redirectUri,
    codeChallenge: input.check.codeChallenge,
    codeChallengeMethod: PKCE_METHOD,
    scope: input.check.scope,
    userId: input.user.id,
  });
  return appendQuery(input.check.redirectUri, input.params.state ? { code, state: input.params.state } : { code });
}

/** 用户点了「拒绝」：按规范回 error=access_denied（不发码）。 */
export function denyAuthorization(input: {
  check: Extract<AuthorizationCheck, { ok: true }>;
  params: AuthorizationParams;
  reason?: string;
}): string {
  const params: Record<string, string> = { error: "access_denied", error_description: input.reason ?? "用户拒绝了这次授权。" };
  if (input.params.state) params.state = input.params.state;
  return appendQuery(input.check.redirectUri, params);
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

async function issueTokens(input: { clientId: string; userId: string; email: string; scope: string }): Promise<TokenResponse> {
  const accessToken = await createAccessToken(input);
  const refreshToken = await createRefreshToken(input);
  await touchClient(input.clientId);
  return { access_token: accessToken, token_type: "Bearer", expires_in: MCP_ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: input.scope };
}

/** 换令牌的统一入口，按 grant_type 分派。 */
export async function exchangeToken(body: Record<string, unknown>): Promise<TokenResponse> {
  const grantType = text(body.grant_type);
  if (grantType === "authorization_code") return exchangeAuthorizationCode(body);
  if (grantType === "refresh_token") return exchangeRefreshToken(body);
  throw new OAuthError("unsupported_grant_type", "只支持 authorization_code 与 refresh_token 两种 grant_type。");
}

/**
 * 码换令牌。**顺序是有讲究的**：先原子地把码换掉（用掉即作废），再逐项校验 ——
 * 这样即使校验失败，那枚码也废了，攻击者拿不到可以反复试的机会。
 */
export async function exchangeAuthorizationCode(body: Record<string, unknown>): Promise<TokenResponse> {
  const clientId = text(body.client_id);
  const client = clientId ? await findClient(clientId) : null;
  if (!client || client.disabled) throw new OAuthError("invalid_client", "client_id 不对，或这个客户端已停用。");

  const code = text(body.code);
  if (!code) throw new OAuthError("invalid_request", "缺少 code。");

  const record = await consumeAuthorizationCode(code);
  if (!record) throw new OAuthError("invalid_grant", "授权码无效、已经用过或已过期（授权码只能用一次，60 秒内有效）。");
  if (record.clientId !== client.id) throw new OAuthError("invalid_grant", "这枚授权码不是发给这个客户端的。");
  if (text(body.redirect_uri) !== record.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri 与授权时用的那个不一致。");
  if (record.expired) throw new OAuthError("invalid_grant", "授权码已过期（60 秒），重新走一次授权。");
  if (!verifyPkce({ method: record.codeChallengeMethod, challenge: record.codeChallenge, verifier: body.code_verifier })) {
    throw new OAuthError("invalid_grant", "PKCE 校验没过：要带上生成 code_challenge 时用的那个 code_verifier。");
  }

  const user = await findSessionUser(record.userId);
  if (!user) throw new OAuthError("invalid_grant", "授权时那个账号已被删除或停用，重新授权。");
  return issueTokens({ clientId: client.id, userId: user.id, email: user.email, scope: record.scope });
}

/** 刷新令牌换访问令牌：旧的那条当场作废（轮换），同一条用两次第二次必然失败。 */
export async function exchangeRefreshToken(body: Record<string, unknown>): Promise<TokenResponse> {
  const clientId = text(body.client_id);
  const client = clientId ? await findClient(clientId) : null;
  if (!client || client.disabled) throw new OAuthError("invalid_client", "client_id 不对，或这个客户端已停用。");

  const token = text(body.refresh_token);
  if (!token) throw new OAuthError("invalid_request", "缺少 refresh_token。");

  const record = await consumeRefreshToken(token);
  if (!record) throw new OAuthError("invalid_grant", "刷新令牌无效、已被轮换或已过期（30 天），重新走一次授权。");
  if (record.clientId !== client.id) throw new OAuthError("invalid_grant", "这个刷新令牌不是发给这个客户端的。");

  const user = await findSessionUser(record.userId);
  if (!user) throw new OAuthError("invalid_grant", "这个刷新令牌代表的账号已被删除或停用。");
  return issueTokens({ clientId: client.id, userId: user.id, email: user.email, scope: record.scope });
}
