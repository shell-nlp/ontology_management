import { describe, expect, it } from "vitest";
import {
  buildGroupFrames,
  circleLayout,
  GROUP_PALETTE,
  groupColor,
  groupedLayoutPositions,
  LAYOUT_MODES,
  paletteColor,
  resolveGroup,
  summarizeGroups,
} from "@/lib/concept-groups";
import type { ConceptGroup } from "@/lib/ontology";

const 客户域: ConceptGroup = { id: "g-customer", name: "客户域", color: "" };
const 账务域: ConceptGroup = { id: "g-billing", name: "账务域", color: "#123456" };

const types = [
  { id: "t1", name: "客户", groupId: "g-customer" },
  { id: "t2", name: "用户", groupId: "g-customer" },
  { id: "t3", name: "调账", groupId: "g-billing" },
  { id: "t4", name: "孤立类型", groupId: "" },
];

describe("paletteColor / groupColor", () => {
  it("按位置取色，越界回绕", () => {
    expect(paletteColor(0)).toBe(GROUP_PALETTE[0]);
    expect(paletteColor(GROUP_PALETTE.length)).toBe(GROUP_PALETTE[0]);
    expect(paletteColor(-1)).toBe(GROUP_PALETTE[GROUP_PALETTE.length - 1]);
  });

  it("自己填了颜色就用自己的，没填按位置取；未知分组没有颜色", () => {
    expect(groupColor([客户域, 账务域], "g-customer")).toBe(GROUP_PALETTE[0]);
    expect(groupColor([客户域, 账务域], "g-billing")).toBe("#123456");
    expect(groupColor([客户域], "g-不存在")).toBe("");
  });
});

describe("resolveGroup", () => {
  it("空名字表示不归组", () => {
    expect(resolveGroup([客户域], "   ")).toEqual({ groups: [客户域], groupId: "" });
  });

  it("按名字复用已有分组：去掉前后空格、不分大小写", () => {
    const 字典域: ConceptGroup = { id: "g-dict", name: "Dict", color: "" };
    expect(resolveGroup([字典域], " dict ").groupId).toBe("g-dict");
    expect(resolveGroup([客户域], "客户域").groupId).toBe("g-customer");
  });

  it("没有就新建，给一个新 id 和调色板色", () => {
    const result = resolveGroup([客户域], "账务域", () => "new-0");
    expect(result.groupId).toBe("new-0");
    expect(result.groups).toHaveLength(2);
    expect(result.groups[1]).toMatchObject({ id: "new-0", name: "账务域", color: paletteColor(1) });
  });

  it("不修改传进来的数组", () => {
    const input = [客户域];
    resolveGroup(input, "新域", () => "x");
    expect(input).toHaveLength(1);
  });
});

describe("buildGroupFrames", () => {
  it("节点 id 就是类型 id 时按组装箱，只画有成员的组", () => {
    const frames = buildGroupFrames(
      [客户域, 账务域],
      types,
      [{ id: "t1", name: "客户" }, { id: "t2", name: "用户" }, { id: "t3", name: "调账" }],
    );
    expect(frames.map((frame) => [frame.name, frame.nodeIds])).toEqual([
      ["客户域", ["t1", "t2"]],
      ["账务域", ["t3"]],
    ]);
  });

  it("节点名等于类型名时也认（快照里按标签读出来的节点）", () => {
    const frames = buildGroupFrames([客户域], types, [{ id: "n-1", name: "客户" }]);
    expect(frames).toHaveLength(1);
    expect(frames[0].nodeIds).toEqual(["n-1"]);
  });

  it("类型名等于节点 id 时也认（图库骨架的节点 id 是临时分配的）", () => {
    const frames = buildGroupFrames([客户域], types, [{ id: "客户", name: "c-1" }]);
    expect(frames[0].nodeIds).toEqual(["客户"]);
  });

  it("未归组、指向不存在的分组的类型都不进框", () => {
    const stale = [...types, { id: "t5", name: "旧类型", groupId: "g-已删除" }];
    const frames = buildGroupFrames([客户域, 账务域], stale, [
      { id: "t1", name: "客户" },
      { id: "t4", name: "孤立类型" },
      { id: "t5", name: "旧类型" },
    ]);
    expect(frames.map((frame) => frame.nodeIds)).toEqual([["t1"]]);
  });

  it("分组框的颜色沿用分组自己的颜色", () => {
    const frames = buildGroupFrames([客户域, 账务域], types, [{ id: "t3", name: "调账" }]);
    expect(frames[0]).toMatchObject({ id: "g-billing", color: "#123456" });
  });
});

