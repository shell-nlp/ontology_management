import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  descendantsOf,
  effectivePropertiesOf,
  expandLabelFilter,
  findInheritanceCycles,
  indexNodes,
  inheritedPropertiesOf,
  mergeInheritedProperties,
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

describe("mergeInheritedProperties", () => {
  it("把祖先的属性并进来，近的祖先优先，自己写的排在最前", () => {
    const merged = mergeInheritedProperties(专线, graph);
    expect(merged.map((property) => property.name)).toEqual(["套餐", "姓名", "手机号", "创建时间"]);
  });

  it("同名属性以本类为准，不会把祖先那份也塞进来", () => {
    const override = { id: "id-override", name: "覆盖", parents: ["id-用户"], properties: [{ name: "姓名", dataType: "INTEGER" }] };
    const merged = mergeInheritedProperties(override, [...graph, override]);
    expect(merged.filter((property) => property.name === "姓名")).toHaveLength(1);
    expect(merged.find((property) => property.name === "姓名")!.dataType).toBe("INTEGER");
  });

  it("没有父类的类只返回自己的属性", () => {
    expect(mergeInheritedProperties(订单, graph)).toEqual([]);
    expect(mergeInheritedProperties(主体, graph).map((property) => property.name)).toEqual(["创建时间"]);
  });

  it("遇到环时停止上溯，不会挂死", () => {
    const a = { id: "a", name: "A", parents: ["b"], properties: [{ name: "甲", dataType: "TEXT" }] };
    const b = { id: "b", name: "B", parents: ["a"], properties: [{ name: "乙", dataType: "TEXT" }] };
    expect(mergeInheritedProperties(a, [a, b]).map((property) => property.name)).toEqual(["甲", "乙"]);
  });

  it("保留调用方自己的属性结构（unique / indexed 不丢）", () => {
    const base = { id: "base", name: "基类", parents: [], properties: [{ name: "编码", dataType: "TEXT", unique: true, indexed: true }] };
    const leaf = { id: "leaf", name: "子类", parents: ["base"], properties: [{ name: "自己的", dataType: "TEXT" }] };
    const merged = mergeInheritedProperties(leaf, [base, leaf]);
    expect(merged.find((property) => property.name === "编码")).toMatchObject({ unique: true, indexed: true });
  });
});

describe("expandLabelFilter", () => {
  it("按父类筛时把整条子类链都带上", () => {
    expect(new Set(expandLabelFilter(["主体"], graph))).toEqual(new Set(["主体", "用户", "专线产品用户"]));
    expect(new Set(expandLabelFilter(["用户"], graph))).toEqual(new Set(["用户", "专线产品用户"]));
  });

  it("叶子类不会反向带出父类或无关的类", () => {
    expect(expandLabelFilter(["专线产品用户"], graph)).toEqual(["专线产品用户"]);
    expect(expandLabelFilter(["订单"], graph)).toEqual(["订单"]);
  });

  it("多个父类各走各的路，去重后返回", () => {
    const multi = [...graph, node("id-双亲", "双亲", ["id-用户", "id-专线"])];
    expect(new Set(expandLabelFilter(["主体"], multi))).toEqual(new Set(["主体", "用户", "专线产品用户", "双亲"]));
  });

  it("层级里没有的名字原样保留，外部数据的标签不会被吞掉", () => {
    expect(expandLabelFilter(["外部标签"], graph)).toEqual(["外部标签"]);
    expect(expandLabelFilter([], graph)).toEqual([]);
  });

  it("只有带 id 的节点参与：没有 id 的类本来也不可能有父类", () => {
    const noId = [{ name: "无 id 的类", parents: ["id-用户"] } as unknown as HierarchyNode];
    expect(expandLabelFilter(["用户"], noId)).toEqual(["用户"]);
  });
});
