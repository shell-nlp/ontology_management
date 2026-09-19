import { describe, expect, it } from "vitest";
import {
  checkImplementations,
  effectiveInterfaceLinkConstraints,
  effectiveInterfaceProperties,
  implementersOf,
  interfaceLineage,
  resolveInterfacePropertyMappings,
  validateInterfaceImplementations,
  validateInterfaces,
} from "@/lib/interfaces";

const facility = "11111111-1111-4111-8111-111111111111";
const asset = "22222222-2222-4222-8222-222222222222";
const airport = "33333333-3333-4333-8333-333333333333";
const airline = "44444444-4444-4444-8444-444444444444";
const flightAlert = "55555555-5555-4555-8555-555555555555";
const alertInterface = "66666666-6666-4666-8666-666666666666";
const link1 = "77777777-7777-4777-8777-777777777777";
const link2 = "88888888-8888-4888-8888-888888888888";
const link3 = "99999999-9999-4999-8999-999999999999";

const interfaces = [
  { id: asset, name: "资产", properties: [{ name: "资产编号", required: true }], extends: [], linkConstraints: [] },
  {
    id: facility,
    name: "设施",
    properties: [{ name: "设施名称", required: true }, { name: "位置", required: false }],
    extends: [asset],
    linkConstraints: [{ id: link1, name: "服务的航司", targetKind: "OBJECT_TYPE" as const, targetId: airline, cardinality: "MANY" as const, required: true }],
  },
  { id: alertInterface, name: "告警", properties: [{ name: "告警级别", required: true }], extends: [], linkConstraints: [] },
];

describe("interface inheritance", () => {
  it("接口属性可以显式映射到实现方不同名的属性（Palantir 的 map local properties）", () => {
    const implementer = {
      id: flightAlert,
      name: "航班告警",
      properties: [{ name: "CUST_NAME" }, { name: "LEVEL" }],
      implements: [facility],
    };
    // 没写映射：按同名兜底 —— 设施名称 / 位置 都没同名属性，required 的报 missing。
    const byName = checkImplementations(implementer, interfaces, [], [implementer])[0];
    expect(byName.missingProperties).toEqual(["设施名称", "资产编号"]);
    expect(byName.mappedProperties).toEqual([]);
    // 显式映射：接口属性 设施名称 / 位置 / 资产编号 分别落到实现方的 CUST_NAME / LEVEL / CUST_NAME。
    const mapped = {
      ...implementer,
      interfaceMappings: [{ interfaceId: facility, properties: { 设施名称: "CUST_NAME", 位置: "LEVEL", 资产编号: "CUST_NAME" } }],
    };
    const check = checkImplementations(mapped, interfaces, [], [mapped])[0];
    expect(check.missingProperties).toEqual([]);
    expect(check.mappedProperties.sort()).toEqual(["位置", "资产编号", "设施名称"].sort());
    expect(resolveInterfacePropertyMappings(interfaces, mapped, facility)).toEqual([
      { name: "设施名称", required: true, entityProperty: "CUST_NAME", source: "explicit" },
      { name: "位置", required: false, entityProperty: "LEVEL", source: "explicit" },
      { name: "资产编号", required: true, entityProperty: "CUST_NAME", source: "explicit" },
    ]);
  });

  it("显式映射指到一个不存在的属性：算没对上，不悄悄退回同名", () => {
    const implementer = {
      id: flightAlert,
      name: "航班告警",
      properties: [{ name: "设施名称" }],
      implements: [facility],
      interfaceMappings: [{ interfaceId: facility, properties: { 设施名称: "没有这个属性" } }],
    };
    const check = checkImplementations(implementer, interfaces, [], [implementer])[0];
    expect(check.missingProperties).toContain("设施名称");
    expect(resolveInterfacePropertyMappings(interfaces, implementer, facility)[0]).toMatchObject({ name: "设施名称", entityProperty: "", source: "missing" });
  });

  it("动作约束：实现方得把约束映射到自己的一条动作上，required 没映射就报出来", () => {
    const withAction = [
      { id: facility, name: "设施", properties: [{ name: "设施名称", required: true }], extends: [], linkConstraints: [], actionConstraints: [{ id: link2, name: "冻结设施", required: true }, { id: link3, name: "导出报表", required: false }] },
    ];
    const freezeAction = "aaaaaaaa-1111-4111-8111-111111111111";
    const otherAction = "bbbbbbbb-2222-4222-8222-222222222222";
    const implementer = { id: flightAlert, name: "航班告警", properties: [{ name: "设施名称" }], implements: [facility] };
    // 没映射：required 的报缺，optional 的不报。
    const bare = checkImplementations(implementer, withAction, [], [implementer], [{ id: freezeAction, scopeEntityTypeId: flightAlert }])[0];
    expect(bare.missingActions).toEqual(["冻结设施"]);
    // 映射到自己身上的动作才算对上；映射到别人的动作不算。
    const mapped = { ...implementer, interfaceMappings: [{ interfaceId: facility, properties: {}, actions: { 冻结设施: freezeAction } }] };
    expect(checkImplementations(mapped, withAction, [], [implementer], [{ id: freezeAction, scopeEntityTypeId: flightAlert }])[0].missingActions).toEqual([]);
    const wrongOwner = { ...implementer, interfaceMappings: [{ interfaceId: facility, properties: {}, actions: { 冻结设施: otherAction } }] };
    expect(checkImplementations(wrongOwner, withAction, [], [implementer], [{ id: otherAction, scopeEntityTypeId: asset }])[0].missingActions).toEqual(["冻结设施"]);
    expect(validateInterfaceImplementations({ interfaces: withAction, entityTypes: [implementer], relationshipTypes: [], actionTypes: [{ id: freezeAction, scopeEntityTypeId: flightAlert }] }).some((item) => item.rule === "INTERFACE_ACTION_MISSING")).toBe(true);
  });

  it("血缘是自身 + 祖先，近的在前", () => {
    expect(interfaceLineage(interfaces, facility)).toEqual([facility, asset]);
    expect(interfaceLineage(interfaces, asset)).toEqual([asset]);
  });

  it("自己声明的属性优先于继承来的同名属性", () => {
    const withOverride = [
      { id: asset, name: "资产", properties: [{ name: "资产编号", required: true, description: "父" }], extends: [] },
      { id: facility, name: "设施", properties: [{ name: "资产编号", required: false, description: "子" }], extends: [asset] },
    ];
    const properties = effectiveInterfaceProperties(withOverride, facility);
    expect(properties.map((item) => item.name)).toEqual(["资产编号"]);
    expect(properties[0].description).toBe("子");
  });

  it("继承绕成环也不会挂死", () => {
    const cycle = [
      { id: asset, name: "A", extends: [facility] },
      { id: facility, name: "B", extends: [asset] },
    ];
    expect(interfaceLineage(cycle, asset).sort()).toEqual([asset, facility].sort());
  });
});

