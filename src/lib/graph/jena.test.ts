import { describe, expect, it } from "vitest";
import { bindSparqlParameters, containsWriteSparql, iriSegment, localName, nodeIdFromTerm, parseNTriples, resolveSparqlEndpoints, sparqlQueryForm, termForId, termValue } from "@/lib/graph/jena";
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

  it("实体 id 与 SPARQL 主语项互转", () => {
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
