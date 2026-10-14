import { NextRequest, NextResponse } from "next/server";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { registerClient } from "@/lib/oauth/store";
import { withPublic } from "@/lib/platform/route-guard";

/**
 * 客户端自助注册（RFC 7591 的精简版：只收 **public client**）。
 *
 * **故意不要求登录**：MCP 客户端是在用户第一次连接时注册自己的，那一刻它还没有任何凭据。
 * 所以这里发出的 `client_id` 本身**不含权限** —— 真正的授权要用户在浏览器里登录后点「允许」，
 * 令牌也是发给那个用户的。上游有 `MAX_DYNAMIC_CLIENTS` 条数上限兜住刷量。
 *
 * 只回 RFC 7591 规定的那几项；不回 client_secret（公开客户端没有密钥）。
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export const POST = withPublic(async (request: NextRequest) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const client = await registerClient({
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
      source: "DCR",
    });
    await writeAuditEntry({
      action: "OAUTH_CLIENT_REGISTERED",
      details: {
        clientId: client.id,
        name: client.name,
        redirectUris: client.redirectUris,
        scope: "DCR",
        note: "MCP 客户端自助注册（还没有任何权限，授权要用户登录后点「允许」）。",
      },
    });
    return NextResponse.json(
      {
        client_id: client.id,
        client_name: client.name,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp.read",
      },
      { status: 201, headers: CORS_HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      { error: "invalid_client_metadata", error_description: error instanceof Error ? error.message : "注册失败。" },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});

export const OPTIONS = withPublic(async () => {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
});
