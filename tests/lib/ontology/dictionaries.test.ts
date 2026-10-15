import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { dictionaryIssues, type EntityDictionary } from "@/lib/ontology/dictionaries";
import { dataSourcesForTable, dictionaryReferencesTo } from "@/lib/reasoning/tools/projection";
import { runReasoningTool } from "@/lib/reasoning/tools";
import { rankSchemaConcepts, schemaConcepts } from "@/lib/reasoning/tools/search";

const dictionary: EntityDictionary = {
  id: "status", name: "用户状态字典", description: "解释业务状态代码", dataSourceId: "resource-a", schema: "GISTOOLS", view: "DIC_STATUS",
  mappings: [{ property: "状态", codeColumn: "CODE", labelColumn: "LABEL" }],
};
const resources = [{ id: "resource-a", name: "业务资源", schema_name: "GISTOOLS" }, { id: "resource-b", name: "其他资源", schema_name: "GISTOOLS" }] as never;
function definition(dictionaries: EntityDictionary[] = [dictionary]) {
  return ontologyDefinitionSchema.parse({ entityTypes: [{
    id: "11111111-1111-4111-8111-111111111111", name: "用户", properties: [{ name: "状态", dataType: "TEXT" }, { name: "地市", dataType: "TEXT" }], dictionaries,
  }] });
}

describe("对象类型的字典引用", () => {
  it("多表、多映射与仅参考引用均可保存，JSON 往返完整保留", () => {
    const input = [dictionary, { ...dictionary, id: "area", name: "地市字典", view: "DIC_AREA", mappings: [] }];
    const parsed = definition(input);
    expect(ontologyDefinitionSchema.parse(JSON.parse(JSON.stringify(parsed))).entityTypes[0].dictionaries).toEqual(input);
    expect(parsed.entityTypes[0].sources).toEqual([]);
    expect(parsed.relationshipTypes).toEqual([]);
    expect(parsed.entityTypes[0].properties[0].enumValues ?? []).toEqual([]);
  });
  it("同一字典表可以解释多个属性", () => {
    expect(dictionaryIssues([{ ...dictionary, mappings: [...dictionary.mappings, { property: "地市", codeColumn: "AREA_CODE", labelColumn: "AREA_NAME" }] }], [{ name: "状态" }, { name: "地市" }])).toEqual([]);
  });
  it("旧定义不会被加入空字典数组，避免改变快照内容", () => {
    const old = ontologyDefinitionSchema.parse({ entityTypes: [{ id: "11111111-1111-4111-8111-111111111111", name: "客户" }] });
    expect(JSON.stringify(old)).not.toContain("dictionaries");
  });
  it("不完整映射不能被当作可用配置保存", () => {
    expect(() => definition([{ ...dictionary, mappings: [{ property: "状态", codeColumn: "", labelColumn: "LABEL" }] }])).toThrow();
    expect(() => definition([{ ...dictionary, dataSourceId: "" }])).toThrow();
  });
  it("拒绝失效的属性映射和一个属性的多个释义来源", () => {
    expect(() => definition([{ ...dictionary, mappings: [{ ...dictionary.mappings[0], property: "已删除" }] }])).toThrow(/不存在的属性/);
    expect(() => definition([dictionary, { ...dictionary, id: "another", name: "另一字典" }])).toThrow(/重复配置/);
  });
  it("字典 id 与名称不能重复，但同一张表可按不同用途登记", () => {
    expect(() => definition([dictionary, { ...dictionary, mappings: [] }])).toThrow(/重复/);
    expect(() => definition([dictionary, { ...dictionary, id: "ref", name: "参考用途", mappings: [] }])).not.toThrow();
  });
  it("查 DDL 能从字典引用定位资源，不把字典伪装为对象来源", () => {
    const parsed = definition();
    expect(dataSourcesForTable(parsed, resources, "gistools", "dic_status").map((item) => item.id)).toEqual(["resource-a"]);
    expect(dictionaryReferencesTo(parsed, "resource-a", "GISTOOLS", "DIC_STATUS")).toEqual([{ object_type: "用户", dictionary: dictionary.name, description: dictionary.description, mappings: dictionary.mappings }]);
    expect(dictionaryReferencesTo(parsed, "resource-b", "GISTOOLS", "DIC_STATUS")).toEqual([]);
  });
  it("按字典名称搜到对象类型及已映射属性，不伪造取值命中", () => {
    const concepts = schemaConcepts(definition(), undefined, resources);
    const hits = rankSchemaConcepts(concepts, "用户状态字典", 10);
    expect(hits.some((item) => item.name === "用户")).toBe(true);
    expect(hits.some((item) => item.name === "用户.状态")).toBe(true);
    expect(concepts.find((item) => item.name === "用户.地市")?.haystack).not.toContain("用户状态字典");
  });
  it("get_object_type 完整返回映射与仅参考状态，保留已有属性信息", async () => {
    const parsed = definition([dictionary, { ...dictionary, id: "area", name: "地区参考", view: "DIC_AREA", mappings: [] }]);
    const result = await runReasoningTool("get_object_type", { type_name: "用户" }, { store: {} as never, definition: parsed, dataSources: resources });
    expect(result.payload).toMatchObject({ name: "用户", properties: [{ name: "状态", data_type: "TEXT" }, { name: "地市", data_type: "TEXT" }], sources: [], dictionaries: [
      { name: "用户状态字典", description: dictionary.description, data_source: "业务资源", schema: "GISTOOLS", view: "DIC_STATUS", usage: "property_mapping", mappings: [{ property: "状态", code_column: "CODE", label_column: "LABEL" }] },
      { name: "地区参考", usage: "reference_only", mappings: [] },
    ] });
  });
  it("批量查询与单类型结果完全一致，超过 30 条映射也不截尾", async () => {
    const properties = Array.from({ length: 40 }, (_, index) => ({ name: `P${index}`, dataType: "TEXT" }));
    const mappings = properties.map((property) => ({ property: property.name, codeColumn: `CODE_${property.name}`, labelColumn: `NAME_${property.name}` }));
    const parsed = ontologyDefinitionSchema.parse({ entityTypes: [{ id: "11111111-1111-4111-8111-111111111111", name: "用户", properties, dictionaries: [{ ...dictionary, mappings }] }] });
    const context = { store: {} as never, definition: parsed, dataSources: resources };
    const single = await runReasoningTool("get_object_type", { type_name: "用户" }, context);
    const batch = await runReasoningTool("get_object_type", { type_names: ["用户"] }, context);
    expect(batch.payload).toMatchObject({ objects: [single.payload] });
    expect(single.payload).toMatchObject({ dictionaries: [{ mappings: mappings.map((mapping) => ({ property: mapping.property, code_column: mapping.codeColumn, label_column: mapping.labelColumn })) }] });
  });
});
