/**
 * MCP 协议版本：平台里两个 MCP 服务端共用同一个值。
 *
 * 平台有两个 MCP 服务端，职责不同、鉴权也不同：
 *   - `/api/mcp`：查**本体数据**，要平台会话或 `Authorization: Bearer <MCP_API_TOKEN>`。
 *   - `/api/skills/mcp`：发**建模方法**（本体技能），免令牌。
 *
 * 版本号单独放这一个文件，是为了让技能 MCP **不必 import `@/lib/reasoning/mcp`** ——
 * 那个模块会拉起图库与数据源驱动（Jena / oracledb / pg），而技能 MCP 只读几个 Markdown 文件，
 * 不该为了一个常量把整套驱动加载进一个公开端点。改协议版本只改这里。
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