describe("implementers", () => {
  it("实现子接口的对象类型也算父接口的实现者", () => {
    const entities = [{ id: airport, name: "机场", implements: [facility] }];
    expect(implementersOf(interfaces, entities, facility).map((item) => item.name)).toEqual(["机场"]);
    expect(implementersOf(interfaces, entities, asset)).toEqual([{ id: airport, name: "机场", direct: false }]);
  });
});

describe("checkImplementations", () => {
  it("缺必填属性会报出来，可选属性不报", () => {
    const checks = checkImplementations(
      { id: airport, name: "机场", properties: [{ name: "位置" }], implements: [facility] },
      interfaces,
      [],
      [{ id: airport, name: "机场", properties: [{ name: "位置" }], implements: [facility] }],
    );
    expect(checks[0].missingProperties).toEqual(["设施名称", "资产编号"]);
    expect(checks[0].mappedProperties).toEqual(["位置"]);
  });

  // 类之间没有继承（2026-09-16 移除）：属性只能写在类自己身上，接口要求必须同名属性自己对上。
  it("属性只算类自己写的，没写就报缺", () => {
    const checks = checkImplementations(
      { id: airport, name: "机场", properties: [], implements: [facility] },
      interfaces,
      [],
      [{ id: airport, name: "机场", properties: [] }],
    );
    expect(checks[0].missingProperties).toEqual(["设施名称", "资产编号"]);
  });

  it("关系类型双向：实现方在任一头都算满足约束", () => {
    const satisfied = checkImplementations(
      { id: airport, name: "机场", properties: [{ name: "资产编号" }, { name: "设施名称" }], implements: [facility] },
      interfaces,
      [{ name: "服务航司", sourceEntityTypeId: airport, targetEntityTypeId: airline }],
      [{ id: airport, name: "机场", properties: [{ name: "资产编号" }, { name: "设施名称" }], implements: [facility] }, { id: airline, name: "航司" }],
    );
    expect(satisfied[0].missingLinks).toEqual([]);
    expect(satisfied[0].satisfiedLinks.map((item) => item.relationshipName)).toEqual(["服务航司"]);

    // 反向那条同样算：Palantir 的一条 link type 两侧都能走（见 AGENTS.md 的术语约定），
    // 实现方在终点这一头，另一端是对端，约束就满足了。
    const reversed = checkImplementations(
      { id: airport, name: "机场", properties: [{ name: "资产编号" }, { name: "设施名称" }], implements: [facility] },
      interfaces,
      [{ name: "航司开班", sourceEntityTypeId: airline, targetEntityTypeId: airport }],
      [{ id: airport, name: "机场" }, { id: airline, name: "航司" }],
    );
    expect(reversed[0].missingLinks).toEqual([]);
    expect(reversed[0].satisfiedLinks.map((item) => item.relationshipName)).toEqual(["航司开班"]);

    // 完全不沾边的关系类型仍然不算。
    const missing = checkImplementations(
      { id: airport, name: "机场", properties: [{ name: "资产编号" }, { name: "设施名称" }], implements: [facility] },
      interfaces,
      [{ name: "航司开航站", sourceEntityTypeId: airline, targetEntityTypeId: flightAlert }],
      [{ id: airport, name: "机场" }, { id: airline, name: "航司" }, { id: flightAlert, name: "航班告警" }],
    );
    expect(missing[0].missingLinks.map((item) => item.name)).toEqual(["服务的航司"]);
  });

  it("约束目标写成接口时，终点实现该接口即满足", () => {
    const withInterfaceLink = [{
      id: facility,
      name: "设施",
      properties: [],
      extends: [],
      linkConstraints: [{ id: link2, name: "产生的告警", targetKind: "INTERFACE" as const, targetId: alertInterface, cardinality: "MANY" as const, required: true }],
    }];
    const entities = [{ id: airport, name: "机场", implements: [facility] }, { id: flightAlert, name: "航班告警", implements: [alertInterface] }];
    const checks = checkImplementations(
      entities[0],
      withInterfaceLink,
      [{ name: "产生告警", sourceEntityTypeId: airport, targetEntityTypeId: flightAlert }],
      entities,
    );
    expect(checks[0].missingLinks).toEqual([]);
  });

  it("关系约束也会继承", () => {
    expect(effectiveInterfaceLinkConstraints(interfaces, facility).map((item) => item.name)).toEqual(["服务的航司"]);
  });
});

