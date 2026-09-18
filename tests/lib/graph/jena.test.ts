import { describe, expect, it } from "vitest";
import { DEFAULT_SINGLE_REPLACE_LIMIT, applyEndpointHostAlias, bindSparqlParameters, containsWriteSparql, iriSegment, localName, nodeIdFromTerm, parseHostAliases, parseNTriples, planReplaceRequests, resolveSparqlEndpoints, schemaStatements, scopedQueryUrl, sparqlQueryForm, termForId, termValue } from "@/lib/graph/jena";
import { dataTypeFromSparqlDatatype, sparqlLiteral, valueFromSparqlLiteral } from "@/lib/graph/schema-inference";
import type { GraphDefinitionLike, GraphTarget } from "@/lib/graph/types";

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

describe("图库端点的主机别名（GRAPH_ENDPOINT_HOST_ALIAS）", () => {
  it("把库里登记的主机换成部署侧能到的那个", () => {
    // 容器里 localhost 是容器自己；同一个 compose 里的 Fuseki 用服务名就能到。
    expect(applyEndpointHostAlias("http://localhost:3030/ds", "localhost=fuseki")).toBe("http://fuseki:3030/ds");
    expect(applyEndpointHostAlias("http://localhost:3030/ds/query", "localhost=fuseki")).toBe("http://fuseki:3030/ds/query");
  });

  it("右边可以写主机:端口；只写主机时保留原端口", () => {
    expect(applyEndpointHostAlias("http://localhost:3030/ds", "localhost=host.docker.internal:3031")).toBe("http://host.docker.internal:3031/ds");
    expect(applyEndpointHostAlias("http://localhost:3030/ds", "localhost=other")).toBe("http://other:3030/ds");
  });

  it("多条规则用逗号分隔，空白与大小写不影响；没命中就原样返回", () => {
    expect(parseHostAliases(" localhost = fuseki , a=b ")).toEqual(new Map([["localhost", "fuseki"], ["a", "b"]]));
    expect(applyEndpointHostAlias("http://LOCALHOST:3030/ds", "localhost=fuseki")).toBe("http://fuseki:3030/ds");
    expect(applyEndpointHostAlias("http://example.com:3030/ds", "localhost=fuseki")).toBe("http://example.com:3030/ds");
    expect(applyEndpointHostAlias("http://localhost:3030/ds", undefined)).toBe("http://localhost:3030/ds");
    expect(applyEndpointHostAlias("http://localhost:3030/ds", "")).toBe("http://localhost:3030/ds");
  });

  it("不合法或残缺的地址原样返回，不吞掉后续本来的报错", () => {
    expect(applyEndpointHostAlias("not a url", "localhost=fuseki")).toBe("not a url");
    // 只有一半的规则（没有右边）不算规则。
    expect(parseHostAliases("localhost=").size).toBe(0);
  });

  it("resolveSparqlEndpoints 会带上别名（读的是环境变量）", () => {
    const previous = process.env.GRAPH_ENDPOINT_HOST_ALIAS;
    process.env.GRAPH_ENDPOINT_HOST_ALIAS = "localhost=fuseki";
    try {
      expect(resolveSparqlEndpoints(target()).query).toBe("http://fuseki:3030/ds/query");
      expect(resolveSparqlEndpoints(target({ options: { queryEndpoint: "http://localhost:3030/ds/query" } })).query).toBe("http://fuseki:3030/ds/query");
    } finally {
      if (previous === undefined) delete process.env.GRAPH_ENDPOINT_HOST_ALIAS;
      else process.env.GRAPH_ENDPOINT_HOST_ALIAS = previous;
    }
  });
});

