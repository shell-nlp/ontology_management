import { randomUUID } from "node:crypto";
import { decryptSecret } from "@/lib/crypto";
import { graphTargetKindInfo } from "@/lib/graph/types";
import {
  dataTypeFromSparqlDatatype,
  escapeSparqlStringLiteral,
  isAutoUniqueCandidate,
  sparqlLiteral,
  valueFromSparqlLiteral,
} from "@/lib/graph/schema-inference";
import type {
  ConnectionInfo,
  EntityRecord,
  EntitySearchHit,
  GraphData,
  GraphDefinitionLike,
  GraphExport,
  GraphNode,
  GraphRelationship,
  GraphStore,
  GraphTarget,
  GraphViolation,
  GraphWriteSnapshot,
  ListEntitiesOptions,
  ListRelationshipsOptions,
  QueryResult,
  ReadGraphOptions,
  RelationshipRecord,
  RuntimeProperty,
  RuntimeTypeSet,
  SearchEntitiesOptions,
} from "@/lib/graph/types";

/**
 * Apache Jena 适配器。
 *
 * 生产部署里 Jena 通常以 Fuseki（SPARQL 1.1 HTTP 协议）暴露服务，这里就是
 * Fuseki 客户端：SELECT/ASK 走 SPARQL 查询端点，写入走 SPARQL Update 端点。
 *
 * RDF 与属性图之间的映射：
 * - 三元组 <s> <p> <o> 中 o 是资源 -> 一条关系，类型取 p 的 local name；
 * - o 是字面量 -> 节点的属性，键取 p 的 local name；
 * - ?s rdf:type ?t -> 节点的标签，取 t 的 local name；
 * - 属性图里关系也能带属性，用 RDF 具体化表达：
 *   <urn:bkn:rel:ID> a bkn:Relationship ; bkn:relType "类型" ; bkn:source <s> ;
 *   bkn:target <o> ; <urn:bkn:prop:键> "值" 。
 *   同时保留直接三元组，外部 SPARQL 工具照常可以查询。
 */

const RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL = "http://www.w3.org/2002/07/owl#";
const RDF_TYPE = `${RDF}type`;
const RDFS_LABEL = `${RDFS}label`;
const RDFS_SUBCLASS = `${RDFS}subClassOf`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const OWL_CLASS = `${OWL}Class`;
const RDFS_CLASS = `${RDFS}Class`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const RDF_PROPERTY = `${RDF}Property`;
const OWL_SAME_AS = `${OWL}sameAs`;

const BKN = "urn:bkn:";
const BKN_RELATIONSHIP = `${BKN}Relationship`;
const BKN_REL_TYPE = `${BKN}relType`;
const BKN_SOURCE = `${BKN}source`;
const BKN_TARGET = `${BKN}target`;
export const BKN_NODE_PREFIX = `${BKN}node:`;
export const BKN_CLASS_PREFIX = `${BKN}class:`;
export const BKN_PROPERTY_PREFIX = `${BKN}prop:`;
export const BKN_RELATIONSHIP_PREFIX = `${BKN}rel:`;
export const BKN_REL_TYPE_PREFIX = `${BKN}reltype:`;

/** 结构谓词只在内部使用，不作为节点属性或关系暴露。 */
const STRUCTURAL_PREDICATES = [
  RDF_TYPE,
  RDF_FIRST,
  RDF_REST,
  RDFS_SUBCLASS,
  RDFS_DOMAIN,
  RDFS_RANGE,
  OWL_SAME_AS,
  BKN_REL_TYPE,
  BKN_SOURCE,
  BKN_TARGET,
];
const STRUCTURAL_FILTER = STRUCTURAL_PREDICATES.map((predicate) => `<${predicate}>`).join(", ");
const STRUCTURAL_LOCAL_NAMES = STRUCTURAL_PREDICATES.map((predicate) => localName(predicate));

export type SparqlTerm = { type: string; value: string; datatype?: string; "xml:lang"?: string };
export type SparqlEndpoints = { query: string; update: string; dataset: string; namedGraph: string | null };

type NtTerm = { value: string; type: "uri" | "bnode" | "literal"; datatype?: string; end: number };

