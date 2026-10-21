import { beforeEach, describe, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { objectIdOf, objectRefOf } from "@/lib/ontology/object-identity";
import type { ObjectRecord } from "@/lib/instance/object-service/types";

const mocks = vi.hoisted(() => ({ query: vi.fn(), readByKey: vi.fn(), readVersionSnapshot: vi.fn(), readLinks: vi.fn() }));
vi.mock("@/lib/instance/object-service/ods-source", () => ({ createOdsFirstObjectSource: () => ({ kind: "mock", query: mocks.query, readByKey: mocks.readByKey }) }));
vi.mock("@/lib/versioning/snapshot", () => ({
  readVersionSnapshot: mocks.readVersionSnapshot,
  listVersionRecords: vi.fn(),
  getVersionRecord: vi.fn(async () => ({ id: "version", status: "DRAFT" })),
}));
vi.mock("@/lib/instance/object-service/links", () => ({ queryLinks: mocks.readLinks }));

import { getObject, queryAllObjects, queryObjects } from "@/lib/instance/object-service";
import { readInstanceGraph } from "@/lib/instance/object-service/instance-graph";

const definition = ontologyDefinitionSchema.parse({ entityTypes: ["客户", "用户", "本地类型"].map((name, index) => ({
  id: `11111111-1111-4111-8111-11111111111${index}`, name, indexPolicy: "INDEXED",
  properties: [{ name: "编号", dataType: "TEXT", sourceField: "ID", primaryKey: true }, { name: "地区", dataType: "TEXT", sourceField: "AREA", primaryKey: true }],
  sources: index === 2 ? [] : [{ id: "main", dataSourceId: "99999999-9999-4999-8999-999999999999", view: "T", primaryKey: ["ID", "AREA"] }],
})), relationshipTypes: [] });
const context = { targetId: "target", versionId: "version", definition };
function record(type: string, id: string): ObjectRecord {
  const primaryKey = { ID: id, AREA: "371" };
  return { objectId: objectIdOf(type, primaryKey), entityType: type, primaryKey, title: id, properties: { 编号: id, 地区: "371" }, origin: "source", objectRef: objectRefOf(type, primaryKey), warnings: [] };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readVersionSnapshot.mockResolvedValue({ definition, nodes: [], relationships: [], objectEdits: {} });
  mocks.query.mockImplementation(async (_definition, type, query) => {
    const rows = type === "客户" ? [record(type, "A"), record(type, "B")] : [record(type, "C"), record(type, "D")];
    return { rows: rows.slice(query.offset, query.offset + query.limit), total: rows.length, warnings: [], limit: query.limit };
  });
  mocks.readByKey.mockResolvedValue({ record: record("客户", "A"), warnings: [] });
  mocks.readLinks.mockResolvedValue({ links: [], warnings: [], total: 0, relationshipTypes: [], truncated: false });
});
describe("统一虚拟对象读取", () => {
  it("旧 INDEXED 配置和 origin=index 不访问对象索引", async () => {
    const single = await getObject(context, "客户", { ID: "A", AREA: "371" }, { origin: "index" });
    expect(single?.origin).toBe("source");
    const page = await queryObjects(context, { entityType: "客户", origin: "index", limit: 1 });
    expect(page.rows[0].title).toBe("A");
    expect(mocks.query.mock.calls[0][2].sort).toEqual([{ property: "编号", direction: "ASC" }, { property: "地区", direction: "ASC" }]);
  });
  it("全部标签从未物化类型实时取数，支持跨类型分页", async () => {
    const page = await queryAllObjects(context, { offset: 1, limit: 2 });
    expect(page.rows.map((row) => `${row.entityType}:${row.title}`)).toEqual(["客户:B", "用户:C"]);
    expect(page.total).toBe(4);
    const next = await queryAllObjects(context, { offset: 3, limit: 2 });
    expect(next.rows.map((row) => row.title)).toEqual(["D"]);
  });
  it("只查指定类型；不存在的类型不能静默忽略", async () => {
    expect((await queryAllObjects(context, { labels: ["用户"] })).rows.map((row) => row.title)).toEqual(["C", "D"]);
    await expect(queryAllObjects(context, { labels: ["不存在"] })).rejects.toThrow("不存在");
  });
  it("本地对象与未绑定类型也出现在全部标签里", async () => {
    const local = record("本地类型", "local");
    mocks.readVersionSnapshot.mockResolvedValue({ definition, nodes: [{ id: local.objectId, labels: ["本地类型"], properties: local.properties }], relationships: [], objectEdits: {} });
    const page = await queryAllObjects(context, { limit: 10 });
    expect(page.rows.at(-1)?.properties.编号).toBe("local");
    expect(page.total).toBe(5);
    expect(page.rows.at(-1)?.editMode).toBe("LOCAL");
  });
  it("未知总数不伪造跨类型分页结果", async () => {
    mocks.query.mockResolvedValue({ rows: [record("客户", "A")], total: null, warnings: ["计数不可用"], limit: 20 });
    expect((await queryAllObjects(context)).total).toBeNull();
    await expect(queryAllObjects(context, { offset: 10 })).rejects.toThrow("不能保证跨类型分页不漏项");
  });
  it("删除墓碑和字段覆盖在虚拟列表中继续生效", async () => {
    const original = record("客户", "A");
    mocks.readVersionSnapshot.mockResolvedValue({ definition, nodes: [{ id: original.objectId, labels: ["客户"], properties: original.properties }], relationships: [], objectEdits: { [original.objectId]: { entityTypeId: definition.entityTypes[0].id, primaryKey: original.primaryKey, base: original.properties, deleted: true } } });
    const page = await queryAllObjects(context, { labels: ["客户"] });
    expect(page.rows.map((row) => row.title)).toEqual(["B"]);
    expect(page.total).toBeNull();
  });
  it("无需对象或关系物化即可装配图谱，只画屏内两端", async () => {
    const a = record("客户", "A"), b = record("用户", "C"), outside = record("用户", "outside");
    const link = (target: ObjectRecord) => ({ relationshipType: "拥有", source: a, target, linkRef: target.objectId, properties: {} });
    mocks.readLinks.mockResolvedValue({ links: [link(b), link(outside)], warnings: [], truncated: false });
    const graph = await readInstanceGraph(context, { nodeLimit: 10 });
    expect(graph.nodes).toHaveLength(4);
    expect(graph.relationships).toHaveLength(1);
    expect(graph.warnings.join()).toContain("另一端不在当前展示范围");
    expect(mocks.readLinks.mock.calls[0][1].seed.keys[0]).toEqual({ ID: "A", AREA: "371" });
  });
  it("关系白名单在读源之前生效，避免查询不相关关系", async () => {
    await readInstanceGraph(context, { relationshipTypes: ["拥有"], nodeLimit: 2 });
    expect(mocks.readLinks.mock.calls.every(([ctx]) => ctx.definition.relationshipTypes.every((type: { name: string }) => type.name === "拥有"))).toBe(true);
  });
  it("跨版本查询传入当前映射，不复用旧对象属性", async () => {
    const next = structuredClone(definition);
    next.entityTypes[0].properties[0].sourceField = "NEW_ID";
    await queryObjects({ ...context, versionId: "next-version", definition: next }, { entityType: "客户" });
    expect(mocks.query.mock.calls[0][0].entityTypes[0].properties[0].sourceField).toBe("NEW_ID");
  });
  it("图谱主键重复必须报告合并数", async () => {
    const row = record("客户", "A");
    mocks.query.mockResolvedValue({ rows: [row, row], total: 2, warnings: [], limit: 20 });
    const graph = await readInstanceGraph(context, { labels: ["客户"], nodeLimit: 20 });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.warnings.join()).toContain("主键重复");
    expect(graph.warnings.join()).toContain("只显示每个身份一行");
  });
  it("对象列表按身份去重并明确报告源主键重复", async () => {
    const row = record("客户", "A");
    mocks.query.mockResolvedValue({ rows: [row, row, { ...row, properties: { ...row.properties, 地区: "999" } }], total: 3, warnings: [], limit: 20 });
    const result = await queryObjects(context, { entityType: "客户" });
    expect(result.rows).toHaveLength(1);
    expect(result.total).toBe(3);
    expect(result.warnings.join()).toContain("有 2 行与其他行形成相同的对象身份");
  });
  it("主键不完整时保留行但提示无法稳定识别", async () => {
    const noKey = { ...record("客户", ""), objectId: "", primaryKey: {}, objectRef: "客户/" };
    mocks.query.mockResolvedValue({ rows: [noKey], total: 1, warnings: [], limit: 20 });
    const result = await queryObjects(context, { entityType: "客户" });
    expect(result.rows).toHaveLength(1);
    expect(result.warnings.join()).toContain("主键不完整");
  });
  it("某个类型不可读时展示其它类型并明确报告不完整", async () => {
    mocks.query.mockImplementation(async (_definition, type) => {
      if (type === "客户") throw new Error("source offline");
      return { rows: [record(type, "C")], total: 1, warnings: [], limit: 20 };
    });
    const page = await queryAllObjects(context);
    expect(page.rows[0].entityType).toBe("用户");
    expect(page.total).toBeNull();
    expect(page.warnings.join()).toContain("结果不完整：source offline");
    await expect(queryAllObjects(context, { offset: 1 })).rejects.toThrow("无法保证跨类型分页完整");
  });
  it("关系源失败不读取旧边，保留节点并报告不完整", async () => {
    mocks.readLinks.mockRejectedValue(new Error("link source offline"));
    const graph = await readInstanceGraph(context, { nodeLimit: 10 });
    expect(graph.nodes).toHaveLength(4);
    expect(graph.relationships).toHaveLength(0);
    expect(graph.warnings.join()).toContain("关系不完整：link source offline");
  });
  it("交互页拿满一页就停止类型扇出，不为总数继续查其它表", async () => {
    const result = await queryAllObjects(context, { limit: 2, count: false });
    expect(result.rows).toHaveLength(2);
    expect(result.total).toBeNull();
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0][2].count).toBe(false);
    expect(result.warnings.join()).toContain("未继续查询其它类型");
  });
  it("取消的交互请求不再读取下一张表", async () => {
    const controller = new AbortController();
    mocks.query.mockImplementationOnce(async () => {
      controller.abort();
      return { rows: [record("客户", "A")], total: 1, warnings: [], limit: 20 };
    });
    await expect(queryAllObjects(context, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});