describe("工作台查询的数据集限定", () => {
  it("配了命名图时，把它设成这次查询的默认图，并登记成命名图", () => {
    const endpoints = resolveSparqlEndpoints(target({ options: { namedGraph: "urn:ontology:abc" } }));
    const url = scopedQueryUrl(endpoints);
    expect(url).toBe("http://localhost:3030/ds/query?default-graph-uri=urn%3Aontology%3Aabc&named-graph-uri=urn%3Aontology%3Aabc");
  });

  it("端点本身带查询串时用 & 接，不吞掉原有参数", () => {
    const endpoints = resolveSparqlEndpoints(target({ options: { queryEndpoint: "http://host/q?timeout=30", namedGraph: "urn:g" } }));
    expect(scopedQueryUrl(endpoints)).toBe("http://host/q?timeout=30&default-graph-uri=urn%3Ag&named-graph-uri=urn%3Ag");
  });

  it("没配命名图时原样返回：那个本体就住在默认图里，不该乱限定", () => {
    expect(scopedQueryUrl(resolveSparqlEndpoints(target()))).toBe("http://localhost:3030/ds/query");
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

describe("schemaStatements", () => {
  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
  const OWL_OBJECT_PROPERTY = "http://www.w3.org/2002/07/owl#ObjectProperty";
  const SUBCLASS = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
  const DOMAIN = "http://www.w3.org/2000/01/rdf-schema#domain";
  const RANGE = "http://www.w3.org/2000/01/rdf-schema#range";

  function definition(): GraphDefinitionLike {
    return {
      entityTypes: [
        { id: "t-user", name: "用户", properties: [] },
        { id: "t-line", name: "专线产品用户", properties: [] },
      ],
      relationshipTypes: [
        { name: "下单", sourceEntityTypeId: "t-user", targetEntityTypeId: "t-line", properties: [] },
      ],
    };
  }

  it("每个类同时声明 owl:Class 与平台的元模型标记", () => {
    const statements = schemaStatements(definition());
    for (const name of ["用户", "专线产品用户"]) {
      expect(statements).toContain(`<urn:bkn:class:${name}> <${RDF_TYPE}> <${OWL_CLASS}> .`);
      expect(statements).toContain(`<urn:bkn:class:${name}> <${RDF_TYPE}> <urn:bkn:Class> .`);
    }
  });

  // 类之间不再有父子继承（2026-09-16 移除）：没有父类，就没有隐式继承带来的 subClassOf。
  it("对象类型之间不写 rdfs:subClassOf（抽象只走接口）", () => {
    const statements = schemaStatements(definition());
    expect(statements.some((statement) => statement.includes(`<urn:bkn:class:专线产品用户> <${SUBCLASS}>`))).toBe(false);
  });

  it("关系类型写 domain / range，并带上元模型标记", () => {
    const statements = schemaStatements(definition());
    expect(statements).toContain(`<urn:bkn:reltype:下单> <${RDF_TYPE}> <${OWL_OBJECT_PROPERTY}> .`);
    expect(statements).toContain("<urn:bkn:reltype:下单> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:bkn:Property> .");
    expect(statements).toContain(`<urn:bkn:reltype:下单> <${DOMAIN}> <urn:bkn:class:用户> .`);
    expect(statements).toContain(`<urn:bkn:reltype:下单> <${RANGE}> <urn:bkn:class:专线产品用户> .`);
  });

  it("接口声明成抽象类，接口之间的继承与对象类型的实现都写进元模型", () => {
    const statements = schemaStatements({
      interfaces: [
        { id: "i-asset", name: "资产" },
        { id: "i-facility", name: "设施", extends: ["i-asset"] },
      ],
      entityTypes: [
        { id: "t-airport", name: "机场", implements: ["i-facility"], properties: [] },
        { id: "t-plant", name: "工厂", implements: ["i-missing"], properties: [] },
      ],
      relationshipTypes: [],
    });
    expect(statements).toContain(`<urn:bkn:class:设施> <${RDF_TYPE}> <urn:bkn:Interface> .`);
    expect(statements).toContain(`<urn:bkn:class:设施> <${SUBCLASS}> <urn:bkn:class:资产> .`);
    // 实现也写 subClassOf：读路径的类型传播才能"按接口筛对象"。
    expect(statements).toContain(`<urn:bkn:class:机场> <${SUBCLASS}> <urn:bkn:class:设施> .`);
    expect(statements).toContain("<urn:bkn:class:机场> <urn:bkn:implements> <urn:bkn:class:设施> .");
    // 找不到的接口 id 跳过，不写指向空节点的三元组。
    expect(statements.some((statement) => statement.includes("t-missing") || statement.includes("i-missing"))).toBe(false);
  });  it("端点没指定就不写 domain / range", () => {
    const statements = schemaStatements({
      entityTypes: [{ id: "t-user", name: "用户", properties: [] }],
      relationshipTypes: [{ name: "泛关系", properties: [] }],
    });
    expect(statements.some((statement) => statement.includes(DOMAIN) || statement.includes(RANGE))).toBe(false);
  });
});
