import { describe, expect, it } from "vitest";
import { DEFAULT_SINGLE_REPLACE_LIMIT, bindSparqlParameters, containsWriteSparql, iriSegment, localName, nodeIdFromTerm, parseNTriples, planReplaceRequests, resolveSparqlEndpoints, sparqlQueryForm, termForId, termValue } from "@/lib/graph/jena";
import { dataTypeFromSparqlDatatype, sparqlLiteral, valueFromSparqlLiteral } from "@/lib/graph/schema-inference";
import type { GraphTarget } from "@/lib/graph/types";

function target(overrides: Partial<GraphTarget> = {}): GraphTarget {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "jena",
    kind: "JENA",
    uri: "http://localhost:3030",
    database_name: "ds",
    username: "",
    credential_secret: "",
    options: {},
    created_at: new Date(),
    ...overrides,
  };
}

describe("resolveSparqlEndpoints", () => {
  it("由服务地址与数据集名推导 Fuseki 端点", () => {
    expect(resolveSparqlEndpoints(target())).toMatchObject({ query: "http://localhost:3030/ds/query", update: "http://localhost:3030/ds/update", dataset: "ds", namedGraph: null });
  });

  it("接受统一端点与单端点写法，并处理末尾斜杠", () => {
    expect(resolveSparqlEndpoints(target({ uri: "http://localhost:3030/ds/sparql" })).query).toBe("http://localhost:3030/ds/sparql");
    expect(resolveSparqlEndpoints(target({ uri: "http://localhost:3030/ds/sparql" })).update).toBe("http://localhost:3030/ds/sparql");
    expect(resolveSparqlEndpoints(target({ uri: "http://localhost:3030/ds/query/" })).update).toBe("http://localhost:3030/ds/update");
    expect(resolveSparqlEndpoints(target({ uri: "http://localhost:3030/ds/" })).query).toBe("http://localhost:3030/ds/query");
  });

  it("允许用 options 显式覆盖端点与命名图", () => {
    const endpoints = resolveSparqlEndpoints(target({ options: { queryEndpoint: "http://host/q", updateEndpoint: "http://host/u", namedGraph: "urn:ontology" } }));
    expect(endpoints).toMatchObject({ query: "http://host/q", update: "http://host/u", namedGraph: "urn:ontology" });
  });
});

describe("RDF 名词转换", () => {
  it("支持应用自有的 urn 命名与本体的 hash/slash 命名", () => {
    expect(localName("urn:bkn:class:指标")).toBe("指标");
    expect(localName("http://example.org/onto#Person")).toBe("Person");
    expect(localName("http://example.org/onto/Person")).toBe("Person");
  });

  it("转义 IRI 非法字符后可以还原", () => {
    const raw = "指标 口径#1";
    expect(iriSegment(raw)).toBe("指标%20口径%231");
    expect(localName(`urn:bkn:class:${iriSegment(raw)}`)).toBe(raw);
  });

  it("对象 id 与 SPARQL 主语项互转", () => {
    expect(termForId("32ae1a46-faa1-485b-8dbc-44c63481c8f5")).toBe("urn:bkn:node:32ae1a46-faa1-485b-8dbc-44c63481c8f5");
    expect(termForId("http://example.org/Person/1")).toBe("http://example.org/Person/1");
    expect(termForId("_:b0")).toBe("_:b0");
    expect(nodeIdFromTerm("urn:bkn:node:32ae1a46-faa1-485b-8dbc-44c63481c8f5")).toBe("32ae1a46-faa1-485b-8dbc-44c63481c8f5");
    expect(nodeIdFromTerm("http://example.org/Person/1")).toBe("http://example.org/Person/1");
  });
});

describe("bindSparqlParameters", () => {
  it("把字符串、数字与实例 id 绑定成合法 SPARQL 项", () => {
    expect(bindSparqlParameters("FILTER(?x = $name)", { name: "营 收" })).toBe('FILTER(?x = "营 收")');
    expect(bindSparqlParameters("LIMIT $limit", { limit: 10 })).toBe("LIMIT 10");
    expect(bindSparqlParameters("VALUES ?s { $focus }", { focus: "32ae1a46-faa1-485b-8dbc-44c63481c8f5" })).toBe("VALUES ?s { <urn:bkn:node:32ae1a46-faa1-485b-8dbc-44c63481c8f5> }");
  });

  it("不替换 IRI、字面量与注释中的同名片段", () => {
    expect(bindSparqlParameters("SELECT ?s WHERE { ?s <http://x/$name> ?o } # $name", { name: "v" })).toBe('SELECT ?s WHERE { ?s <http://x/$name> ?o } # $name');
  });
});

describe("parseNTriples", () => {
  it("解析字面量、数据类型、bnode 与转义序列", () => {
    const triples = parseNTriples('<urn:a> <urn:p> "行\\n名"^^<http://www.w3.org/2001/XMLSchema#string> .\n<urn:a> <urn:q> <urn:b> .\n_:b0 <urn:r> "x"@zh .\n');
    expect(triples).toHaveLength(3);
    expect(termValue({ type: triples[0].object.type, value: triples[0].object.value, datatype: triples[0].object.datatype })).toBe("行\n名");
    expect(triples[1].object.type).toBe("uri");
    expect(termValue({ type: "bnode", value: triples[2].subject.value.replace(/^_:/, "") })).toBe("_:b0");
  });
});

