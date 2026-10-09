import { randomBytes, randomUUID, timingSafeEqual } from "crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { readPlatformSetting, writePlatformSetting } from "@/lib/platform-db";

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
 * 这是服务端模块（要用密钥、要读库），**不要**从客户端组件 import。
 */
export const MCP_TOKEN_SETTING_KEY = "mcp.apiTokens";

/** 明文长这样：`mcp_` + 32 字节 base64url（43 字符）。前缀是为了让人一眼认出这是哪来的令牌。 */
export const MCP_TOKEN_PREFIX = "mcp_";

export const MCP_TOKEN_NAME_MAX = 60;

export type McpTokenSource = "PLATFORM" | "ENV";

/** 库里一条令牌的形状（`ciphertext` 是密文，别往外发）。 */
type StoredToken = { id: string; name: string; ciphertext: string; createdAt: string; createdBy: string | null };

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
function readStoredTokens(value: unknown): StoredToken[] {
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

/**
 * 清单（**不含明文**）。解不开的条目照样列出来（名字 + 提示），
 * 否则用户只会看到"我明明生成过"，却不知道该怎么办。
 */
export async function listMcpTokens(): Promise<McpTokenList> {
  const stored = await loadStoredTokens();
  const entries: McpTokenEntry[] = [];
  let broken = 0;
  for (const token of stored) {
    let hint: string;
    try {
      hint = mcpTokenHint(decryptSecret(token.ciphertext));
    } catch {
      broken += 1;
      hint = "（解不开）";
    }
    entries.push({
      id: token.id,
      name: token.name,
      hint,
      source: "PLATFORM",
      platformManaged: true,
      createdAt: token.createdAt,
      createdBy: token.createdBy,
    });
  }
  const env = envToken();
  if (env) {
    entries.push({
      id: "env",
      name: ".env.local 的 MCP_API_TOKEN",
      hint: mcpTokenHint(env),
      source: "ENV",
      platformManaged: false,
      createdAt: null,
      createdBy: null,
    });
  }
  return {
    entries,
    configured: entries.length > broken,
    envConfigured: Boolean(env),
    warning: broken
      ? `有 ${broken} 条令牌用当前的 TARGET_ENCRYPTION_KEY 解不开（换过密钥？）。撤销它们，重新生成。`
      : null,
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

/** 生成并追加一条。返回明文**一次**，让界面直接展开给用户复制。 */
export async function createMcpToken(name: unknown, actorId?: string): Promise<{ entry: McpTokenEntry; token: string }> {
  const token = generateMcpToken();
  const record: StoredToken = {
    id: randomUUID(),
    name: normalizeTokenName(name),
    ciphertext: encryptSecret(token),
    createdAt: new Date().toISOString(),
    createdBy: actorId ?? null,
  };
  await saveStoredTokens([...(await loadStoredTokens()), record], actorId);
  return {
    entry: {
      id: record.id,
      name: record.name,
      hint: mcpTokenHint(token),
      source: "PLATFORM",
      platformManaged: true,
      createdAt: record.createdAt,
      createdBy: record.createdBy,
    },
    token,
  };
}

/** 撤销一条。找不到（比如是环境变量那条）就返回 false，界面据此提示"这条撤不了"。 */
export async function revokeMcpToken(id: string, actorId?: string): Promise<boolean> {
  const stored = await loadStoredTokens();
  const next = stored.filter((item) => item.id !== id);
  if (next.length === stored.length) return false;
  await saveStoredTokens(next, actorId);
  return true;
}

/**
 * 请求里带来的令牌对不对。**逐条恒定时间比较**（条数很少，不用担心性能）；
 * 平台清单与环境变量那条都算数。返回 `configured` 让调用方区分"令牌错"与"根本没配"。
 */
export async function verifyMcpToken(presented: string): Promise<{ ok: boolean; configured: boolean }> {
  let configured = Boolean(envToken());
  for (const token of await loadStoredTokens()) {
    let plain: string;
    try {
      plain = decryptSecret(token.ciphertext);
    } catch {
      continue;
    }
    configured = true;
    if (mcpTokenMatches(presented, plain)) return { ok: true, configured: true };
  }
  const env = envToken();
  if (env && mcpTokenMatches(presented, env)) return { ok: true, configured: true };
  return { ok: false, configured };
}