"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, Copy, FileJson, Loader2, Play, RefreshCcw, Terminal, Wand2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import type { OntologySummary } from "@/components/ontology-studio";
import "./mcp-studio.css";

/**
 * MCP 调试：把平台暴露的 MCP 工具当成一个"接口台"来用。
 *
 * 页面上跑的是**真实的 MCP 协议**（POST /api/mcp，JSON-RPC 2.0），不是另做一套内部调用 ——
 * 这样调试页里看到什么，外部客户端接进来就是什么。
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
  groups: { key: string; label: string; description: string; disabled?: boolean }[];
  /** 被关掉的工具名：关掉之后模型与外部客户端都拿不到它。 */
  disabledTools: string[];
  tools: McpTool[];
};

type Props = {
  ontologies: OntologySummary[];
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

function typeLabel(property: SchemaProperty) {
  if (!property.type) return "any";
  if (property.type === "array") return `${property.items?.type ?? "string"}[]`;
  return property.type;
}

/**
 * 「自动填参」：本体 id 用当前选中的，数据资源名用本机登记的第一个 ——
 * 这两个是从名字猜不出来的，不填就等着看"xxx 不能为空"；其余按类型给示例值。
 */
function exampleArguments(tool: McpTool, ontologyId: string, defaultDataSource = "") {
  const properties = tool.inputSchema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (name === "ontology_id") { result[name] = ontologyId; continue; }
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

/** 令牌只以占位符出现在配置里：真实值在服务端 `.env.local`，密文不出服务端。 */
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
 * 地址用你当前访问平台的地址，令牌永远是占位符。
 */
function connectTabs(url: string): ConnectTab[] {
  const config = (entry: Record<string, unknown>) => JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
  const withToken = { type: "http", url, headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` } };
  return [
    {
      key: "claude",
      label: "Claude Code",
      hint: "两种加法：一行命令，或者项目里的 .mcp.json（后者可以进版本库，团队共用）。",
      blocks: [
        {
          label: "CLI 一行接入",
          note: "--scope user 是「所有项目都能用」，去掉就只对当前项目生效。",
          code: [
            `claude mcp add --transport http ${SERVER_NAME} ${url} \\`,
            `  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}" \\`,
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
  ];
}

export function McpStudio({ ontologies, notify, fail }: Props) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [activeName, setActiveName] = useState("search_schema");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [response, setResponse] = useState<string>("");
  const [ok, setOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showDoc, setShowDoc] = useState(false);
  const [connectTab, setConnectTab] = useState("claude");
  const [dataSourceNames, setDataSourceNames] = useState<string[]>([]);
  const ontologyId = ontologies[0]?.id ?? "";
  const defaultDataSource = dataSourceNames[0] ?? "";
  const absoluteUrl = info?.absoluteUrl ?? "";
  const tabs = useMemo(() => connectTabs(absoluteUrl), [absoluteUrl]);
  const activeTab = tabs.find((tab) => tab.key === connectTab) ?? tabs[0];

  useEffect(() => {
    void api<McpInfo>("/api/mcp/info").then((data) => {
      setInfo(data);
      const first = data.tools.find((tool) => tool.name === "search_schema") ?? data.tools[0];
      if (first) { setActiveName(first.name); setArgumentsText(JSON.stringify(exampleArguments(first, ontologyId), null, 2)); }
    }).catch(fail);
    // 只在挂载时取一次；换了工具 / 本体 / 数据资源时由 select 按最新依赖重填示例参数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据资源名要填进示例参数里（名字猜不出来），开机就先拿一份 —— 列表接口只回公开字段，没有密文。
  useEffect(() => {
    void api<{ name: string }[]>("/api/data-sources")
      .then((sources) => setDataSourceNames(sources.map((item) => item.name)))
      .catch(() => setDataSourceNames([]));
  }, []);

  const active = useMemo(() => info?.tools.find((tool) => tool.name === activeName) ?? null, [info, activeName]);

  /** 开关一个工具：写完立刻刷新清单，因为「运行」与外部客户端看到的都是服务端那一份。 */
  const toggleTool = async (name: string, enabled: boolean) => {
    if (!info) return;
    const next = enabled ? info.disabledTools.filter((item) => item !== name) : [...info.disabledTools, name];
    try {
      const saved = await api<{ disabledTools: string[] }>("/api/reasoning/tools", { method: "PUT", body: JSON.stringify({ disabledTools: next }) });
      setInfo({ ...info, disabledTools: saved.disabledTools });
      const label = info.tools.find((tool) => tool.name === name)?.title ?? name;
      notify(enabled ? `已开启「${label}」，模型与外部客户端都能用它。` : `已关闭「${label}」，模型不再使用它。`);
    } catch (reason) {
      fail(reason);
    }
  };

  const select = useCallback((tool: McpTool) => {
    setActiveName(tool.name);
    setArgumentsText(JSON.stringify(exampleArguments(tool, ontologyId, defaultDataSource), null, 2));
    setResponse("");
    setShowDoc(false);
  }, [defaultDataSource, ontologyId]);

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
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const body = await res.json();
      const elapsed = `${Date.now() - started}ms`;
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
  }, [active, argumentsText, fail]);

  if (!info) return <section className="stack"><div className="panel functional-panel">正在读取 MCP 信息…</div></section>;

  const properties = Object.entries(active?.inputSchema.properties ?? {});
  const required = new Set(active?.inputSchema.required ?? []);

  return (
    <section className="mcp-root">
      <div className="mcp-connect panel functional-panel">
        <div className="mcp-connect-head">
          <span className="mcp-connect-mark"><Terminal size={16} /></span>
          <div>
            <span className="eyebrow">MCP 服务地址</span>
            <b>{info.transport} · 协议 {info.protocolVersion}</b>
          </div>
          <span className={`mcp-token${info.tokenConfigured ? "" : " off"}`}>
            {info.tokenConfigured ? "外部令牌已配置" : "未配置 MCP_API_TOKEN"}
          </span>
        </div>
        <div className="mcp-connect-row">
          <code>{info.absoluteUrl}</code>
          <CopyButton value={info.absoluteUrl} label="地址" notify={notify} />
        </div>
        <p className="mcp-connect-note">
          外部客户端用 <code>Authorization: Bearer &lt;MCP_API_TOKEN&gt;</code> 连接（令牌在 <code>.env.local</code> 里）；
          平台内这个页面用登录会话直接调，走的是同一个端点、同一套工具。
        </p>

        <div className="mcp-connect-body">
          <ol className="mcp-steps">
            <li>在服务端的 <code>.env.local</code> 里给 <code>MCP_API_TOKEN</code> 填一个值，重启开发服务。</li>
            <li>选一个客户端，把下面的整段配置复制过去（令牌先用占位符，粘完再换成真值）。</li>
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

      <div className="mcp-body">
        <aside className="mcp-tools panel functional-panel">
          <div className="mcp-tools-head">
            <span className="eyebrow">工具</span>
            <span className="mcp-tools-count">
              <b>{info.tools.filter((tool) => !tool.disabled && !info.disabledTools.includes(tool.name)).length} 个可用</b>
              {/* 关掉的与平台停用的都要单独说清，否则"总数"会被当成"可用数"。 */}
              {info.disabledTools.length > 0 && <em>{info.disabledTools.length} 个已关闭</em>}
              {info.tools.some((tool) => tool.disabled) && <em>{info.tools.filter((tool) => tool.disabled).length} 个暂不使用</em>}
            </span>
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
                          title={off ? "已关闭：模型与外部客户端都拿不到它，点一下开启" : "已开启：点一下关掉，模型就不再用它"}
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
                  <button className="action compact" onClick={() => setArgumentsText(JSON.stringify(exampleArguments(active, ontologyId), null, 2))}>
                    <Wand2 size={13} />自动填参
                  </button>
                  <button className="action primary compact" disabled={busy || info.disabledTools.includes(activeName)} onClick={() => void run()}>
                    {busy ? <Loader2 size={13} className="mcp-spin" /> : <Play size={13} />}运行
                  </button>
                </div>
              </div>
              <p className="mcp-desk-desc">{active.description}</p>

              {showDoc && <pre className="mcp-doc">{JSON.stringify(active.inputSchema, null, 2)}</pre>}

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
    </section>
  );
}
