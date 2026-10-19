import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { decryptSecret, encryptSecret } from "@/lib/shared/server/crypto";
import {
  findSessionUser,
  listUserIdentities,
  readPlatformSetting,
  writePlatformSetting,
  type PlatformUserView,
} from "@/lib/platform/platform-db";

/**
 * 外部 MCP 客户端的访问令牌（`Authorization: Bearer <令牌>`）。**可以有多条**。
 *
 * 两个用户口径叠出来的设计：
 * - 2026-10-08：「mcp 接入的 token 现在只能通过配置文件进行配置，不行的，要实现，可以在这个界面生成，
 *   也要支持查看和撤销」；
 * - 2026-10-08 追加：「token 应该能生成多个，可以管理 token，而不是现在的一个」。
 *
 * 所以这里存的是**一个令牌清单**，每条有自己的名字（`Claude Desktop` / 「张三的笔记本」这种，
 * 撤销的时候才知道撤的是谁）。多条并存是必须的：换个客户端、换台机器各配一条，
 * 停用其中一个不该把别人踢下线 —— 只有一条的话，"重新生成"就等于全员掉线。
 *
 * **取值来源**：
 * - `mcp.apiTokens`：界面上生成的清单，AES-256-GCM 加密后存进 `platform_settings`
 *   （密钥就是数据资源凭据那把 `TARGET_ENCRYPTION_KEY`，不引入第二套密钥管理）。
 * - `MCP_API_TOKEN`：老部署的环境变量，作为**一条只读的兜底令牌**保留 —— 不动配置文件也能继续用，
 *   但它不归界面管（撤销要去改 `.env.local`）。
 *
 * **每条令牌代表一个平台账号**（2026-10-14 用户口径）：在这之前令牌只是"一把能进门的钥匙"，
 * 谁拿着都一样、也没有身份，审计里说不清是谁在查数。现在令牌必须记 `ownerUserId` ——
 * 每次调用都拿它回库取**当前**的账号与角色，于是三件事自动成立：账号被停用 / 删掉，令牌当场失效；
 * 角色（权限点）被改，下一次调用立刻跟着变；外部调用终于有"操作人"。
 * **没绑账号的令牌一律拒绝** —— 宁可让老令牌失效并给出重新生成的路，也不要一把没有身份的万能钥匙。
 *
 * 这是服务端模块（要用密钥、要读库），**不要**从客户端组件 import。
 */
export const MCP_TOKEN_SETTING_KEY = "mcp.apiTokens";

/** 明文长这样：`mcp_` + 32 字节 base64url（43 字符）。前缀是为了让人一眼认出这是哪来的令牌。 */
export const MCP_TOKEN_PREFIX = "mcp_";

export const MCP_TOKEN_NAME_MAX = 60;

export type McpTokenSource = "PLATFORM" | "ENV";

/** 库里一条令牌的形状（`ciphertext` 是密文，别往外发）。 */
export type StoredToken = {
  id: string;
  name: string;
  ciphertext: string;
  createdAt: string;
  createdBy: string | null;
  /** 这条令牌代表哪个平台账号。null = 老数据 / 没绑，**不可用**（要重新生成一条）。 */
  ownerUserId: string | null;
};

/** 令牌的归属账号：只留"是谁、还在不在"，不含密码与权限点。 */
export type TokenOwner = { id: string; email: string; roleName: string; disabled: boolean };

/** 给界面看的一条：**没有明文**，要明文单独走 `revealMcpToken`。 */
export type McpTokenEntry = {
  /** 平台那条是 uuid；环境变量那条固定 `"env"`（撤销不了，所以不需要真 id）。 */
  id: string;
  name: string;
  hint: string;
  source: McpTokenSource;
  /** 只有平台那条能被撤销。 */
  platformManaged: boolean;
  createdAt: string | null;
  createdBy: string | null;
  /** 这条令牌代表哪个账号（平台那条由生成时选定）。 */
  ownerUserId: string | null;
  /** 归属账号的邮箱；没绑或账号已删就是 null。 */
  ownerEmail: string | null;
  /** 归属账号的角色名（回显用）。 */
  ownerRoleName: string | null;
  /** 归属账号被停用了（令牌随之失效）。 */
  ownerDisabled: boolean;
  /** 现在能不能用它调 MCP。false 时 `blockedReason` 说为什么、下一步怎么办。 */
  usable: boolean;
  blockedReason: string | null;
};

