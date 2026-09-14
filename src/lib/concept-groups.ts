import type { ConceptGroup } from "@/lib/ontology";
// 别名导入：下面 resolveGroup 的参数也叫 newId（调用方可以注入自己的生成器），不能撞名。
import { newId as createId } from "@/lib/ids";

/**
 * 概念分组（业务域）的展示逻辑：取色、算成员、按组排布。
 *
 * 全部是纯函数，浏览器与服务端都能用，也有单测。分组**只影响展示与检索提示**，
 * 不参与推理，也不进图库 —— 它是"人怎么看这个本体"的组织方式。
 */

/** 分组框的调色板：和平台主色同一支系，相邻两组区分得开。 */
export const GROUP_PALETTE = ["#2563eb", "#b45309", "#7c3aed", "#0f766e", "#0e7490", "#be123c"];

export function paletteColor(index: number) {
  const size = GROUP_PALETTE.length;
  return GROUP_PALETTE[((index % size) + size) % size];
}

/** 分组用哪支色：自己填了用自己的，没填按它在清单里的位置取调色板色。 */
export function groupColor(groups: readonly ConceptGroup[], groupId: string) {
  const index = groups.findIndex((item) => item.id === groupId);
  if (index < 0) return "";
  return groups[index].color.trim() || paletteColor(index);
}

/** 按名字找分组；没有就新建一条。名字比较去空格、不分大小写，免得「客户域」和「客户域 」变成两个。 */
export function resolveGroup(
  groups: readonly ConceptGroup[],
  name: string,
  newId: () => string = () => createId(),
): { groups: ConceptGroup[]; groupId: string } {
  const trimmed = name.trim();
  if (!trimmed) return { groups: [...groups], groupId: "" };
  const key = trimmed.toLowerCase();
  const hit = groups.find((item) => item.name.trim().toLowerCase() === key);
  if (hit) return { groups: [...groups], groupId: hit.id };
  const created: ConceptGroup = { id: newId(), name: trimmed, color: paletteColor(groups.length) };
  return { groups: [...groups, created], groupId: created.id };
}

export type GroupFrame = { id: string; name: string; color: string; nodeIds: string[] };

/**
 * 画布布局：默认（按关系铺开）/ 圆形 / 按逻辑分组。
 *
 * 「按逻辑分组」是唯一会画分组框的布局；另外两种只看节点，免得框线白占地方。
 */
export type LayoutMode = "default" | "circle" | "grouped";

export const LAYOUT_MODES: { key: LayoutMode; label: string; hint: string }[] = [
  { key: "default", label: "默认布局", hint: "按关系铺开，保留手工摆放的位置" },
  { key: "circle", label: "圆形布局", hint: "所有对象类型排成一个圈" },
  { key: "grouped", label: "按逻辑分组", hint: "概念分组各占一块，外面画出分组框" },
];

/** 分组概览：界面右栏的成员清单和工具返回的清单都用这一份，口径不会漂。 */
export type GroupSummary = { id: string; name: string; color: string; objectTypes: string[] };

export function summarizeGroups(
  groups: readonly ConceptGroup[],
  types: readonly { id: string; name: string; groupId?: string }[],
): { groups: GroupSummary[]; ungrouped: string[] } {
  const known = new Set(groups.map((group) => group.id));
  const buckets = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const type of types) {
    const groupId = type.groupId ?? "";
    if (!groupId || !known.has(groupId)) { ungrouped.push(type.name); continue; }
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(type.name);
    else buckets.set(groupId, [type.name]);
  }
  return {
    groups: groups.map((group, index) => ({
      id: group.id,
      name: group.name,
      color: group.color.trim() || paletteColor(index),
      objectTypes: buckets.get(group.id) ?? [],
    })),
    ungrouped,
  };
}

/**
 * 把画布上的节点按分组装箱，返回**有成员的那些组**。
 *
 * 节点与对象类型的对应关系有三种认法：节点 id 就是类型 id（草稿直接建的）、
 * 节点名等于类型名（图库里按标签读出来的）、或者反过来。三种都要认，
 * 否则换个数据来源分组就"消失"了。
 */
