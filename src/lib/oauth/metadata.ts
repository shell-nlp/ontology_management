import { MCP_SCOPE, SUPPORTED_SCOPES } from "@/lib/oauth/rules";

/**
 * 两份发现文档的内容（RFC 9728 受保护资源 + RFC 8414 授权服务器）。
 *
 * 这两份是**唯一**告诉外部客户端"该找谁要令牌"的地方，所以它们必须是可拼的纯函数：
 * 换授权服务器（比如以后接企业统一认证）只要改这里喂进来的地址，客户端不用动。
 */

/** MCP 端点的路径：protected-resource 元数据里的 `resource` 就是它。 */
export const MCP_RESOURCE_PATH = "/api/mcp";
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** 受保护资源元数据：客户端拿到 401 后先读它，才知道授权服务器是谁、要什么范围。 */
export function protectedResourceMetadata(origin: string, authorizationServer: string) {
  return {
    resource: origin + MCP_RESOURCE_PATH,
    authorization_servers: [authorizationServer],
    scopes_supported: [...SUPPORTED_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "本体管理平台 MCP 服务",
    resource_documentation: origin + "/",
  };
}

/** 授权服务器元数据：客户端据此找授权端点、令牌端点与注册端点。 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/api/oauth/authorize",
    token_endpoint: origin + "/api/oauth/token",
    registration_endpoint: origin + "/api/oauth/register",
    scopes_supported: [...SUPPORTED_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // 只认 S256：见 @/lib/oauth/pkce 的说明。
    code_challenge_methods_supported: ["S256"],
    // 公开客户端：没有 client_secret，客户端身份靠回调地址精确匹配 + PKCE。
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: origin + "/",
  };
}

/**
 * 401 上那个 `WWW-Authenticate` 头。
 *
 * MCP 客户端就是靠这一行知道"这儿要 OAuth、元数据在哪"的；少了它，客户端只会报"未授权"。
 * （另一个更省事的办法是让用户手工填客户端 id —— 但那就不是"能自动接上"了。）
 */
export function unauthorizedHeader(origin: string): string {
  return "Bearer resource_metadata=\"" + origin + PROTECTED_RESOURCE_PATH + "\", scope=\"" + MCP_SCOPE + "\"";
}
