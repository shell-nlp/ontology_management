"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Copy, FileJson, KeyRound, Loader2, Play, RefreshCcw, Terminal, Wand2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { stripOntologyId } from "@/lib/mcp-schema";
import { authHeaders } from "@/lib/session-token";
import type { OntologySummary } from "@/components/ontology-studio";
import { McpTokenDialog, type McpTokenEntry, type RevealedToken } from "@/components/mcp-token-dialog";
import "./mcp-studio.css";

/**
 * MCP 调试：把平台暴露的 MCP 工具当成一个"接口台"来用。
 *
 * 页面上跑的是**真实的 MCP 协议**（POST /api/mcp，JSON-RPC 2.0），不是另做一套内部调用 ——
 * 这样调试页里看到什么，外部客户端接进来就是什么。
 *
 * 页面分两档（`.view-switcher`，与「本体技能」页同一个类）：
 * - **工具**（默认）：左边工具清单 + 右边被选中那个的说明 / 参数 / 请求体 / 响应；
 * - **MCP 接入**：服务地址与各客户端的配置片段（默认选中「通用 mcp.json」）。
 * 两档分开放是有意的：以前接入配置常驻在工具清单上面，页面太长（2026-09-18 用户口径：
 * "上面的 MCP 配置的信息也参照本体技能那里一样可以切换，默认看的是工具的页面"）。
 */

type SchemaProperty = { type?: string; description?: string; items?: { type?: string } };
type ToolSchema = { type?: string; properties?: Record<string, SchemaProperty>; required?: string[] };
type McpTool = { name: string; title: string; group: string; description: string; inputSchema: ToolSchema; disabled?: boolean };
type McpInfo = {
  endpoint: string;
  absoluteUrl: string;
  protocolVersion: string;
  transport: string;
  tokenConfigured: boolean;
  /** 访问令牌的清单：明文永远不在这份响应里（要看明文走 `/api/mcp/token?reveal=<id>`）。 */
  token: {
    configured: boolean;
    envConfigured: boolean;
    /** 可以有多条：换个客户端 / 换台机器各配一条，停用其中一个不牵连别人。 */
    tokens: McpTokenEntry[];
    warning: string | null;
    /** 管理令牌要 ADMIN。 */
    canManage: boolean;
  };
  groups: { key: string; label: string; description: string; disabled?: boolean }[];
  /** 被关掉的工具名：关掉之后模型与外部客户端都拿不到它。 */
  disabledTools: string[];
  /** 这份开关是从哪来的：当前本体自己的覆盖 / 全局默认 / 谁都没配。 */
  toolPolicySource: "ONTOLOGY" | "GLOBAL" | "DEFAULT";
  /** 全局默认那一份（界面上用来说明"继承的是什么"）。 */
  globalDisabledTools: string[];
  /** 当前本体自己的覆盖；null = 跟随全局。 */
  overrideDisabledTools: string[] | null;
  /** 服务端认的当前本体（回显用）。 */
  ontologyId: string | null;
  tools: McpTool[];
};

/** `/api/reasoning/tools` 的响应：只管开关状态，没有地址与工具目录。 */
type ToolPolicyState = {
  ontologyId: string | null;
  disabledTools: string[];
  toolPolicySource: "ONTOLOGY" | "GLOBAL" | "DEFAULT";
  globalDisabledTools: string[];
  overrideDisabledTools: string[] | null;
};