export function buildGroupFrames(
  groups: readonly ConceptGroup[],
  types: readonly { id: string; name: string; groupId?: string }[],
  nodes: readonly { id: string; name: string }[],
): GroupFrame[] {
  const buckets = new Map<string, string[]>();
  for (const node of nodes) {
    const type = types.find((item) => item.id === node.id || item.name === node.name || item.name === node.id);
    const groupId = type?.groupId ?? "";
    if (!groupId || !groups.some((group) => group.id === groupId)) continue;
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(node.id);
    else buckets.set(groupId, [node.id]);
  }
  return groups
    .map((group, index) => ({ id: group.id, name: group.name, color: group.color.trim() || paletteColor(index), nodeIds: buckets.get(group.id) ?? [] }))
    .filter((frame) => frame.nodeIds.length > 0);
}

/**
 * 组之间按"连边多的排一起"定顺序：分组框在画布上排成一圈，
 * 顺序随便定的话跨组的线会到处飞，按边把关系近的组排相邻，图看起来就顺了。
 */
function orderFramesByEdges(frames: readonly GroupFrame[], edges: readonly { source: string; target: string }[]): GroupFrame[] {
  if (frames.length <= 2) return [...frames];
  const groupOf = new Map<string, number>();
  frames.forEach((frame, index) => frame.nodeIds.forEach((id) => groupOf.set(id, index)));
  const weights = frames.map(() => frames.map(() => 0));
  for (const edge of edges) {
    const left = groupOf.get(edge.source);
    const right = groupOf.get(edge.target);
    if (left === undefined || right === undefined || left === right) continue;
    weights[left][right] += 1;
    weights[right][left] += 1;
  }
  const start = frames.reduce((best, frame, index) => (frame.nodeIds.length > frames[best].nodeIds.length ? index : best), 0);
  const visited = new Set([start]);
  const order = [start];
  while (order.length < frames.length) {
    const current = order[order.length - 1];
    let best = -1;
    for (let index = 0; index < frames.length; index += 1) {
      if (visited.has(index)) continue;
      if (best < 0 || weights[current][index] > weights[current][best]) best = index;
    }
    visited.add(best);
    order.push(best);
  }
  return order.map((index) => frames[index]);
}

/**
 * 按分组排布：每组在自己的小圈里，组心再排成一个大圈，没归组的放到最外圈。
 *
 * 确定性优先（同一份输入永远同一份结果），所以换个 seed 只是整圈转一下，
 * 「自动整理」看得见变化但不会把图搅乱。想看力的效果请用「默认布局」。
 */
export function groupedLayoutPositions(
  frames: readonly GroupFrame[],
  ungrouped: readonly string[],
  edges: readonly { source: string; target: string }[],
  seed = 0,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const rotation = (seed % 8) * (Math.PI / 8);

  if (!frames.length) {
    // 一个组都没有：退化成一个大圈，别让画布空着。
    const all = [...ungrouped];
    all.forEach((id, index) => {
      const angle = rotation + (index / Math.max(1, all.length)) * Math.PI * 2;
      const radius = Math.max(150, all.length * 26);
      positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
    return positions;
  }

  const ordered = orderFramesByEdges(frames, edges);
  /** 一组自己的展开半径：人多的组圈大一点，组框才不会挤在一起。 */
  const memberRadius = (count: number) => (count <= 1 ? 0 : 46 + Math.min(120, count * 16));
  const maxMemberRadius = Math.max(70, ...ordered.map((frame) => memberRadius(frame.nodeIds.length)));
  const groupRing = maxMemberRadius * 2 + 170;

  ordered.forEach((frame, index) => {
    const angle = rotation + (index / ordered.length) * Math.PI * 2;
    const centerX = Math.cos(angle) * groupRing;
    const centerY = Math.sin(angle) * groupRing;
    const radius = memberRadius(frame.nodeIds.length);
    if (radius === 0) {
      positions.set(frame.nodeIds[0], { x: centerX, y: centerY });
      return;
    }
    frame.nodeIds.forEach((id, position) => {
      const memberAngle = rotation + (position / frame.nodeIds.length) * Math.PI * 2;
      positions.set(id, { x: centerX + Math.cos(memberAngle) * radius, y: centerY + Math.sin(memberAngle) * radius * 0.88 });
    });
  });

  const outerRing = groupRing + maxMemberRadius + 170;
  ungrouped.forEach((id, index) => {
    const angle = rotation + (index / Math.max(1, ungrouped.length)) * Math.PI * 2;
    positions.set(id, { x: Math.cos(angle) * outerRing, y: Math.sin(angle) * outerRing });
  });
  return positions;
}

/** 圆形布局：所有节点排一圈。分组布局在「一个分组都没有」时走的也是这条路径。 */
export function circleLayout(ids: readonly string[], seed = 0) {
  return groupedLayoutPositions([], ids, [], seed);
}
