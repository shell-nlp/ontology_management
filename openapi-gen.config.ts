/**
 * OpenAPI 文档的生成配置（next-openapi-gen，devDependency：只在生成时用，不进运行时）。
 *
 * `pnpm openapi` 会扫 `src/app/api` 下每个 `route.ts` 与其中的 zod schema，产出：
 * - `public/openapi.json`：机器可读的接口契约（文档页面读它，也能喂给 SDK 生成器）；
 * - `public/swagger-ui/*`：文档页面用的静态资源（自托管，不连 CDN，内网/容器里都能开）。
 * 文档页面本身是手写的：`src/app/docs/route.ts`（访问路径 `/docs`）。
 *
 * 生成之后还有一道本地化（`scripts/openapi-build.mjs`）：把按路径推出来的英文分组换成平台的中文分组、
 * 声明会话 Cookie 与 MCP 令牌两套鉴权、给每个接口补一个兜底的成功响应。
 * **能在这里表达的（标题、服务器、错误响应形状）就别写进那个脚本**。
 */
export default {
  openapi: "3.0.0",
  info: {
    title: "本体管理平台 API",
    version: "1.0.0",
    description: [
      "本体建模、本体实例、数据资源与能力验证的 HTTP 接口。",
      "",
      "全部接口挂在 `/api` 下。除登录、首次初始化与「本体技能 MCP」外，都需要平台会话 Cookie；",
      "`/api/mcp` 额外接受 `Authorization: Bearer <MCP_API_TOKEN>`。",
      "请求体由各路由里的 zod schema 推断，响应体是手写对象、暂时没有 schema（页面上给的是通用 200）。",
    ].join("\n"),
  },
  // 相对地址：本机 3001、容器里的 3000、内网 IP 访问都跟着实际地址走，不写死 host。
  servers: [{ url: "/api", description: "当前部署" }],
  apiDir: "./src/app/api",
  schemaDir: "./src",
  routerType: "app",
  framework: { kind: "nextjs", router: "app" },
  schemaType: "zod",
  outputFile: "openapi.json",
  outputDir: "./public",
  // 失败响应的形状：路由里统一是 `{ error: "..." }`（见 apiErrorMessage / describeApiError 那一对）。
  defaultResponseSet: "common",
  responseSets: { common: ["400", "500"] },
  errorConfig: {
    template: {
      type: "object",
      properties: { error: { type: "string", example: "{{ERROR_MESSAGE}}" } },
    },
    codes: {
      "400": { description: "请求不合法", variables: { ERROR_MESSAGE: "请求参数不合法。" } },
      "401": { description: "未登录或会话已过期", variables: { ERROR_MESSAGE: "未授权。" } },
      "403": { description: "权限不足", variables: { ERROR_MESSAGE: "当前账号没有这个权限。" } },
      "404": { description: "资源不存在", variables: { ERROR_MESSAGE: "资源不存在。" } },
      "500": { description: "服务端错误", variables: { ERROR_MESSAGE: "服务端处理失败。" } },
    },
  },
  diagnostics: { enabled: true },
  ignoreRoutes: [],
};
