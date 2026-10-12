import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked, Renderer } from "marked";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "docs", "系统说明书");
const OUTPUT_FILE = path.join(SOURCE_DIR, "阅读版.html");
const README_FILE = "README.md";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;").replaceAll("\r", "");
}

function decodeHtml(value) {
  return String(value)
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripTags(value) {
  return String(value).replace(/<[^>]*>/g, "");
}

function stripInline(value) {
  return decodeHtml(
    String(value)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_~]/g, "")
      .replace(/\s+/g, " "),
  ).trim();
}

function slugify(value) {
  const slug = stripInline(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function docIdForFile(file) {
  return `doc-${file.replace(/\.md$/i, "")}`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(value);
}

function cleanTitle(value) {
  return stripInline(value).replace(/^第\s*(\d+)\s*章\s*·\s*/, "第 $1 章 · ");
}

function parseNavigation(readme) {
  const tocMatch = readme.match(/## 目录\s*\n([\s\S]*?)\n## 阅读中的状态标记/);
  const toc = tocMatch ? tocMatch[1] : readme;
  const groups = [];
  let current = null;
  let previous = null;

  for (const line of toc.split(/\r?\n/)) {
    const groupMatch = line.match(/^###\s+(.+?)\s*$/);
    if (groupMatch) {
      current = { label: stripInline(groupMatch[1]), items: [] };
      groups.push(current);
      previous = null;
      continue;
    }

    const itemMatch = line.match(/^-\s+\[(.+?)\]\(\.\/([^)#]+\.md)(?:#[^)]+)?\)/);
    if (itemMatch) {
      if (!current) {
        current = { label: "文档", items: [] };
        groups.push(current);
      }
      previous = {
        file: path.basename(itemMatch[2]),
        title: cleanTitle(itemMatch[1]),
        description: "",
      };
      current.items.push(previous);
      continue;
    }

    const descriptionMatch = line.match(/^\s{2,}-\s+(.+?)\s*$/);
    if (previous && descriptionMatch) {
      previous.description = stripInline(descriptionMatch[1]);
    }
  }

  return groups.filter((group) => group.items.length);
}

function renderMarkdown(markdown, docId) {
  const body = markdown.replace(/^#\s+.+(?:\r?\n)+/, "");
  const usedHeadingIds = new Map();
  const headings = [];
  const renderer = new Renderer();

  renderer.code = ({ text, lang }) => {
    const language = String(lang || "").trim().split(/\s+/)[0];
    const escaped = escapeHtml(text);
    if (language === "mermaid") {
      return `<figure class="diagram-frame" data-mermaid-source="${escapeAttribute(text)}">
  <figcaption><span>系统结构图</span><small>Mermaid 流程图</small></figcaption>
  <div class="mermaid">${escaped}</div>
  <details class="diagram-source"><summary>查看图表源码</summary><pre><code>${escaped}</code></pre></details>
</figure>`;
    }
    const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
    return `<pre class="code-block"><code${className}>${escaped}</code></pre>`;
  };

  let html = marked.parse(body, { gfm: true, renderer });
  html = html
    .replace(/<table>/g, '<div class="table-wrap"><table>')
    .replace(/<\/table>/g, "</table></div>");

  html = html.replace(/<h([1-4])>(.*?)<\/h\1>/gs, (full, levelText, inner) => {
    const level = Number(levelText);
    const label = stripInline(stripTags(inner));
    const base = slugify(label);
    const seen = usedHeadingIds.get(base) || 0;
    usedHeadingIds.set(base, seen + 1);
    const id = `${docId}--${base}${seen ? `-${seen + 1}` : ""}`;
    headings.push({ id, level, title: label });

    if (level < 2 || level > 3) {
      return `<h${level} id="${escapeAttribute(id)}">${inner}</h${level}>`;
    }

    return `<h${level} id="${escapeAttribute(id)}"><span>${inner}</span><a class="heading-anchor" href="#${escapeAttribute(id)}" aria-label="复制本节链接">#</a></h${level}>`;
  });

  return { html, headings };
}
function rewriteLinks(html, docIds) {
  return html.replace(/href="([^"]*)"/g, (full, rawHref) => {
    const href = decodeHtml(rawHref);
    if (!href || href.startsWith("#")) return full;

    if (/^https?:/i.test(href)) {
      return `href="${rawHref}" target="_blank" rel="noreferrer"`;
    }

    if (href.startsWith("/docs")) {
      return `href="${rawHref}" target="_blank" rel="noreferrer" class="service-link"`;
    }

    const [pathname] = href.split("#");
    const file = path.posix.basename(pathname.replaceAll("\\", "/"));
    const docId = docIds.get(file);
    if (docId) {
      return `href="#${escapeAttribute(docId)}" class="doc-link"`;
    }

    if (/\.md$/i.test(pathname)) {
      return `href="${rawHref}" target="_blank" rel="noreferrer" class="file-link"`;
    }

    return full;
  });
}

function chapterNumber(title) {
  const match = title.match(/^第\s*(\d+)\s*章/);
  if (match) return match[1].padStart(2, "0");
  if (title.includes("查询 DSL")) return "附";
  return "导";
}

function navLabel(title) {
  return title.replace(/^第\s*\d+\s*章\s*·\s*/, "").replace(/^附录\s*·\s*/, "");
}

function wordCount(markdown) {
  return markdown.replace(/\s+/g, "").length;
}

const files = (await readdir(SOURCE_DIR, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort((a, b) => a.localeCompare(b, "zh-CN"));

const readme = await readFile(path.join(SOURCE_DIR, README_FILE), "utf8");
const navGroups = [
  {
    label: "开始阅读",
    items: [
      {
        file: README_FILE,
        title: "本体管理平台 · 系统说明书",
        description: "阅读地图、状态标记与维护规则。",
      },
    ],
  },
  ...parseNavigation(readme),
];

const orderedFiles = [];
for (const file of [README_FILE, ...navGroups.flatMap((group) => group.items.map((item) => item.file)), ...files]) {
  if (files.includes(file) && !orderedFiles.includes(file)) orderedFiles.push(file);
}

const navMeta = new Map();
for (const group of navGroups) {
  for (const item of group.items) {
    navMeta.set(item.file, { group: group.label, ...item });
  }
}

const docIds = new Map(files.map((file) => [file, docIdForFile(file)]));
const docs = [];

for (const file of orderedFiles) {
  const fullPath = path.join(SOURCE_DIR, file);
  const markdown = await readFile(fullPath, "utf8");
  const fileStat = await stat(fullPath);
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const fallbackTitle = titleMatch ? cleanTitle(titleMatch[1]) : path.basename(file, ".md");
  const meta = navMeta.get(file) || {
    title: fallbackTitle,
    description: "",
    group: "更多文档",
  };
  const title = fallbackTitle || meta.title;
  const id = docIds.get(file);
  const rendered = renderMarkdown(markdown, id);

  docs.push({
    id,
    file,
    title,
    navTitle: navLabel(title),
    chapter: chapterNumber(title),
    description: meta.description || "",
    group: meta.group,
    html: rewriteLinks(rendered.html, docIds),
    headings: rendered.headings,
    words: wordCount(markdown),
    updatedAt: formatDateTime(fileStat.mtime),
  });
}

const docsById = new Map(docs.map((doc) => [doc.id, doc]));
const navMarkup = navGroups
  .map((group) => {
    const items = group.items
      .filter((item) => docsById.has(docIds.get(item.file)))
      .map((item) => {
        const doc = docsById.get(docIds.get(item.file));
        return `<a class="nav-link" href="#${escapeAttribute(doc.id)}" data-doc-id="${escapeAttribute(doc.id)}" title="${escapeAttribute(doc.description || doc.title)}">
  <span class="nav-node" aria-hidden="true">${escapeHtml(doc.chapter)}</span>
  <span class="nav-copy"><b>${escapeHtml(doc.navTitle)}</b><small>${escapeHtml(doc.description || doc.group)}</small></span>
</a>`;
      })
      .join("\n");
    return `<section class="nav-group"><p class="nav-group-title">${escapeHtml(group.label)}</p><div class="chapter-nav">${items}</div></section>`;
  })
  .join("\n");

const articleMarkup = docs
  .map(
    (doc) => `<article class="doc" id="${escapeAttribute(doc.id)}" data-doc-id="${escapeAttribute(doc.id)}" hidden>
  <header class="chapter-hero">
    <div class="chapter-kicker"><span>${escapeHtml(doc.group)}</span><i></i><span>章节 ${escapeHtml(doc.chapter)}</span></div>
    <h1>${escapeHtml(doc.title)}</h1>
    ${doc.description ? `<p class="chapter-lede">${escapeHtml(doc.description)}</p>` : ""}
    <div class="chapter-meta">
      <span>${escapeHtml(doc.file)}</span>
      <span>${doc.words.toLocaleString("zh-CN")} 字</span>
      <span>${doc.headings.filter((heading) => heading.level === 2).length} 个主节</span>
      <span>更新 ${escapeHtml(doc.updatedAt)}</span>
    </div>
  </header>
  <div class="doc-body">${doc.html}</div>
  <footer class="chapter-footer" data-chapter-footer></footer>
</article>`,
  )
  .join("\n");

const manifest = {
  title: "本体管理平台 · 系统说明书",
  defaultDocId: docs[0]?.id || "",
  buildTime: formatDateTime(new Date()),
  docs: docs.map(({ html, headings, ...doc }) => doc),
};
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="description" content="本体管理平台系统说明书阅读版：单文件网页，支持章节导航、全文搜索、目录定位与打印。">
<title>${escapeHtml(manifest.title)}</title>
<style>
:root {
  --ink: #14282c;
  --ink-2: #30494d;
  --muted: #6b7c7e;
  --paper: #f4f3ed;
  --paper-deep: #ebe9e1;
  --panel: #fffefa;
  --line: #d5d9d3;
  --line-strong: #b9c2ba;
  --nav: #132628;
  --nav-2: #1b3436;
  --nav-3: #29484a;
  --mint: #8bc4aa;
  --mint-soft: #e8f3ed;
  --coral: #d97860;
  --gold: #bd9550;
  --blue: #5f91a8;
  --shadow: 0 20px 60px rgba(27, 45, 45, .10);
  --font-display: Georgia, "Noto Serif SC", "Songti SC", serif;
  --font-body: "IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei", sans-serif;
  --font-mono: "Cascadia Code", "SFMono-Regular", Consolas, monospace;
  --sidebar: 306px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; background: var(--paper); }
body { margin: 0; min-height: 100vh; color: var(--ink); background: var(--paper); font-family: var(--font-body); font-size: 15px; }
button, input { font: inherit; }
button { cursor: pointer; }
a { color: inherit; }
::selection { background: rgba(139, 196, 170, .38); }
body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(20, 40, 44, .025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(20, 40, 44, .025) 1px, transparent 1px);
  background-size: 28px 28px;
  mask-image: linear-gradient(to bottom, rgba(0,0,0,.8), transparent 75%);
}
.sidebar {
  position: fixed;
  inset: 0 auto 0 0;
  z-index: 30;
  width: var(--sidebar);
  overflow: auto;
  color: #eaf3ef;
  background:
    radial-gradient(circle at 22px 18px, rgba(139, 196, 170, .16), transparent 32%),
    linear-gradient(160deg, var(--nav) 0%, #102022 100%);
  border-right: 1px solid #294144;
}
.sidebar::after {
  content: "";
  position: fixed;
  left: calc(var(--sidebar) - 1px);
  top: 0;
  width: 1px;
  height: 100%;
  background: linear-gradient(transparent, rgba(139, 196, 170, .38), transparent);
  opacity: .45;
}
.brand {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  gap: 13px;
  align-items: center;
  padding: 24px 22px 18px;
  background: linear-gradient(180deg, rgba(19, 38, 40, .98), rgba(19, 38, 40, .9));
  backdrop-filter: blur(16px);
}
.brand-mark {
  flex: none;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  color: #123034;
  background: var(--mint);
  border-radius: 9px 9px 9px 2px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 8px 24px rgba(0,0,0,.22);
}
.brand-mark svg { width: 24px; height: 24px; }
.brand-copy { min-width: 0; }
.brand-copy strong { display: block; color: #f5faf7; font-family: var(--font-display); font-size: 18px; font-weight: 600; letter-spacing: .04em; }
.brand-copy span { display: block; margin-top: 3px; color: #8fa8a4; font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
.sidebar-tools { padding: 0 16px 12px; }
.search-trigger {
  width: 100%;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  color: #b9cac5;
  text-align: left;
  border: 1px solid #355052;
  border-radius: 6px;
  background: rgba(255,255,255,.045);
  transition: border-color .15s ease, background .15s ease, color .15s ease;
}
.search-trigger:hover { color: #fff; border-color: #547374; background: rgba(255,255,255,.08); }
.search-trigger span { flex: 1; }
.search-trigger kbd { color: #9fb2ae; border: 1px solid #496064; border-radius: 3px; padding: 2px 5px; font-family: var(--font-mono); font-size: 10px; }
.nav-groups { padding: 2px 16px 28px; }
.nav-group { margin-top: 22px; }
.nav-group-title {
  margin: 0 10px 8px;
  color: #78918d;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: .13em;
  text-transform: uppercase;
}
.chapter-nav { position: relative; display: grid; gap: 2px; }
.chapter-nav::before {
  content: "";
  position: absolute;
  left: 18px;
  top: 19px;
  bottom: 19px;
  width: 1px;
  background: #365153;
}
.nav-link {
  position: relative;
  display: grid;
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-height: 54px;
  padding: 7px 8px 7px 0;
  color: #b9cac5;
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: 7px;
  transition: color .14s ease, background .14s ease, border-color .14s ease, transform .14s ease;
}
.nav-link:hover { color: #fff; background: rgba(255,255,255,.055); transform: translateX(2px); }
.nav-link.active { color: #fff; background: rgba(139, 196, 170, .12); border-color: rgba(139, 196, 170, .22); }
.nav-node {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 25px;
  height: 25px;
  margin-left: 6px;
  color: #90a7a3;
  background: var(--nav);
  border: 1px solid #426063;
  border-radius: 50%;
  font-family: var(--font-mono);
  font-size: 9px;
  transition: color .14s ease, background .14s ease, border-color .14s ease, box-shadow .14s ease;
}
.nav-link.active .nav-node { color: #173033; background: var(--mint); border-color: var(--mint); box-shadow: 0 0 0 4px rgba(139,196,170,.12); }
.nav-copy { min-width: 0; }
.nav-copy b { display: block; overflow: hidden; color: inherit; font-size: 12.5px; font-weight: 600; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.nav-copy small { display: block; overflow: hidden; margin-top: 2px; color: #78908d; font-size: 10.5px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.nav-link.active .nav-copy small { color: #a9beb9; }
.sidebar-foot {
  margin: 0 16px 18px;
  padding: 14px 12px 0;
  color: #78908d;
  border-top: 1px solid #2d484a;
  font-size: 10.5px;
  line-height: 1.7;
}
.sidebar-foot b { color: #b9cac5; font-weight: 500; }
.main-shell { min-width: 0; margin-left: var(--sidebar); }
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  height: 66px;
  background: rgba(244, 243, 237, .88);
  border-bottom: 1px solid rgba(185, 194, 186, .72);
  backdrop-filter: blur(18px);
}
.topbar-inner { height: 100%; display: flex; align-items: center; gap: 14px; padding: 0 34px; }
.menu-toggle { display: none; }
.breadcrumb { min-width: 0; flex: 1; display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 12px; }
.breadcrumb b, .breadcrumb strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.breadcrumb b { color: #9aa5a2; font-weight: 500; }
.breadcrumb strong { color: var(--ink); font-weight: 650; }
.top-actions { display: flex; align-items: center; gap: 8px; }
.icon-button, .action-button {
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  color: var(--ink-2);
  background: rgba(255,255,255,.72);
  border: 1px solid var(--line);
  border-radius: 6px;
  transition: border-color .14s ease, background .14s ease, color .14s ease, transform .14s ease;
}
.icon-button { width: 36px; }
.action-button { padding: 0 12px; font-size: 12px; }
.icon-button:hover, .action-button:hover { color: #173b3c; border-color: #9eb9ac; background: #fff; transform: translateY(-1px); }
.icon-button svg, .action-button svg { width: 16px; height: 16px; }
.progress-track { position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: transparent; }
.progress-bar { width: var(--reading-progress, 0%); height: 100%; background: linear-gradient(90deg, var(--mint), var(--coral)); transition: width .12s linear; }.reader {
  display: grid;
  grid-template-columns: minmax(0, 900px) 220px;
  gap: 60px;
  width: min(100%, 1260px);
  margin: 0 auto;
  padding: 52px 48px 120px;
}
.doc { min-width: 0; animation: doc-in .32s cubic-bezier(.2,.75,.25,1); }
.doc[hidden] { display: none; }
@keyframes doc-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.chapter-hero {
  position: relative;
  padding-bottom: 34px;
  border-bottom: 1px solid var(--line-strong);
}
.chapter-hero::after {
  content: "";
  position: absolute;
  left: 0;
  bottom: -1px;
  width: 96px;
  height: 3px;
  background: linear-gradient(90deg, var(--coral), var(--gold));
}
.chapter-kicker { display: flex; align-items: center; gap: 10px; color: var(--muted); font-family: var(--font-mono); font-size: 11px; letter-spacing: .06em; }
.chapter-kicker i { width: 34px; height: 1px; background: var(--line-strong); }
.chapter-hero h1 {
  margin: 17px 0 12px;
  color: var(--ink);
  font-family: var(--font-display);
  font-size: clamp(31px, 4vw, 48px);
  font-weight: 600;
  letter-spacing: -.025em;
  line-height: 1.2;
}
.chapter-lede { max-width: 760px; margin: 0; color: var(--ink-2); font-size: 16px; line-height: 1.85; }
.chapter-meta { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 22px; color: #7a8888; font-family: var(--font-mono); font-size: 10.5px; }
.chapter-meta span + span::before { content: "·"; margin-right: 16px; color: #b4bdb8; }
.doc-body { padding-top: 36px; color: #253a3d; font-size: 16px; line-height: 1.9; }
.doc-body > :first-child { margin-top: 0; }
.doc-body p { margin: 0 0 19px; }
.doc-body strong { color: #172e31; font-weight: 700; }
.doc-body a { color: #2e6971; text-decoration-color: rgba(46,105,113,.32); text-decoration-thickness: 1px; text-underline-offset: 3px; transition: color .14s ease, text-decoration-color .14s ease; }
.doc-body a:hover { color: #b4523f; text-decoration-color: currentColor; }
.doc-body .doc-link::after { content: "↗"; display: inline-block; margin-left: 3px; font-size: .78em; color: var(--coral); }
.doc-body .file-link::after, .doc-body .service-link::after { content: "↗"; margin-left: 3px; font-size: .78em; color: var(--muted); }
.doc-body h2, .doc-body h3, .doc-body h4 {
  position: relative;
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 600;
  letter-spacing: -.01em;
  scroll-margin-top: 92px;
}
.doc-body h2 { margin: 56px 0 20px; padding-left: 17px; font-size: 28px; line-height: 1.38; }
.doc-body h2::before { content: ""; position: absolute; left: 0; top: .28em; bottom: .22em; width: 4px; background: var(--mint); border-radius: 2px; }
.doc-body h3 { margin: 38px 0 14px; font-size: 21px; line-height: 1.5; }
.doc-body h4 { margin: 30px 0 12px; font-size: 17px; }
.heading-anchor { display: inline-block; margin-left: 8px; color: #b7c1bb !important; font-family: var(--font-mono); font-size: 15px; opacity: 0; text-decoration: none !important; transition: opacity .14s ease, color .14s ease; }
h2:hover .heading-anchor, h3:hover .heading-anchor, .heading-anchor:focus { opacity: 1; color: var(--coral) !important; }
.doc-body ul, .doc-body ol { margin: 0 0 20px; padding-left: 1.55em; }
.doc-body li { margin: 7px 0; padding-left: .2em; }
.doc-body li::marker { color: var(--coral); font-family: var(--font-mono); }
.doc-body li > ul, .doc-body li > ol { margin-top: 7px; margin-bottom: 7px; }
.doc-body input[type="checkbox"] { width: 15px; height: 15px; margin: 0 7px 0 -1.55em; vertical-align: -2px; accent-color: #4f8a77; }
.doc-body blockquote {
  margin: 26px 0;
  padding: 18px 22px;
  color: #3a5052;
  background: linear-gradient(100deg, #edf4ef, #f8f6ef);
  border-left: 4px solid var(--mint);
  border-radius: 0 8px 8px 0;
}
.doc-body blockquote p:last-child { margin-bottom: 0; }
.doc-body :not(pre) > code {
  padding: .12em .34em;
  color: #a84d3b;
  background: #f0ece4;
  border: 1px solid #e3ddd2;
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: .88em;
}
.code-block {
  position: relative;
  margin: 24px 0 28px;
  padding: 20px 22px;
  overflow: auto;
  color: #dcebe6;
  background: #182d30;
  border: 1px solid #2b4a4d;
  border-radius: 8px;
  box-shadow: 0 12px 28px rgba(20,40,44,.12);
}
.code-block::before { content: ""; position: absolute; top: 10px; right: 12px; width: 5px; height: 5px; background: var(--coral); border-radius: 50%; box-shadow: -9px 0 0 var(--gold), -18px 0 0 var(--mint); opacity: .8; }
.code-block code { display: block; padding-top: 5px; color: inherit; font-family: var(--font-mono); font-size: 12.5px; line-height: 1.72; white-space: pre; }
.table-wrap { margin: 22px 0 30px; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: rgba(255,254,250,.72); box-shadow: 0 8px 26px rgba(29,48,48,.045); }
.doc-body table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13px; line-height: 1.65; }
.doc-body th { padding: 12px 14px; color: #eff8f3; background: #244547; font-weight: 650; text-align: left; white-space: nowrap; }
.doc-body td { padding: 11px 14px; vertical-align: top; border-top: 1px solid #e2e6df; }
.doc-body tbody tr:nth-child(even) { background: rgba(139,196,170,.06); }
.doc-body tbody tr:hover { background: rgba(217,120,96,.06); }
.doc-body hr { margin: 42px 0; border: 0; border-top: 1px solid var(--line); }
.diagram-frame {
  margin: 26px 0 32px;
  padding: 20px;
  overflow: hidden;
  background: #fffefa;
  border: 1px solid #cfd8d1;
  border-radius: 9px;
  box-shadow: var(--shadow);
}
.diagram-frame figcaption { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 16px; color: var(--ink-2); font-size: 12px; font-weight: 650; }
.diagram-frame figcaption small { color: var(--muted); font-family: var(--font-mono); font-size: 10px; font-weight: 400; }
.mermaid { display: block; min-height: 120px; overflow: auto; color: #496366; font-family: var(--font-mono); font-size: 11px; line-height: 1.55; white-space: pre; }
.mermaid[data-processed="true"] { display: grid; place-items: center; padding: 10px 0; background: transparent; white-space: normal; }
.mermaid svg { max-width: 100%; height: auto; }
.diagram-source { margin-top: 14px; border-top: 1px dashed var(--line); }
.diagram-source summary { padding-top: 12px; color: var(--muted); font-size: 11px; cursor: pointer; }
.diagram-source pre { overflow: auto; margin: 10px 0 0; padding: 14px; background: #f0f3ee; border-radius: 6px; }
.diagram-source code { font-family: var(--font-mono); font-size: 11px; line-height: 1.5; }
.outline { position: sticky; top: 96px; align-self: start; max-height: calc(100vh - 126px); overflow: auto; padding-left: 18px; border-left: 1px solid var(--line); }
.outline-title { margin: 0 0 14px; color: #8b9896; font-family: var(--font-mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
.outline-list { display: grid; gap: 2px; }
.outline-list a { display: block; padding: 6px 0 6px 10px; color: #718082; border-left: 2px solid transparent; font-size: 11.5px; line-height: 1.45; text-decoration: none; transition: color .14s ease, border-color .14s ease, transform .14s ease; }
.outline-list a.level-3 { padding-left: 21px; color: #899694; font-size: 11px; }
.outline-list a:hover { color: var(--ink); transform: translateX(2px); }
.outline-list a.active { color: #1d5558; border-left-color: var(--coral); font-weight: 650; }
.chapter-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 72px; padding-top: 26px; border-top: 1px solid var(--line-strong); }
.chapter-link-card { min-height: 96px; padding: 17px 18px; color: var(--ink); text-decoration: none; background: rgba(255,254,250,.68); border: 1px solid var(--line); border-radius: 8px; transition: border-color .15s ease, background .15s ease, transform .15s ease, box-shadow .15s ease; }
.chapter-link-card:hover { border-color: #9eb9ac; background: #fff; transform: translateY(-2px); box-shadow: 0 10px 24px rgba(26,47,47,.08); }
.chapter-link-card.next { text-align: right; }
.chapter-link-card span { color: var(--muted); font-family: var(--font-mono); font-size: 10px; }
.chapter-link-card b { display: block; margin-top: 9px; font-family: var(--font-display); font-size: 16px; font-weight: 600; line-height: 1.45; }
.chapter-link-card.placeholder { visibility: hidden; pointer-events: none; }
.empty-state { padding: 32px 0; color: var(--muted); text-align: center; }.search-dialog {
  width: min(760px, calc(100vw - 30px));
  max-height: min(72vh, 680px);
  margin: 10vh auto 0;
  padding: 0;
  overflow: hidden;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid #bcc8c1;
  border-radius: 12px;
  box-shadow: 0 28px 90px rgba(10, 28, 30, .28);
}
.search-dialog::backdrop { background: rgba(10, 28, 30, .58); backdrop-filter: blur(5px); }
.search-head { display: flex; align-items: center; gap: 11px; padding: 15px 17px; border-bottom: 1px solid var(--line); }
.search-head svg { flex: none; color: var(--muted); }
.search-input { min-width: 0; flex: 1; height: 36px; padding: 0; color: var(--ink); background: transparent; border: 0; outline: 0; font-size: 16px; }
.search-close { width: 31px; height: 31px; display: grid; place-items: center; color: var(--muted); background: #f1f2ed; border: 0; border-radius: 5px; }
.search-hint { padding: 10px 18px; color: var(--muted); background: #f6f6f1; border-bottom: 1px solid var(--line); font-size: 10.5px; }
.search-results { max-height: 54vh; overflow: auto; padding: 8px; }
.search-result { width: 100%; display: block; padding: 12px 13px; color: var(--ink); text-align: left; background: transparent; border: 0; border-radius: 7px; }
.search-result:hover, .search-result.active { background: #edf4ef; }
.search-result small { display: block; margin-bottom: 4px; color: #7b8b89; font-family: var(--font-mono); font-size: 10px; }
.search-result b { display: block; font-size: 13px; font-weight: 700; line-height: 1.5; }
.search-result p { display: -webkit-box; overflow: hidden; margin: 5px 0 0; color: #667779; font-size: 11.5px; line-height: 1.55; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.search-result mark { color: #8f3e2e; background: #f4d7c8; border-radius: 2px; }
.nav-overlay { position: fixed; inset: 0; z-index: 25; display: none; background: rgba(6,22,24,.52); backdrop-filter: blur(3px); }
@media (max-width: 1180px) {
  .reader { grid-template-columns: minmax(0, 900px); }
  .outline { display: none; }
}
@media (max-width: 900px) {
  .sidebar { transform: translateX(-102%); transition: transform .22s cubic-bezier(.2,.75,.25,1); box-shadow: 20px 0 50px rgba(8,26,28,.28); }
  body.nav-open .sidebar { transform: none; }
  body.nav-open .nav-overlay { display: block; }
  .main-shell { margin-left: 0; }
  .menu-toggle { display: inline-flex; }
  .topbar-inner { padding: 0 18px; }
  .reader { padding: 38px 28px 100px; }
}
@media (max-width: 640px) {
  body { font-size: 14px; }
  .topbar { height: 60px; }
  .topbar-inner { gap: 8px; padding: 0 12px; }
  .breadcrumb b { display: none; }
  .action-button .button-label { display: none; }
  .action-button { width: 36px; padding: 0; }
  .reader { padding: 28px 18px 84px; }
  .chapter-hero h1 { font-size: 30px; }
  .chapter-lede { font-size: 15px; }
  .doc-body { font-size: 15px; line-height: 1.85; }
  .doc-body h2 { font-size: 24px; }
  .doc-body h3 { font-size: 19px; }
  .chapter-meta span + span::before { content: ""; margin: 0; }
  .chapter-footer { grid-template-columns: 1fr; }
  .chapter-link-card.next { text-align: left; }
  .search-dialog { margin-top: 4vh; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
@media print {
  body::before, .sidebar, .topbar, .outline, .chapter-footer, .nav-overlay, .heading-anchor, .diagram-source { display: none !important; }
  .main-shell { margin: 0; }
  .reader { display: block; width: auto; padding: 0; }
  .doc[hidden] { display: none !important; }
  .chapter-hero { padding-bottom: 18px; }
  .chapter-hero h1 { font-size: 26pt; }
  .doc-body { font-size: 10.5pt; }
  .doc-body a { text-decoration: none; }
  .doc-body h2 { break-after: avoid; }
  .code-block, .diagram-frame, .table-wrap { break-inside: avoid; }
}
</style>
</head>
<body>
<aside class="sidebar" id="sidebar" aria-label="系统说明书目录">
  <div class="brand">
    <div class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="7" r="2.4"/><circle cx="12" cy="18" r="2.4"/>
        <path d="M8.2 7.1 15.8 7M7.1 8.1l3.7 7.7M16.9 9.1l-3.7 6.7"/>
      </svg>
    </div>
    <div class="brand-copy"><strong>系统说明书</strong><span>Ontology Field Guide</span></div>
  </div>
  <div class="sidebar-tools">
    <button class="search-trigger" type="button" data-open-search>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.7-3.7"/></svg>
      <span>搜索说明内容</span><kbd>Ctrl K</kbd>
    </button>
  </div>
  <nav class="nav-groups">
    ${navMarkup}
  </nav>
  <div class="sidebar-foot">
    <b>${docs.length} 篇 · 单文件阅读版</b><br>
    生成于 ${escapeHtml(manifest.buildTime)}<br>
    源码目录：docs/系统说明书
  </div>
</aside>
<div class="nav-overlay" data-close-nav></div>
<div class="main-shell">
  <header class="topbar">
    <div class="topbar-inner">
      <button class="icon-button menu-toggle" type="button" data-toggle-nav aria-label="打开章节导航">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h16"/></svg>
      </button>
      <div class="breadcrumb"><b id="breadcrumb-group">系统说明书</b><span>/</span><strong id="breadcrumb-title">正在载入</strong></div>
      <div class="top-actions">
        <button class="action-button" type="button" data-open-search>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.7-3.7"/></svg>
          <span class="button-label">搜索</span>
        </button>
        <button class="action-button" type="button" data-print>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>
          <span class="button-label">打印本章</span>
        </button>
      </div>
    </div>
    <div class="progress-track"><div class="progress-bar"></div></div>
  </header>
  <div class="reader">
    <main id="manual-content">
      ${articleMarkup}
    </main>
    <aside class="outline" aria-label="本章目录">
      <p class="outline-title">本章目录</p>
      <nav class="outline-list" id="outline-list"></nav>
    </aside>
  </div>
</div>
<dialog class="search-dialog" id="search-dialog">
  <div class="search-head">
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.7-3.7"/></svg>
    <input class="search-input" id="search-input" type="search" autocomplete="off" placeholder="搜索章节、术语、接口或错误码" aria-label="搜索说明内容">
    <button class="search-close" type="button" data-close-search aria-label="关闭搜索">Esc</button>
  </div>
  <div class="search-hint">输入关键词，结果会定位到章节。支持 Ctrl/⌘ + K。</div>
  <div class="search-results" id="search-results"></div>
</dialog>
<script id="manual-manifest" type="application/json">${JSON.stringify(manifest).replaceAll("<", "\\u003c")}</script><script>
(() => {
  "use strict";
  const manifest = JSON.parse(document.getElementById("manual-manifest").textContent);
  const docs = manifest.docs;
  const docsById = new Map(docs.map((doc) => [doc.id, doc]));
  const articles = [...document.querySelectorAll(".doc")];
  const navLinks = [...document.querySelectorAll(".nav-link")];
  const breadcrumbGroup = document.getElementById("breadcrumb-group");
  const breadcrumbTitle = document.getElementById("breadcrumb-title");
  const outlineList = document.getElementById("outline-list");
  const searchDialog = document.getElementById("search-dialog");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  let activeDocId = "";
  let searchEntries = [];
  let visibleResults = [];
  let activeResultIndex = -1;
  let mermaidStarted = false;

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function plainText(node) {
    return String(node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findDocIdForHash(hash) {
    if (!hash) return manifest.defaultDocId;
    const element = document.getElementById(hash);
    if (!element) return manifest.defaultDocId;
    if (element.classList.contains("doc")) return element.id;
    return element.closest(".doc")?.id || manifest.defaultDocId;
  }

  function showDoc(docId, anchorId, options = {}) {
    const doc = docsById.get(docId) || docsById.get(manifest.defaultDocId);
    if (!doc) return;
    activeDocId = doc.id;

    for (const article of articles) {
      article.hidden = article.id !== doc.id;
    }

    for (const link of navLinks) {
      const isActive = link.dataset.docId === doc.id;
      link.classList.toggle("active", isActive);
      if (isActive) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    breadcrumbGroup.textContent = doc.group;
    breadcrumbTitle.textContent = doc.title;
    document.title = doc.title + " · 系统说明书";

    renderOutline(doc.id);
    renderChapterFooter(doc.id);

    const anchor = anchorId ? document.getElementById(anchorId) : null;
    requestAnimationFrame(() => {
      if (anchor) {
        anchor.scrollIntoView({ block: "start", behavior: options.instant ? "auto" : "smooth" });
      } else if (!options.keepScroll) {
        window.scrollTo({ top: 0, behavior: options.instant ? "auto" : "smooth" });
      }
      updateScrollState();
    });

    if (options.closeNav !== false) document.body.classList.remove("nav-open");
  }

  function route() {
    const hash = decodeURIComponent(window.location.hash.slice(1));
    const docId = findDocIdForHash(hash);
    const target = hash && document.getElementById(hash);
    const anchorId = target && !target.classList.contains("doc") ? hash : "";
    showDoc(docId, anchorId, { instant: true, closeNav: false });
  }

  function renderOutline(docId) {
    const article = document.getElementById(docId);
    const headings = article ? [...article.querySelectorAll(".doc-body h2, .doc-body h3")] : [];
    if (!headings.length) {
      outlineList.innerHTML = '<span class="empty-state">本章暂无分节</span>';
      return;
    }
    outlineList.innerHTML = headings.map((heading) =>
      '<a class="level-' + heading.tagName.slice(1) + '" href="#' + heading.id + '" data-heading-id="' + heading.id + '">' + escapeHtml(plainText(heading).replace(/#$/, "")) + "</a>"
    ).join("");
    updateOutlineActive();
  }

  function renderChapterFooter(docId) {
    const article = document.getElementById(docId);
    const footer = article?.querySelector("[data-chapter-footer]");
    if (!footer) return;
    const index = docs.findIndex((doc) => doc.id === docId);
    const previous = index > 0 ? docs[index - 1] : null;
    const next = index < docs.length - 1 ? docs[index + 1] : null;
    footer.innerHTML = (previous
      ? '<a class="chapter-link-card previous" href="#' + previous.id + '"><span>上一章</span><b>' + escapeHtml(previous.title) + "</b></a>"
      : '<span class="chapter-link-card placeholder"></span>')
      + (next
        ? '<a class="chapter-link-card next" href="#' + next.id + '"><span>下一章</span><b>' + escapeHtml(next.title) + "</b></a>"
        : '<span class="chapter-link-card placeholder"></span>');
  }

  function updateScrollState() {
    const doc = document.getElementById(activeDocId);
    if (!doc) return;
    const top = window.scrollY || document.documentElement.scrollTop;
    const height = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    document.documentElement.style.setProperty("--reading-progress", Math.min(100, Math.max(0, top / height * 100)) + "%");
    updateOutlineActive();
  }

  function updateOutlineActive() {
    const current = document.getElementById(activeDocId);
    if (!current) return;
    const links = [...outlineList.querySelectorAll("a[data-heading-id]")];
    if (!links.length) return;
    let active = links[0].dataset.headingId;
    const marker = Math.max(90, Math.round(window.innerHeight * .2));
    for (const link of links) {
      const heading = document.getElementById(link.dataset.headingId);
      if (heading && heading.getBoundingClientRect().top <= marker) active = link.dataset.headingId;
      else break;
    }
    for (const link of links) link.classList.toggle("active", link.dataset.headingId === active);
  }

  function buildSearchIndex() {
    searchEntries = docs.map((doc) => {
      const article = document.getElementById(doc.id);
      const entries = [{
        docId: doc.id,
        headingId: "",
        group: doc.group,
        docTitle: doc.title,
        heading: doc.title,
        text: doc.description || article.querySelector(".chapter-hero")?.textContent || "",
      }];
      const body = article.querySelector(".doc-body");
      let current = null;
      for (const node of body.children) {
        if (/^H[23]$/.test(node.tagName)) {
          current = { docId: doc.id, headingId: node.id, group: doc.group, docTitle: doc.title, heading: plainText(node).replace(/#$/, ""), text: "" };
          entries.push(current);
          continue;
        }
        const text = plainText(node);
        if (!text) continue;
        if (!current) {
          current = { docId: doc.id, headingId: "", group: doc.group, docTitle: doc.title, heading: doc.title, text: "" };
          entries.push(current);
        }
        if (current.text.length < 9000) current.text += (current.text ? " " : "") + text.slice(0, 1800);
      }
      return entries;
    }).flat();
  }
  function resultSnippet(text, query) {
    const normalizedText = normalize(text);
    const index = normalizedText.indexOf(query);
    const start = Math.max(0, index - 42);
    const raw = text.slice(start, start + 150);
    const lowerRaw = raw.toLowerCase();
    const hit = lowerRaw.indexOf(query);
    if (hit < 0) return escapeHtml(raw) + (text.length > start + 150 ? "…" : "");
    return escapeHtml(raw.slice(0, hit)) + "<mark>" + escapeHtml(raw.slice(hit, hit + query.length)) + "</mark>" + escapeHtml(raw.slice(hit + query.length)) + (text.length > start + 150 ? "…" : "");
  }

  function search(queryValue) {
    const query = normalize(queryValue);
    if (!query) {
      searchResults.innerHTML = '<div class="empty-state">输入关键词开始搜索</div>';
      visibleResults = [];
      activeResultIndex = -1;
      return;
    }

    visibleResults = searchEntries.map((entry) => {
      const heading = normalize(entry.heading);
      const title = normalize(entry.docTitle);
      const text = normalize(entry.text);
      let score = -1;
      if (title.startsWith(query)) score = 100;
      else if (heading.startsWith(query)) score = 90;
      else if (title.includes(query)) score = 75;
      else if (heading.includes(query)) score = 70;
      else if (text.includes(query)) score = 40;
      return { ...entry, score };
    }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 40);

    activeResultIndex = visibleResults.length ? 0 : -1;
    searchResults.innerHTML = visibleResults.length
      ? visibleResults.map((entry, index) =>
        '<button class="search-result' + (index === 0 ? " active" : "") + '" type="button" data-result-index="' + index + '">'
        + '<small>' + escapeHtml(entry.group + " · " + entry.docTitle) + "</small>"
        + "<b>" + escapeHtml(entry.heading) + "</b>"
        + "<p>" + resultSnippet(entry.text || entry.heading, query) + "</p>"
        + "</button>"
      ).join("")
      : '<div class="empty-state">没有找到“' + escapeHtml(queryValue) + '”</div>';
  }

  function setActiveResult(index) {
    const buttons = [...searchResults.querySelectorAll(".search-result")];
    buttons.forEach((button, buttonIndex) => button.classList.toggle("active", buttonIndex === index));
    buttons[index]?.scrollIntoView({ block: "nearest" });
  }

  function openSearch() {
    if (typeof searchDialog.showModal === "function") searchDialog.showModal();
    else searchDialog.setAttribute("open", "");
    document.body.classList.remove("nav-open");
    requestAnimationFrame(() => {
      searchInput.focus();
      searchInput.select();
    });
    search(searchInput.value);
  }

  function closeSearch() {
    if (typeof searchDialog.close === "function") searchDialog.close();
    else searchDialog.removeAttribute("open");
  }

  function openResult(index) {
    const entry = visibleResults[index];
    if (!entry) return;
    closeSearch();
    const targetHash = entry.headingId || entry.docId;
    if (window.location.hash.slice(1) === targetHash) route();
    else window.location.hash = targetHash;
  }

  for (const button of document.querySelectorAll("[data-open-search]")) button.addEventListener("click", openSearch);
  for (const button of document.querySelectorAll("[data-close-search]")) button.addEventListener("click", closeSearch);
  document.querySelector("[data-print]").addEventListener("click", () => window.print());
  document.querySelector("[data-toggle-nav]").addEventListener("click", () => document.body.classList.toggle("nav-open"));
  document.querySelector("[data-close-nav]").addEventListener("click", () => document.body.classList.remove("nav-open"));

  searchInput.addEventListener("input", () => search(searchInput.value));
  searchResults.addEventListener("click", (event) => {
    const button = event.target.closest("[data-result-index]");
    if (button) openResult(Number(button.dataset.resultIndex));
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      if (searchDialog.open) closeSearch();
      else openSearch();
      return;
    }
    if (!searchDialog.open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (visibleResults.length) {
        activeResultIndex = (activeResultIndex + 1) % visibleResults.length;
        setActiveResult(activeResultIndex);
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (visibleResults.length) {
        activeResultIndex = (activeResultIndex - 1 + visibleResults.length) % visibleResults.length;
        setActiveResult(activeResultIndex);
      }
    } else if (event.key === "Enter" && activeResultIndex >= 0) {
      event.preventDefault();
      openResult(activeResultIndex);
    }
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", updateScrollState, { passive: true });
  window.addEventListener("resize", updateOutlineActive);

  function markMermaidFallback() {
    for (const block of document.querySelectorAll(".mermaid:not([data-processed='true'])")) {
      const frame = block.closest(".diagram-frame");
      if (!frame || frame.dataset.fallback === "true") continue;
      frame.dataset.fallback = "true";
      const note = document.createElement("p");
      note.className = "search-hint";
      note.textContent = "当前无网络或图表组件不可用，下面保留 Mermaid 源码；联网打开会自动渲染为流程图。";
      block.before(note);
    }
  }

  function loadMermaid() {
    if (mermaidStarted) return;
    mermaidStarted = true;
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.async = true;
    script.onload = async () => {
      if (!window.mermaid) return markMermaidFallback();
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "loose",
        theme: "base",
        fontFamily: '"IBM Plex Sans", "Noto Sans SC", "Microsoft YaHei", sans-serif',
        themeVariables: {
          primaryColor: "#e8f3ed",
          primaryTextColor: "#14282c",
          primaryBorderColor: "#8bc4aa",
          lineColor: "#6f8d8b",
          secondaryColor: "#f4e7df",
          tertiaryColor: "#edf0e8",
          fontSize: "13px",
        },
      });
      const blocks = [...document.querySelectorAll(".mermaid")];
      for (let index = 0; index < blocks.length; index += 1) {
        try {
          const result = await window.mermaid.render("system-manual-diagram-" + index, blocks[index].textContent);
          blocks[index].innerHTML = result.svg;
          blocks[index].dataset.processed = "true";
        } catch (error) {
          console.warn("Mermaid render failed", error);
        }
      }
      markMermaidFallback();
    };
    script.onerror = markMermaidFallback;
    document.head.appendChild(script);
    window.setTimeout(markMermaidFallback, 3500);
  }

  buildSearchIndex();
  route();
  loadMermaid();
})();
</script>
</body>
</html>
`;

await writeFile(OUTPUT_FILE, html, "utf8");
console.log(`Generated ${path.relative(ROOT, OUTPUT_FILE)} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KiB, ${docs.length} documents)`);