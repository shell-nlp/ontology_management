"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Boxes, Check, Copy, Download, FileText, PackageCheck, Sparkles, Terminal, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { copyText, downloadResponse } from "@/lib/clipboard";
import "./skill-studio.css";

/**
 * 本体技能：把「怎么建一个本体」写成 AI 助手能直接用的技能包，放在平台里看得见、拿得走。
 *
 * 这一页**刻意只给清单**——编号、名称、适用场景、主要产物。技能正文不进页面。
 * 取用有两条路，2026-09-18 用户口径是「skill 和 mcp 都支持的那种」，所以两条都留：
 *   1. **MCP 直连**：把 `/api/skills/mcp`（免令牌）填进 Agent 的 MCP 配置，它自己列技能、取全文；
 *   2. **整包下载**：拿 zip 解压进 Agent 的技能目录，离线用。
 *
 * 两条路各自一屏，**用顶部切换器分档**（2026-09-18 用户要求"放下面不好，页面太长了，直接做成可切换的页面"）——
 * 别再往同一列里堆叠。页头（标题 + 获取 Skills）与副标题常驻，副标题跟着档位走，这与「本体草稿」页一致。
 */

type SkillSummary = {
  id: string;
  stage: number;
  title: string;
  scenario: string;
  outputs: string;
  icon: "requirement" | "builder" | "bundle";
  description: string;
  files: { path: string; bytes: number; entry: boolean }[];
};

type SkillMcpInfo = {
  serverName: string;
  endpoint: string;
  /** 服务端尽力拼的绝对地址；界面拿到数据后会**用浏览器自己的地址覆盖它**（见下面的 useEffect）。 */
  absoluteUrl: string;
  protocolVersion: string;
  transport: string;
  /** 这个服务端**不鉴权**，恒为 false；字段留着是为了让界面不必靠猜。 */
  tokenRequired: boolean;
  tools: { name: string; title: string; description: string }[];
};

type SkillsPayload = { skills: SkillSummary[]; hint: string | null; mcp: SkillMcpInfo };

/** 页面两档：技能清单（有什么）与 MCP 接入（怎么拿）。 */
type SkillView = "skills" | "mcp";

const ICONS = { requirement: FileText, builder: Boxes, bundle: PackageCheck } as const;

/** 外部客户端里那条 MCP 服务叫这个名字（写进配置文件的 key）。 */
const MCP_SERVER_NAME = "ontology-skills";

/** 副标题跟着档位走（和「本体草稿」页同一套做法）：讲清这一档在干什么、另一档在哪。 */
const SUBTITLES: Record<SkillView, ReactNode> = {
  skills: (
    <>
      从业务材料出发，用三套技能完成需求澄清、本体设计和出包交付；产物是<b>可以直接导入平台的本体包 JSON</b>
      （<code>format: ontology.bundle</code>）。要把它们接进 Agent，切到「MCP 接入」拿地址；
      也可以点右上角整套下载，解压后放进技能目录离线用。
    </>
  ),
  mcp: (
    <>
      不用下载、也不用配技能目录：把下面的地址填进 Agent 的 MCP 配置，它就能自己列出技能、取技能全文，也能当斜杠命令用。
      技能是建模方法（Markdown），不含凭据与本体数据，所以这个端点<b>不校验令牌</b>；
      查本体数据的是另一个 MCP（「MCP 调试」页那个，要令牌）。
    </>
  ),
};

/** 复制按钮：点完自己变成「已复制」再变回来。复制走共用的 `copyText`（http + 机器 IP 访问也能用）。 */
function CopyButton({ value, label, notify }: { value: string; label: string; notify: (text: string) => void }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={`sk-copy${done ? " done" : ""}`}
      onClick={() => {
        void copyText(value).then((ok) => {
          if (!ok) { notify("复制失败，请手动选中这一段。"); return; }
          setDone(true);
          notify(`${label}已复制。`);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1600);
        });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}{done ? "已复制" : "复制"}
    </button>
  );
}

type ConnectTab = { key: string; label: string; hint: string; blocks: { label: string; note?: string; code: string }[] };

