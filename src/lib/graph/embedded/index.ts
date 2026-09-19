import Graph from "graphology";
import { QueryEngine } from "@comunica/query-sparql";
import { DataFactory, Parser, Store } from "n3";
import { EmbeddedGraphEntity, ensurePlatformSchema, jsonValue, platformRepo } from "@/lib/db";
import { valueFromSparqlLiteral } from "@/lib/graph/schema-inference";
import { bindSparqlParameters, containsWriteSparql, graphFromTriples, snapshotStatements, sparqlQueryForm } from "@/lib/graph/jena";
import { graphTargetKindInfo, type GraphData, type GraphStore, type GraphTarget, type GraphViolation, type GraphWriteSnapshot, type QueryResult, type RelationshipRecord, type RuntimeTypeSet } from "@/lib/graph/types";

const NODE_PREFIX = "urn:bkn:node:";
const EMPTY: GraphWriteSnapshot = { definition: { entityTypes: [], relationshipTypes: [], interfaces: [] }, nodes: [], relationships: [] };

/** PG 是唯一的已发布状态；内存图只在查询期间由当前版本构建，不依赖单个 Node 进程的寿命。 */
async function activeSnapshot(targetId: string): Promise<GraphWriteSnapshot> {
  const repo = await platformRepo(EmbeddedGraphEntity);
  const row = await repo.findOne({ where: { targetId } });
  return (row?.snapshot as GraphWriteSnapshot | undefined) ?? EMPTY;
}

function typeGraph(snapshot: GraphWriteSnapshot) {
  const graph = new Graph({ type: "directed", multi: true });
  for (const item of snapshot.definition.entityTypes) graph.addNode(item.name, { isInterface: false });
  for (const item of snapshot.definition.interfaces ?? []) if (!graph.hasNode(item.name)) graph.addNode(item.name, { isInterface: true });
  const interfaceById = new Map((snapshot.definition.interfaces ?? []).map((item) => [item.id, item.name]));
  for (const item of snapshot.definition.interfaces ?? []) for (const id of item.extends ?? []) {
    const parent = interfaceById.get(id);
    if (parent && graph.hasNode(parent)) graph.addDirectedEdgeWithKey(`interface:${item.name}:${parent}`, item.name, parent, { type: "subClassOf" });
  }
  for (const item of snapshot.definition.entityTypes) for (const id of item.implements ?? []) {
    const name = interfaceById.get(id);
    if (name && graph.hasNode(name)) graph.addDirectedEdgeWithKey(`implements:${item.name}:${name}`, item.name, name, { type: "implements" });
  }
  const typeById = new Map(snapshot.definition.entityTypes.map((item) => [item.id, item.name]));
  for (const item of snapshot.definition.relationshipTypes) {
    const source = typeById.get(item.sourceEntityTypeId ?? "");
    const target = typeById.get(item.targetEntityTypeId ?? "");
    if (source && target) graph.addDirectedEdgeWithKey(`relation:${item.name}:${source}:${target}`, source, target, { type: item.name });
  }
  return graph;
}

export function embeddedSchemaGraph(snapshot: GraphWriteSnapshot): GraphData {
  const graph = typeGraph(snapshot);
  const nodes: GraphData["nodes"] = [];
  const relationships: GraphData["relationships"] = [];
  graph.forEachNode((id, attributes) => nodes.push({ id, labels: [id], properties: attributes.isInterface ? { isInterface: true } : {} }));
  graph.forEachEdge((id, attributes, source, target) => relationships.push({ id, type: String(attributes.type), source, target, properties: {} }));
  return { nodes, relationships };
}

function instanceGraph(snapshot: GraphWriteSnapshot, options: { labels?: string[]; relationshipTypes?: string[]; search?: string | null; limit?: number } = {}): GraphData {
  const labels = new Set(options.labels ?? []);
  const relationTypes = new Set(options.relationshipTypes ?? []);
  const search = options.search?.trim().toLocaleLowerCase();
  const nodes = snapshot.nodes.filter((node) => (!labels.size || node.labels.some((label) => labels.has(label)))
    && (!search || JSON.stringify([node.labels, node.properties]).toLocaleLowerCase().includes(search)))
    .slice(0, options.limit ?? 300);
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes: nodes.map((node) => ({ ...node })), relationships: snapshot.relationships
    .filter((rel) => ids.has(rel.sourceId) && ids.has(rel.targetId) && (!relationTypes.size || relationTypes.has(rel.type)))
    .map((rel) => ({ id: rel.id, type: rel.type, source: rel.sourceId, target: rel.targetId, properties: rel.properties })) };
}

