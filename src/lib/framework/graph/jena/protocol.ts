import { BKN_NODE_PREFIX, SparqlTerm, SparqlEndpoints, NtTerm } from "./vocabulary";
import { decryptSecret } from "@/lib/framework/crypto";
import { escapeSparqlStringLiteral, valueFromSparqlLiteral } from "@/lib/framework/graph/schema-inference";
import { type GraphTarget } from "@/lib/framework/graph/types";

export function optionText(target: GraphTarget, key: string) {
  const value = target.options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * 解析 `GRAPH_ENDPOINT_HOST_ALIAS`：形如 `localhost=host.docker.internal` 或 `a:3030=b:3030`，
 * 多条用逗号分隔。左边是库里登记的主机名（大小写不敏感），右边是要换成的目标。
 */
export function parseHostAliases(value: string | undefined) {
  const aliases = new Map<string, string>();
  for (const entry of (value ?? "").split(",")) {
    const [from, to] = entry.split("=");
    const key = from?.trim().toLowerCase() ?? "";
    const target = to?.trim() ?? "";
    if (key && target) aliases.set(key, target);
  }
  return aliases;
}

/**
 * 端点主机名改写：`GRAPH_ENDPOINT_HOST_ALIAS`。
 *
 * 库里登记的端点是**按某一种运行环境写的**：本机开发服务写 `http://localhost:3030`
 * （宿主机上的 Fuseki）。而同一份数据在容器里看，`localhost` 是容器自己 —— 于是同一个平台库
 * 在宿主机和容器里要两条不同的地址，来回切很别扭。
 *
 * 与其让用户为容器再登记一条，不如在部署侧声明"A 换成 B"：容器里设
 * `GRAPH_ENDPOINT_HOST_ALIAS=localhost=host.docker.internal`（可选 Jena 服务在宿主机上），
 * 容器仍能复用原登记；其他地址可按部署环境配置。只改主机与端口，协议与路径不动。
 */
export function applyEndpointHostAlias(uri: string, alias: string | undefined = process.env.GRAPH_ENDPOINT_HOST_ALIAS) {
  const aliases = parseHostAliases(alias);
  if (!aliases.size) return uri;
  try {
    const url = new URL(uri);
    const replacement = aliases.get(url.hostname.toLowerCase());
    if (!replacement) return uri;
    // 允许写成 `主机:端口`；只写主机时保留原来的端口。
    if (replacement.includes(":")) url.host = replacement;
    else url.hostname = replacement;
    return url.toString();
  } catch {
    // 不是合法 URL 就原样返回：让原有的报错路径去说"连不上这个端点"，别在这里换一种说法。
    return uri;
  }
}

/** Fuseki 端点命名规则：/ds/query、/ds/update，或统一端点 /ds/sparql。 */
export function resolveSparqlEndpoints(target: GraphTarget): SparqlEndpoints {
  const dataset = target.database_name?.trim() || "ds";
  const trimmed = applyEndpointHostAlias(target.uri).trim().replace(/\/+$/, "");
  const endpointLike = /\/(sparql|query|update)$/i.test(trimmed);
  const base = endpointLike || trimmed.endsWith(`/${dataset}`) ? trimmed : `${trimmed}/${dataset}`;
  const derive = (kind: "query" | "update") => {
    if (/\/sparql$/i.test(base)) return base;
    if (/\/(query|update)$/i.test(base)) return base.replace(/\/(query|update)$/i, `/${kind}`);
    return `${base}/${kind}`;
  };
  const queryOption = optionText(target, "queryEndpoint");
  const updateOption = optionText(target, "updateEndpoint");
  return {
    query: queryOption ? applyEndpointHostAlias(queryOption) : derive("query"),
    update: updateOption ? applyEndpointHostAlias(updateOption) : derive("update"),
    dataset,
    namedGraph: optionText(target, "namedGraph"),
  };
}

/**
 * 工作台查询用的端点：把这个本体的命名图设成**这次查询的默认图**（SPARQL 协议参数）。
 *
 * 为什么必须有这一层：用户在「图谱」页写的往往是裸 `?s ?p ?o`，里面没有 GRAPH。
 * 不限定数据集的话，这类查询读的是 Fuseki 的默认图 —— 而默认图里放的是**没有配命名图
 * 的那个本体**的数据，表现出来就是"别的本体的数据跑进来了"。
 *
 * 同时把命名图登记成 named-graph-uri，这样 `GRAPH <自己的图>` 与 `GRAPH ?g` 仍然可用，
 * 但数据集里只有这一个图，读不到别人的。
 *
 * 注意这一层只加在**用户查询**上：适配器自己的读路径（readGraph / hydrateNodes 等）
 * 用的是内联 `GRAPH <图>` 写法，已经是隔离的，不需要也不应该重复限定。
 */
export function scopedQueryUrl(endpoints: SparqlEndpoints) {
  if (!endpoints.namedGraph) return endpoints.query;
  const separator = endpoints.query.includes("?") ? "&" : "?";
  const params = `default-graph-uri=${encodeURIComponent(endpoints.namedGraph)}&named-graph-uri=${encodeURIComponent(endpoints.namedGraph)}`;
  return `${endpoints.query}${separator}${params}`;
}

export function authorizationHeader(target: GraphTarget) {
  if (!target.username) return undefined;
  const password = target.credential_secret ? decryptSecret(target.credential_secret) : "";
  return `Basic ${Buffer.from(`${target.username}:${password}`).toString("base64")}`;
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** 对象 id -> 裸主语项（不含尖括号）。应用写入的节点固定用 urn:bkn:node:<uuid>。 */
export function termForId(id: string) {
  if (id.startsWith("_:")) return id;
  if (isUuid(id)) return `${BKN_NODE_PREFIX}${id}`;
  return id;
}

export function nodeIdFromTerm(term: string) {
  return term.startsWith(BKN_NODE_PREFIX) ? term.slice(BKN_NODE_PREFIX.length) : term;
}

export function termToken(term: string) {
  return term.startsWith("_:") ? term : `<${term}>`;
}

/** IRI -> 显示名（local name），同时兼容 urn:bkn:class:指标 与 http://x#Person。 */
export function localName(iri: string) {
  const last = iri.slice(Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/")) + 1);
  const withoutScheme = last.includes(":") ? last.slice(last.lastIndexOf(":") + 1) : last;
  const candidate = withoutScheme || last || iri;
  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

/**
 * 名称 -> IRI 片段：转义 IRI 非法字符，同时保留中文等可读字符。
 * `#` / `/` / `?` / `%` 虽然不是 IRI 非法字符，但会破坏 localName 的反向解析，
 * 所以一并转义，保证「名称 -> IRI -> 名称」可逆。
 */
export function iriSegment(name: string) {
  return name.replace(/[ <>{}|^"`\\\u0000-\u001F#?/%]/g, (character) => encodeURIComponent(character));
}

export function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

export function sparqlString(value: string) {
  return `"${escapeSparqlStringLiteral(value)}"`;
}

export function sparqlParameterTerm(value: unknown): string {
  if (value === null || value === undefined) return "UNDEF";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "UNDEF";
  if (Array.isArray(value)) return `(${value.map(sparqlParameterTerm).join(", ")})`;
  if (typeof value === "object") return sparqlString(JSON.stringify(value));
  const text = String(value);
  if (isUuid(text) || /^https?:\/\//i.test(text) || text.startsWith("urn:")) return termToken(termForId(text));
  return sparqlString(text);
}

/** `$name` 形式的参数绑定：只替换字符串字面量、IRI 与注释之外的位置。 */
export function bindSparqlParameters(query: string, parameters: Record<string, unknown> = {}) {
  const names = Object.keys(parameters).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  if (!names.length) return query;
  let result = "";
  let index = 0;
  while (index < query.length) {
    const character = query[index];
    if (character === "#") {
      const end = query.indexOf("\n", index);
      const stop = end === -1 ? query.length : end;
      result += query.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === "<") {
      const end = query.indexOf(">", index);
      const stop = end === -1 ? query.length : end + 1;
      result += query.slice(index, stop);
      index = stop;
      continue;
    }
    if (character === '"' || character === "'") {
      let cursor = index + 1;
      while (cursor < query.length) {
        if (query[cursor] === "\\") { cursor += 2; continue; }
        if (query[cursor] === character) { cursor += 1; break; }
        cursor += 1;
      }
      result += query.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (character === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(query.slice(index));
      if (match && names.includes(match[1])) {
        result += sparqlParameterTerm(parameters[match[1]]);
        index += match[0].length;
        continue;
      }
    }
    result += character;
    index += 1;
  }
  return result;
}

export function readNtTerm(text: string, start: number): NtTerm | null {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return null;
  if (text[index] === "<") {
    const end = text.indexOf(">", index);
    if (end === -1) return null;
    return { value: text.slice(index + 1, end), type: "uri", end: end + 1 };
  }
  if (text.startsWith("_:", index)) {
    let cursor = index + 2;
    while (cursor < text.length && !/\s/.test(text[cursor]) && text[cursor] !== ".") cursor += 1;
    return { value: `_:${text.slice(index + 2, cursor)}`, type: "bnode", end: cursor };
  }
  if (text[index] === '"') {
    let cursor = index + 1;
    let value = "";
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\\") {
        const next = text[cursor + 1];
        if (next === "u") { value += String.fromCharCode(Number.parseInt(text.slice(cursor + 2, cursor + 6), 16)); cursor += 6; continue; }
        if (next === "U") { value += String.fromCodePoint(Number.parseInt(text.slice(cursor + 2, cursor + 10), 16)); cursor += 10; continue; }
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
        value += escapes[next] ?? next;
        cursor += 2;
        continue;
      }
      if (character === '"') { cursor += 1; break; }
      value += character;
      cursor += 1;
    }
    let datatype: string | undefined;
    if (text.startsWith("^^", cursor)) {
      const term = readNtTerm(text, cursor + 2);
      datatype = term?.value;
      cursor = term?.end ?? cursor;
    } else if (text[cursor] === "@") {
      let cursorLang = cursor + 1;
      while (cursorLang < text.length && /[A-Za-z0-9-]/.test(text[cursorLang])) cursorLang += 1;
      cursor = cursorLang;
    }
    return { value, type: "literal", datatype, end: cursor };
  }
  return null;
}

/** 解析 N-Triples（CONSTRUCT / DESCRIBE 的返回体）。 */
export function parseNTriples(text: string) {
  const triples: { subject: NtTerm; predicate: NtTerm; object: NtTerm }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const subject = readNtTerm(line, 0);
    if (!subject) continue;
    const predicate = readNtTerm(line, subject.end);
    if (!predicate) continue;
    const object = readNtTerm(line, predicate.end);
    if (!object) continue;
    triples.push({ subject, predicate, object });
  }
  return triples;
}

export function termValue(term: SparqlTerm): unknown {
  if (term.type === "uri") return term.value;
  if (term.type === "bnode") return `_:${term.value}`;
  return valueFromSparqlLiteral(term.value, term.datatype);
}

export function termIsResource(term: { type: string }) {
  return term.type === "uri" || term.type === "bnode";
}

export function nodeLabelFromTerm(term: { type: string; value: string }) {
  return term.type === "bnode" ? term.value : localName(term.value);
}

export const WRITE_SPARQL = /\b(insert|delete|load|clear|create|drop|add|move|copy)\b/i;

export function containsWriteSparql(query: string) {
  return WRITE_SPARQL.test(query);
}

/** 取查询表单关键字，跳过 PREFIX / BASE / 注释。 */
export function sparqlQueryForm(query: string) {
  let text = query;
  for (;;) {
    const before = text;
    text = text.replace(/^\s*#[^\n]*\n/, "").replace(/^\s*(PREFIX|BASE)\s[^\n]*\n/i, "").replace(/^\s+/, "");
    if (text === before) break;
  }
  return /^([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() ?? "";
}