/**
 * 接入配置：**故意不带 `Authorization` 头** —— 这个 MCP 服务端不校验令牌，
 * 配上头反而会让人以为要申请一个 token。写法按各家官方文档来（Claude Code 的
 * `claude mcp add --transport http`、Cursor 的 `.cursor/mcp.json`）。
 *
 * **通用 mcp.json 放第一位、也是默认档**（2026-09-18 用户要求："默认是通用 mcp.json，并且要放到前面"）：
 * 它是所有客户端共用的那一段，先看到它就够了；两个具名客户端往后排。
 */
function connectTabs(url: string): ConnectTab[] {
  const config = JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url } } }, null, 2);
  return [
    {
      key: "generic",
      label: "通用 mcp.json",
      hint: "Claude Desktop、VS Code 这类客户端读的都是这一段，差别只在文件名与存放位置。",
      blocks: [{ label: "mcpServers 片段", note: "有的客户端把 type 写成 streamable-http，含义完全一样。", code: config }],
    },
    {
      key: "claude",
      label: "Claude Code",
      hint: "两种加法：一行命令，或者项目里的 .mcp.json（后者可以进版本库，团队共用）。",
      blocks: [
        {
          label: "CLI 一行接入",
          note: "--scope user 是「所有项目都能用」，去掉就只对当前项目生效。",
          code: [`claude mcp add --transport http ${MCP_SERVER_NAME} ${url} \\`, "  --scope user"].join("\n"),
        },
        {
          label: "项目 .mcp.json",
          note: "放在项目根目录并提交；Claude Code 首次使用时会问一次是否信任。",
          code: config,
        },
      ],
    },
    {
      key: "cursor",
      label: "Cursor",
      hint: "项目级放在 .cursor/mcp.json，想全局可用就放到 ~/.cursor/mcp.json。",
      blocks: [{ label: "项目 .cursor/mcp.json", code: config }],
    },
  ];
}

