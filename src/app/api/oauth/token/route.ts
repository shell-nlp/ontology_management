import { NextRequest, NextResponse } from "next/server";
import { exchangeToken, OAuthError } from "@/lib/oauth/authorize";

/**
 * 令牌端点：`authorization_code` 与 `refresh_token` 两种 grant。
 *
 * 收 `application/x-www-form-urlencoded`（OAuth 标准写法，几乎所有客户端都这么发）
 * 也收 JSON（方便我们自己用脚本排障）。响应**绝不能被缓存**。
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-store",
};

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await request.json().catch(() => ({}));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  }
  const form = new URLSearchParams(await request.text());
  return Object.fromEntries(form.entries());
}

export async function POST(request: NextRequest) {
  try {
    const token = await exchangeToken(await readBody(request));
    return NextResponse.json(token, { headers: CORS_HEADERS });
  } catch (error) {
    if (error instanceof OAuthError) {
      return NextResponse.json({ error: error.code, error_description: error.message }, { status: 400, headers: CORS_HEADERS });
    }
    return NextResponse.json(
      { error: "server_error", error_description: error instanceof Error ? error.message : "换令牌时出错。" },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
