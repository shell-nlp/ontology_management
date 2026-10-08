#!/usr/bin/env node
/**
 * 命令行导入本体：把 bkn 知识网络（`module_type: knowledge_network`）或平台自己的本体包
 * 一次性导进平台，**一个请求搞定**，不用在界面上传、也不用一步一步建类型。
 *
 * 为什么要有它（2026-10-08 用户要求）：一个几百 KB 的 bkn 文件里有几十个对象类型、上千个属性，
 * 走对话/界面手工建一次要很久。这个脚本把整件事收敛成一条命令，服务端一次解析、一次绑定、一次落快照。
 *
 * 用法（Windows / Linux / macOS 通用，只要有 Node 18+，不装依赖、不联网到别处）：
 *
 *   node scripts/import-ontology.mjs <文件.json> --email <账号> --password <密码>
 *   node scripts/import-ontology.mjs <文件.json> --dry-run          # 只算不写：看清文件里到底有什么
 *   node scripts/import-ontology.mjs <文件.json> --storage-target 内置类型图 --name "新名字"
 *   node scripts/import-ontology.mjs <文件.json> --publish          # 导入后顺手发布
 *
 * 常用选项：
 *   --url <地址>            平台地址，默认 http://localhost:3000（也可用环境变量 ONTOLOGY_URL）
 *   --email / --password    登录账号（也可用 ONTOLOGY_EMAIL / ONTOLOGY_PASSWORD）
 *   --cookie <cookie>       跳过登录，直接用现成的会话 cookie（也可用 ONTOLOGY_COOKIE）
 *   --storage-target <值>   本体存储：id 或名字（省略时若只有一个存储就自动用它）
 *   --name <值>             导入时改名（默认用文件里的名字）
 *   --publish               导入后立刻发布（默认只建草稿，和界面导入一致）
 *   --json                  把服务端响应的 JSON 原样打出来
 *   --quiet                 只在出错时说话
 *   --timeout <秒>          单次请求超时，默认 300 秒
 *
 * 退出码：0 成功；1 失败（登录 / 请求 / 导入报错）；2 用法不对。
 *
 * 导入**默认停在草稿**（不发布、不碰图库）：先到「本体建模」看一眼校验与提醒，再决定发布；
 * 想一步到位就加 `--publish`（那会真正重建图数据）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

class UsageError extends Error {}

function printHelp() {
  console.log([
    "命令行导入本体（bkn 知识网络 / ontology.bundle）",
    "",
    "用法：node scripts/import-ontology.mjs <文件.json> [选项]",
    "",
    "选项：",
    "      --url <地址>          平台地址（默认 http://localhost:3000，或环境变量 ONTOLOGY_URL）",
    "      --email <邮箱>        登录账号（或 ONTOLOGY_EMAIL）",
    "      --password <密码>     登录密码（或 ONTOLOGY_PASSWORD）",
    "      --cookie <cookie>     直接用会话 cookie，跳过登录（或 ONTOLOGY_COOKIE）",
    "      --storage-target <值> 本体存储的 id 或名字（省略时若只有一个就自动用它）",
    "      --target <值>         同上",
    "      --name <值>           导入时改名（默认用文件里的名字）",
    "      --dry-run             只算不写：解析 + 转换 + 绑定 + 统计，不建本体",
    "      --publish             导入后立刻发布（默认只建草稿）",
    "      --json                打印服务端返回的原始 JSON",
    "  -q, --quiet               只在出错时说话",
    "      --timeout <秒>        单次请求超时，默认 300",
    "  -h, --help                看这段说明",
    "",
    "例子：",
    "  node scripts/import-ontology.mjs telecom.json --dry-run",
    "  node scripts/import-ontology.mjs telecom.json --email admin@example.com --password '******'",
    "  node scripts/import-ontology.mjs telecom.json --storage-target 内置类型图 --name \"客户账务网络 v6\" --publish",
  ].join("\n"));
}

function parseArgs(argv) {
  const options = {
    file: "",
    url: process.env.ONTOLOGY_URL?.trim() || "http://localhost:3000",
    email: process.env.ONTOLOGY_EMAIL?.trim() || "",
    password: process.env.ONTOLOGY_PASSWORD || "",
    cookie: process.env.ONTOLOGY_COOKIE?.trim() || "",
    target: "",
    name: "",
    dryRun: false,
    publish: false,
    json: false,
    quiet: false,
    timeoutMs: 300_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} 后面要跟一个值。`);
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") { printHelp(); process.exit(EXIT_OK); }
    else if (arg === "--url") options.url = next();
    else if (arg === "--email") options.email = next();
    else if (arg === "--password") options.password = next();
    else if (arg === "--cookie") options.cookie = next();
    else if (arg === "--storage-target" || arg === "--target") options.target = next();
    else if (arg === "--name") options.name = next();
    else if (arg === "--dry-run" || arg === "--dryrun") options.dryRun = true;
    else if (arg === "--publish") options.publish = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet" || arg === "-q") options.quiet = true;
    else if (arg === "--timeout") {
      const seconds = Number(next());
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout 要一个正数（秒）。");
      options.timeoutMs = Math.round(seconds * 1000);
    } else if (arg.startsWith("-")) throw new UsageError(`未知选项：${arg}`);
    else if (options.file) throw new UsageError("一次只能导一个文件。");
    else options.file = arg;
  }
  options.url = options.url.replace(/\/+$/, "");
  if (!options.file) throw new UsageError("要传一个文件，例如：node scripts/import-ontology.mjs telecom.json");
  if (!options.cookie && !(options.email && options.password)) {
    throw new UsageError("要能登录：给 --email 和 --password（或 ONTOLOGY_EMAIL / ONTOLOGY_PASSWORD），或者直接给 --cookie。");
  }
  return options;
}

/** 读文件并解析 JSON；BOM 与"这不是 JSON"都给一句人话。 */
function readJsonFile(file) {
  const resolved = path.resolve(file);
  let text;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    throw new Error(`读不了文件：${resolved}（${error instanceof Error ? error.message : "未知错误"}）`);
  }
  const cleaned = text.replace(/^\uFEFF/, "");
  try {
    return { resolved, raw: JSON.parse(cleaned) };
  } catch (error) {
    throw new Error(`这个文件不是 JSON：${resolved}（${error instanceof Error ? error.message : "解析失败"}）`);
  }
}