function relationshipRecord(snapshot: GraphWriteSnapshot, rel: GraphWriteSnapshot["relationships"][number]): RelationshipRecord {
  const source = snapshot.nodes.find((node) => node.id === rel.sourceId);
  const target = snapshot.nodes.find((node) => node.id === rel.targetId);
  return { id: rel.id, type: rel.type, sourceId: rel.sourceId, targetId: rel.targetId, properties: rel.properties,
    sourceLabels: source?.labels, sourceProperties: source?.properties, targetLabels: target?.labels, targetProperties: target?.properties };
}

function rdfStore(snapshot: GraphWriteSnapshot, namedGraph: string) {
  const quads = new Parser({ format: "N-Triples" }).parse(snapshotStatements(snapshot).join("\n"));
  // 数据源只含当前 target，另给同一份事实一个命名图入口，兼容已有 GRAPH 查询而不泄露其他本体。
  const store = new Store(quads);
  if (namedGraph) store.addQuads(quads.map((quad) => DataFactory.quad(quad.subject, quad.predicate, quad.object, DataFactory.namedNode(namedGraph))));
  return store;
}

type Term = { termType: string; value: string; datatype?: { value: string } };
function termValue(term: Term): unknown {
  if (term.termType === "Literal") return valueFromSparqlLiteral(term.value, term.datatype?.value);
  return term.termType === "BlankNode" ? `_:${term.value}` : term.value;
}
function sparqlTerm(term: Term) {
  return { type: term.termType === "Literal" ? "literal" : term.termType === "BlankNode" ? "bnode" : "uri", value: term.value, datatype: term.datatype?.value };
}

function resultGraph(snapshot: GraphWriteSnapshot, triples: { subject: string; predicate: string; object: ReturnType<typeof sparqlTerm> }[]): GraphData {
  const nodes = new Map(snapshot.nodes.map((node) => [`${NODE_PREFIX}${encodeURIComponent(node.id)}`, { id: node.id, labels: node.labels, properties: node.properties }]));
  return graphFromTriples(triples, { hydrate: (iri) => nodes.get(iri) });
}

/** 供契约测试直接运行；不触碰 PG，也不会把实例图常驻 Node 内存。 */
export async function runEmbeddedQuery(snapshot: GraphWriteSnapshot, namedGraph: string, query: string, parameters: Record<string, unknown> = {}): Promise<QueryResult> {
      const text = bindSparqlParameters(query, parameters);
      const form = sparqlQueryForm(text);
      if (containsWriteSparql(text) || !["SELECT", "ASK", "CONSTRUCT", "DESCRIBE"].includes(form)) throw new Error("SPARQL 工作台只支持 SELECT / ASK / CONSTRUCT / DESCRIBE 查询；写入请通过本体发布流程。");
      const engine = new QueryEngine();
      const sources = [rdfStore(snapshot, namedGraph)];
      if (form === "ASK") {
        const answer = await engine.queryBoolean(text, { sources });
        return { keys: ["boolean"], records: [{ boolean: answer }], graph: { nodes: [], relationships: [] }, summary: text };
      }
      if (form === "CONSTRUCT" || form === "DESCRIBE") {
        const triples: { subject: string; predicate: string; object: ReturnType<typeof sparqlTerm> }[] = [];
        for await (const quad of await engine.queryQuads(text, { sources })) triples.push({ subject: quad.subject.value, predicate: quad.predicate.value, object: sparqlTerm(quad.object) });
        return { keys: [], records: [], graph: resultGraph(snapshot, triples), summary: text };
      }
      const records: Record<string, unknown>[] = [];
      const triples: { subject: string; predicate: string; object: ReturnType<typeof sparqlTerm> }[] = [];
      const keys = new Set<string>();
      for await (const binding of await engine.queryBindings(text, { sources })) {
        const record: Record<string, unknown> = {};
        const terms = new Map<string, Term>();
        for (const [variable, term] of binding) { keys.add(variable.value); record[variable.value] = termValue(term); terms.set(variable.value.toLowerCase(), term); }
        records.push(record);
        const subject = terms.get("s") ?? terms.get("subject") ?? terms.get("source");
        const predicate = terms.get("p") ?? terms.get("predicate");
        const object = terms.get("o") ?? terms.get("object") ?? terms.get("target");
        if (subject && predicate && object) triples.push({ subject: subject.value, predicate: predicate.value, object: sparqlTerm(object) });
      }
      return { keys: [...keys], records, graph: resultGraph(snapshot, triples), summary: text };
}

