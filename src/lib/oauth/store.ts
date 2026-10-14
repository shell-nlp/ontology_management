import { createHash, randomBytes, randomUUID } from "node:crypto";
import { IsNull, LessThan } from "typeorm";
import { jsonValue, platformRepo } from "@/lib/platform/db";
import {
  OAuthAuthorizationCodeEntity,
  OAuthClientEntity,
  OAuthRefreshTokenEntity,
} from "@/lib/platform/db/entities";
import { normalizeClientName, normalizeRedirectUris } from "@/lib/oauth/rules";

/**
 * 授权服务器要落库的那三样东西（客户端、授权码、刷新令牌）。
 *
 * 为什么不用内存：生产是 `next start` 多实例 + 会重启，授权码必须**一次性**、
 * 刷新令牌必须**能轮换**，这些约束只有库能给。SQL 全走 ORM（见 @/lib/platform/db）。
 */

/** 授权码寿命：够浏览器跳一次，不够被人捡走再用。 */
export const AUTH_CODE_TTL_SECONDS = 60;
/** 刷新令牌寿命：30 天（访问令牌 1 小时，靠它续）。 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 自助注册客户端的条数上限：这是一条不要求登录的写入口，给个天花板。 */
export const MAX_DYNAMIC_CLIENTS = 200;
/** 过期授权码的保留时长：签发时顺手清掉比这更早的（它们早就过期了）。 */
export const AUTH_CODE_SWEEP_AFTER_SECONDS = 24 * 60 * 60;

export type OAuthClientRecord = {
  id: string;
  name: string;
  redirectUris: string[];
  source: string;
  createdAt: string;
  createdBy: string | null;
  disabled: boolean;
  lastUsedAt: string | null;
};

export type AuthorizationCodeRecord = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  userId: string;
  expired: boolean;
};

function randomToken(prefix: string, bytes = 32): string {
  return prefix + randomBytes(bytes).toString("base64url");
}

/** 刷新令牌只存哈希：库被读走也换不出令牌（和密码存哈希同一个道理）。 */
function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function clientRecord(row: OAuthClientEntity): OAuthClientRecord {
  const uris = Array.isArray(row.redirectUris)
    ? (row.redirectUris as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  return {
    id: row.id,
    name: row.clientName,
    redirectUris: uris,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    disabled: Boolean(row.disabledAt),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
  };
}

export async function findClient(clientId: string): Promise<OAuthClientRecord | null> {
  const id = clientId.trim();
  if (!id) return null;
  const row = await (await platformRepo(OAuthClientEntity)).findOne({ where: { id } });
  return row ? clientRecord(row) : null;
}

export async function listClients(): Promise<OAuthClientRecord[]> {
  const rows = await (await platformRepo(OAuthClientEntity)).find({ order: { createdAt: "DESC" } });
  return rows.map(clientRecord);
}

/**
 * 登记一个客户端。`source` 是 DCR（客户端自助注册）或 ADMIN（管理员登记）。
 *
 * 回调地址**必须**至少有一个合法的：没有回调地址的客户端谁也接不回来，
 * 与其让它注册成功再在授权时报错，不如在这里就挡住。
 */
export async function registerClient(input: {
  clientName: unknown;
  redirectUris: unknown;
  source: "DCR" | "ADMIN";
  createdBy?: string | null;
}): Promise<OAuthClientRecord> {
  const redirectUris = normalizeRedirectUris(input.redirectUris);
  if (!redirectUris.length) {
    throw new Error("redirect_uris 至少要有一个合法的回调地址（https，或 http://localhost 用于本机客户端）。");
  }
  const repo = await platformRepo(OAuthClientEntity);
  const total = await repo.count();
  if (total >= MAX_DYNAMIC_CLIENTS) {
    throw new Error("客户端数量已达上限（" + MAX_DYNAMIC_CLIENTS + " 个）：到「MCP 调试 → MCP 接入」删掉不用的再注册。");
  }
  const winner = randomToken("mcpc_", 18);
  const now = new Date();
  await repo.insert({
    id: winner,
    clientName: normalizeClientName(input.clientName),
    redirectUris: jsonValue(redirectUris),
    source: input.source,
    createdAt: now,
    createdBy: input.createdBy ?? null,
    disabledAt: null,
    lastUsedAt: null,
  });
  return { id: winner, name: normalizeClientName(input.clientName), redirectUris, source: input.source, createdAt: now.toISOString(), createdBy: input.createdBy ?? null, disabled: false, lastUsedAt: null };
}

/** 删客户端：**顺手作废它的授权码与刷新令牌** —— 删了还能用就等于没删。 */
export async function deleteClient(clientId: string): Promise<boolean> {
  const repo = await platformRepo(OAuthClientEntity);
  const row = await repo.findOne({ where: { id: clientId } });
  if (!row) return false;
  await repo.delete({ id: clientId });
  const codes = await platformRepo(OAuthAuthorizationCodeEntity);
  await codes.delete({ clientId });
  const refresh = await platformRepo(OAuthRefreshTokenEntity);
  await refresh.update({ clientId, revokedAt: IsNull() }, { revokedAt: new Date() });
  return true;
}

/** 换到令牌时记一笔：界面上据此看这个客户端还在不在用。 */
export async function touchClient(clientId: string): Promise<void> {
  await (await platformRepo(OAuthClientEntity)).update({ id: clientId }, { lastUsedAt: new Date() });
}

export async function createAuthorizationCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  userId: string;
}): Promise<string> {
  const code = randomToken("mcpac_", 32);
  const now = new Date();
  const repo = await platformRepo(OAuthAuthorizationCodeEntity);
  /*
   * 顺手清掉作废很久的码：这张表一行一次授权，长期不收拾只会越堆越多。
   * 按 created_at 删（它有索引）—— 一天前的码早就过期了，留着没有任何用处。
   */
  await repo.delete({ createdAt: LessThan(new Date(now.getTime() - AUTH_CODE_SWEEP_AFTER_SECONDS * 1000)) });
  await repo.insert({
    code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    userId: input.userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SECONDS * 1000),
    consumedAt: null,
  });
  return code;
}