export function SkillStudio({ notify, fail }: { notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [mcp, setMcp] = useState<SkillMcpInfo | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [view, setView] = useState<SkillView>("skills");
  const [modalOpen, setModalOpen] = useState(false);
  const [connectTab, setConnectTab] = useState("generic");

  useEffect(() => {
    api<SkillsPayload>("/api/skills")
      .then((data) => {
        // MCP 地址以**浏览器当前地址**为准：服务端给的 absoluteUrl 有可能是它自己认的 localhost，
        // 复制出去换台机器就废了（2026-09-18 用户报的：「不能只是 localhost，要根据前端 url 变化才对」）。
        setMcp({ ...data.mcp, absoluteUrl: `${window.location.origin}${data.mcp.endpoint}` });
        setSkills(data.skills);
        setHint(data.hint);
      })
      .catch((reason) => { setSkills([]); fail(reason); });
  }, [fail]);

  const download = async (url: string, name: string, message: string) => {
    try {
      await downloadResponse(url, name);
      notify(message);
    } catch (reason) {
      fail(reason);
    }
  };

  /** 展示与复制都用这一份：已经是「浏览器当前地址 + 端点路径」。 */
  const mcpUrl = mcp?.absoluteUrl ?? "";
  const tabs = connectTabs(mcpUrl);
  const activeTab = tabs.find((tab) => tab.key === connectTab) ?? tabs[0];

  return (
    <section className="stack">
      <div className="panel functional-panel">
        <div className="title-row">
          <div>
            <span className="eyebrow">本体技能</span>
            <h2>AI Skills 辅助构建本体</h2>
          </div>
          <div className="functional-actions">
            <button className="action primary" onClick={() => setModalOpen(true)}><Sparkles size={16} />获取 Skills</button>
          </div>
        </div>
        <p className="subtle">{SUBTITLES[view]}</p>
      </div>

      <div className="view-switcher" aria-label="本体技能视图">
        <button className={view === "skills" ? "active" : ""} aria-pressed={view === "skills"} onClick={() => setView("skills")}>
          技能清单 <b>{skills?.length ?? 0}</b>
        </button>
        <button className={view === "mcp" ? "active" : ""} aria-pressed={view === "mcp"} onClick={() => setView("mcp")}>
          MCP 接入
        </button>
      </div>

      {view === "skills" && (
        <>
          <ol className="sk-flow">
            {(skills ?? []).map((skill) => {
              const Icon = ICONS[skill.icon];
              return (
                <li key={skill.id} className="sk-flow-item">
                  <span className="sk-stage">{skill.stage}</span>
                  <span className="sk-flow-icon" aria-hidden><Icon size={17} /></span>
                  <div className="sk-flow-body">
                    <div className="sk-flow-title">
                      <h3>{skill.title} Skill</h3>
                      <span aria-hidden>：</span>
                      <code>{skill.id}</code>
                    </div>
                    <dl className="sk-flow-desc">
                      <div>
                        <dt>适用场景</dt>
                        <dd>{skill.scenario}</dd>
                      </div>
                      <div>
                        <dt>主要产物</dt>
                        <dd>{skill.outputs}</dd>
                      </div>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ol>
          {skills?.length === 0 && <p className="sk-empty">{hint ?? "技能目录里没有内容。"}</p>}
        </>
      )}

      {view === "mcp" && (
        mcp ? (
          <div className="panel functional-panel sk-mcp">
            <div className="sk-mcp-head">
              <span className="eyebrow">服务地址</span>
              <span className="sk-mcp-badge">免令牌</span>
            </div>

            <div className="sk-mcp-addr">
              <Terminal size={14} aria-hidden />
              <code>{mcpUrl}</code>
              <CopyButton value={mcpUrl} label="MCP 地址" notify={notify} />
            </div>

            <div className="sk-mcp-meta">
              <span>{mcp.transport}</span>
              <span>协议 {mcp.protocolVersion}</span>
              <span>服务名 {mcp.serverName}</span>
              <span>{mcp.tools.length} 个工具 + {skills?.length ?? 0} 个提示词</span>
            </div>

            <div className="sk-mcp-tabs">
              <span className="eyebrow">接入配置</span>
              <div>
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`sk-mcp-tab${tab.key === activeTab.key ? " active" : ""}`}
                    onClick={() => setConnectTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="sk-mcp-hint">{activeTab.hint}</p>

            {activeTab.blocks.map((block) => (
              <div className="sk-mcp-block" key={block.label}>
                <div className="sk-mcp-block-head">
                  <span>{block.label}</span>
                  <CopyButton value={block.code} label={block.label} notify={notify} />
                </div>
                <pre>{block.code}</pre>
                {block.note && <p className="sk-mcp-block-note">{block.note}</p>}
              </div>
            ))}

            <div className="sk-mcp-tools">
              {mcp.tools.map((tool) => (
                <div className="sk-mcp-tool" key={tool.name}>
                  <b>{tool.title}</b>
                  <code>{tool.name}</code>
                  <p>{tool.description}</p>
                </div>
              ))}
            </div>
          </div>
        ) : <p className="sk-empty">正在读取 MCP 接入信息…</p>
      )}

      {modalOpen && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setModalOpen(false)}>
          <div className="dialog sk-modal" role="dialog" aria-modal="true" aria-label="获取 Skills" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="close-button" onClick={() => setModalOpen(false)} title="关闭"><X size={18} /></button>
            <div className="dialog-icon"><Sparkles size={22} /></div>
            <span className="eyebrow">获取 Skills</span>
            <h2>把技能装进你的 Agent</h2>
            <p className="sk-modal-note">
              两条路任选：<b>MCP 直连</b>最省事 —— 不用装东西，把 <code>{mcpUrl || "/api/skills/mcp"}</code> 填进
              Agent 的 MCP 配置即可（免令牌，配置见本页「MCP 接入」）。
              要走 <b>离线安装</b>就下载整包，解压到 Agent 的技能目录：
              Codex 是 <code>~/.codex/skills/&lt;技能名&gt;/SKILL.md</code>，
              通用目录是 <code>~/.agents/skills/&lt;技能名&gt;/SKILL.md</code>，重启会话即可使用。
            </p>
            <div className="sk-install-list">
              {(skills ?? []).map((skill) => (
                <section key={skill.id} className="sk-install-item">
                  <b>{skill.stage}. {skill.title} Skill</b>
                  <code>{skill.id}</code>
                  <p>{skill.scenario}</p>
                </section>
              ))}
            </div>
            <div className="sk-install-foot">
              <span>三套技能打在一个包里，解压出来就是三个技能目录。</span>
              <button
                className="action primary"
                onClick={() => void download("/api/skills/archive", "ontology-skills.zip", "已下载全部 Skills：解压后把三个目录放进 Agent 的技能目录即可。")}
              >
                <Download size={15} />下载全部 Skills (.zip)
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
