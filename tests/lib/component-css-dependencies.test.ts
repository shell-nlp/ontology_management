import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const componentsRoot = path.join(process.cwd(), "src", "components");

function componentFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(full);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [full] : [];
  });
}

function classNameTokens(text: string): string[] {
  return [...text.matchAll(/className\s*=\s*["'`]([^"'`]+)["'`]/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((token) => /^[a-z][\w-]*$/i.test(token));
}

const families = [
  { name: "graph", matches: (value: string) => value.startsWith("graph-") || ["manager-rows", "endpoint-card", "endpoint-cards", "settings-grid", "settings-field", "cypher-bar-trigger", "cypher-bar-toggle", "cypher-bar-content", "property-editor", "property-key", "property-add"].includes(value), css: "graph-canvas.css" },
  { name: "type editor", matches: (value: string) => value.startsWith("ted-"), css: "type-edit-dialog.css" },
  { name: "action", matches: (value: string) => value.startsWith("as-"), css: "action-studio.css" },
  { name: "qa", matches: (value: string) => value.startsWith("qa-"), css: "qa-studio.css" },
];

describe("组件 CSS 依赖", () => {
  it("使用共享控件类名的组件必须显式加载对应 CSS", () => {
    const violations: string[] = [];
    for (const file of componentFiles(componentsRoot)) {
      const text = fs.readFileSync(file, "utf8");
      const classes = new Set(classNameTokens(text));
      for (const family of families) {
        const cssText = fs.readFileSync(path.join(componentsRoot, family.css), "utf8");
        if (![...classes].some((value) => family.matches(value) && cssText.includes(`.${value}`))) continue;
        if (!text.includes(family.css)) violations.push(`${path.relative(process.cwd(), file).replaceAll("\\", "/")} -> ${family.css}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