describe("groupedLayoutPositions", () => {
  const nodes = [{ id: "t1", name: "客户" }, { id: "t2", name: "用户" }, { id: "t3", name: "调账" }];
  const frames = buildGroupFrames([客户域, 账务域], types, nodes);
  const edges = [{ source: "t1", target: "t3" }, { source: "t2", target: "t3" }];

  it("同一份输入永远同一份结果", () => {
    const first = groupedLayoutPositions(frames, ["t4"], edges, 0);
    const second = groupedLayoutPositions(frames, ["t4"], edges, 0);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("每个节点都拿到坐标", () => {
    const positions = groupedLayoutPositions(frames, ["t4"], edges, 0);
    expect([...positions.keys()].sort()).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("同组挨着，跨组分开", () => {
    const positions = groupedLayoutPositions(frames, [], edges, 0);
    const distance = (left: string, right: string) => {
      const a = positions.get(left)!;
      const b = positions.get(right)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    // 同组的两点，比它们到另一组任意一点都近
    const intra = distance("t1", "t2");
    const cross = Math.min(distance("t1", "t3"), distance("t2", "t3"));
    expect(intra).toBeLessThan(cross);
  });

  it("未归组的节点放在最外圈", () => {
    const positions = groupedLayoutPositions(frames, ["t4"], edges, 0);
    const radius = (id: string) => Math.hypot(positions.get(id)!.x, positions.get(id)!.y);
    expect(radius("t4")).toBeGreaterThan(radius("t1"));
  });

  it("换 seed 整体转一下，节点数量不变", () => {
    const base = groupedLayoutPositions(frames, ["t4"], edges, 0);
    const rotated = groupedLayoutPositions(frames, ["t4"], edges, 3);
    expect([...rotated.keys()].sort()).toEqual([...base.keys()].sort());
    expect(rotated.get("t1")).not.toEqual(base.get("t1"));
  });

  it("一个分组都没有时退化成一个大圈，不留空画布", () => {
    const positions = circleLayout(["a", "b", "c"], 0);
    expect([...positions.keys()]).toEqual(["a", "b", "c"]);
    const radius = (id: string) => Math.hypot(positions.get(id)!.x, positions.get(id)!.y);
    expect(radius("a")).toBeCloseTo(radius("b"), 5);
    expect(radius("c")).toBeGreaterThan(0);
  });

  it("没有节点时返回空", () => {
    expect(groupedLayoutPositions([], [], [], 0).size).toBe(0);
  });
});

describe("summarizeGroups", () => {
  it("列出每个分组的成员，未归组的分开列", () => {
    const summary = summarizeGroups([客户域, 账务域], [...types, { id: "t5", name: "旧类型", groupId: "g-已删除" }]);
    expect(summary.groups.map((group) => [group.name, group.objectTypes])).toEqual([
      ["客户域", ["客户", "用户"]],
      ["账务域", ["调账"]],
    ]);
    // 没归组、和指向已删除分组的类型都算未归组
    expect(summary.ungrouped).toEqual(["孤立类型", "旧类型"]);
  });

  it("空分组照样列出来（建了组还没归类型）", () => {
    const empty: ConceptGroup = { id: "g-empty", name: "订购域", color: "" };
    const summary = summarizeGroups([empty], []);
    expect(summary.groups).toEqual([{ id: "g-empty", name: "订购域", color: paletteColor(0), objectTypes: [] }]);
    expect(summary.ungrouped).toEqual([]);
  });
});

describe("LAYOUT_MODES", () => {
  it("三种布局，按逻辑分组是其中唯一画分组框的", () => {
    expect(LAYOUT_MODES.map((mode) => mode.key)).toEqual(["default", "circle", "grouped"]);
    expect(LAYOUT_MODES.every((mode) => mode.label && mode.hint)).toBe(true);
  });
});
