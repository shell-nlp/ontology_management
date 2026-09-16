/**
 * Markdown 里 front-matter 的读写（纯函数，客户端与服务端共用）。
 *
 * 技能文件（SKILL.md）的头部是 `--- name / description ---`：**它是给 Agent 挑技能用的元数据**，
 * 展示给人看时要摘掉，否则页面上第一眼就是一堆 YAML。
 */

export type FrontMatter = { name: string; description: string; body: string };

/** 解析 front-matter；没有就返回空的 name / description 与原文。 */
export function parseFrontMatter(markdown: string): FrontMatter {
  const trimmed = markdown.trimStart();
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(trimmed);
  if (!match) return { name: "", description: "", body: markdown };
  const block = match[1];
  const read = (key: string) => {
    // 冒号后允许空格；行首制表符交给下面的 trim 处理，正则里就不塞转义了。
    const line = new RegExp(`^${key}: *(.*)$`, "m").exec(block);
    if (!line) return "";
    const inline = line[1].trim();
    if (inline && inline !== ">-" && inline !== "|" && inline !== ">") return inline.replace(/^["']|["']$/g, "").trim();
    // 续行（缩进的后续行）拼成多行值。
    const rest = block.slice(block.indexOf(line[0]) + line[0].length).split(/\r?\n/);
    const parts: string[] = [];
    for (const row of rest) {
      if (!row.trim()) { if (parts.length) break; continue; }
      if (!/^\s/.test(row)) break;
      parts.push(row.trim());
    }
    return parts.join(" ").trim();
  };
  return { name: read("name"), description: read("description"), body: trimmed.slice(match[0].length) };
}

/** 只要正文（展示用）。 */
export function stripFrontMatter(markdown: string): string {
  return parseFrontMatter(markdown).body;
}