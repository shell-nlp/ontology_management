"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Boxes, Check, Copy, Download, FileJson, FileText, Info, Loader2, PackageCheck, Sparkles, Wand2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { stripFrontMatter } from "@/lib/markdown";
import { copyText, downloadResponse } from "@/lib/clipboard";
import { MarkdownView, inlineMarkdown } from "@/components/markdown-view";
import { useSplitPane } from "@/components/split-pane";
import "./skill-studio.css";

/**
 * 本体技能：把「怎么建一个本体」写成 AI 助手能直接用的技能包，放在平台里看得见、拿得走。
 *
 * 三件事按顺序：需求澄清 → 本体设计 → 出包交付；最终产物是平台能导入的
 * 本体包 JSON（`format: ontology.bundle`）。技能正文来自仓库根的 `skills/`（服务端读盘），
 * 这一页只负责展示、复制、下载与安装说明。
 *
 * 对标 bkn-studio 的「AI Skills 构建」：同样的"几号技能 / 适用场景 / 主要产物"结构，
 * 区别是技能内容就在本平台里，不依赖外部仓库。
 */

type SkillFile = { path: string; bytes: number; entry: boolean };
type SkillSummary = {
  id: string;
  stage: number;
  title: string;
  scenario: string;
  outputs: string;
  icon: "requirement" | "builder" | "bundle";
  description: string;
  files: SkillFile[];
};
type SkillFileContent = SkillFile & { content: string };
type SkillDetail = Omit<SkillSummary, "files"> & { files: SkillFileContent[] };

const ICONS = { requirement: FileText, builder: Boxes, bundle: PackageCheck } as const;

const EXAMPLE_FILE = { skillId: "ontology-bundle", path: "references/example.bundle.json", name: "example.bundle.json" };

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