export function createEmbeddedStore(target: GraphTarget): GraphStore {
  const namedGraph = typeof target.options.namedGraph === "string" ? target.options.namedGraph : "";
  return {
    kind: "EMBEDDED", target, info: graphTargetKindInfo("EMBEDDED"),
    async testConnection() {
      await ensurePlatformSchema();
      return { connected: true, kind: "EMBEDDED", address: "embedded://platform", agent: "内置类型图（PostgreSQL + Graphology + N3.js）", protocolVersion: "SPARQL 1.1", detail: { namedGraph } };
    },
    containsWriteStatement: containsWriteSparql,
    async execute(query, parameters = {}, options = {}) {
      if (options.readOnly && containsWriteSparql(query)) throw new Error("只读模式下不允许执行 SPARQL 更新语句。");
      return runEmbeddedQuery(await activeSnapshot(target.id), namedGraph, query, parameters);
    },
    queryTemplate: () => ({ defaultQuery: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100", placeholder: "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 100", visualizationHint: "以 ?s / ?p / ?o 返回三元组，或用 CONSTRUCT 构造子图。" }),
    async readSchemaGraph() { return { keys: [], records: [], graph: embeddedSchemaGraph(await activeSnapshot(target.id)), summary: "内置类型图" }; },
    async readMeta() {
      const snapshot = await activeSnapshot(target.id);
      return { labels: snapshot.definition.entityTypes.map((item) => item.name), relationshipTypes: snapshot.definition.relationshipTypes.map((item) => item.name),
        propertyKeys: [...new Set([...snapshot.definition.entityTypes, ...snapshot.definition.relationshipTypes]
          .flatMap((item) => item.properties.map((property) => property.name)))] };
    },
    async readRuntimeTypes(): Promise<RuntimeTypeSet> {
      const snapshot = await activeSnapshot(target.id);
      const endpoints = new Map(snapshot.definition.entityTypes.map((item) => [item.id, item.name]));
      const relationshipEndpoints: NonNullable<RuntimeTypeSet["relationshipEndpoints"]> = {};
      for (const item of snapshot.definition.relationshipTypes) relationshipEndpoints[item.name] = { source: endpoints.get(item.sourceEntityTypeId ?? "") ?? "", target: endpoints.get(item.targetEntityTypeId ?? "") ?? "" };
      return { labels: snapshot.definition.entityTypes.map((item) => ({ name: item.name, count: snapshot.nodes.filter((node) => node.labels.includes(item.name)).length, properties: item.properties })),
        relationshipTypes: snapshot.definition.relationshipTypes.map((item) => ({ name: item.name, count: snapshot.relationships.filter((rel) => rel.type === item.name).length, properties: item.properties })),
        entityCount: snapshot.nodes.length, relationshipCount: snapshot.relationships.length, relationshipEndpoints };
    },
    async readGraph(options = {}) { return instanceGraph(await activeSnapshot(target.id), { labels: options.labels?.length ? options.labels : options.label ? [options.label] : [], relationshipTypes: options.relationshipTypes, search: options.search, limit: options.nodeLimit }); },
    async readNeighborhood(id, limit) {
      const snapshot = await activeSnapshot(target.id);
      const relations = snapshot.relationships.filter((rel) => rel.sourceId === id || rel.targetId === id).slice(0, limit);
      const ids = new Set([id, ...relations.flatMap((rel) => [rel.sourceId, rel.targetId])]);
      return { nodes: snapshot.nodes.filter((node) => ids.has(node.id)), relationships: relations.map((rel) => ({ id: rel.id, type: rel.type, source: rel.sourceId, target: rel.targetId, properties: rel.properties })) };
    },
    async listEntities(options = {}) {
      const snapshot = await activeSnapshot(target.id);
      const labels = options.labels?.length ? options.labels : options.label ? [options.label] : [];
      const text = options.search?.toLocaleLowerCase();
      return snapshot.nodes.filter((node) => (!labels.length || node.labels.some((label) => labels.includes(label))) && (!text || JSON.stringify(node.properties).toLocaleLowerCase().includes(text))).slice(0, options.limit ?? 200);
    },
    async readEntity(id) { return (await activeSnapshot(target.id)).nodes.find((node) => node.id === id) ?? null; },
    async searchEntities(options) {
      const text = options.search.toLocaleLowerCase();
      const nodes = await this.listEntities({ labels: options.labels, search: text, limit: options.limit });
      return nodes.map((node) => ({ ...node, rank: 1, matched: Object.keys(node.properties).filter((key) => String(node.properties[key]).toLocaleLowerCase().includes(text)) }));
    },
    async listRelationships(options = {}) {
      const snapshot = await activeSnapshot(target.id);
      const text = options.search?.toLocaleLowerCase();
      return snapshot.relationships.filter((rel) => (!options.type || rel.type === options.type) && (!text || JSON.stringify([rel.type, rel.properties]).toLocaleLowerCase().includes(text))).slice(0, options.limit ?? 200).map((rel) => relationshipRecord(snapshot, rel));
    },
    async exportGraph() {
      const snapshot = await activeSnapshot(target.id);
      return { nodes: snapshot.nodes.map((node) => ({ ...node })), relationships: snapshot.relationships.map((rel) => ({ ...rel })) };
    },
    async replaceGraph(snapshot) {
      // 单行 upsert 是数据库层面的原子操作；查询只见到旧图或新图，不见半成品。
      const repo = await platformRepo(EmbeddedGraphEntity);
      await repo.upsert({ targetId: target.id, snapshot: jsonValue(snapshot), updatedAt: new Date() }, ["targetId"]);
    },
    async clearGraph() { const repo = await platformRepo(EmbeddedGraphEntity); await repo.delete({ targetId: target.id }); },
    async validateDefinition(definition): Promise<GraphViolation[]> {
      const snapshot = await activeSnapshot(target.id);
      const violations: GraphViolation[] = [];
      for (const item of definition.entityTypes) for (const property of item.properties.filter((prop) => prop.required)) {
        const count = snapshot.nodes.filter((node) => node.labels.includes(item.name) && (node.properties[property.name] === undefined || node.properties[property.name] === null)).length;
        if (count) violations.push({ rule: `${item.name}.${property.name}`, message: "存在缺失必填属性的对象实例。", count });
      }
      const names = new Map(definition.entityTypes.map((item) => [item.id, item.name]));
      for (const item of definition.relationshipTypes) {
        const sourceName = names.get(item.sourceEntityTypeId ?? "");
        const targetName = names.get(item.targetEntityTypeId ?? "");
        const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
        const count = snapshot.relationships.filter((rel) => rel.type === item.name && ((!byId.get(rel.sourceId)?.labels.includes(sourceName ?? "")) || (!byId.get(rel.targetId)?.labels.includes(targetName ?? "")))).length;
        if (sourceName && targetName && count) violations.push({ rule: item.name, message: `存在不符合 ${sourceName} -> ${targetName} 端点契约的关系实例。`, count });
        for (const property of item.properties.filter((prop) => prop.required)) {
          const missing = snapshot.relationships.filter((rel) => rel.type === item.name && (rel.properties[property.name] === undefined || rel.properties[property.name] === null)).length;
          if (missing) violations.push({ rule: `${item.name}.${property.name}`, message: "存在缺失必填属性的关系实例。", count: missing });
        }
      }
      return violations;
    },
    async reconcileStrongRules() { return { enforced: false }; },
  };
}
