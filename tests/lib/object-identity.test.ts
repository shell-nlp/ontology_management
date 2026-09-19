import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import {
  canonicalPrimaryKey,
  objectIdOf,
  objectKeyOf,
  objectRefOf,
  parsePrimaryKeyInput,
  primaryKeyConflicts,
  primaryKeyFromProperties,
  resolveObjectIdentity,
} from "@/lib/object-identity";

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const definition = ontologyDefinitionSchema.parse({
  entityTypes: [
    {
      id: CUSTOMER_ID,
      name: "客户",
      displayProperty: "客户名称",
      properties: [
        { name: "客户编号", dataType: "TEXT", sourceField: "cust_id" },
        { name: "地区编码", dataType: "TEXT", sourceField: "area_code" },
        { name: "客户名称", dataType: "TEXT", sourceField: "cust_name" },
      ],
      sources: [{ id: "primary", schema: "GISTOOLS", view: "TB_CUST", primaryKey: ["cust_id", "area_code"], titleField: "cust_name" }],
    },
    { id: USER_ID, name: "用户", properties: [{ name: "user_id", dataType: "TEXT" }] },
  ],
  relationshipTypes: [],
});

const customer = definition.entityTypes[0];

describe("对象身份", () => {
  it("同一个对象类型 + 同一组主键值，无论字段顺序都推同一个 id", () => {
    const left = objectIdOf("客户", { cust_id: "1001", area_code: "371" });
    const right = objectIdOf("客户", { area_code: "371", cust_id: "1001" });
    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("对象类型不同 / 主键值不同都会换 id，主键为空时没有身份", () => {
    expect(objectIdOf("客户", { cust_id: "1001" })).not.toBe(objectIdOf("用户", { cust_id: "1001" }));
    expect(objectIdOf("客户", { cust_id: "1001" })).not.toBe(objectIdOf("客户", { cust_id: "1002" }));
    expect(objectIdOf("客户", {})).toBe("");
  });

  it("主键串里转义 & 与 =，不同结构不会撞成同一个键", () => {
    expect(canonicalPrimaryKey({ a: "b&c=d" })).not.toBe(canonicalPrimaryKey({ a: "b", c: "d" }));
    expect(objectKeyOf("客户", { a: "b&c=d" })).not.toBe(objectKeyOf("客户", { a: "b", c: "d" }));
  });

  it("列名与值一起进对象键：同一个对象类型 + 同一个主键 = 同一个键", () => {
    expect(objectKeyOf("客户", { cust_id: "1001" })).toBe(objectKeyOf("客户", { cust_id: "1001" }));
    expect(objectKeyOf("客户", { cust_id: "1001" })).not.toBe(objectKeyOf("客户", { cust_id: "1001", area_code: "371" }));
  });
});

describe("从对象属性取主键", () => {
  it("按 sourceField 映射取值（值按去空格口径，Oracle CHAR 的补空格不影响）", () => {
    const { primaryKey, missing } = primaryKeyFromProperties(customer, { 客户编号: " 1001 ", 地区编码: "371       " });
    expect(primaryKey).toEqual({ cust_id: "1001", area_code: "371" });
    expect(missing).toEqual([]);
  });

  it("缺列如实报出来，且不给出半截身份", () => {
    const { primaryKey, missing } = primaryKeyFromProperties(customer, { 客户编号: "1001" });
    expect(primaryKey).toEqual({ cust_id: "1001" });
    expect(missing).toEqual(["area_code"]);
    expect(resolveObjectIdentity(customer, { 客户编号: "1001" })).toBeNull();
  });

  it("没绑数据来源的对象类型没有身份（退回随机 id 由调用方处理）", () => {
    const user = definition.entityTypes[1];
    expect(resolveObjectIdentity(user, { user_id: "u-1" })).toBeNull();
  });
});

describe("主键入参解析与引用串", () => {
  it("解析 `列=值&列=值`，忽略缺值段", () => {
    expect(parsePrimaryKeyInput("cust_id=1001&area_code=371")).toEqual({ cust_id: "1001", area_code: "371" });
    expect(parsePrimaryKeyInput("cust_id=&area_code=371")).toEqual({ area_code: "371" });
    expect(parsePrimaryKeyInput("坏输入")).toEqual({});
  });

  it("引用串是「对象类型/主键串」，没主键时只剩对象类型名", () => {
    expect(objectRefOf("客户", { cust_id: "1001" })).toBe("客户/cust_id=1001");
    expect(objectRefOf("客户", {})).toBe("客户");
  });
});

describe("主键冲突", () => {
  it("同一个对象类型里主键相同即为冲突，不同对象类型不算", () => {
    const conflicts = primaryKeyConflicts(definition, [
      { id: "a", labels: ["客户"], properties: { 客户编号: "1001", 地区编码: "371" } },
      { id: "b", labels: ["客户"], properties: { 客户编号: "1001", 地区编码: "371" } },
      { id: "c", labels: ["用户"], properties: { user_id: "1001" } },
      { id: "d", labels: ["客户"], properties: { 客户编号: "1002", 地区编码: "371" } },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].typeName).toBe("客户");
    expect(conflicts[0].ids.sort()).toEqual(["a", "b"]);
  });
});