export type McpTokenList = {
  entries: McpTokenEntry[];
  /** 至少有一条能用（平台清单或环境变量）。 */
  configured: boolean;
  envConfigured: boolean;
  /** 清单里有解不开的条目（换了 `TARGET_ENCRYPTION_KEY` / 密文坏了）时的说明；正常是 null。 */
  warning: string | null;
};

/** 生成一条新令牌。用 CSPRNG，不要用 Math.random / 时间戳。 */
export function generateMcpToken(): string {
  return `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** 只给界面看的尾巴：`mcp_…ab12`。够确认"是不是我手上这一条"，又不用把明文摆出来。 */
export function mcpTokenHint(token: string): string {
  return `${MCP_TOKEN_PREFIX}…${token.slice(-4)}`;
}

/**
 * 恒定时间比较，别用 `===`：字符串比较会在第一个不同的字符处返回，
 * 用响应时间能把令牌一位一位试出来。
 */
export function mcpTokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 名字只是给人看的标签，截断 + 兜底，别让空名字把界面撑坏。 */
export function normalizeTokenName(name: unknown, fallback = "未命名令牌"): string {
  const text = typeof name === "string" ? name.trim() : "";
  return (text || fallback).slice(0, MCP_TOKEN_NAME_MAX);
}

function envToken(): string {
  return process.env.MCP_API_TOKEN?.trim() ?? "";
}

/** 库里那条可能是老格式 / 脏数据：形状不对就丢掉，不能因为一条坏记录把外部客户端全挡在门外。 */
export function readStoredTokens(value: unknown): StoredToken[] {
  const raw = value && typeof value === "object" && Array.isArray((value as { tokens?: unknown }).tokens)
    ? (value as { tokens: unknown[] }).tokens
    : [];
  const tokens: StoredToken[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.ciphertext !== "string" || !record.ciphertext.trim()) continue;
    tokens.push({
      id: typeof record.id === "string" && record.id.trim() ? record.id : randomUUID(),
      name: normalizeTokenName(record.name),
      ciphertext: record.ciphertext,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
      createdBy: typeof record.createdBy === "string" ? record.createdBy : null,
      ownerUserId: typeof record.ownerUserId === "string" && record.ownerUserId.trim() ? record.ownerUserId : null,
    });
  }
  return tokens;
}

/** 读库失败不抛 —— 令牌读取不该把 MCP 端点整死，那种情况按"平台里还没有令牌"处理。 */
async function loadStoredTokens(): Promise<StoredToken[]> {
  try {
    return readStoredTokens(await readPlatformSetting<unknown>(MCP_TOKEN_SETTING_KEY));
  } catch {
    return [];
  }
}

async function saveStoredTokens(tokens: StoredToken[], actorId?: string): Promise<void> {
  await writePlatformSetting<{ tokens: StoredToken[] }>(MCP_TOKEN_SETTING_KEY, { tokens }, actorId);
}

/** 环境变量那条令牌代表谁：`MCP_API_TOKEN_USER=<邮箱>`。没配 / 配的邮箱对不上账号，它就用不了。 */
function envOwnerEmail(): string {
  return process.env.MCP_API_TOKEN_USER?.trim().toLowerCase() ?? "";
}

/**
 * 一条令牌现在的可用状态（**纯函数**）：界面清单与 MCP 端点共用同一套判断，
 * 不许两边各写一份 —— 否则迟早出现"界面说能用、端点说不能用"。
 *
 * 只看三件事：绑没绑账号、账号还在不在、账号有没有被停用。
 * 权限点够不够（`reasoning.use`）**不在这一层** —— 那是"这个人能不能用 MCP"，不是"这条令牌能不能用"。
 */
export function tokenStatus(input: { bound: boolean; owner: TokenOwner | null; unboundReason?: string }): { usable: boolean; blockedReason: string | null } {
  if (!input.bound) {
    return { usable: false, blockedReason: input.unboundReason ?? "这条令牌没有绑定账号，不能再用：重新生成一条，并选好它代表哪个账号。" };
  }
  if (!input.owner) {
    return { usable: false, blockedReason: "这条令牌代表的账号已被删除：重新生成一条，或改绑到其它账号。" };
  }
  if (input.owner.disabled) {
    return { usable: false, blockedReason: `这条令牌代表的账号 ${input.owner.email} 已被停用：启用该账号，或换一条绑了有效账号的令牌。` };
  }
  return { usable: true, blockedReason: null };
}

/**
 * 清单（**不含明文**）。解不开的条目照样列出来（名字 + 提示），
 * 否则用户只会看到"我明明生成过"，却不知道该怎么办。
 *
 * 每条都带上**归属账号**与**现在能不能用**：令牌失效最常见的原因就是
 * "老令牌没绑账号"和"绑的账号被停用 / 删了"，不写出来，用户只会看到外部客户端莫名其妙连不上。
 */
export async function listMcpTokens(): Promise<McpTokenList> {
  const stored = await loadStoredTokens();
  // 账号整表读一次（账号很少），别一条令牌查一次库。
  const owners = new Map<string, TokenOwner>();
  const ownersByEmail = new Map<string, TokenOwner>();
  try {
    for (const identity of await listUserIdentities()) {
      owners.set(identity.id, identity);
      ownersByEmail.set(identity.email.toLowerCase(), identity);
    }
  } catch {
    // 读不到账号不抛：清单还要能打开，归属一律按"查不到"处理。
  }
  const entries: McpTokenEntry[] = [];
  let broken = 0;
  let unusable = 0;
  for (const token of stored) {
    let hint: string;
    let brokenKey = false;
    try {
      hint = mcpTokenHint(decryptSecret(token.ciphertext));
    } catch {
      broken += 1;
      brokenKey = true;
      hint = "（解不开）";
    }
    const owner = token.ownerUserId ? owners.get(token.ownerUserId) ?? null : null;
    const status: { usable: boolean; blockedReason: string | null } = brokenKey
      ? { usable: false, blockedReason: "这条令牌的密文解不开（换过 TARGET_ENCRYPTION_KEY？）：撤销它，重新生成一条。" }
      : tokenStatus({ bound: Boolean(token.ownerUserId), owner });
    if (!brokenKey && !status.usable) unusable += 1;
    entries.push({
      id: token.id,
      name: token.name,
      hint,
      source: "PLATFORM",
      platformManaged: true,
      createdAt: token.createdAt,
      createdBy: token.createdBy,
      ownerUserId: token.ownerUserId,
      ownerEmail: owner?.email ?? null,
      ownerRoleName: owner?.roleName ?? null,
      ownerDisabled: owner?.disabled ?? false,
      usable: status.usable,
      blockedReason: status.blockedReason,
    });
  }
  const env = envToken();
  if (env) {
    const email = envOwnerEmail();
    const owner = email ? ownersByEmail.get(email) ?? null : null;
    const status = email
      ? tokenStatus({ bound: true, owner })
      : tokenStatus({
          bound: false,
          owner: null,
          unboundReason:
            "这条 .env.local 的令牌还没指定代表哪个账号：加一行 MCP_API_TOKEN_USER=<账号邮箱> 才能用（平台里生成的令牌不受影响）。",
        });
    if (!status.usable) unusable += 1;
    entries.push({
      id: "env",
      name: ".env.local 的 MCP_API_TOKEN",
      hint: mcpTokenHint(env),
      source: "ENV",
      platformManaged: false,
      createdAt: null,
      createdBy: null,
      ownerUserId: owner?.id ?? null,
      ownerEmail: owner?.email ?? (email || null),
      ownerRoleName: owner?.roleName ?? null,
      ownerDisabled: owner?.disabled ?? false,
      usable: status.usable,
      blockedReason: status.blockedReason,
    });
  }
  const notes: string[] = [];
  if (broken) notes.push(`有 ${broken} 条令牌用当前的 TARGET_ENCRYPTION_KEY 解不开（换过密钥？）。撤销它们，重新生成。`);
  if (unusable) notes.push(`有 ${unusable} 条令牌现在不能用（没绑账号 / 账号已停用或删除）：下面每条都写了原因和下一步。`);
  return {
    entries,
    // 「配好了」= 现在**真的有一条能用**，不是"清单里曾经有过"。
    configured: entries.some((entry) => entry.usable),
    envConfigured: Boolean(env),
    warning: notes.length ? notes.join(" ") : null,
  };
}

/** 取某一条的明文（界面点「查看」时才调）。不在清单里 → null。 */
export async function revealMcpToken(id: string): Promise<string | null> {
  const token = (await loadStoredTokens()).find((item) => item.id === id);
  if (!token) return null;
  try {
    return decryptSecret(token.ciphertext);
  } catch {
    return null;
  }
}

/** 一条刚生成的令牌 → 给界面看的那份（归属已经校验过，状态直接算出来）。 */
function entryOf(record: StoredToken, owner: TokenOwner, hint: string): McpTokenEntry {
  const status = tokenStatus({ bound: true, owner });
  return {
    id: record.id,
    name: record.name,
    hint,
    source: "PLATFORM",
    platformManaged: true,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    ownerUserId: owner.id,
    ownerEmail: owner.email,
    ownerRoleName: owner.roleName,
    ownerDisabled: owner.disabled,
    usable: status.usable,
    blockedReason: status.blockedReason,
  };
}

/** 归属账号必须**存在且没停用**：从源头挡住"绑一个用不了的账号"。 */
async function resolveOwner(ownerUserId: unknown): Promise<TokenOwner> {
  const id = typeof ownerUserId === "string" ? ownerUserId.trim() : "";
  if (!id) throw new Error("生成令牌要指定它代表哪个账号（一般就是你自己）。");
  const owner = (await listUserIdentities()).find((item) => item.id === id) ?? null;
  if (!owner) throw new Error("要绑定的账号不存在，换一个再生成。");
  if (owner.disabled) throw new Error(`账号 ${owner.email} 已停用，不能作为令牌的归属。`);
  return owner;
}

/**
 * 生成并追加一条。返回明文**一次**，让界面直接展开给用户复制。
 *
 * `ownerUserId` 是**必填**的：令牌代表谁，就按谁的权限走。界面默认选当前登录的人；
 * 需要"共用的服务账号"时，管理员可以显式选另一个账号（那个账号的权限就是这条令牌的上限）。
 */
export async function createMcpToken(name: unknown, input: { actorId?: string; ownerUserId?: unknown }): Promise<{ entry: McpTokenEntry; token: string }> {
  const owner = await resolveOwner(input.ownerUserId);
  const token = generateMcpToken();
  const record: StoredToken = {
    id: randomUUID(),
    name: normalizeTokenName(name),
    ciphertext: encryptSecret(token),
    createdAt: new Date().toISOString(),
    createdBy: input.actorId ?? null,
    ownerUserId: owner.id,
  };
  await saveStoredTokens([...(await loadStoredTokens()), record], input.actorId);
  return { entry: entryOf(record, owner, mcpTokenHint(token)), token };
}

/** 撤销一条。找不到（比如是环境变量那条）就返回 false，界面据此提示"这条撤不了"。 */
export async function revokeMcpToken(id: string, actorId?: string): Promise<boolean> {
  const stored = await loadStoredTokens();
  const next = stored.filter((item) => item.id !== id);
  if (next.length === stored.length) return false;
  await saveStoredTokens(next, actorId);
  return true;
}

/** 令牌认出来了：它代表哪个账号（连同**当前**角色与权限点，每次都现取）。 */
export type McpTokenCaller = {
  /** 平台库那条的 id；环境变量那条固定 `"env"`。 */
  tokenId: string;
  tokenName: string;
  user: PlatformUserView;
};

export type McpTokenResolution =
  | { ok: true; caller: McpTokenCaller }
  | { ok: false; configured: boolean; reason: string };

/**
 * 请求里带来的令牌对不对、代表谁。**逐条恒定时间比较**（条数很少，不用担心性能）；
 * 平台清单与环境变量那条都算数。返回 `configured` 让调用方区分"令牌错"与"根本没配"。
 *
 * 认出来之后**还要拿归属账号回库**（`findSessionUser`）：
 * - 账号被删 / 被停用 → 令牌当场失效，不用等重启，也不用等令牌过期；
 * - 返回的是**当前**的角色与权限点，所以调用方拿它判权限永远是最新的。
 *
 * 没绑账号、或绑的账号已经不在了，一律 `ok: false` + 一句"怎么办" —— 绝不静默放行。
 */
export async function resolveMcpToken(presented: string): Promise<McpTokenResolution> {
  const stored = await loadStoredTokens();
  const env = envToken();
  const configured = Boolean(env) || stored.length > 0;

  for (const token of stored) {
    let plain: string;
    try {
      plain = decryptSecret(token.ciphertext);
    } catch {
      continue;
    }
    if (!mcpTokenMatches(presented, plain)) continue;
    return callerFor({ tokenId: token.id, tokenName: token.name, ownerUserId: token.ownerUserId }, configured);
  }

  if (env && mcpTokenMatches(presented, env)) {
    return callerFor(
      { tokenId: "env", tokenName: ".env.local 的 MCP_API_TOKEN", ownerUserId: await envOwnerId() },
      configured,
    );
  }
  return { ok: false, configured, reason: "" };
}

/** 认出的那条 → 回库取身份。任何一步不过都返回 `ok: false` 并说清下一步怎么办。 */
async function callerFor(
  input: { tokenId: string; tokenName: string; ownerUserId: string | null },
  configured: boolean,
): Promise<McpTokenResolution> {
  if (!input.ownerUserId) {
    const unbound = input.tokenId === "env"
      ? "这条 .env.local 的令牌还没指定代表哪个账号：加一行 MCP_API_TOKEN_USER=<账号邮箱> 才能用。"
      : `令牌「${input.tokenName}」没有绑定账号，不能再用：到「MCP 调试 → MCP 接入」重新生成一条。`;
    return { ok: false, configured, reason: unbound };
  }
  const user = await findSessionUser(input.ownerUserId);
  if (!user) {
    return {
      ok: false,
      configured,
      reason: `令牌「${input.tokenName}」代表的账号已被删除或停用：到「MCP 调试 → MCP 接入」换一条绑了有效账号的令牌。`,
    };
  }
  return { ok: true, caller: { tokenId: input.tokenId, tokenName: input.tokenName, user } };
}

/**
 * 环境变量那条令牌代表谁：`MCP_API_TOKEN_USER=<邮箱>`。
 * 返回 null = 没配 / 配的邮箱没有对应的**启用**账号 —— 调用方一律当"这条令牌不可用"。
 */
async function envOwnerId(): Promise<string | null> {
  const email = envOwnerEmail();
  if (!email) return null;
  try {
    const identity = (await listUserIdentities()).find((item) => item.email.toLowerCase() === email);
    return identity && !identity.disabled ? identity.id : null;
  } catch {
    return null;
  }
}