function optionText(target: GraphTarget, key: string) {
  const value = target.options?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Fuseki 端点命名规则：/ds/query、/ds/update，或统一端点 /ds/sparql。 */
export function resolveSparqlEndpoints(target: GraphTarget): SparqlEndpoints {
  const dataset = target.database_name?.trim() || "ds";
  const trimmed = target.uri.trim().replace(/\/+$/, "");
  const endpointLike = /\/(sparql|query|update)$/i.test(trimmed);
  const base = endpointLike || trimmed.endsWith(`/${dataset}`) ? trimmed : `${trimmed}/${dataset}`;
  const derive = (kind: "query" | "update") => {
    if (/\/sparql$/i.test(base)) return base;
    if (/\/(query|update)$/i.test(base)) return base.replace(/\/(query|update)$/i, `/${kind}`);
    return `${base}/${kind}`;
  };
  return {
    query: optionText(target, "queryEndpoint") ?? derive("query"),
    update: optionText(target, "updateEndpoint") ?? derive("update"),
    dataset,
    namedGraph: optionText(target, "namedGraph"),
  };
}

function authorizationHeader(target: GraphTarget) {
  if (!target.username) return undefined;
  const password = target.credential_secret ? decryptSecret(target.credential_secret) : "";
  return `Basic ${Buffer.from(`${target.username}:${password}`).toString("base64")}`;
}

function isUuid(value: string) {
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

function termToken(term: string) {
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

function chunk<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sparqlString(value: string) {
  return `"${escapeSparqlStringLiteral(value)}"`;
}

function sparqlParameterTerm(value: unknown): string {
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

function readNtTerm(text: string, start: number): NtTerm | null {
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

function termIsResource(term: { type: string }) {
  return term.type === "uri" || term.type === "bnode";
}

function nodeLabelFromTerm(term: { type: string; value: string }) {
  return term.type === "bnode" ? term.value : localName(term.value);
}

const WRITE_SPARQL = /\b(insert|delete|load|clear|create|drop|add|move|copy)\b/i;

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

export function createJenaStore(target: GraphTarget): GraphStore {
  const endpoints = resolveSparqlEndpoints(target);
  const auth = authorizationHeader(target);
  const namedGraph = endpoints.namedGraph;
  const scope = (pattern: string) => (namedGraph ? `GRAPH <${namedGraph}> { ${pattern} }` : pattern);

  async function post(endpoint: string, body: string, contentType: string, accept: string) {
    const headers: Record<string, string> = { "Content-Type": contentType, Accept: accept };
    if (auth) headers.Authorization = auth;
    let response: Response;
    try {
      response = await fetch(endpoint, { method: "POST", headers, body, cache: "no-store" });
    } catch (error) {
      throw new Error(`无法连接 SPARQL 端点 ${endpoint}：${error instanceof Error ? error.message : "网络错误"}`);
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`SPARQL 端点返回 ${response.status} ${response.statusText}${text ? `：${text.slice(0, 400)}` : ""}`);
    return text;
  }

  async function select(query: string, parameters: Record<string, unknown> = {}) {
    const text = await post(endpoints.query, bindSparqlParameters(query, parameters), "application/sparql-query; charset=utf-8", "application/sparql-results+json");
    let parsed: { head?: { vars?: string[] }; results?: { bindings?: Record<string, SparqlTerm>[] } };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      throw new Error(`SPARQL 查询返回了非 JSON 结果，请确认 ${endpoints.query} 是 SPARQL 查询端点。`);
    }
    return { vars: parsed.head?.vars ?? [], rows: parsed.results?.bindings ?? [] };
  }

  async function update(statement: string) {
    await post(endpoints.update, statement, "application/sparql-update; charset=utf-8", "*/*");
  }

  function valuesClause(variable: string, terms: string[]) {
    return `VALUES ?${variable} { ${terms.map(termToken).join(" ")} }`;
  }

  /** 读取一组主语的对象类标签与字面量属性。 */
  async function hydrateNodes(terms: string[]) {
    const nodes = new Map<string, GraphNode>();
    // 具体化关系 / 类 / 属性这些 RDF 资源不算实例节点，单独回报给调用方。
    const relationshipTerms = new Set<string>();
    if (!terms.length) return { nodes, relationshipTerms };
    for (const group of chunk([...new Set(terms)], 200)) {
      const [typeRows, literalRows] = await Promise.all([
        select(`SELECT ?s ?t WHERE { ${scope(`${valuesClause("s", group)} ?s <${RDF_TYPE}> ?t`)} }`),
        select(`SELECT ?s ?p ?o WHERE { ${scope(`${valuesClause("s", group)} ?s ?p ?o FILTER(isLiteral(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)} }`),
      ]);
      const relationshipNodes = new Set<string>();
      for (const row of typeRows.rows) {
        const subject = row.s?.value;
        const type = row.t?.value;
        if (!subject || !type) continue;
        if (type === BKN_RELATIONSHIP || type === OWL_CLASS || type === RDFS_CLASS || type === OWL_OBJECT_PROPERTY || type === RDF_PROPERTY) {
          relationshipNodes.add(subject);
          continue;
        }
        const node = nodes.get(subject) ?? { id: nodeIdFromTerm(subject), labels: [], properties: {} };
        const label = nodeLabelFromTerm(row.t);
        if (label && !node.labels.includes(label)) node.labels.push(label);
        nodes.set(subject, node);
      }
      for (const row of literalRows.rows) {
        const subject = row.s?.value;
        const predicate = row.p?.value;
        if (!subject || !predicate || relationshipNodes.has(subject)) continue;
        const node = nodes.get(subject) ?? { id: nodeIdFromTerm(subject), labels: [], properties: {} };
        pushProperty(node.properties, localName(predicate), valueFromSparqlLiteral(row.o.value, row.o.datatype));
        nodes.set(subject, node);
      }
      for (const subject of relationshipNodes) {
        nodes.delete(subject);
        relationshipTerms.add(subject);
      }
    }
    return { nodes, relationshipTerms };
  }

  /** 读取一组主语之间的关系（含 RDF 具体化的关系属性）。 */
  async function readEdges(subjectTerms: string[], relationshipTypes: string[] = []) {
    const relationships = new Map<string, GraphRelationship>();
    const discovered = new Set<string>();
    if (!subjectTerms.length) return { relationships: [], discovered };
    const typeFilter = relationshipTypes.length ? `FILTER(?rt IN (${relationshipTypes.map((type) => sparqlString(type)).join(", ")}))` : "";
    for (const group of chunk([...new Set(subjectTerms)], 200)) {
      const [reifiedRows, directRows] = await Promise.all([
        select(`SELECT ?r ?rt ?src ?tgt ?pk ?pv WHERE {
            ${scope(`${valuesClause("src", group)} ?r <${RDF_TYPE}> <${BKN_RELATIONSHIP}> ; <${BKN_REL_TYPE}> ?rt ; <${BKN_SOURCE}> ?src ; <${BKN_TARGET}> ?tgt`)}
            ${typeFilter}
            OPTIONAL { ?r ?pk ?pv FILTER(?pk NOT IN (${STRUCTURAL_FILTER})) }
          }`),
        select(`SELECT ?s ?p ?o WHERE {
            ${scope(`${valuesClause("s", group)} ?s ?p ?o FILTER(isIRI(?o) || isBlank(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)}
          }`),
      ]);
      const reifiedKeys = new Set<string>();
      for (const row of reifiedRows.rows) {
        const id = row.r?.value;
        // 这里统一用“裸 IRI”做键（不带尖括号），与 hydrateNodes 的 Map 键一致。
        const source = row.src?.value ?? null;
        const target = row.tgt?.value ?? null;
        if (!id || !source || !target) continue;
        const type = row.rt ? String(termValue(row.rt)) : "";
        const relationshipId = id.startsWith(BKN_RELATIONSHIP_PREFIX) ? id.slice(BKN_RELATIONSHIP_PREFIX.length) : id;
        const relationship = relationships.get(relationshipId) ?? { id: relationshipId, type, source: nodeIdFromTerm(source), target: nodeIdFromTerm(target), properties: {} };
        if (row.pk?.value && row.pv) pushProperty(relationship.properties, localName(row.pk.value), termValue(row.pv));
        relationships.set(relationshipId, relationship);
        reifiedKeys.add(`${type}\u0000${source}\u0000${target}`);
        discovered.add(source);
        discovered.add(target);
      }
      for (const row of directRows.rows) {
        const source = row.s?.value ?? null;
        const predicate = row.p?.value;
        const target = row.o?.value ?? null;
        if (!source || !predicate || !target) continue;
        const type = localName(predicate);
        if (reifiedKeys.has(`${type}\u0000${source}\u0000${target}`)) continue;
        const id = `${source}|${predicate}|${target}`;
        relationships.set(id, { id, type, source: nodeIdFromTerm(source), target: nodeIdFromTerm(target), properties: {} });
        discovered.add(source);
        discovered.add(target);
      }
    }
    return { relationships: [...relationships.values()], discovered };
  }

  /** 按对象类 / 关键词筛选主语。 */
  async function selectSubjects(options: { labels?: string[]; search?: string | null; limit?: number } = {}) {
    const labels = options.labels ?? [];
    const search = options.search?.trim() || null;
    const limit = Math.min(200000, Math.max(1, Math.floor(options.limit ?? 300)));
    const labelPattern = labels.length
      ? `?s <${RDF_TYPE}> ?labelType FILTER(?labelType IN (${labels.map((label) => `<${BKN_CLASS_PREFIX}${iriSegment(label)}>`).join(", ")}))`
      : null;
    const searchPattern = search
      ? `{ { ?s ?searchPredicate ?searchValue FILTER(isLiteral(?searchValue) && CONTAINS(LCASE(STR(?searchValue)), LCASE(${sparqlString(search)}))) } UNION { ?s <${RDF_TYPE}> ?searchType FILTER(CONTAINS(LCASE(STR(?searchType)), LCASE(${sparqlString(search)}))) } }`
      : null;
    // 三元组模式之间必须显式用 "." 分隔，否则 Fuseki 会把相邻模式判为语法错误。
    const patterns = ["?s ?seedPredicate ?seedObject", labelPattern, searchPattern].filter((pattern): pattern is string => Boolean(pattern));
    const rows = await select(`SELECT DISTINCT ?s WHERE {
        ${scope(patterns.join(" . "))}
        FILTER NOT EXISTS { ${scope(`?s <${RDF_TYPE}> <${BKN_RELATIONSHIP}>`)} }
      } LIMIT ${limit}`);
    return rows.rows.map((row) => row.s?.value).filter((value): value is string => Boolean(value));
  }

  async function graphFromTerms(terms: string[], relationshipTypes: string[] = []): Promise<GraphData> {
    const hydrated = await hydrateNodes(terms);
    const nodes = hydrated.nodes;
    if (!nodes.size) return { nodes: [], relationships: [] };
    const { relationships, discovered } = await readEdges([...nodes.keys()], relationshipTypes);
    const missing = [...discovered].filter((term) => !nodes.has(term) && !hydrated.relationshipTerms.has(term));
    if (missing.length) {
      const extra = await hydrateNodes(missing);
      for (const [key, value] of extra.nodes) nodes.set(key, value);
      for (const term of extra.relationshipTerms) hydrated.relationshipTerms.add(term);
    }
    const ids = new Set([...nodes.values()].map((node) => node.id));
    return {
      nodes: [...nodes.values()],
      relationships: relationships.filter((relationship) => ids.has(relationship.source) && ids.has(relationship.target)),
    };
  }

  return {
    kind: "JENA",
    target,
    // 连接表单元数据只有一份：来自 @/lib/graph/types 的注册表。
    info: graphTargetKindInfo("JENA"),

    async testConnection(): Promise<ConnectionInfo> {
      const text = await post(endpoints.query, `ASK { ${scope("?s ?p ?o")} }`, "application/sparql-query; charset=utf-8", "application/sparql-results+json");
      let hasTriples = false;
      try {
        hasTriples = Boolean((JSON.parse(text) as { boolean?: boolean }).boolean);
      } catch {
        hasTriples = false;
      }
      return {
        connected: true,
        kind: "JENA",
        address: endpoints.query,
        agent: "Apache Jena Fuseki (SPARQL 1.1)",
        protocolVersion: "SPARQL 1.1",
        detail: { dataset: endpoints.dataset, updateEndpoint: endpoints.update, namedGraph, hasTriples },
      };
    },

    containsWriteStatement: containsWriteSparql,

    async execute(query: string, parameters: Record<string, unknown> = {}, options: { readOnly?: boolean } = {}): Promise<QueryResult> {
      const bound = bindSparqlParameters(query, parameters);
      if (options.readOnly && containsWriteSparql(bound)) throw new Error("只读模式下不允许执行 SPARQL 更新语句。");
      const form = sparqlQueryForm(bound);
      if (form === "CONSTRUCT" || form === "DESCRIBE") {
        const text = await post(endpoints.query, bound, "application/sparql-query; charset=utf-8", "application/n-triples");
        const triples = parseNTriples(text).map((triple) => ({
          subject: triple.subject.value,
          predicate: triple.predicate.value,
          object: { type: triple.object.type, value: triple.object.value, datatype: triple.object.datatype },
        }));
        const terms = new Set<string>();
        for (const triple of triples) {
          terms.add(triple.subject);
          if (termIsResource(triple.object)) terms.add(triple.object.value);
        }
        const hydrated = await hydrateNodes([...terms]);
        const graph = graphFromTriples(triples, {
          hydrate: (term) => hydrated.nodes.get(term),
          exclude: (term) => hydrated.relationshipTerms.has(term),
        });
        return { keys: [], records: [], graph, summary: bound };
      }
      if (form !== "SELECT" && form !== "ASK") {
        throw new Error("SPARQL 工作台只支持 SELECT / ASK / CONSTRUCT / DESCRIBE 查询；写入请通过本体发布流程。");
      }
      const rows = await select(bound);
      const records = rows.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, term]) => [key, termValue(term)])) as Record<string, unknown>);
      const triples = extractTripleRows(rows.vars, rows.rows);
      if (!triples.length) return { keys: rows.vars, records, graph: { nodes: [], relationships: [] }, summary: bound };
      const terms = new Set<string>();
      for (const triple of triples) {
        terms.add(triple.subject);
        if (termIsResource(triple.object)) terms.add(triple.object.value);
      }
      const hydrated = await hydrateNodes([...terms]);
      const graph = graphFromTriples(triples, {
        hydrate: (term) => hydrated.nodes.get(term),
        exclude: (term) => hydrated.relationshipTerms.has(term),
      });
      return { keys: rows.vars, records, graph, summary: bound };
    },

    queryTemplate: () => ({
      defaultQuery: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100",
      placeholder: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100",
      visualizationHint: "以 ?s / ?p / ?o 为变量名返回三元组即可可视化；也可以用 CONSTRUCT 直接构造子图。",
    }),

    async readSchemaGraph(): Promise<QueryResult> {
      const rows = await select(`SELECT ?sourceType ?predicate ?targetType (COUNT(*) AS ?count) WHERE {
          ${scope(`?source <${RDF_TYPE}> ?sourceType . ?source ?predicate ?target . ?target <${RDF_TYPE}> ?targetType
            FILTER(isIRI(?target) || isBlank(?target))
            FILTER(?predicate NOT IN (${STRUCTURAL_FILTER}))`)}
        } GROUP BY ?sourceType ?predicate ?targetType ORDER BY DESC(?count)`);
      const nodes = new Map<string, GraphNode>();
      const relationships: GraphRelationship[] = [];
      for (const row of rows.rows) {
        const source = row.sourceType ? nodeLabelFromTerm(row.sourceType) : null;
        const predicate = row.predicate?.value;
        const target = row.targetType ? nodeLabelFromTerm(row.targetType) : null;
        if (!source || !predicate || !target) continue;
        if (!nodes.has(source)) nodes.set(source, { id: source, labels: [source], properties: {} });
        if (!nodes.has(target)) nodes.set(target, { id: target, labels: [target], properties: {} });
        const type = localName(predicate);
        relationships.push({ id: `${source}|${type}|${target}`, type, source, target, properties: { count: Number(row.count?.value ?? 0) } });
      }
      if (!nodes.size) {
        const [classRows, subclassRows] = await Promise.all([
          select(`SELECT DISTINCT ?class ?label WHERE {
              ${scope(`{ ?class <${RDF_TYPE}> <${OWL_CLASS}> } UNION { ?class <${RDF_TYPE}> <${RDFS_CLASS}> } UNION { ?child <${RDFS_SUBCLASS}> ?class } UNION { ?class <${RDFS_SUBCLASS}> ?parent }`)}
              OPTIONAL { ${scope(`?class <${RDFS_LABEL}> ?label`)} }
            }`),
          select(`SELECT ?child ?parent WHERE { ${scope(`?child <${RDFS_SUBCLASS}> ?parent`)} }`),
        ]);
        for (const row of classRows.rows) {
          const iri = row.class?.value;
          if (!iri) continue;
          const name = localName(iri);
          nodes.set(name, { id: name, labels: [name], properties: { label: row.label ? String(termValue(row.label)) : name } });
        }
        for (const row of subclassRows.rows) {
          const child = row.child?.value;
          const parent = row.parent?.value;
          if (!child || !parent) continue;
          relationships.push({ id: `${child}|subClassOf|${parent}`, type: "subClassOf", source: localName(child), target: localName(parent), properties: {} });
        }
      }
      return { keys: [], records: [], graph: { nodes: [...nodes.values()], relationships }, summary: "RDF Schema / 实例类型推导" };
    },

    async readMeta() {
      const [typeRows, resourcePredicateRows, literalPredicateRows] = await Promise.all([
        select(`SELECT DISTINCT ?value WHERE { ${scope(`?s <${RDF_TYPE}> ?value`)} }`),
        select(`SELECT DISTINCT ?value WHERE { ${scope("?s ?value ?o FILTER(isIRI(?o) || isBlank(?o))")} }`),
        select(`SELECT DISTINCT ?value WHERE { ${scope("?s ?value ?o FILTER(isLiteral(?o))")} }`),
      ]);
      const names = (rows: { value?: string }[]) =>
        [...new Set(rows.map((row) => row.value).filter((value): value is string => typeof value === "string" && value.length > 0).map(localName))].sort((a, b) => a.localeCompare(b, "zh-CN"));
      return {
        labels: names(typeRows.rows.map((row) => ({ value: row.value?.value }))).filter((name) => name !== localName(BKN_RELATIONSHIP)),
        relationshipTypes: names(resourcePredicateRows.rows.map((row) => ({ value: row.value?.value }))).filter((name) => !STRUCTURAL_LOCAL_NAMES.includes(name)),
        propertyKeys: names(literalPredicateRows.rows.map((row) => ({ value: row.value?.value }))),
      };
    },

    async readRuntimeTypes(): Promise<RuntimeTypeSet> {
      const [typeRows, relationshipRows, nodeCountRows, relationshipCountRows, endpointRows, propertyRows, relationshipPropertyRows] = await Promise.all([
        select(`SELECT ?t (COUNT(DISTINCT ?s) AS ?count) WHERE { ${scope(`?s <${RDF_TYPE}> ?t`)} } GROUP BY ?t ORDER BY DESC(?count)`),
        select(`SELECT ?p (COUNT(*) AS ?count) WHERE { ${scope(`?s ?p ?o FILTER(isIRI(?o) || isBlank(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)} } GROUP BY ?p ORDER BY DESC(?count)`),
        select(`SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE { ${scope(`?s ?p ?o FILTER NOT EXISTS { ?s <${RDF_TYPE}> <${BKN_RELATIONSHIP}> }`)} }`),
        select(`SELECT (COUNT(*) AS ?count) WHERE { ${scope(`?s ?p ?o FILTER(isIRI(?o) || isBlank(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)} }`),
        select(`SELECT ?p ?sourceType ?targetType (COUNT(*) AS ?count) WHERE {
            ${scope(`?s ?p ?o . ?s <${RDF_TYPE}> ?sourceType . ?o <${RDF_TYPE}> ?targetType
              FILTER(isIRI(?o) || isBlank(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)}
          } GROUP BY ?p ?sourceType ?targetType ORDER BY DESC(?count)`),
        select(`SELECT ?t ?p (COUNT(?o) AS ?count) (COUNT(DISTINCT ?o) AS ?distinctCount) (MAX(STRLEN(STR(?o))) AS ?maxLength) (SAMPLE(DATATYPE(?o)) AS ?datatype) WHERE {
            ${scope(`?s <${RDF_TYPE}> ?t . ?s ?p ?o FILTER(isLiteral(?o))`)}
          } GROUP BY ?t ?p`),
        select(`SELECT ?rt ?p (COUNT(?o) AS ?count) (COUNT(DISTINCT ?o) AS ?distinctCount) (MAX(STRLEN(STR(?o))) AS ?maxLength) (SAMPLE(DATATYPE(?o)) AS ?datatype) WHERE {
            ${scope(`?r <${RDF_TYPE}> <${BKN_RELATIONSHIP}> ; <${BKN_REL_TYPE}> ?rt ; ?p ?o FILTER(isLiteral(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)}
          } GROUP BY ?rt ?p`),
      ]);
      const labelProperties = buildRuntimeProperties(propertyRows.rows.map((row) => ({
        name: row.t?.value ? localName(row.t.value) : "",
        key: row.p?.value ? localName(row.p.value) : "",
        count: Number(row.count?.value ?? 0),
        distinctCount: Number(row.distinctCount?.value ?? 0),
        maxLength: Number(row.maxLength?.value ?? 0),
        datatype: row.datatype?.value ?? null,
      })));
      const relationshipProperties = buildRuntimeProperties(relationshipPropertyRows.rows.map((row) => ({
        name: row.rt ? String(termValue(row.rt)) : "",
        key: row.p?.value ? localName(row.p.value) : "",
        count: Number(row.count?.value ?? 0),
        distinctCount: Number(row.distinctCount?.value ?? 0),
        maxLength: Number(row.maxLength?.value ?? 0),
        datatype: row.datatype?.value ?? null,
      })));
      const relationshipEndpoints: Record<string, { source: string; target: string }> = {};
      for (const row of endpointRows.rows) {
        const name = row.p?.value ? localName(row.p.value) : "";
        if (!name || relationshipEndpoints[name]) continue;
        relationshipEndpoints[name] = {
          source: row.sourceType ? nodeLabelFromTerm(row.sourceType) : "",
          target: row.targetType ? nodeLabelFromTerm(row.targetType) : "",
        };
      }
      return {
        labels: typeRows.rows
          .filter((row) => row.t?.value && row.t.value !== BKN_RELATIONSHIP)
          .map((row) => {
            const name = localName(row.t!.value);
            return { name, count: Number(row.count?.value ?? 0), properties: labelProperties.get(name) };
          }),
        relationshipTypes: relationshipRows.rows.map((row) => {
          const name = row.p?.value ? localName(row.p.value) : "";
          return { name, count: Number(row.count?.value ?? 0), properties: relationshipProperties.get(name) };
        }),
        entityCount: Number(nodeCountRows.rows[0]?.count?.value ?? 0),
        relationshipCount: Number(relationshipCountRows.rows[0]?.count?.value ?? 0),
        relationshipEndpoints,
      };
    },

    async readGraph(options: ReadGraphOptions = {}): Promise<GraphData> {
      const labels = [...new Set([...(options.label ? [options.label] : []), ...(options.labels ?? [])])];
      const terms = await selectSubjects({ labels, search: options.search, limit: options.nodeLimit ?? 300 });
      return graphFromTerms(terms, options.relationshipTypes ?? []);
    },

    async readNeighborhood(id: string, limit: number) {
      const focus = termForId(id);
      const bounded = Math.min(10000, Math.max(1, Math.floor(limit)));
      const [outgoing, incoming] = await Promise.all([
        select(`SELECT ?p ?o WHERE { ${scope(`${termToken(focus)} ?p ?o FILTER(isIRI(?o) || isBlank(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)} } LIMIT ${bounded}`),
        select(`SELECT ?p ?s WHERE { ${scope(`?s ?p ${termToken(focus)} FILTER(isIRI(?s) || isBlank(?s)) FILTER(?p NOT IN (${STRUCTURAL_FILTER}))`)} } LIMIT ${bounded}`),
      ]);
      const terms = new Set<string>([focus]);
      for (const row of outgoing.rows) if (row.o?.value) terms.add(row.o.value);
      for (const row of incoming.rows) if (row.s?.value) terms.add(row.s.value);
      return graphFromTerms([...terms]);
    },

    async listEntities(options: ListEntitiesOptions = {}): Promise<EntityRecord[]> {
      const labels = [...new Set([...(options.label ? [options.label] : []), ...(options.labels ?? [])])];
      const terms = await selectSubjects({ labels, search: options.search, limit: options.limit ?? 200 });
      const { nodes } = await hydrateNodes(terms);
      return [...nodes.values()];
    },

    async readEntity(id: string): Promise<EntityRecord | null> {
      const { nodes } = await hydrateNodes([termForId(id)]);
      return [...nodes.values()][0] ?? null;
    },

    async searchEntities(options: SearchEntitiesOptions): Promise<EntitySearchHit[]> {
      const search = options.search.trim();
      if (!search) return [];
      const limit = Math.min(30, Math.max(1, Math.floor(options.limit ?? 12)));
      const terms = await selectSubjects({ labels: options.labels, search, limit: 200 });
      const { nodes } = await hydrateNodes(terms);
      const needle = search.toLowerCase();
      const hits: EntitySearchHit[] = [];
      for (const node of nodes.values()) {
        const matched = Object.entries(node.properties).filter(([, value]) => String(value).toLowerCase().includes(needle)).map(([key]) => key);
        if (!matched.length && !node.labels.some((label) => label.toLowerCase().includes(needle))) continue;
        const displayName = displayNameOf(node, options.displayProperties);
        const rank = displayName.toLowerCase() === needle ? 0
          : displayName.toLowerCase().startsWith(needle) ? 1
          : matched.some((key) => String(node.properties[key]).toLowerCase() === needle) ? 2
          : displayName.toLowerCase().includes(needle) ? 3
          : matched.some((key) => String(node.properties[key]).toLowerCase().startsWith(needle)) ? 4
          : 5;
        hits.push({ ...node, matched, rank });
      }
      return hits.sort((a, b) => (a.rank - b.rank) || (b.matched.length - a.matched.length) || a.id.localeCompare(b.id)).slice(0, limit);
    },

    async listRelationships(options: ListRelationshipsOptions = {}): Promise<RelationshipRecord[]> {
      const limit = Math.min(10000, Math.max(1, Math.floor(options.limit ?? 200)));
      const typeFilter = options.type ? `FILTER(${sparqlString(options.type)} = REPLACE(STR(?p), "^.*[/#]", ""))` : "";
      const search = options.search?.trim();
      const searchFilter = search
        ? `{ { ?s ?searchPredicate ?searchValue FILTER(isLiteral(?searchValue) && CONTAINS(LCASE(STR(?searchValue)), LCASE(${sparqlString(search)}))) } UNION { ?o ?searchPredicate2 ?searchValue2 FILTER(isLiteral(?searchValue2) && CONTAINS(LCASE(STR(?searchValue2)), LCASE(${sparqlString(search)}))) } UNION { FILTER(CONTAINS(LCASE(STR(?p)), LCASE(${sparqlString(search)}))) } }`
        : "";
      const rows = await select(`SELECT ?s ?p ?o WHERE {
          ${scope(`?s ?p ?o FILTER(isIRI(?o) || isBlank(?o)) FILTER(?p NOT IN (${STRUCTURAL_FILTER})) ${typeFilter} ${searchFilter}`)}
        } LIMIT ${limit}`);
      const terms = new Set<string>();
      for (const row of rows.rows) {
        if (!row.s?.value || !row.o?.value) continue;
        terms.add(row.s.value);
        terms.add(row.o.value);
      }
      const [hydrated, edges] = await Promise.all([hydrateNodes([...terms]), readEdges([...terms])]);
      const nodes = hydrated.nodes;
      const records: RelationshipRecord[] = [];
      for (const row of rows.rows) {
        if (!row.s?.value || !row.p?.value || !row.o?.value) continue;
        const source = row.s.value;
        const target = row.o.value;
        const type = localName(row.p.value);
        const sourceNode = nodes.get(source);
        const targetNode = nodes.get(target);
        const matched = edges.relationships.find((edge) => edge.type === type && edge.source === nodeIdFromTerm(source) && edge.target === nodeIdFromTerm(target));
        records.push({
          id: matched?.id ?? `${termToken(source)}|${row.p.value}|${termToken(target)}`,
          type,
          sourceId: nodeIdFromTerm(source),
          targetId: nodeIdFromTerm(target),
          properties: matched?.properties ?? {},
          sourceLabels: sourceNode?.labels ?? [],
          sourceProperties: sourceNode?.properties ?? {},
          targetLabels: targetNode?.labels ?? [],
          targetProperties: targetNode?.properties ?? {},
        });
      }
      return records;
    },

    async exportGraph(): Promise<GraphExport> {
      const rows = await select(`SELECT DISTINCT ?s WHERE { ${scope("?s ?p ?o")} FILTER NOT EXISTS { ${scope(`?s <${RDF_TYPE}> <${BKN_RELATIONSHIP}>`)} } }`);
      const terms = rows.rows.map((row) => row.s?.value).filter((value): value is string => Boolean(value));
      const [hydrated, edges] = await Promise.all([hydrateNodes(terms), readEdges(terms)]);
      const nodes = hydrated.nodes;
      for (const term of edges.discovered) {
        if (nodes.has(term) || hydrated.relationshipTerms.has(term)) continue;
        const extra = await hydrateNodes([term]);
        for (const [key, value] of extra.nodes) nodes.set(key, value);
      }
      return {
        nodes: [...nodes.values()].map((node) => ({ id: node.id, labels: node.labels, properties: node.properties })),
        relationships: edges.relationships.map((relationship) => ({
          id: relationship.id,
          sourceId: relationship.source,
          targetId: relationship.target,
          type: relationship.type,
          properties: relationship.properties,
        })),
      };
    },

    async replaceGraph(snapshot: GraphWriteSnapshot) {
      const statements: string[] = [];
      for (const node of snapshot.nodes) {
        const subject = `<${BKN_NODE_PREFIX}${iriSegment(node.id)}>`;
        for (const label of node.labels) statements.push(`${subject} <${RDF_TYPE}> <${BKN_CLASS_PREFIX}${iriSegment(label)}> .`);
        const entityType = snapshot.definition.entityTypes.find((type) => node.labels.includes(type.name));
        for (const [key, value] of Object.entries(node.properties)) {
          const dataType = entityType?.properties.find((property) => property.name === key)?.dataType ?? "TEXT";
          const values = dataType === "JSON" || !Array.isArray(value) ? [value] : value;
          for (const item of values) {
            const literal = sparqlLiteral(item, dataType);
            if (literal === null) continue;
            statements.push(`${subject} <${BKN_PROPERTY_PREFIX}${iriSegment(key)}> ${literal} .`);
          }
        }
      }
      for (const relationship of snapshot.relationships) {
        const source = `<${BKN_NODE_PREFIX}${iriSegment(relationship.sourceId)}>`;
        const target = `<${BKN_NODE_PREFIX}${iriSegment(relationship.targetId)}>`;
        const reified = `<${BKN_RELATIONSHIP_PREFIX}${iriSegment(relationship.id)}>`;
        statements.push(`${source} <${BKN_REL_TYPE_PREFIX}${iriSegment(relationship.type)}> ${target} .`);
        statements.push(`${reified} <${RDF_TYPE}> <${BKN_RELATIONSHIP}> .`);
        statements.push(`${reified} <${BKN_REL_TYPE}> ${sparqlString(relationship.type)} .`);
        statements.push(`${reified} <${BKN_SOURCE}> ${source} .`);
        statements.push(`${reified} <${BKN_TARGET}> ${target} .`);
        const relationshipType = snapshot.definition.relationshipTypes.find((type) => type.name === relationship.type);
        for (const [key, value] of Object.entries(relationship.properties)) {
          const dataType = relationshipType?.properties.find((property) => property.name === key)?.dataType ?? "TEXT";
          const values = dataType === "JSON" || !Array.isArray(value) ? [value] : value;
          for (const item of values) {
            const literal = sparqlLiteral(item, dataType);
            if (literal === null) continue;
            statements.push(`${reified} <${BKN_PROPERTY_PREFIX}${iriSegment(key)}> ${literal} .`);
          }
        }
      }
      const plan = planReplaceRequests(statements, { namedGraph, singleRequestLimit: replaceSingleRequestLimit(target) });
      try {
        for (const request of plan.requests) await update(request);
      } catch (error) {
        // 只有失败时才需要兜底：切换成功时影子图已在同一个请求里被删掉，不必多发一次请求。
        if (plan.cleanup) await update(plan.cleanup).catch(() => undefined);
        throw error;
      }
    },

    async validateDefinition(definition: GraphDefinitionLike): Promise<GraphViolation[]> {
      const violations: GraphViolation[] = [];
      const entityNameById = new Map(definition.entityTypes.filter((entity) => entity.id).map((entity) => [entity.id as string, entity.name]));
      for (const entity of definition.entityTypes) {
        const classIri = `<${BKN_CLASS_PREFIX}${iriSegment(entity.name)}>`;
        for (const property of entity.properties) {
          if (!property.required) continue;
          const predicate = `<${BKN_PROPERTY_PREFIX}${iriSegment(property.name)}>`;
          const rows = await select(`SELECT (COUNT(DISTINCT ?s) AS ?count) WHERE {
              ${scope(`?s <${RDF_TYPE}> ${classIri} FILTER NOT EXISTS { ?s ${predicate} ?value }`)}
            }`);
          const amount = Number(rows.rows[0]?.count?.value ?? 0);
          if (amount) violations.push({ rule: `${entity.name}.${property.name}`, message: "存在缺失必填属性的对象实例。", count: amount });
        }
      }
      for (const relationship of definition.relationshipTypes) {
        const predicate = `<${BKN_REL_TYPE_PREFIX}${iriSegment(relationship.name)}>`;
        const source = relationship.sourceEntityTypeId ? entityNameById.get(relationship.sourceEntityTypeId) : undefined;
        const target = relationship.targetEntityTypeId ? entityNameById.get(relationship.targetEntityTypeId) : undefined;
        if (source && target) {
          const rows = await select(`SELECT (COUNT(*) AS ?count) WHERE {
              ${scope(`?s ${predicate} ?o FILTER NOT EXISTS { ?s <${RDF_TYPE}> <${BKN_CLASS_PREFIX}${iriSegment(source)}> }`)}
            }`);
          const amount = Number(rows.rows[0]?.count?.value ?? 0);
          if (amount) violations.push({ rule: relationship.name, message: `存在不符合 ${source} -> ${target} 端点契约的关系实例。`, count: amount });
        }
        for (const property of relationship.properties.filter((item) => item.required)) {
          const propertyPredicate = `<${BKN_PROPERTY_PREFIX}${iriSegment(property.name)}>`;
          const rows = await select(`SELECT (COUNT(*) AS ?count) WHERE {
              ${scope(`?r <${RDF_TYPE}> <${BKN_RELATIONSHIP}> ; <${BKN_REL_TYPE}> ${sparqlString(relationship.name)} ; <${BKN_SOURCE}> ?s ; <${BKN_TARGET}> ?o
                FILTER NOT EXISTS { ?r ${propertyPredicate} ?value }`)}
            }`);
          const amount = Number(rows.rows[0]?.count?.value ?? 0);
          if (amount) violations.push({ rule: `${relationship.name}.${property.name}`, message: "存在缺失必填属性的关系实例。", count: amount });
        }
      }
      return violations;
    },

    async reconcileStrongRules() {
      // Fuseki 不落地唯一 / 必填约束；RDF 侧表达这类规则应当导出 SHACL 形状，
      // 交由 SHACL 校验流程处理，而不是在这里静默假装成功。这里只如实上报能力。
      return { enforced: false };
    },
  };
}

function pushProperty(properties: Record<string, unknown>, key: string, value: unknown) {
  const existing = properties[key];
  if (existing === undefined) properties[key] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else properties[key] = [existing, value];
}

/** 单个 SPARQL Update 请求里能安全提交的三元组条数；超过就走影子图切换。 */
export const DEFAULT_SINGLE_REPLACE_LIMIT = 5000;

function replaceSingleRequestLimit(target: GraphTarget) {
  const configured = target.options?.singleReplaceLimit;
  const numeric = typeof configured === "number" ? configured : Number(configured);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : DEFAULT_SINGLE_REPLACE_LIMIT;
}

export type ReplacePlan = { requests: string[]; cleanup: string | null };

/**
 * 把整图替换计划成若干 SPARQL Update 请求。
 *
 * 关键约束：**可见状态的切换只能由一个请求完成**。已实测（Fuseki 5.1 / TDB2）：
 * 单个 update 请求是事务性的——请求体里有语法错误时，前面的 `CLEAR` 不会生效。
 * 所以小图用「清空 + 插入」的单请求；大图先把三元组写进影子图（这批写入不可见），
 * 再用一个请求「清空目标 + ADD 影子图 + 删影子图」原子切换，避免超大请求体。
 */
export function planReplaceRequests(statements: string[], options: { namedGraph: string | null; singleRequestLimit?: number }): ReplacePlan {
  const { namedGraph } = options;
  const limit = Math.max(1, options.singleRequestLimit ?? DEFAULT_SINGLE_REPLACE_LIMIT);
  const clear = namedGraph ? `CLEAR SILENT GRAPH <${namedGraph}>` : "CLEAR SILENT DEFAULT";
  const targetRef = namedGraph ? `<${namedGraph}>` : "DEFAULT";
  const wrap = (body: string, graph: string | null) => (graph ? `GRAPH <${graph}> { ${body} }` : body);
  if (!statements.length) return { requests: [clear], cleanup: null };
  if (statements.length <= limit) {
    return { requests: [`${clear} ;\nINSERT DATA { ${wrap(statements.join("\n"), namedGraph)} }`], cleanup: null };
  }
  const stagingGraph = `${BKN}staging:${randomUUID()}`;
  return {
    requests: [
      ...chunk(statements, 500).map((group) => `INSERT DATA { ${wrap(group.join("\n"), stagingGraph)} }`),
      `${clear} ;\nADD <${stagingGraph}> TO ${targetRef} ;\nDROP SILENT GRAPH <${stagingGraph}>`,
    ],
    cleanup: `DROP SILENT GRAPH <${stagingGraph}>`,
  };
}

function buildRuntimeProperties(rows: { name: string; key: string; count: number; distinctCount: number; maxLength: number; datatype: string | null }[]) {
  const result = new Map<string, RuntimeProperty[]>();
  for (const row of rows) {
    if (!row.name || !row.key) continue;
    if (!result.has(row.name)) result.set(row.name, []);
    result.get(row.name)!.push({
      name: row.key,
      dataType: dataTypeFromSparqlDatatype(row.datatype),
      required: false,
      unique: isAutoUniqueCandidate({ cnt: row.count, distinctCount: row.distinctCount, maxCharacterLength: row.maxLength }),
      indexed: false,
    });
  }
  for (const list of result.values()) list.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  return result;
}

/** 展示名优先级与前端 entityTitle 保持一致，并补充 RDF 常见的 label / prefLabel。 */
function displayNameOf(node: EntityRecord, displayProperties?: Record<string, string>) {
  for (const label of node.labels) {
    const property = displayProperties?.[label];
    if (property && node.properties[property] != null) return String(node.properties[property]);
  }
  for (const key of ["name", "名称", "title", "label", "prefLabel", "id"]) {
    const value = node.properties[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return node.labels[0] ?? node.id;
}

/** 从 SELECT 结果里识别 ?s / ?p / ?o 三元组变量。 */
function extractTripleRows(vars: string[], rows: Record<string, SparqlTerm>[]) {
  const pick = (candidates: string[]) => vars.find((variable) => candidates.includes(variable.toLowerCase()));
  const subject = pick(["s", "subject", "source"]);
  const predicate = pick(["p", "predicate"]);
  const object = pick(["o", "object", "target"]);
  if (!subject || !predicate || !object || !rows.length) return [];
  return rows
    .filter((row) => row[subject]?.value && row[predicate]?.value && row[object])
    .map((row) => ({ subject: row[subject].value, predicate: row[predicate].value, object: row[object] }));
}

function graphFromTriples(
  triples: { subject: string; predicate: string; object: SparqlTerm }[],
  options: { hydrate?: (term: string) => GraphNode | undefined; exclude?: (term: string) => boolean } = {},
) {
  const nodes = new Map<string, GraphNode>();
  const relationships: GraphRelationship[] = [];
  const hydratedIds = new Set<string>();
  const ensure = (term: string): GraphNode | null => {
    if (options.exclude?.(term)) return null;
    const id = nodeIdFromTerm(term);
    const existing = nodes.get(id);
    if (existing) return existing;
    const hydrated = options.hydrate?.(term);
    if (hydrated) hydratedIds.add(id);
    const node: GraphNode = hydrated
      ? { id, labels: [...hydrated.labels], properties: { ...hydrated.properties } }
      : { id, labels: [], properties: {} };
    nodes.set(id, node);
    return node;
  };
  for (const triple of triples) {
    const source = ensure(triple.subject);
    if (!source) continue;
    if (triple.predicate === RDF_TYPE) {
      if (triple.object.value === BKN_RELATIONSHIP) continue;
      const label = nodeLabelFromTerm(triple.object);
      if (label && !source.labels.includes(label)) source.labels.push(label);
      continue;
    }
    if (STRUCTURAL_PREDICATES.includes(triple.predicate)) continue;
    const key = localName(triple.predicate);
    if (termIsResource(triple.object)) {
      const target = ensure(triple.object.value);
      if (!target) continue;
      relationships.push({ id: `${triple.subject}|${triple.predicate}|${triple.object.value}`, type: key, source: source.id, target: target.id, properties: {} });
      continue;
    }
    // 已经按主语整体补水过的节点，字面量属性直接以补水结果为准，避免重复值。
    if (hydratedIds.has(source.id)) continue;
    pushProperty(source.properties, key, termValue(triple.object));
  }
  return { nodes: [...nodes.values()], relationships };
}
