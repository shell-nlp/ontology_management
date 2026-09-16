"use client";

import { Fragment, type ReactNode } from "react";
import "./markdown-view.css";

/**
 * 极简 Markdown：只覆盖平台自己会产出的那几种（标题、粗体、行内代码、围栏代码块、列表、表格）。
 *
 * 为什么不用 markdown 库：这里渲染的都是**我们自己写的**文本（模型结论、技能原文），
 * 不需要完整 CommonMark，也不需要 HTML 透传 —— 少一个依赖、少一条 XSS 面。
 * 需要的能力只有"读得下去"，所以代码块、表格、清单这几样必须有，其它可以没有。
 *
 * `className` 让调用方沿用各自的样式域（问答区仍用 `qa-markdown`，技能页用默认的 `md-view`）。
 */
export function inlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((part) => part !== "");
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <b key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</b>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>;
    return <Fragment key={`${keyPrefix}-${index}`}>{part}</Fragment>;
  });
}

/** 清单项 `- [ ]` / `- [x]` 画成方框，便于逐条对照。 */
function checklistPrefix(item: string) {
  if (/^\[ \]\s?/.test(item)) return { mark: "☐ ", text: item.replace(/^\[ \]\s?/, "") };
  if (/^\[[xX]\]\s?/.test(item)) return { mark: "☑ ", text: item.replace(/^\[[xX]\]\s?/, "") };
  return null;
}

export function MarkdownView({ text, className = "md-view" }: { text: string; className?: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  let key = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    // 围栏代码块：内部原样输出，不做行内解析（JSON 示例靠它才看得清）。
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(<pre className="md-code" key={`code-${key}`}><code>{body.join("\n")}</code></pre>);
      key += 1; continue;
    }
    if (line.trim().startsWith("|")) {
      const header = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        rows.push(lines[cursor].trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
        cursor += 1;
      }
      blocks.push(
        <div className="md-table-wrap" key={`t-${key}`}>
          <table><thead><tr>{header.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell, `th-${key}-${cellIndex}`)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{inlineMarkdown(cell, `td-${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      key += 1; index = cursor; continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      blocks.push(<h4 key={`h-${key}`}>{inlineMarkdown(line.replace(/^#{1,6}\s/, ""), `h-${key}`)}</h4>);
      key += 1; index += 1; continue;
    }
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^\s*([-*]|\d+\.)\s/.test(lines[index])) {
        const raw = lines[index].replace(/^\s*([-*]|\d+\.)\s+/, "");
        const check = checklistPrefix(raw);
        items.push(<li key={items.length}>{check ? <><span className="md-check">{check.mark}</span>{inlineMarkdown(check.text, `li-${key}-${items.length}`)}</> : inlineMarkdown(raw, `li-${key}-${items.length}`)}</li>);
        index += 1;
      }
      blocks.push(<ul key={`ul-${key}`}>{items}</ul>);
      key += 1; continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !lines[index].trim().startsWith("|") && !/^#{1,6}\s/.test(lines[index]) && !/^\s*([-*]|\d+\.)\s/.test(lines[index]) && !/^\s*```/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(<p key={`p-${key}`}>{inlineMarkdown(paragraph.join(" "), `p-${key}`)}</p>);
    key += 1;
  }
  return <div className={className}>{blocks}</div>;
}