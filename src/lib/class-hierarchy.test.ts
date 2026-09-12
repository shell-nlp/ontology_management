import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  descendantsOf,
  effectivePropertiesOf,
  findInheritanceCycles,
  indexNodes,
  inheritedPropertiesOf,
  selectableParentsOf,
  validateClassHierarchy,
  type HierarchyNode,
} from "@/lib/class-hierarchy";

const node = (
  id: string,
  name: string,
  parents: string[] = [],
  properties: { name: string; dataType: string; required?: boolean }[] = [],
): HierarchyNode => ({ id, name, parents, properties });

// 主体 ← 用户 ← 专线产品用户，外加一条独立的 订单。
const 主体 = node("id-主体", "主体", [], [{ name: "创建时间", dataType: "DATETIME", required: true }]);
const 用户 = node("id-用户", "用户", ["id-主体"], [{ name: "姓名", dataType: "TEXT", required: true }, { name: "手机号", dataType: "TEXT" }]);
const 专线 = node("id-专线", "专线产品用户", ["id-用户"], [{ name: "套餐", dataType: "TEXT" }]);
const 订单 = node("id-订单", "订单", []);
const graph = [主体, 用户, 专线, 订单];

describe("ancestorsOf / descendantsOf", () => {
  it("一路往上，拿到所有祖先，由近到远", () => {
    const byId = indexNodes(graph);
    expect(ancestorsOf("id-专线", byId)).toEqual(["id-用户", "id-主体"]);
    expect(ancestorsOf("id-用户", byId)).toEqual(["id-主体"]);
    expect(ancestorsOf("id-主体", byId)).toEqual([]);
  });

  it("多继承时有几个父类就走几条路，同一个祖先只出现一次", () => {
    const byId = indexNodes([主体, 用户, 专线, node("id-双亲", "双亲", ["id-用户", "id-专线"])]);
    expect(new Set(ancestorsOf("id-双亲", byId))).toEqual(new Set(["id-主体", "id-用户", "id-专线"]));
  });

  it("后代就是「谁把我当祖先」", () => {
    const byId = indexNodes(graph);
    expect(new Set(descendantsOf("id-主体", graph, byId))).toEqual(new Set(["id-用户", "id-专线"]));
    expect(descendantsOf("id-专线", graph, byId)).toEqual([]);
  });

  it("数据里已经成环时也不会挂死", () => {
    const a = node("a", "A", ["b"]);
    const b = node("b", "B", ["a"]);
    const byId = indexNodes([a, b]);
    expect(ancestorsOf("a", byId)).toEqual(["b"]);
    expect(ancestorsOf("b", byId)).toEqual(["a"]);
  });
});

describe("inheritedPropertiesOf", () => {
  it("把祖先的属性一路继承下来，并标出来自谁", () => {
    const byId = indexNodes(graph);
    const inherited = inheritedPropertiesOf(专线, byId);
    expect(inherited.map((item) => `${item.property.name}@${item.from}`)).toEqual(["姓名@用户", "手机号@用户", "创建时间@主体"]);
  });

  it("本类自己写了的同名属性就不再算继承", () => {
    const byId = indexNodes(graph);
    const overridden = node("id-专线", "专线产品用户", ["id-用户"], [{ name: "姓名", dataType: "TEXT" }]);
    const names = inheritedPropertiesOf(overridden, byId).map((item) => item.property.name);
    expect(names).not.toContain("姓名");
    expect(names).toContain("手机号");
  });

  it("近的祖先优先：两个祖先有同名属性时，取离得近的那个", () => {
    const near = node("id-near", "近", ["id-far"], [{ name: "标识", dataType: "INTEGER" }]);
    const far = node("id-far", "远", [], [{ name: "标识", dataType: "TEXT" }]);
    const leaf = node("id-leaf", "叶子", ["id-near"]);
    const inherited = inheritedPropertiesOf(leaf, indexNodes([near, far, leaf]));
    expect(inherited).toHaveLength(1);
    expect(inherited[0].from).toBe("近");
    expect(inherited[0].property.dataType).toBe("INTEGER");
  });

  it("生效属性 = 自己写的 + 继承来的", () => {
    const byId = indexNodes(graph);
    expect(effectivePropertiesOf(专线, byId).map((property) => property.name)).toEqual(["套餐", "姓名", "手机号", "创建时间"]);
  });
});

describe("selectableParentsOf", () => {
  it("排除自己和自己的所有后代，界面上根本选不出环", () => {
    const candidates = selectableParentsOf(用户, graph).map((item) => item.name);
    expect(candidates).not.toContain("用户");
    expect(candidates).not.toContain("专线产品用户");
    expect(candidates).toContain("主体");
    expect(candidates).toContain("订单");
  });
});

describe("findInheritanceCycles", () => {
  it("报出环上的每一环", () => {
    const cycles = findInheritanceCycles([node("a", "A", ["b"]), node("b", "B", ["c"]), node("c", "C", ["a"])]);
    expect(cycles).toHaveLength(1);
    expect([...new Set(cycles[0])].sort()).toEqual(["A", "B", "C"]);
  });

  it("正常的层级不报环", () => {
    expect(findInheritanceCycles(graph)).toEqual([]);
  });
});

describe("validateClassHierarchy", () => {
  it("正常的层级没有问题", () => {
    expect(validateClassHierarchy(graph)).toEqual([]);
  });

  it("把自己设成父类、父类不存在、继承成环，都拦下来", () => {
    const violations = validateClassHierarchy([
      node("a", "A", ["a"]),
      node("b", "B", ["ghost"]),
      node("c", "C", ["d"]),
      node("d", "D", ["c"]),
    ]);
    const messages = violations.map((item) => item.message).join("\n");
    expect(messages).toContain("把自己设成了父类");
    expect(messages).toContain("父类不存在");
    expect(messages).toContain("绕成了环");
    expect(violations.every((item) => item.severity !== "WARN")).toBe(true);
  });

  it("同名属性类型对不上是拦下来的问题，把必填改宽只是提示", () => {
    const parent = node("p", "父", [], [{ name: "编号", dataType: "TEXT", required: true }]);
    const clash = node("c1", "类型冲突", ["p"], [{ name: "编号", dataType: "INTEGER" }]);
    const loose = node("c2", "放宽必填", ["p"], [{ name: "编号", dataType: "TEXT" }]);
    const violations = validateClassHierarchy([parent, clash, loose]);
    expect(violations.find((item) => item.message.includes("两边对不上"))?.severity).toBeUndefined();
    expect(violations.find((item) => item.message.includes("被改成非必填"))?.severity).toBe("WARN");
  });
});
