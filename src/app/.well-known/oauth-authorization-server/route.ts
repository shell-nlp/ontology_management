import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "@/lib/framework/public-origin";
import { authorizationServerMetadata } from "@/lib/oauth/metadata";

/**
 * 授权服务器元数据（RFC 8414）。
 *
 * 外部 MCP 客户端第一步就读它，从中拿到授权端点、令牌端点与注册端点 ——
 * 这几个地址都用**客户端实际访问的地址**拼（代理后面不能落回服务端自己的 localhost）。
 * 这里只是"告诉别人去哪儿授权"，不含任何鉴权判断。
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function GET(request: NextRequest) {
  return NextResponse.json(authorizationServerMetadata(publicOrigin(request)), { headers: CORS_HEADERS });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