describe("validation", () => {
  it("重名、缺父接口、继承成环、约束目标缺失都要报", () => {
    const bad = {
      interfaces: [
        { id: asset, name: "设施", properties: [], extends: [alertInterface], linkConstraints: [] },
        { id: facility, name: "设施", properties: [{ name: "名字", required: true }, { name: "名字", required: true }], extends: [alertInterface, airport], linkConstraints: [{ id: link3, name: "空的", targetKind: "OBJECT_TYPE" as const, targetId: "", cardinality: "ONE" as const, required: true }] },
        { id: alertInterface, name: "告警", properties: [], extends: [asset], linkConstraints: [] },
      ],
      entityTypes: [{ id: airport, name: "机场", implements: [] }],
    };
    const rules = validateInterfaces(bad).map((item) => item.rule);
    expect(rules).toContain("INTERFACE_DUPLICATE_NAME");
    expect(rules).toContain("INTERFACE_DUPLICATE_PROPERTY");
    expect(rules).toContain("INTERFACE_MISSING_PARENT");
    expect(rules).toContain("INTERFACE_CYCLE");
    expect(rules).toContain("INTERFACE_LINK_TARGET_MISSING");
  });

  it("实现不完整（缺属性 / 缺必填关系）会挡住发布", () => {
    const violations = validateInterfaceImplementations({
      interfaces,
      entityTypes: [{ id: airport, name: "机场", properties: [], implements: [facility] }],
      relationshipTypes: [],
    });
    expect(violations.map((item) => item.rule).sort()).toEqual(["INTERFACE_LINK_MISSING", "INTERFACE_PROPERTY_MISSING"]);
    expect(violations[0].message).toContain("机场");
  });

  it("实现了一个不存在的接口也要报", () => {
    const violations = validateInterfaceImplementations({
      interfaces,
      entityTypes: [{ id: airport, name: "机场", properties: [], implements: ["00000000-0000-4000-8000-000000000000"] }],
      relationshipTypes: [],
    });
    expect(violations.some((item) => item.rule === "IMPLEMENTS_MISSING_INTERFACE")).toBe(true);
  });
});