export function SkillStudio({ notify, fail }: { notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [filePath, setFilePath] = useState("SKILL.md");
  const [modalOpen, setModalOpen] = useState(false);
  const [copied, setCopied] = useState("");
  const copyTimer = useRef<number | null>(null);

  const { containerRef, containerStyle, handleProps } = useSplitPane({
    storageKey: "skill-split",
    defaultWidth: 340,
    minLeft: 300,
    minDetail: 480,
    maxLeft: 620,
    label: "拖动调整技能清单宽度，双击恢复默认",
  });

  useEffect(() => {
    api<{ skills: SkillSummary[]; hint: string | null }>("/api/skills")
      .then((data) => {
        setSkills(data.skills);
        setHint(data.hint);
        setSelectedId((current) => current || data.skills[0]?.id || "");
      })
      .catch((reason) => { setSkills([]); fail(reason); });
  }, [fail]);

  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    api<{ skill: SkillDetail }>(`/api/skills/${encodeURIComponent(selectedId)}`)
      .then((data) => { if (!alive) return; setDetail(data.skill); setFilePath(data.skill.files.find((file) => file.entry)?.path ?? data.skill.files[0]?.path ?? ""); })
      .catch((reason) => { if (alive) fail(reason); });
    return () => { alive = false; };
  }, [selectedId, fail]);

  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);

  /** 加载态由"选中的技能与已加载的不一致"推出来，不用额外的 state（effect 里直接 setState 会被 lint 拦）。 */
  const loadingDetail = Boolean(selectedId) && detail?.id !== selectedId;
  const activeFile = useMemo(
    () => detail?.files.find((file) => file.path === filePath) ?? detail?.files[0] ?? null,
    [detail, filePath],
  );

  const copy = async (value: string, key: string, label: string) => {
    const ok = await copyText(value);
    if (!ok) { notify("复制失败，请手动选中这一段。"); return; }
    setCopied(key);
    notify(`${label}已复制。`);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(""), 1600);
  };

  const downloadFile = async (skillId: string, path: string, fallback: string) => {
    try {
      await downloadResponse(`/api/skills/${encodeURIComponent(skillId)}/file?path=${encodeURIComponent(path)}`, fallback);
    } catch (reason) {
      fail(reason);
    }
  };

  const downloadArchive = async (skill: SkillSummary) => {
    try {
      await downloadResponse(`/api/skills/${encodeURIComponent(skill.id)}/archive`, `${skill.id}.zip`);
      notify(`已下载「${skill.title}」技能包（解压后放进 Agent 的技能目录即可）。`);
    } catch (reason) {
      fail(reason);
    }
  };

  const downloadExample = async () => {
    try {
      await downloadResponse(`/api/skills/${EXAMPLE_FILE.skillId}/file?path=${encodeURIComponent(EXAMPLE_FILE.path)}`, EXAMPLE_FILE.name);
      notify("已下载示例本体包：可以在「本体 → 导入本体包」里先试一次。");
    } catch (reason) {
      fail(reason);
    }
  };

  return (
    <section className="stack">
      <div className="panel functional-panel">
        <div className="title-row">
          <div>
            <span className="eyebrow">本体技能</span>
            <h2>用 AI Skills 构建本体</h2>
          </div>
          <div className="functional-actions">
            <button className="action" onClick={() => void downloadExample()} title="下载一份能直接导入的示例本体包"><FileJson size={16} />下载示例包</button>
            <button className="action primary" onClick={() => setModalOpen(true)}><Sparkles size={16} />获取 Skills</button>
          </div>
        </div>
        <p className="subtle">
          从业务材料出发，用三套技能完成需求澄清、本体设计和出包交付；产物是平台能直接导入的
          <b>本体包 JSON</b>（<code>format: ontology.bundle</code>）。技能可以整套下载，放进 Codex / Claude 的技能目录里用。
        </p>
      </div>

      <section className="manager-grid instance-manager-grid" ref={containerRef} style={containerStyle}>
        <div className="panel functional-panel sk-list">
          <span className="eyebrow">技能清单</span>
          <h2>{skills ? `${skills.length} 套技能` : "加载中…"}</h2>
          {hint && <p className="sk-hint"><Info size={13} />{hint}</p>}
          {(skills ?? []).map((skill) => {
            const Icon = ICONS[skill.icon];
            return (
              <button
                key={skill.id}
                type="button"
                className={skill.id === selectedId ? "sk-card selected" : "sk-card"}
                onClick={() => setSelectedId(skill.id)}
              >
                <span className="sk-stage">{skill.stage}</span>
                <span className="sk-card-body">
                  <span className="sk-card-title"><Icon size={14} />{skill.title}</span>
                  <code className="sk-card-code">{skill.id}</code>
                  <small>{inlineMarkdown(skill.description || skill.scenario, `desc-${skill.id}`)}</small>
                  <span className="sk-card-meta">{skill.files.length} 个文件 · {formatBytes(skill.files.reduce((sum, file) => sum + file.bytes, 0))}</span>
                </span>
              </button>
            );
          })}
          {skills?.length === 0 && <p className="sk-empty">技能目录里没有内容。</p>}
          <div className="sk-list-foot">
            <button className="action compact" onClick={() => void downloadExample()}><FileJson size={13} />示例包</button>
            <button className="action compact" onClick={() => setModalOpen(true)}><PackageCheck size={13} />整套下载</button>
          </div>
        </div>

        <div {...handleProps}><span aria-hidden="true" /></div>

        <div className="panel functional-panel sk-detail">
          {detail ? (
            <>
              <div className="title-row">
                <div>
                  <span className="eyebrow">技能原文</span>
                  <h2>{detail.title} <code className="sk-detail-code">{detail.id}</code></h2>
                </div>
                <div className="functional-actions">
                  <button className="action" onClick={() => void copy(detail.files.find((file) => file.entry)?.content ?? "", `${detail.id}-all`, "技能入口")}><Copy size={15} />复制 SKILL.md</button>
                  <button className="action" onClick={() => void downloadArchive(detail)}><Download size={15} />下载整套 (.zip)</button>
                </div>
              </div>
              <p className="subtle">{inlineMarkdown(detail.description || detail.scenario, "detail-desc")}</p>

              <div className="sk-files" role="tablist" aria-label="技能文件">
                {detail.files.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    role="tab"
                    aria-selected={file.path === activeFile?.path}
                    className={file.path === activeFile?.path ? "sk-file active" : "sk-file"}
                    onClick={() => setFilePath(file.path)}
                  >
                    {file.path}{file.entry ? "（入口）" : ""}
                  </button>
                ))}
              </div>

              {activeFile && (
                <>
                  <div className="sk-file-bar">
                    <span>{activeFile.path} · {formatBytes(activeFile.bytes)}</span>
                    <span className="sk-file-actions">
                      <button className="action compact" onClick={() => void copy(activeFile.content, activeFile.path, activeFile.path)}>
                        {copied === activeFile.path ? <Check size={13} /> : <Copy size={13} />}{copied === activeFile.path ? "已复制" : "复制"}
                      </button>
                      <button className="action compact" onClick={() => void downloadFile(detail.id, activeFile.path, activeFile.path.split("/").pop() ?? "skill.md")}><Download size={13} />下载</button>
                    </span>
                  </div>
                  <div className="sk-doc"><MarkdownView text={activeFile.entry ? stripFrontMatter(activeFile.content) : activeFile.content} /></div>
                </>
              )}
              {loadingDetail && <p className="sk-loading"><Loader2 size={13} />加载中…</p>}
            </>
          ) : (
            <p className="sk-empty">{loadingDetail ? "加载中…" : "左边选一套技能。"}</p>
          )}
        </div>
      </section>

      <div className="panel functional-panel sk-contract">
        <span className="eyebrow">交付契约</span>
        <h2>产物就是一个可导入的本体包</h2>
        <div className="sk-contract-grid">
          <div>
            <b><FileJson size={13} />一个 JSON 文件</b>
            <p>技能最终产出 <code>&lt;标识&gt;.ontology.json</code>：对象类型、关系类型、接口、概念分组、动作与规则，
              外加数据资源的<b>连接坐标</b>（不含账号密码，也不含实例数据）。</p>
          </div>
          <div>
            <b><Wand2 size={13} />三步导入</b>
            <p>左侧「本体」→「导入本体包」→ 选文件与存储资源 → 导入。导入后停在草稿，
              <b>先「校验」再「发布」</b>，发布后图库里才有这份结构。</p>
          </div>
          <div>
            <b><PackageCheck size={13} />怎么拿到技能</b>
            <p>点「获取 Skills」下载 zip，解压到 <code>~/.codex/skills/</code>（或 <code>~/.agents/skills/</code>），
              重启会话即可用；也可以直接复制 SKILL.md 内容贴给任意助手。</p>
          </div>
        </div>
      </div>

      {modalOpen && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setModalOpen(false)}>
          <div className="dialog sk-modal" role="dialog" aria-modal="true" aria-label="获取 Skills" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="close-button" onClick={() => setModalOpen(false)} title="关闭"><X size={18} /></button>
            <div className="dialog-icon"><Sparkles size={22} /></div>
            <span className="eyebrow">获取 Skills</span>
            <h2>把技能装进你的 Agent</h2>
            <p className="sk-modal-note">
              技能是一组 Markdown 文件，不需要装依赖。下载后解压到 Agent 的技能目录：
              Codex 是 <code>~/.codex/skills/&lt;技能名&gt;/SKILL.md</code>，
              通用目录是 <code>~/.agents/skills/&lt;技能名&gt;/SKILL.md</code>，重启会话即可使用。
            </p>
            <div className="sk-install-list">
              {(skills ?? []).map((skill) => (
                <section key={skill.id} className="sk-install-item">
                  <div>
                    <b>{skill.stage}. {skill.title}</b>
                    <code>{skill.id}</code>
                    <p>{skill.scenario}</p>
                  </div>
                  <span className="sk-install-actions">
                    <button className="action compact" onClick={() => void downloadArchive(skill)}><Download size={13} />下载 .zip</button>
                    <button className="action compact" onClick={() => void downloadFile(skill.id, "SKILL.md", "SKILL.md")}><FileText size={13} />只要 SKILL.md</button>
                  </span>
                </section>
              ))}
            </div>
            <div className="sk-install-foot">
              <span>示例本体包（可以直接导入试一次）：<code>example.bundle.json</code></span>
              <button className="action primary" onClick={() => void downloadExample()}><FileJson size={15} />下载示例包</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}