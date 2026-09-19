/**
 * 生成 OpenAPI 之后的两件事（`pnpm openapi` 里的第二步）：
 *
 * 1. **本地化 `public/openapi.json`** —— 生成器只能按路径首段推出英文分组（Ontology / Targets…），
 *    这里换成平台自己的中文分组；再把两套鉴权（会话 Cookie、MCP 令牌）声明上，
 *    给每个接口补一个兜底的成功响应（我们的响应体是手写对象，没有 schema）。
 * 2. **自托管文档页面的静态资源** —— 从 devDependency `swagger-ui-dist` 拷 js/css/图标到
 *    `public/swagger-ui/`。不这么做，文档页就只能从 CDN 拉前端 bundle，内网/容器里会白屏。
 *
 * 只用 Node 内置模块（和 `skills/ontology-bundle/scripts/*` 一个路子：不装额外依赖、不联网）。
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "..");
const specPath = path.join(root, "public", "openapi.json");
const uiDir = path.join(root, "public", "swagger-ui");

/** 生成器按路径首段推出来的分组 → 平台自己的分组名（与左侧导航一致）。 */
const TAG_RENAME = new Map([
  ["Ontology", "本体模型"],
  ["Ontologies", "本体管理"],
  ["Instances", "本体实例"],
  ["Object-search", "检索与查询"],
  ["Query", "检索与查询"],
  ["Reasoning", "能力验证"],
  ["Mcp", "能力验证 · MCP"],
  ["Skills", "本体技能"],
  ["Data-sources", "数据资源"],
  ["Targets", "图引擎配置"],
  ["Auth", "平台"],
  ["Bootstrap", "平台"],
]);

/** 分组在文档里的顺序（不列出来的排后面，按名字排）。 */
const TAG_ORDER = ["本体模型", "本体管理", "本体实例", "检索与查询", "数据资源", "能力验证", "能力验证 · MCP", "本体技能", "图引擎配置", "平台"];

const TAG_DESCRIPTION = {
  本体模型: "本体建模画布：对象类型、关系类型、接口、概念分组，以及草稿的校验与发布。",
  本体管理: "本体的创建、导入导出，以及按本体隔离的存储。",
  本体实例: "实例图谱里的对象与关系：节点、边、位置与检索。",
  检索与查询: "对象检索索引，以及只读图查询（SPARQL / Cypher 由存储后端决定）。",
  数据资源: "业务数据源连接与结构读取：库、表、视图、字段。",
  能力验证: "智能问答、工具调用与对话历史。",
  "能力验证 · MCP": "把本体数据以 MCP 暴露给外部 Agent（会话 Cookie 或 MCP 令牌）。",
  本体技能: "建模方法论 Skill 的清单与整体下载。",
  图引擎配置: "本体存储（内置类型图 / Jena）的连接与维护。",
  平台: "登录、会话与首次初始化。",
};

/** 不需要会话的接口：登录/登出/会话探测、首次初始化，以及免令牌的技能 MCP。 */
const PUBLIC_PATHS = ["/auth/login", "/auth/logout", "/auth/session", "/bootstrap", "/skills/mcp"];
/** 会话 Cookie 与 MCP 令牌二选一：面向外部 Agent 的 MCP 端点。 */
const SESSION_OR_TOKEN_PATHS = ["/mcp", "/mcp/info"];

const SWAGGER_FILES = ["swagger-ui.css", "swagger-ui-bundle.js", "swagger-ui-standalone-preset.js", "favicon-16x16.png", "favicon-32x32.png"];

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

/** 只遍历真正的操作对象：路径项里还可能有 parameters / summary 这些非操作字段。 */
function* operationsOf(document) {
  for (const [route, item] of Object.entries(document.paths ?? {})) {
    for (const method of METHODS) if (item?.[method]) yield { route, method, operation: item[method] };
  }
}

function fail(message) {
  process.stderr.write(`✗ ${message}\n`);
  process.exit(1);
}

/** 把生成出来的英文分组换成中文分组，并按固定顺序写出分组说明。 */
function localizeTags(document) {
  const used = new Set();
  for (const { operation } of operationsOf(document)) {
    if (!Array.isArray(operation.tags)) continue;
    operation.tags = [...new Set(operation.tags.map((tag) => TAG_RENAME.get(tag) ?? tag))];
    for (const tag of operation.tags) used.add(tag);
  }
  const ordered = [...used].sort((a, b) => {
    const left = TAG_ORDER.indexOf(a);
    const right = TAG_ORDER.indexOf(b);
    if (left >= 0 && right >= 0) return left - right;
    if (left >= 0) return -1;
    if (right >= 0) return 1;
    return a.localeCompare(b);
  });
  document.tags = ordered.map((name) => ({ name, description: TAG_DESCRIPTION[name] ?? "" }));
  return ordered.length;
}