/** 从 set-cookie 头里抠出所有 cookie，拼成请求头用的 Cookie 串。 */
function cookieHeaderFrom(response) {
  const list = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
  return list.map((item) => item.split(";")[0]).filter(Boolean).join("; ");
}

async function requestJson(url, { method = "GET", cookie, body, timeoutMs, what }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? `超时（${Math.round(timeoutMs / 1000)} 秒）` : (error instanceof Error ? error.message : String(error));
    throw new Error(`${what}失败：连不上 ${url}（${reason}）`);
  }
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const detail = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : text.slice(0, 300);
    throw new Error(`${what}失败：HTTP ${response.status}${detail ? ` · ${detail}` : ""}`);
  }
  return { response, payload, cookie: cookieHeaderFrom(response) };
}

/** 按 id → 名字 → 唯一子串 的顺序挑一个存储；挑不出来就把候选列给人看（`taken` = 已被本体占用的存储数）。 */
function pickTarget(targets, wanted, taken = 0) {
  const list = Array.isArray(targets) ? targets : [];
  const hint = taken ? `（另外 ${taken} 个存储已经被别的本体占用，不能重复导入）` : "";
  if (!list.length) throw new Error(`平台上没有可用的本体存储${hint}：到「设置 → 图引擎配置」加一个再导。`);
  const trimmed = wanted.trim();
  if (trimmed) {
    const byId = list.find((item) => item.id === trimmed);
    if (byId) return byId;
    const exact = list.filter((item) => String(item.name).trim() === trimmed);
    if (exact.length === 1) return exact[0];
    const partial = list.filter((item) => String(item.name).includes(trimmed));
    if (partial.length === 1) return partial[0];
    const names = list.map((item) => `${item.name}（${item.id}）`).join("；");
    throw new Error(`${partial.length ? "名字匹配到多个" : "没找到"}存储「${trimmed}」。现有：${names}`);
  }
  if (list.length === 1) return list[0];
  const names = list.map((item) => `${item.name}（${item.id}）`).join("；");
  throw new UsageError(`有多个可用存储，用 --storage-target 指定一个${hint}：${names}`);
}

function formatSeconds(ms) {
  return `${(Number(ms ?? 0) / 1000).toFixed(2)}s`;
}