/**
 * 把授权码**换走**：先原子地占位（`consumed_at IS NULL` 那次 UPDATE 就是锁），
 * 占不到说明已经用过或根本不存在 —— 一次性就是这么实现的，别改成"先读后写"。
 *
 * 过期的码同样会被占掉再判过期：反正它不能再用了，判完直接作废最干净。
 */
export async function consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | null> {
  const value = code.trim();
  if (!value) return null;
  const repo = await platformRepo(OAuthAuthorizationCodeEntity);
  const claimed = await repo.update({ code: value, consumedAt: IsNull() }, { consumedAt: new Date() });
  if (!claimed.affected) return null;
  const row = await repo.findOne({ where: { code: value } });
  if (!row) return null;
  return {
    code: row.code,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    codeChallenge: row.codeChallenge,
    codeChallengeMethod: row.codeChallengeMethod,
    scope: row.scope,
    userId: row.userId,
    expired: row.expiresAt.getTime() <= Date.now(),
  };
}

/** 签发刷新令牌：返回**明文**（只回这一次），库里只留哈希。 */
export async function createRefreshToken(input: { clientId: string; userId: string; scope: string }): Promise<string> {
  const token = randomToken("mcprt_", 32);
  const now = new Date();
  await (await platformRepo(OAuthRefreshTokenEntity)).insert({
    id: randomUUID(),
    tokenHash: hashToken(token),
    clientId: input.clientId,
    userId: input.userId,
    scope: input.scope,
    createdAt: now,
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    revokedAt: null,
  });
  return token;
}

/**
 * 用刷新令牌换新的：**轮换**（旧的那条当场作废）。
 * 同一条用两次（比如令牌被偷走后两边都在刷）第二次就会失败 —— 这正是轮换要的效果。
 */
export async function consumeRefreshToken(token: string): Promise<{ clientId: string; userId: string; scope: string } | null> {
  const value = token.trim();
  if (!value) return null;
  const repo = await platformRepo(OAuthRefreshTokenEntity);
  const hash = hashToken(value);
  const claimed = await repo.update({ tokenHash: hash, revokedAt: IsNull() }, { revokedAt: new Date() });
  if (!claimed.affected) return null;
  const row = await repo.findOne({ where: { tokenHash: hash } });
  if (!row) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return { clientId: row.clientId, userId: row.userId, scope: row.scope };
}
