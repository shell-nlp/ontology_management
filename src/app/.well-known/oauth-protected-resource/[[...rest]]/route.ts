import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "@/lib/shared/server/public-origin";
import { protectedResourceMetadata } from "@/lib/oauth/metadata";
import { oauthProvider } from "@/lib/oauth/provider";

/**
 * 受保护资源元数据（RFC 9728）：MCP 客户端拿到 401 后读它，才知道令牌该找谁要。
 *
 * 路径有两种写法，都要认：
 * - `/.well-known/oauth-protected-resource` —— 直接在源站根上问；
 * - `/.well-known/oauth-protected-resource/api/mcp` —— 规范里"把 well-known 插在资源路径前面"的写法。
 * 所以这里用可选 catch-all 接住后面那一段；我们只有 `/api/mcp` 一个受保护资源，多出来的段一概忽略。
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function GET(request: NextRequest) {
  const origin = publicOrigin(request);
  const provider = oauthProvider();
  return NextResponse.json(protectedResourceMetadata(origin, provider.authorizationServer(origin)), { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
