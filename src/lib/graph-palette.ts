/**
 * 图谱与本体画布共用的类型配色。
 *
 * 同一个类型名在任何页面都落到同一个色值，作者才能在「图谱」和「本体草稿」之间
 * 用颜色认出同一个类，而不是每个页面各有一套配色。
 */
export const graphPalette = ["#1677ff", "#0f8f8f", "#6d4aff", "#0b84d8", "#0f766e", "#7c3aed", "#2563eb", "#0369a1"];

export function graphColor(label: string) {
  let hash = 0;
  for (const character of label) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return graphPalette[Math.abs(hash) % graphPalette.length];
}

/** 画布上放不下的长名称压缩成尾部片段，完整名称留在检查器里。 */
export function compactGraphLabel(value: string) {
  const text = value.trim();
  if (text.length <= 12) return text;
  if (/^[A-Za-z0-9_.\-/]+$/.test(text)) {
    const parts = text.split(/[._\-/]/).filter(Boolean);
    const tail3 = parts.slice(-3).join("_");
    if (tail3.length <= 12) return tail3;
    const tail2 = parts.slice(-2).join("_");
    return tail2.length <= 12 ? tail2 : `…${tail2.slice(-11)}`;
  }
  return text;
}
