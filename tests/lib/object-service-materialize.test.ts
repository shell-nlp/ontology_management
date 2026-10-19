import { expect, it, vi } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";

const mocks = vi.hoisted(() => ({
  sourceQuery: vi.fn(),
  syncTargetObjects: vi.fn(),
  countTypeObjects: vi.fn(),
  saveMaterialization: vi.fn(),
}));

vi.mock("@/lib/instance/object-service/data-source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/instance/object-service/data-source")>();
  return { ...actual, createDataSourceObjectSource: () => ({ query: mocks.sourceQuery }) };
});

vi.mock("@/lib/infrastructure/object-index", () => ({
  getObjectIndex: () => ({
    syncTargetObjects: mocks.syncTargetObjects,
    countTypeObjects: mocks.countTypeObjects,
    saveMaterialization: mocks.saveMaterialization,
  }),
}));

import { materializeObjectType } from "@/lib/instance/object-service";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [{
    id: "11111111-1111-4111-8111-111111111111",
    name: "客户",
    properties: [{ name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" }],
    sources: [{ id: "primary", schema: "S", view: "T", primaryKey: ["CUST_ID"] }],
  }],
  relationshipTypes: [],
});

function record(id: string, key: string) {
  return {
    objectId: id,
    entityType: "客户",
    primaryKey: { 客户编号: key },
    title: key,
    properties: { 客户编号: key },
    origin: "source" as const,
    objectRef: `客户/客户编号=${key}`,
    warnings: [],
  };
}

it("主键游标漏读后自动用 OFFSET 读全，再按对象键计折叠", async () => {
  mocks.sourceQuery.mockImplementation(async (_definition, _entityType, query) => {
    if (query.cursor) {
      return query.cursor.values
        ? { rows: [record("c", "C")], total: null, warnings: [] }
        : { rows: [record("a1", "A"), record("b1", "B")], total: 4, warnings: [] };
    }
    const offset = query.offset ?? 0;
    if (offset === 0) return { rows: [record("a1", "A"), record("a2", "A")], total: 4, warnings: [] };
    if (offset === 2) return { rows: [record("b1", "B"), record("c1", "C")], total: null, warnings: [] };
    return { rows: [], total: null, warnings: [] };
  });
  mocks.syncTargetObjects.mockResolvedValue({ upserted: 3, total: 3 });
  mocks.countTypeObjects.mockResolvedValue(3);
  mocks.saveMaterialization.mockResolvedValue(undefined);

  const result = await materializeObjectType({ targetId: "target", versionId: "version", definition }, "客户", { pageSize: 2 });
  expect(result).toMatchObject({ scanned: 4, folded: 1, total: 4, truncated: false });
  expect(result.warnings.some((warning) => warning.includes("已自动改用 OFFSET"))).toBe(true);
  expect(mocks.saveMaterialization).toHaveBeenCalledWith(expect.objectContaining({ sourceRows: 4, scanned: 4, folded: 1 }));
});
