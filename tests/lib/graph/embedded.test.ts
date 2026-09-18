import { describe, expect, it } from "vitest";
import { embeddedSchemaGraph, runEmbeddedQuery } from "@/lib/graph/embedded";
import { getGraphStore } from "@/lib/graph";
import type { GraphWriteSnapshot } from "@/lib/graph/types";

const snapshot: GraphWriteSnapshot = {
  definition: {
    interfaces: [{ id: "i", name: "可识别对象", extends: [] }],
    entityTypes: [
      { id: "a", name: "客户", implements: ["i"], properties: [{ name: "名称", dataType: "TEXT", required: true, unique: false, indexed: false }] },
      { id: "b", name: "产品", properties: [] },
    ],
    relationshipTypes: [{ name: "订购", sourceEntityTypeId: "a", targetEntityTypeId: "b", properties: [] }],
  },
  nodes: [{ id: "customer-1", labels: ["客户"], properties: { 名称: "张三" } }, { id: "product-1", labels: ["产品"], properties: {} }],
  relationships: [{ id: "link-1", sourceId: "customer-1", targetId: "product-1", type: "订购", properties: {} }],
};

describe("内置本体后端", () => {
  it("通过原有 GraphStore 注册表切换，Jena 仍保留", () => {
    const target = { id: "test", name: "test", kind: "EMBEDDED" as const, uri: "embedded://platform", database_name: "platform", username: "", credential_secret: "", options: {}, created_at: new Date() };
    expect(getGraphStore(target).kind).toBe("EMBEDDED");
    expect(getGraphStore({ ...target, kind: "JENA", uri: "http://localhost:3030", database_name: "ds" }).kind).toBe("JENA");
  });

  it("从版本定义重建类型图、接口实现和关系类型", () => {
    const graph = embeddedSchemaGraph(snapshot);
    expect(graph.nodes.map((node) => node.id)).toEqual(["客户", "产品", "可识别对象"]);
    expect(graph.relationships.map((edge) => edge.type)).toEqual(["implements", "订购"]);
    expect(graph.nodes.find((node) => node.id === "可识别对象")?.properties.isInterface).toBe(true);
  });

  it("在内存 RDF 数据集上执行 SELECT / ASK / CONSTRUCT / DESCRIBE", async () => {
    const select = await runEmbeddedQuery(snapshot, "urn:ontology:test", "SELECT ?s ?p ?o WHERE { ?s ?p ?o } LIMIT 10");
    expect(select.records.length).toBe(10);
    expect(select.graph.nodes.length).toBeGreaterThan(0);
    const ask = await runEmbeddedQuery(snapshot, "urn:ontology:test", "ASK { <urn:bkn:node:customer-1> a <urn:bkn:class:客户> }");
    expect(ask.records).toEqual([{ boolean: true }]);
    const construct = await runEmbeddedQuery(snapshot, "urn:ontology:test", "CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o } LIMIT 5");
    expect(construct.graph.nodes.length).toBeGreaterThan(0);
    const describe = await runEmbeddedQuery(snapshot, "urn:ontology:test", "DESCRIBE <urn:bkn:node:customer-1>");
    expect(describe.graph.nodes.length).toBeGreaterThan(0);
  });

  it("命名图只包含当前本体，拒绝写语句", async () => {
    const own = await runEmbeddedQuery(snapshot, "urn:ontology:test", "ASK { GRAPH <urn:ontology:test> { ?s ?p ?o } }");
    const other = await runEmbeddedQuery(snapshot, "urn:ontology:test", "ASK { GRAPH <urn:ontology:other> { ?s ?p ?o } }");
    expect(own.records).toEqual([{ boolean: true }]);
    expect(other.records).toEqual([{ boolean: false }]);
    await expect(runEmbeddedQuery(snapshot, "urn:ontology:test", "DELETE WHERE { ?s ?p ?o }")).rejects.toThrow("只支持");
  });
});