/**
 * 每个接口都要有成功响应，否则文档页只列 400/500，看着像坏了。
 * 响应体没有 schema（路由返回的是手写对象），所以给一个通用 200 并说明清楚。
 */
function ensureSuccessResponses(document) {
  let added = 0;
  for (const { operation } of operationsOf(document)) {
    const responses = operation.responses;
    if (!responses) continue;
    if (Object.keys(responses).some((code) => /^2\d\d$/.test(code))) continue;
    responses["200"] = {
      description: "成功（响应体字段以实际返回为准，暂未声明 schema）",
      content: { "application/json": { schema: { type: "object", additionalProperties: true } } },
    };
    added += 1;
  }
  return added;
}

/** 两套鉴权：平台会话 Cookie 是默认，外部 Agent 可以改用 MCP 令牌。 */
function declareSecurity(document) {
  document.components = document.components ?? {};
  document.components.securitySchemes = {
    SessionCookie: {
      type: "apiKey",
      in: "cookie",
      name: "ontology_session",
      description: "平台登录后浏览器自带的会话 Cookie（文档页的 Try it out 用的就是它）。",
    },
    McpToken: {
      type: "http",
      scheme: "bearer",
      description: "外部 MCP 客户端用：Authorization: Bearer <MCP_API_TOKEN>。",
    },
  };
  document.security = [{ SessionCookie: [] }];
  for (const { route, operation } of operationsOf(document)) {
    const security = PUBLIC_PATHS.includes(route)
      ? []
      : SESSION_OR_TOKEN_PATHS.includes(route)
        ? [{ SessionCookie: [] }, { McpToken: [] }]
        : [{ SessionCookie: [] }];
    operation.security = security;
  }
}

/**
 * 清掉生成器造的垃圾 schema：`request.json()` 这种没有类型可推断的地方，它会塞一个名为 `JSON` 的空 schema
 * （`{}`），在文档的 Schemas 列表里就是一条看不懂的条目。只删**既空又没人引用**的，其他一律留着。
 */
function pruneEmptyUnreferencedSchemas(document) {
  const schemas = document.components?.schemas;
  if (!schemas) return 0;
  const referenced = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.$ref === "string") referenced.add(node.$ref.split("/").pop());
    for (const value of Object.values(node)) walk(value);
  };
  walk(document);
  let removed = 0;
  for (const [name, schema] of Object.entries(schemas)) {
    const empty = schema && typeof schema === "object" && Object.keys(schema).length === 0;
    if (empty && !referenced.has(name)) {
      delete schemas[name];
      removed += 1;
    }
  }
  return removed;
}

/** 文档页的前端资源从 devDependency 拷进 public/：内网部署照样能打开。 */
async function copySwaggerUi() {
  const distDir = path.dirname(require.resolve("swagger-ui-dist"));
  await mkdir(uiDir, { recursive: true });
  for (const file of SWAGGER_FILES) await copyFile(path.join(distDir, file), path.join(uiDir, file));
  return SWAGGER_FILES.length;
}

const raw = await readFile(specPath, "utf8").catch(() => fail(`读不到 ${path.relative(root, specPath)}：先生成一次（pnpm openapi）。`));
let document;
try {
  document = JSON.parse(raw);
} catch (error) {
  fail(`${path.relative(root, specPath)} 不是合法 JSON：${error.message}`);
}

const tagCount = localizeTags(document);
const addedResponses = ensureSuccessResponses(document);
declareSecurity(document);
const pruned = pruneEmptyUnreferencedSchemas(document);
const copied = await copySwaggerUi();
await writeFile(specPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");

const operations = Object.values(document.paths ?? {}).reduce((sum, item) => sum + Object.keys(item).length, 0);
process.stdout.write(
  `✓ 接口文档已就绪：${Object.keys(document.paths ?? {}).length} 个路径 / ${operations} 个操作 / ${tagCount} 个分组`
  + `（补了 ${addedResponses} 个成功响应，清掉 ${pruned} 个空 schema，拷贝 ${copied} 个 Swagger UI 资源）\n`
  + `  打开 /docs 看文档，契约在 /openapi.json\n`,
);
