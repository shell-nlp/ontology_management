import { beforeEach, expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import type { LinkPlan } from "@/lib/ontology/link-source";
const mocks = vi.hoisted(() => ({ findOne: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/infrastructure/persistence/postgres", () => ({ OdsSourceEntity: class {}, platformRepo: async () => ({ findOne: mocks.findOne }) }));
vi.mock("@/lib/infrastructure/ods", () => ({ getOdsStore: () => ({ read: mocks.read }) }));
import { readOdsLinkRows } from "@/lib/instance/object-service/link-rows";

const definition = ontologyDefinitionSchema.parse({ entityTypes: [{ id: "11111111-1111-4111-8111-111111111111", name: "客户", properties: [], sources: [{ id: "main", dataSourceId: "99999999-9999-4999-8999-999999999999", schema: "S", view: "T", readMode: "AUTO" }] }] });
const context = { targetId: "target", versionId: "version", definition };
const plan = { ok: true, mode: "FOREIGN_KEY", dataSourceId: "99999999-9999-4999-8999-999999999999", table: { schema: "S", name: "T" }, holder: { entityTypeName: "客户" } } as LinkPlan & { ok: true };
beforeEach(() => {
  vi.clearAllMocks();
  definition.entityTypes[0].sources[0].readMode = "AUTO";
  mocks.findOne.mockResolvedValue({ id: "ods-id", chTable: "ods_table", status: "READY", columns: [{ name: "ID" }, { name: "AREA" }] });
  mocks.read.mockResolvedValue({ rows: [{ ID: "A", AREA: "371" }], total: 1, truncated: false });
});
it("关系按需读取 READY ODS，不需要对象或边物化", async () => {
  const groups = [[{ column: "ID", operator: "EQ" as const, value: "A" }, { column: "AREA", operator: "EQ" as const, value: "371" }]];
  const result = await readOdsLinkRows(context, plan, ["ID", "AREA"], [], groups, 20);
  expect(result?.total).toBe(1);
  expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({ keyGroups: groups, columns: ["ID", "AREA"], limit: 20 }));
});
it("DIRECT 不探查 ODS 配置", async () => {
  definition.entityTypes[0].sources[0].readMode = "DIRECT";
  expect(await readOdsLinkRows(context, plan, ["ID"], [], undefined, 20)).toBeNull();
  expect(mocks.findOne).not.toHaveBeenCalled();
});
it("AUTO 缺少镜像或列时交还业务源", async () => {
  mocks.findOne.mockResolvedValue(null);
  expect(await readOdsLinkRows(context, plan, ["ID"], [], undefined, 20)).toBeNull();
  mocks.findOne.mockResolvedValue({ status: "READY", columns: [] });
  expect(await readOdsLinkRows(context, plan, ["ID"], [], undefined, 20)).toBeNull();
  expect(mocks.read).not.toHaveBeenCalled();
});
it("显式 ODS 镜像缺失或列不全必须报错", async () => {
  definition.entityTypes[0].sources[0].readMode = "ODS";
  mocks.findOne.mockResolvedValue({ status: "READY", columns: [] });
  await expect(readOdsLinkRows(context, plan, ["ID"], [], undefined, 20)).rejects.toThrow("缺少列");
  mocks.findOne.mockResolvedValue({ status: "FAILED", columns: [{ name: "ID" }] });
  await expect(readOdsLinkRows(context, plan, ["ID"], [], undefined, 20)).rejects.toThrow("READY");
});
it("ODS 执行失败不悄悄改查源库", async () => {
  mocks.read.mockRejectedValue(new Error("mirror unavailable"));
  await expect(readOdsLinkRows(context, plan, ["ID"], [], undefined, 20)).rejects.toThrow("mirror unavailable");
});
