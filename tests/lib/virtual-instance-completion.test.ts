import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { applyObjectEdit } from "@/lib/instance/object-service/edit-overlay";
import { changedProperties } from "@/lib/ontology/object-edits";
import type { ObjectRecord } from "@/lib/instance/object-service/types";
import { derivedRowsStatement, derivedCountStatement } from "@/lib/shared/server/sql-guard";

const definition = ontologyDefinitionSchema.parse({ entityTypes: [{ id: "11111111-1111-4111-8111-111111111111", name: "客户", properties: [{ name: "编号", dataType: "TEXT", sourceField: "ID" }, { name: "地区", dataType: "TEXT", sourceField: "AREA" }, { name: "名称", dataType: "TEXT", sourceField: "NAME" }, { name: "金额", dataType: "DECIMAL", sourceField: "FEE" }], sources: [{ id: "main", view: "T", schema: "S", primaryKey: ["ID", "AREA"] }] }] });
const context = { definition, targetId: "target", versionId: "version" };
const original = { 编号: "A", 地区: "371", 名称: "原名", 金额: 10 };
const base = { objectId: "11111111-1111-4111-8111-111111111112", entityType: "客户", properties: { ...original, 金额: 99 }, primaryKey: { ID: "A", AREA: "371" }, title: "原名", origin: "source", objectRef: "客户/AREA=371&ID=A", warnings: [] } satisfies ObjectRecord;

describe("版本编辑层", () => {
  it("源刷新继续更新未改字段，只有改名覆盖源值", () => {
    const snapshot = { definition, nodes: [{ id: base.objectId, labels: ["客户"], properties: { ...original, 名称: "改名" } }], relationships: [], objectEdits: { [base.objectId]: { entityTypeId: definition.entityTypes[0].id, primaryKey: base.primaryKey, base: original } } };
    expect(applyObjectEdit(context, snapshot, base, "客户", base.objectId)?.properties).toEqual({ ...original, 名称: "改名", 金额: 99 });
    snapshot.objectEdits[base.objectId] = { ...snapshot.objectEdits[base.objectId], deleted: true } as typeof snapshot.objectEdits[typeof base.objectId];
    expect(applyObjectEdit(context, snapshot, base, "客户", base.objectId)).toBeNull();
  });
  it("null 和清空值是明确修改；布局不构成业务编辑", () => {
    expect(changedProperties({ a: "old", b: 1 }, { a: null, b: 1, fx: 3 })).toEqual({ a: null });
  });
});
it("复合主键批次保持列值成对，不会读到交叉组合", () => {
  const compiled = derivedRowsStatement("POSTGRES", "SELECT * FROM customer", { keyGroups: [[{ column: "ID", operator: "EQ", value: "A" }, { column: "AREA", operator: "EQ", value: "371" }], [{ column: "ID", operator: "EQ", value: "B" }, { column: "AREA", operator: "EQ", value: "379" }]] }, 20);
  expect(compiled.statement).toContain('("t"."ID" = $1 AND "t"."AREA" = $2) OR ("t"."ID" = $3 AND "t"."AREA" = $4)');
  expect(compiled.params).toEqual(["A", "371", "B", "379"]);
});

it("口径文本检索与总数使用相同的参数条件，MySQL 每个占位符都绑定", () => {
  const query = { search: { text: "A%", columns: ["ID", "NAME"] } };
  const read = derivedRowsStatement("MYSQL", "SELECT * FROM customer", query, 20);
  const count = derivedCountStatement("MYSQL", "SELECT * FROM customer", query);
  expect(read.params).toEqual(["%A\\%%", "%A\\%%"]);
  expect(count.params).toEqual(read.params);
  expect(read.statement).toContain("CAST(`t`.`ID` AS CHAR)");
});