type Props = {
  ontologies: OntologySummary[];
  /** 当前选中的本体：工具开关按它读/写，MCP 地址也按它拼。 */
  ontologyId?: string;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

/** 两档：工具（接口台）与 MCP 接入（怎么连）。**默认看工具**（2026-09-18 用户口径）。 */
type McpView = "tools" | "mcp";

const SUBTITLES: Record<McpView, string> = {
  tools: "平台把本体的工具按 MCP 协议暴露出去：外部客户端接的是同一个端点、同一套工具，这个页面用来逐个试。",
  mcp: "外部客户端用 Authorization: Bearer <访问令牌> 连接，令牌就在这一档生成 / 查看 / 撤销；平台内这个页面用登录会话直接调，走的是同一个端点。",
};

function typeLabel(property: SchemaProperty) {
  if (!property.type) return "any";
  if (property.type === "array") return `${property.items?.type ?? "string"}[]`;
  return property.type;
}

/**
 * 「自动填参」：本体 id 用当前选中的，数据资源名用本机登记的第一个 ——
 * 这两个是从名字猜不出来的，不填就等着看"xxx 不能为空"；其余按类型给示例值。
 *
 * `includeOntologyId`：本体级端点时传 false —— 那边 `ontology_id` 由地址钉死、
 * 参数表里也不显示它，示例参数就没必要再摆一个。
 */
function exampleArguments(tool: McpTool, ontologyId: string, defaultDataSource = "", includeOntologyId = true) {
  const properties = tool.inputSchema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (name === "ontology_id") { if (includeOntologyId) result[name] = ontologyId; continue; }
    if (name === "data_source") { if (defaultDataSource) result[name] = defaultDataSource; continue; }
    if (name === "query") { result[name] = "用户 订单"; continue; }
    if (name === "type_name") { result[name] = "用户"; continue; }
    if (name === "type_names") { result[name] = ["用户", "订单"]; continue; }
    if (property.type === "integer") { result[name] = 5; continue; }
    if (property.type === "boolean") { result[name] = false; continue; }
    if (property.type === "array") { result[name] = []; continue; }
  }
  return result;
}

/**
 * 配置片段里的令牌占位符。
 *
 * 没看过明文时配置里写占位符（配置可以随便贴）；点了「查看」之后就用真值 ——
 * 用户口径是「只能通过配置文件进行配置，不行的」，所以复制出去的配置要能直接用。
 */
const TOKEN_PLACEHOLDER = "<MCP_API_TOKEN>";
const SERVER_NAME = "ontology-management";


/** 复制按钮：点完自己变成「已复制」再变回来，不用盯着提示条确认。 */
function CopyButton({ value, label, notify, small }: { value: string; label: string; notify: (text: string) => void; small?: boolean }) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className={`mcp-copy${small ? " small" : ""}${done ? " done" : ""}`}
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

type ConnectBlock = { label: string; note?: string; code: string };
type ConnectTab = { key: string; label: string; hint: string; blocks: ConnectBlock[] };

/**
 * 一键复制走的接入配置。写法按各家官方文档来（Claude Code 的 `claude mcp add --transport http`
 * 与 `.mcp.json` 的 `type: "http"`、Cursor 的 `.cursor/mcp.json` 与 `${env:NAME}` 插值）。
 * 地址用你当前访问平台的地址；令牌用 `token` 传进来的那一条 —— 界面没看过明文时是占位符，
 * 点过「查看」之后就是真值，复制出去能直接用（用户口径：不想再手工替换）。
 *
 * **顺序与默认值**：通用 mcp.json 排第一且默认选中（2026-09-18 用户口径："MCP 配置那里，默认是
 * 通用 mcp.json"）。它是各客户端共用的那一段，先给最通用的，别让人先看到某个专有的写法。
 * 与「本体技能」页的 MCP 接入档口径一致。
 */
function connectTabs(url: string, serverName: string = SERVER_NAME, token: string = TOKEN_PLACEHOLDER): ConnectTab[] {
  const config = (entry: Record<string, unknown>) => JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2);
  const withToken = { type: "http", url, headers: { Authorization: `Bearer ${token}` } };
  return [
    {
      key: "generic",
      label: "通用 mcp.json",
      hint: "Claude Desktop、VS Code 这类客户端读的都是这一段，差别只在文件名与存放位置。",
      blocks: [
        {
          label: "mcpServers 片段",
          note: "有的客户端把 type 写成 streamable-http，含义完全一样。",
          code: config(withToken),
        },
      ],
    },
    {
      key: "claude",
      label: "Claude Code",
      hint: "两种加法：一行命令，或者项目里的 .mcp.json（后者可以进版本库，团队共用）。",
      blocks: [
        {
          label: "CLI 一行接入",
          note: "--scope user 是「所有项目都能用」，去掉就只对当前项目生效。",
          code: [
            `claude mcp add --transport http ${serverName} ${url} \\`,
            `  --header "Authorization: Bearer ${token}" \\`,
            "  --scope user",
          ].join("\n"),
        },
        {
          label: "项目 .mcp.json",
          note: "放在项目根目录并提交；Claude Code 首次使用时会问一次是否信任。",
          code: config(withToken),
        },
      ],
    },
    {
      key: "cursor",
      label: "Cursor",
      hint: "项目级放在 .cursor/mcp.json，想全局可用就放到 ~/.cursor/mcp.json。",
      blocks: [
        {
          label: "项目 .cursor/mcp.json",
          note: "Cursor 支持 ${env:NAME}，令牌放本机环境变量里，配置可以放心分享。",
          code: config({ url, headers: { Authorization: "Bearer ${env:MCP_API_TOKEN}" } }),
        },
      ],
    },
  ];
}

