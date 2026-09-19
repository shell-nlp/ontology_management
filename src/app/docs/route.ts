/**
 * GET /docs：接口文档页（Swagger UI，和 FastAPI 默认那套是同一个 UI）。
 *
 * 为什么手写这个页面、而不是用生成器自带的 UI 脚手架：那套默认从 CDN 拉前端 bundle，
 * 内网/容器里会白屏。这里的 JS/CSS 全是自托管静态资源（`public/swagger-ui/`，
 * 由 `scripts/openapi-build.mjs` 从 devDependency `swagger-ui-dist` 拷过来），不连外网。
 *
 * 文档页本身不要求登录：它只是"有哪些接口"的说明书，不含任何业务数据。
 * 页面上「Try it out」调接口时用的还是浏览器里已有的会话 Cookie，该 401 还是 401。
 */
const PAGE = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>本体管理平台 API 文档</title>
    <link rel="icon" type="image/png" sizes="32x32" href="/swagger-ui/favicon-32x32.png" />
    <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f7f9fc; }
      /* 顶部自带的 Swagger 品牌条与本平台的壳子不搭，隐藏掉，换成平台自己的页眉。 */
      .swagger-ui .topbar { display: none; }
      .docs-head { display: flex; align-items: baseline; gap: 10px; padding: 16px 24px 13px; background: #fff; border-bottom: 1px solid #dfe7f1; }
      .docs-head h1 { margin: 0; color: #14213d; font-family: Georgia, "Noto Serif SC", serif; font-size: 19px; font-weight: 600; }
      .docs-head span { color: #8b9ab0; font-size: 12px; }
      .swagger-ui .scheme-container { background: #fff; box-shadow: none; border-bottom: 1px solid #e6ecf4; }
      .swagger-ui .info { margin: 24px 0; }
      .swagger-ui .info .title { color: #14213d; font-family: Georgia, "Noto Serif SC", serif; }
      .swagger-ui .opblock-tag { font-size: 18px; }
    </style>
  </head>
  <body>
    <div class="docs-head">
      <h1>本体管理平台 API</h1>
      <span>OpenAPI 3.0 · Swagger UI</span>
    </div>
    <div id="swagger-ui"></div>
    <script src="/swagger-ui/swagger-ui-bundle.js"></script>
    <script src="/swagger-ui/swagger-ui-standalone-preset.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        filter: true,
        docExpansion: "list",
        defaultModelsExpandDepth: 1,
        persistAuthorization: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: "StandaloneLayout",
      });
    </script>
  </body>
</html>
`;

export function GET() {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // 契约与页面都跟着 `pnpm openapi` 变，别让浏览器缓存住上一版。
      "cache-control": "no-store",
    },
  });
}