describe("SPARQL 表单与写保护", () => {
  it("跳过 PREFIX 与注释识别查询表单", () => {
    expect(sparqlQueryForm("# 注释\nPREFIX bkn: <urn:bkn:>\nSELECT * WHERE { ?s ?p ?o }")).toBe("SELECT");
    expect(sparqlQueryForm("CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }")).toBe("CONSTRUCT");
  });

  it("识别 SPARQL 更新语句", () => {
    expect(containsWriteSparql("INSERT DATA { <a> <b> <c> }")).toBe(true);
    expect(containsWriteSparql("DELETE WHERE { ?s ?p ?o }")).toBe(true);
    expect(containsWriteSparql("SELECT ?s WHERE { ?s ?p ?o }")).toBe(false);
  });
});

describe("RDF 字面量与数据类型", () => {
  it("按数据类型往返转换", () => {
    expect(sparqlLiteral(12, "INTEGER")).toBe("12");
    expect(sparqlLiteral(true, "BOOLEAN")).toBe("true");
    expect(sparqlLiteral("营业收入", "TEXT")).toBe('"营业收入"^^<http://www.w3.org/2001/XMLSchema#string>');
    expect(sparqlLiteral({ a: 1 }, "JSON")).toBe('"{\\"a\\":1}"^^<urn:bkn:json>');
    expect(dataTypeFromSparqlDatatype("http://www.w3.org/2001/XMLSchema#decimal")).toBe("DECIMAL");
    expect(dataTypeFromSparqlDatatype("urn:bkn:json")).toBe("JSON");
    expect(valueFromSparqlLiteral("0.92", "http://www.w3.org/2001/XMLSchema#decimal")).toBe(0.92);
  });
});

describe("planReplaceRequests", () => {
  it("小图把清空与插入放进同一个请求——单个 update 请求才是事务性的", () => {
    const plan = planReplaceRequests(['<urn:a> <urn:b> "1" .'], { namedGraph: null });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toBe('CLEAR SILENT DEFAULT ;\nINSERT DATA { <urn:a> <urn:b> "1" . }');
    expect(plan.cleanup).toBeNull();
  });

  it("命名图只清空目标图，并写回同一个图", () => {
    const plan = planReplaceRequests(['<urn:a> <urn:b> "1" .'], { namedGraph: "urn:g" });
    expect(plan.requests).toHaveLength(1);
    expect(plan.requests[0]).toContain("CLEAR SILENT GRAPH <urn:g> ;");
    expect(plan.requests[0]).toContain('INSERT DATA { GRAPH <urn:g> { <urn:a> <urn:b> "1" . } }');
    expect(plan.cleanup).toBeNull();
  });

  it("空快照只清空，不构造非法的空 INSERT", () => {
    const plan = planReplaceRequests([], { namedGraph: null });
    expect(plan.requests).toEqual(["CLEAR SILENT DEFAULT"]);
    expect(plan.cleanup).toBeNull();
  });

  it("大图先写影子图，最后一个请求才原子切换，并带回兜底清理", () => {
    const statements = Array.from({ length: 1001 }, (_, index) => `<urn:s:${index}> <urn:p> "v${index}" .`);
    const plan = planReplaceRequests(statements, { namedGraph: "urn:g", singleRequestLimit: 1000 });
    expect(plan.requests).toHaveLength(4); // 500 + 500 + 1 批写入，再 +1 次切换
    const [first, second, third, swap] = plan.requests;
    expect(first).toMatch(/^INSERT DATA \{ GRAPH <urn:bkn:staging:[0-9a-f-]+> \{/);
    expect(first).not.toContain("CLEAR");
    expect(second).toMatch(/^INSERT DATA \{ GRAPH <urn:bkn:staging:[0-9a-f-]+> \{/);
    expect(third).toContain('<urn:s:1000> <urn:p> "v1000" .');
    expect(swap).toMatch(/^CLEAR SILENT GRAPH <urn:g> ;\nADD <urn:bkn:staging:[0-9a-f-]+> TO <urn:g> ;\nDROP SILENT GRAPH <urn:bkn:staging:[0-9a-f-]+>$/);
    expect(plan.cleanup).toMatch(/^DROP SILENT GRAPH <urn:bkn:staging:[0-9a-f-]+>$/);
    // 同一次计划里影子图必须是同一个
    const staging = /urn:bkn:staging:[0-9a-f-]+/.exec(first!)![0];
    expect(swap).toContain(staging);
    expect(plan.cleanup).toContain(staging);
  });

  it("默认图的大图切换走 ADD ... TO DEFAULT", () => {
    const plan = planReplaceRequests(['<urn:a> <urn:b> "1" .', '<urn:a> <urn:b> "2" .'], { namedGraph: null, singleRequestLimit: 1 });
    expect(plan.requests).toHaveLength(2);
    expect(plan.requests[1]).toMatch(/^CLEAR SILENT DEFAULT ;\nADD <urn:bkn:staging:[0-9a-f-]+> TO DEFAULT ;/);
  });

  it("默认单请求上限是给发布用的保守值", () => {
    expect(DEFAULT_SINGLE_REPLACE_LIMIT).toBe(5000);
  });
});