function printSummary(result, options) {
  const say = (line) => { if (!options.quiet) console.log(line); };
  if (result.dryRun) {
    const counts = result.counts ?? {};
    say("— dry-run（只算不写，没有建任何东西）—");
    say(`格式：${result.sourceFormat}`);
    say(`本体名：${result.ontology?.name ?? "（未命名）"}${result.ontology?.identifier ? ` · ${result.ontology.identifier}` : ""}`);
    say(`内容：${counts.objectTypes ?? 0} 个对象类型（${counts.properties ?? 0} 个属性）· ${counts.relationTypes ?? 0} 个关系类型 · ${counts.interfaces ?? 0} 个接口 · ${counts.metrics ?? 0} 个指标 · ${counts.groups ?? 0} 个概念分组 · ${counts.actionTypes ?? 0} 个动作 · ${counts.rules ?? 0} 条规则`);
    if (result.pendingSources?.length) say(`待绑定来源：${result.pendingSources.length} 处（导入后在界面上选数据资源）`);
    say(`耗时：解析 ${formatSeconds(result.timings?.parse_ms)} · 规划 ${formatSeconds(result.timings?.plan_ms)} · 绑定 ${formatSeconds(result.timings?.bind_ms)} · 合计 ${formatSeconds(result.timings?.total_ms)}`);
  } else {
    say(`已导入：${result.ontology?.name ?? "（未命名）"}`);
    say(`本体 id：${result.ontology?.id ?? "?"}`);
    say(`草稿版本：${result.versionId ?? "?"}（对象 ${result.entityCount ?? 0} · 关系 ${result.relationshipCount ?? 0}）`);
    say(`耗时：解析 ${formatSeconds(result.timings?.parse_ms)} · 规划 ${formatSeconds(result.timings?.plan_ms)} · 绑定 ${formatSeconds(result.timings?.bind_ms)} · 建快照 ${formatSeconds(result.timings?.create_ms)} · 合计 ${formatSeconds(result.timings?.total_ms)}`);
  }
  if (result.warnings?.length) {
    say(`提醒 ${result.warnings.length} 条：`);
    for (const warning of result.warnings) say(`  · ${warning}`);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    // `--help` 已经打完用法：正常收尾，不要再往下走。
    if (!options) return;
  } catch (error) {
    console.error(error instanceof UsageError ? `用法不对：${error.message}` : String(error));
    console.error("用 --help 看用法。");
    process.exitCode = EXIT_USAGE;
    return;
  }

  const say = (line) => { if (!options.quiet) console.log(line); };

  let cookie = options.cookie;
  try {
    if (!cookie) {
      const login = await requestJson(`${options.url}/api/auth/login`, {
        method: "POST",
        body: { email: options.email, password: options.password },
        timeoutMs: options.timeoutMs,
        what: "登录",
      });
      cookie = login.cookie;
      if (!cookie) throw new Error("登录成功但没有拿到会话 cookie。");
      say(`已登录：${login.payload?.email ?? options.email}`);
    }

    /*
     * 候选存储 = 还没被任何本体占用的那些。每个本体在自己的存储上占一行，
     * 把已有本体的存储再拿来导入会撞唯一键 —— 界面上看不见的坑，这里先替用户挡掉。
     */
    const [targets, ontologies] = await Promise.all([
      requestJson(`${options.url}/api/targets`, { cookie, timeoutMs: options.timeoutMs, what: "读取本体存储" }),
      requestJson(`${options.url}/api/ontologies`, { cookie, timeoutMs: options.timeoutMs, what: "读取本体列表" }),
    ]);
    const used = new Set((Array.isArray(ontologies.payload) ? ontologies.payload : []).map((item) => item.target_id).filter(Boolean));
    const available = (Array.isArray(targets.payload) ? targets.payload : []).filter((item) => !used.has(item.id));
    const target = pickTarget(available, options.target, used.size);
    say(`本体存储：${target.name}（${target.kind ?? target.kindLabel ?? ""}）`);

    const { resolved, raw } = readJsonFile(options.file);
    say(`文件：${resolved}`);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const kind = typeof raw.module_type === "string" ? raw.module_type : (typeof raw.format === "string" ? raw.format : "未知格式");
      say(`看起来是：${raw.name ? `「${raw.name}」` : "（没有名字）"} · ${kind}`);
    }
    say(options.dryRun ? "开始 dry-run（不写任何数据）…" : "开始导入…");

    const result = await requestJson(`${options.url}/api/ontologies/import`, {
      method: "POST",
      cookie,
      timeoutMs: options.timeoutMs,
      what: options.dryRun ? "dry-run" : "导入",
      body: {
        bundle: raw,
        storageTargetId: target.id,
        ...(options.name ? { name: options.name } : {}),
        ...(options.dryRun ? { dryRun: true } : {}),
      },
    });

    if (options.json) console.log(JSON.stringify(result.payload, null, 2));
    else printSummary(result.payload ?? {}, options);

    if (options.publish && !options.dryRun) {
      const versionId = result.payload?.versionId;
      if (!versionId) throw new Error("导入结果里没有版本 id，无法发布。");
      const published = await requestJson(`${options.url}/api/ontology/${versionId}/publish`, {
        method: "POST",
        cookie,
        timeoutMs: options.timeoutMs,
        what: "发布",
      });
      const body = published.payload ?? {};
      if (body.published) {
        say(`已发布：${body.entityCount ?? 0} 个对象、${body.relationshipCount ?? 0} 条关系已重建。`);
      } else {
        const violations = (body.violations ?? []).map((item) => `${item.message}${item.count ? `（${item.count}）` : ""}`).join("；");
        console.error(`发布被拦下了：${violations || "见服务端返回"}`);
        process.exitCode = EXIT_FAIL;
        return;
      }
    } else if (!options.dryRun) {
      say("下一步：到「本体建模」看一眼校验与提醒，确认后再发布（或下次加 --publish）。");
    }
    process.exitCode = EXIT_OK;
  } catch (error) {
    console.error(error instanceof UsageError ? `用法不对：${error.message}` : (error instanceof Error ? error.message : String(error)));
    if (error instanceof UsageError) { console.error("用 --help 看用法。"); process.exitCode = EXIT_USAGE; return; }
    process.exitCode = EXIT_FAIL;
  }
}

void main();