export function McpStudio({ ontologies, ontologyId: selectedOntologyId, notify, fail }: Props) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [activeName, setActiveName] = useState("search_schema");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [response, setResponse] = useState<string>("");
  const [ok, setOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showDoc, setShowDoc] = useState(false);
  const [view, setView] = useState<McpView>("tools");
  const [connectTab, setConnectTab] = useState("generic");
  /**
   * 复制的配置用哪条地址：
   * - `ontology`（默认）：**本体级**端点 `/api/mcp/<本体 id>`，配置片段一眼看出查的是谁；
   * - `platform`：平台级端点 `/api/mcp`，一个端点覆盖所有本体（每次调用带 ontology_id）。
   */
  const [scope, setScope] = useState<"ontology" | "platform">("ontology");
  const [dataSourceNames, setDataSourceNames] = useState<string[]>([]);
  /**
   * 被「查看」到的那一条（id + 明文）：由令牌弹窗回传，**只有点过查看或刚生成时才在浏览器里**。
   * 页面加载时拿到的是 `/api/mcp/info` 那份清单（只有名字 / 尾巴四位 / 来源）。
   */
  const [revealedToken, setRevealedToken] = useState<RevealedToken>(null);
  /** 令牌清单专门用一个弹窗管（2026-10-08 用户口径），这里只记它开没开。 */
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  // 用**当前选中的本体**，不是列表里的第一个（2026-10-08 修：以前多本体平台下会指向第一个本体）。
  const ontologyId = (selectedOntologyId || ontologies[0]?.id || "").trim();
  const ontologyName = ontologies.find((item) => item.id === ontologyId)?.name ?? ontologyId;
  const defaultDataSource = dataSourceNames[0] ?? "";
  /**
   * scope = 当前本体（默认）时，`ontology_id` 由地址钉死、端点也不返回它，
   * 调试页因此同样要把它藏起来（参数表 / 文档 / 示例参数）—— 页面原则是"看到什么就是什么"。
   */
  const pinnedScope = scope === "ontology" && Boolean(ontologyId);
  const absoluteUrl = info?.absoluteUrl ?? "";
  /*
   * 两条地址：
   * - 平台级：`/api/mcp`（一个端点覆盖所有本体，每次调用带 ontology_id）；
   * - 本体级：`/api/mcp/<本体 id>`（钉死在本体上，模型不用自己填 id，工具清单也按这个本体的开关给）。
   * 默认给**本体级** —— 用户口径：「不同的本体，mcp 工具查的内容也不同」，配置片段要一眼看出查的是谁。
   */
  const platformUrl = absoluteUrl;
  const pinnedUrl = ontologyId && absoluteUrl ? `${absoluteUrl.replace(/\/api\/mcp\/?$/, "")}/api/mcp/${ontologyId}` : absoluteUrl;
  const scopeUrl = scope === "ontology" && ontologyId ? pinnedUrl : platformUrl;
  const scopePath = scope === "ontology" && ontologyId ? `/api/mcp/${ontologyId}` : "/api/mcp";
  const scopeServerName = scope === "ontology" && ontologyId ? `${SERVER_NAME}-${ontologyId.slice(0, 8)}` : SERVER_NAME;
  // 看过明文就把它写进配置片段，复制出去能直接用；否则还是占位符。
  const tabs = useMemo(
    () => connectTabs(scopeUrl, scopeServerName, revealedToken?.token || TOKEN_PLACEHOLDER),
    [scopeUrl, scopeServerName, revealedToken],
  );
  const activeTab = tabs.find((tab) => tab.key === connectTab) ?? tabs[0];

  useEffect(() => {
    // 工具开关按本体分：带上当前本体，服务端会给"这个本体最终生效的那一份"与它的来源。
    void api<McpInfo>(`/api/mcp/info${ontologyId ? `?ontologyId=${encodeURIComponent(ontologyId)}` : ""}`).then((data) => {
      // 地址以**浏览器当前地址**为准，覆盖服务端拼的那份：服务端在 dev / 容器 / 转发后面
      // 有可能只认得到自己的 localhost，复制出去换台机器就废了（2026-09-18 用户报的）。
      setInfo({ ...data, absoluteUrl: `${window.location.origin}${data.endpoint}` });
      const first = data.tools.find((tool) => tool.name === "search_schema") ?? data.tools[0];
      if (first) { setActiveName(first.name); setArgumentsText(JSON.stringify(exampleArguments(first, ontologyId, "", !pinnedScope), null, 2)); }
    }).catch(fail);
    // 只在挂载 / 换本体时取一次；换了工具 / 数据资源时由 select 按最新依赖重填示例参数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ontologyId]);

  // 数据资源名要填进示例参数里（名字猜不出来），开机就先拿一份 —— 列表接口只回公开字段，没有密文。
  useEffect(() => {
    void api<{ name: string }[]>("/api/data-sources")
      .then((sources) => setDataSourceNames(sources.map((item) => item.name)))
      .catch(() => setDataSourceNames([]));
  }, []);

  const active = useMemo(() => info?.tools.find((tool) => tool.name === activeName) ?? null, [info, activeName]);

  /** 开关一个工具：写到**当前本体**（没有本体就写全局）。写完立刻刷新，界面与外部客户端看到的都是服务端那一份。 */
  const toggleTool = async (name: string, enabled: boolean) => {
    if (!info) return;
    const next = enabled ? info.disabledTools.filter((item) => item !== name) : [...info.disabledTools, name];
    try {
      const saved = await api<ToolPolicyState>("/api/reasoning/tools", { method: "PUT", body: JSON.stringify({ disabledTools: next, ...(ontologyId ? { ontologyId } : {}) }) });
      setInfo({ ...info, disabledTools: saved.disabledTools, toolPolicySource: saved.toolPolicySource, globalDisabledTools: saved.globalDisabledTools, overrideDisabledTools: saved.overrideDisabledTools });
      const label = info.tools.find((tool) => tool.name === name)?.title ?? name;
      notify(enabled
        ? `已在${ontologyId ? `本体「${ontologyName}」` : "全局默认"}开启「${label}」，模型与外部客户端都能用它。`
        : `已在${ontologyId ? `本体「${ontologyName}」` : "全局默认"}关闭「${label}」，模型不再使用它。`);
    } catch (reason) {
      fail(reason);
    }
  };

  /** 撤销当前本体的覆盖，回到跟随全局默认。 */
  const resetPolicy = async () => {
    if (!info || !ontologyId) return;
    try {
      const saved = await api<ToolPolicyState>("/api/reasoning/tools", { method: "PUT", body: JSON.stringify({ disabledTools: [], ontologyId, reset: true }) });
      setInfo({ ...info, disabledTools: saved.disabledTools, toolPolicySource: saved.toolPolicySource, globalDisabledTools: saved.globalDisabledTools, overrideDisabledTools: saved.overrideDisabledTools });
      notify(`本体「${ontologyName}」的工具开关已回到跟随全局默认。`);
    } catch (reason) {
      fail(reason);
    }
  };

  /**
   * 令牌弹窗把清单与「手上那条」回传过来：页面据此更新摘要，并把它写进下面的接入配置片段。
   * 生成 / 查看 / 撤销本身都在弹窗里做（`mcp-studio` 不重复一套逻辑）——
   * 这里只接结果，别把这几个动作再抄回来。
   */
  const applyTokenState = useCallback((tokens: McpTokenEntry[], revealed: RevealedToken) => {
    setRevealedToken(revealed);
    setInfo((current) => (current
      ? { ...current, tokenConfigured: tokens.length > 0, token: { ...current.token, configured: tokens.length > 0, tokens } }
      : current));
  }, []);

  const select = useCallback((tool: McpTool) => {
    setActiveName(tool.name);
    setArgumentsText(JSON.stringify(exampleArguments(tool, ontologyId, defaultDataSource, !pinnedScope), null, 2));
    setResponse("");
    setShowDoc(false);
  }, [defaultDataSource, ontologyId, pinnedScope]);

  const run = useCallback(async () => {
    if (!active) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(argumentsText || "{}");
    } catch (error) {
      setOk(false);
      setResponse(`参数不是合法 JSON：${error instanceof Error ? error.message : ""}`);
      return;
    }
    setBusy(true);
    const started = Date.now();
    try {
      const envelope = {
        jsonrpc: "2.0" as const,
        id: 1,
        method: "tools/call" as const,
        params: { name: active.name, arguments: parsed },
      };
      // 调试用的地址跟「MCP 接入」里选的那条一致：默认是本体级端点，能看到"钉死本体"的真实行为。
      const res = await fetch(scopePath, {
        method: "POST",
        // 站内调试页用平台会话令牌（2026-10-09 起没有 cookie）；MCP 端点两种凭据都认。
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(envelope),
      });
      const body = await res.json();
      const elapsed = `POST ${scopePath} · ${Date.now() - started}ms`;
      if (body.error) {
        setOk(false);
        setResponse(`HTTP ${res.status} · ${elapsed}\n\n${JSON.stringify(body.error, null, 2)}`);
      } else if (body.result?.isError) {
        setOk(false);
        setResponse(`HTTP ${res.status} · ${elapsed}\n\n${body.result.content?.[0]?.text ?? ""}`);
      } else {
        setOk(true);
        setResponse(`HTTP ${res.status} · ${elapsed}\n\n${JSON.stringify(body.result?.structuredContent ?? body.result, null, 2)}`);
      }
    } catch (reason) {
      fail(reason);
      setOk(false);
      setResponse(reason instanceof Error ? reason.message : "调用失败。");
    } finally {
      setBusy(false);
    }
  }, [active, argumentsText, fail, scopePath]);

  if (!info) return <section className="stack"><div className="panel functional-panel">正在读取 MCP 信息…</div></section>;

  /** 参数表跟着 scope 走：本体级端点不暴露 ontology_id，页面也不显示它（平台级则保留）。 */
  const activeSchema = active
    ? (pinnedScope ? (stripOntologyId(active.inputSchema as unknown as Record<string, unknown>) as unknown as ToolSchema) : active.inputSchema)
    : undefined;
  const properties = Object.entries(activeSchema?.properties ?? {});
  const required = new Set(activeSchema?.required ?? []);
  /** 真正对外可用的工具数：平台停用的与用户关掉的都不算。 */
  const availableCount = info.tools.filter((tool) => !tool.disabled && !info.disabledTools.includes(tool.name)).length;
  /** 弹窗里刚「查看」过的那条：下面的接入配置片段用的就是它（片段只能带一个令牌）。 */
  const activeToken = revealedToken ? info.token.tokens.find((entry) => entry.id === revealedToken.id) ?? null : null;

  return (
    <section className="mcp-root">
      <div className="panel functional-panel">
        <div className="title-row">
          <div>
            <span className="eyebrow">MCP</span>
            <h2>本体 MCP 服务</h2>
          </div>
        </div>
        <p className="subtle">{SUBTITLES[view]}</p>
      </div>

      {/* 两档切换：默认看工具。以前接入配置压在工具清单上面，页面太长（2026-09-18 用户口径）。 */}
      <div className="view-switcher" aria-label="MCP 调试视图">
        <button className={view === "tools" ? "active" : ""} aria-pressed={view === "tools"} onClick={() => setView("tools")}>
          工具 <b>{availableCount}</b>
        </button>
        <button className={view === "mcp" ? "active" : ""} aria-pressed={view === "mcp"} onClick={() => setView("mcp")}>
          MCP 接入
        </button>
      </div>

      {view === "mcp" && (
      <div className="mcp-connect panel functional-panel">
        <div className="mcp-connect-head">
          <span className="mcp-connect-mark"><Terminal size={16} /></span>
          <div>
            <span className="eyebrow">MCP 服务地址</span>
            <b>{info.transport} · 协议 {info.protocolVersion}</b>
          </div>
          <span className={`mcp-token${info.tokenConfigured ? "" : " off"}`}>
            {info.token.configured ? `外部令牌 ${info.token.tokens.length} 条` : "未配置访问令牌"}
          </span>
        </div>
        <div className="mcp-connect-row">
          <code>{scopeUrl}</code>
          <CopyButton value={scopeUrl} label="地址" notify={notify} />
        </div>
        {/*
         * 这个端点查哪个本体（2026-10-08 用户口径：「不同的本体，mcp 工具查的内容也不同」）：
         * 默认给本体级地址，配置片段因此自带本体信息；平台级端点作为另一种用法留在这里。
         */}
        <div className="mcp-scope">
          <span className="eyebrow">这条配置查哪个本体</span>
          <div>
            <button type="button" className={scope === "ontology" ? "active" : ""} disabled={!ontologyId} onClick={() => setScope("ontology")}>
              当前本体{ontologyId ? `：${ontologyName}` : "（还没选本体）"}
            </button>
            <button type="button" className={scope === "platform" ? "active" : ""} onClick={() => setScope("platform")}>
              平台级（全部本体）
            </button>
          </div>
          <p className="mcp-scope-note">
            {scope === "ontology"
              ? "钉死在这个本体：工具清单按它自己的开关给，调工具时自动用它的 ontology_id —— 模型不用也不该自己填，避免查错本体。"
              : "一个端点覆盖平台上所有本体：每次调用由参数 ontology_id 决定查谁。本体 id 在平台上的本体列表里；开启 list_ontologies 后外部客户端也能自己列出来。"}
          </p>
        </div>
        {/*
         * 访问令牌（2026-10-08 用户口径「专门弹出来一个界面进行管理」）：清单在专用弹窗里管，
         * 这里只留一行摘要与入口 —— 令牌会越攒越多，全铺在页面上会把接入说明挤没了。
         */}
        <div className="mcp-token-box">
          <div className="mcp-token-summary">
            <span className="mcp-token-summary-mark"><KeyRound size={15} /></span>
            <div>
              <b>{info.token.tokens.length ? `访问令牌 ${info.token.tokens.length} 条` : "还没有访问令牌"}</b>
              <small>
                {info.token.tokens.length
                  ? `外部客户端用 Authorization: Bearer 连接${info.token.envConfigured ? " · 其中一条来自 .env.local" : ""}`
                  : "外部客户端现在还连不上：进去生成第一条"}
              </small>
            </div>
            <button type="button" className="mcp-token-manage" onClick={() => setTokenDialogOpen(true)}>
              管理令牌
            </button>
          </div>
          {activeToken && (
            <p className="mcp-token-active">
              下面的配置片段用的是「{activeToken.name}」（<code>{activeToken.hint}</code>）。
            </p>
          )}
          {info.token.warning && <p className="mcp-token-warn">{info.token.warning}</p>}
        </div>

        <div className="mcp-connect-body">
          <ol className="mcp-steps">
            <li>在上面的「访问令牌」里生成一条，并给它起个名字（哪台机器 / 哪个客户端在用）。</li>
            <li>点这条的「查看」，再选一个客户端，把下面的整段配置复制过去 —— 片段里带的就是真值，不用再手工替换。</li>
            <li>回到智能体的对话里直接提问，它通过 MCP 工具读这个本体 —— 只读，且每个结论都带证据。</li>
          </ol>

          <div className="mcp-connect-conf">
            <div className="mcp-tabs">
              <span className="eyebrow">接入配置</span>
              <div>
                {tabs.map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    className={`mcp-tab${tab.key === activeTab.key ? " active" : ""}`}
                    onClick={() => setConnectTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {!info.tokenConfigured && (
              <p className="mcp-connect-warn">
                <AlertCircle size={13} />
                服务端还没有 <code>MCP_API_TOKEN</code>，外面的客户端带着 Bearer 也进不来 —— 先在 <code>.env.local</code> 里补上。
              </p>
            )}

            <p className="mcp-connect-hint">{activeTab.hint}</p>

            {activeTab.blocks.map((block) => (
              <div className="mcp-block" key={block.label}>
                <div className="mcp-block-head">
                  <span>{block.label}</span>
                  <CopyButton value={block.code} label={block.label} notify={notify} small />
                </div>
                <pre>{block.code}</pre>
                {block.note && <p className="mcp-block-note">{block.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>
      )}

      {view === "tools" && (
      <div className="mcp-body">
        <aside className="mcp-tools panel functional-panel">
          <div className="mcp-tools-head">
            <span className="eyebrow">工具</span>
            <span className="mcp-tools-count">
              <b>{availableCount} 个可用</b>
              {/* 关掉的与平台停用的都要单独说清，否则"总数"会被当成"可用数"。 */}
              {info.disabledTools.length > 0 && <em>{info.disabledTools.length} 个已关闭</em>}
              {info.tools.some((tool) => tool.disabled) && <em>{info.tools.filter((tool) => tool.disabled).length} 个暂不使用</em>}
            </span>
          </div>
          {!info.token.canManage && <p className="subtle">只读：工具开关要「管理 MCP 访问令牌」权限，当前角色只能看，改不了。</p>}
          {/*
           * 开关是按本体存的：先说清这一屏的开关管的是谁，再给「跟随全局」的出口 ——
           * 否则用户会以为改了这里所有本体都跟着变（2026-10-08 用户报的疑问）。
           */}
          <div className="mcp-policy" title={info.globalDisabledTools.length ? `全局默认关掉的工具：${info.globalDisabledTools.join("、")}` : "全局默认没有关掉任何工具"}>
            <span>
              工具开关：
              {info.toolPolicySource === "ONTOLOGY"
                ? <>本体「{ontologyName}」<b>单独配置</b></>
                : <>跟随全局默认</>}
              {info.globalDisabledTools.length > 0 && <em>全局关了 {info.globalDisabledTools.length} 个</em>}
            </span>
            {info.toolPolicySource === "ONTOLOGY" && (
              <button type="button" onClick={() => void resetPolicy()} disabled={!info.token.canManage} title={!info.token.canManage ? "只有拥有「管理 MCP 访问令牌」权限的账号能改工具开关" : "删掉这个本体的覆盖，重新跟着全局默认走"}>跟随全局</button>
            )}
          </div>
          {info.groups.map((group) => {
            const tools = info.tools.filter((tool) => tool.group === group.key);
            if (!tools.length) return null;
            return (
              <div className={`mcp-group${group.disabled ? " parked" : ""}`} key={group.key}>
                <div className="mcp-group-head">
                  <b>{group.label}{group.disabled && <em>暂不使用</em>}</b>
                  <small>{group.description}</small>
                </div>
                {tools.map((tool) => {
                  const off = info.disabledTools.includes(tool.name);
                  return (
                    <div className={`mcp-tool-row${off ? " off" : ""}`} key={tool.name}>
                      <button
                        type="button"
                        className={`mcp-tool${tool.name === activeName ? " active" : ""}${tool.disabled ? " parked" : ""}`}
                        onClick={() => select(tool)}
                        disabled={tool.disabled}
                        title={tool.disabled ? "暂时不使用：这一版只在对象类型 / 关系类型这一层推理，不查实例" : tool.title}
                      >
                        <b>{tool.title}</b>
                        <code>{tool.name}</code>
                      </button>
                      {/* 平台自己停用的工具不给开关：开不了；其余的都能单独关掉。 */}
                      {!tool.disabled && (
                        <button
                          type="button"
                          role="switch"
                          aria-checked={!off}
                          aria-label={`${off ? "开启" : "关闭"}工具 ${tool.name}`}
                          className={`mcp-switch${off ? " off" : ""}`}
                          onClick={() => void toggleTool(tool.name, off)}
                          disabled={!info.token.canManage}
                          title={!info.token.canManage ? "只有拥有「管理 MCP 访问令牌」权限的账号能改工具开关" : off ? "已关闭：模型与外部客户端都拿不到它，点一下开启" : "已开启：点一下关掉，模型就不再用它"}
                        >
                          <i />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </aside>

        <div className="mcp-desk panel functional-panel">
          {active ? (
            <>
              <div className="mcp-desk-head">
                <div>
                  <span className="eyebrow">POST {info.endpoint}</span>
                  <h2>{active.title}</h2>
                  <code className="mcp-desk-name">{active.name}</code>
                </div>
                <div className="mcp-desk-actions">
                  <button className="action compact" onClick={() => setShowDoc((current) => !current)}>
                    <FileJson size={13} />{showDoc ? "收起文档" : "接口文档"}
                  </button>
                  <button className="action compact" onClick={() => setArgumentsText(JSON.stringify(exampleArguments(active, ontologyId, defaultDataSource, !pinnedScope), null, 2))}>
                    <Wand2 size={13} />自动填参
                  </button>
                  <button className="action primary compact" disabled={busy || info.disabledTools.includes(activeName)} onClick={() => void run()}>
                    {busy ? <Loader2 size={13} className="mcp-spin" /> : <Play size={13} />}运行
                  </button>
                </div>
              </div>
              <p className="mcp-desk-desc">{active.description}</p>

              {showDoc && <pre className="mcp-doc">{JSON.stringify(activeSchema ?? active.inputSchema, null, 2)}</pre>}

              <div className="mcp-section">
                <div className="mcp-section-head">
                  <span className="eyebrow">参数</span>
                  <small>{properties.length} 个 · 必填 {required.size} 个</small>
                </div>
                <div className="mcp-params">
                  {properties.map(([name, property]) => (
                    <div className="mcp-param" key={name}>
                      <code>{name}</code>
                      <span className={`mcp-param-type${required.has(name) ? " required" : ""}`}>{typeLabel(property)}{required.has(name) ? " · 必填" : ""}</span>
                      <p>{property.description ?? "—"}</p>
                    </div>
                  ))}
                  {!properties.length && <p className="mcp-empty">这个工具不需要参数。</p>}
                </div>
              </div>

              <div className="mcp-section">
                <div className="mcp-section-head">
                  <span className="eyebrow">请求体 · arguments</span>
                  <span className="mcp-section-tools">
                    <small>application/json</small>
                    <CopyButton value={argumentsText} label="请求体" notify={notify} small />
                  </span>
                </div>
                <textarea
                  className="mcp-body-input"
                  value={argumentsText}
                  spellCheck={false}
                  onChange={(event) => setArgumentsText(event.target.value)}
                  rows={8}
                />
              </div>

              <div className="mcp-section">
                <div className="mcp-section-head">
                  <span className="eyebrow">响应</span>
                  <span className="mcp-section-tools">
                    {response && (
                      <span className={`mcp-status${ok ? " ok" : " bad"}`}>
                        {ok ? <Check size={12} /> : <AlertCircle size={12} />}{ok ? "成功" : "出错"}
                      </span>
                    )}
                    {response && <CopyButton value={response} label="响应" notify={notify} small />}
                  </span>
                </div>
                {response
                  ? <pre className={`mcp-response${ok ? "" : " bad"}`}>{response}</pre>
                  : <p className="mcp-empty"><RefreshCcw size={13} />点「运行」调用一次，这里会显示 MCP 的真实返回。</p>}
              </div>
            </>
          ) : <p className="mcp-empty">左边选一个工具。</p>}
        </div>
      </div>
      )}

      {/* 令牌清单专用弹窗：生成 / 查看 / 撤销都在这里，页面只接结果。 */}
      {tokenDialogOpen && (
        <McpTokenDialog
          canManage={info.token.canManage}
          initialTokens={info.token.tokens}
          initialWarning={info.token.warning}
          onClose={() => setTokenDialogOpen(false)}
          onState={applyTokenState}
          notify={notify}
          fail={fail}
        />
      )}
    </section>
  );
}
