"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Copy, FileJson, Loader2, Play, RefreshCcw, Terminal, Wand2 } from "lucide-react";
import { api } from "@/lib/api-client";
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
type McpTool = { name: string; title: string; group: string; description: string; inputSchema: ToolSchema };
type McpInfo = {
  endpoint: string;
  absoluteUrl: string;
  protocolVersion: string;
  transport: string;
  tokenConfigured: boolean;
  groups: { key: string; label: string; description: string }[];
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

/** 「自动填参」：本体 id 用当前选中的，其余按类型给一个能跑通的示例值。 */
function exampleArguments(tool: McpTool, ontologyId: string) {
  const properties = tool.inputSchema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (name === "ontology_id") { result[name] = ontologyId; continue; }
    if (name === "query") { result[name] = "用户 订单"; continue; }
    if (name === "type_name") { result[name] = "用户"; continue; }
    if (name === "type_names") { result[name] = ["用户", "订单"]; continue; }
    if (property.type === "integer") { result[name] = 5; continue; }
    if (property.type === "boolean") { result[name] = false; continue; }
    if (property.type === "array") { result[name] = []; continue; }
  }
  return result;
}

function CopyButton({ value, label, notify }: { value: string; label: string; notify: (text: string) => void }) {
  return (
    <button
      type="button"
      className="mcp-copy"
      onClick={() => { void navigator.clipboard.writeText(value).then(() => notify(`${label}已复制。`)).catch(() => notify("复制失败，请手动选中。")); }}
    >
      <Copy size={12} />复制
    </button>
  );
}

export function McpStudio({ ontologies, notify, fail }: Props) {
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [activeName, setActiveName] = useState("search_schema");
  const [argumentsText, setArgumentsText] = useState("{}");
  const [response, setResponse] = useState<string>("");
  const [ok, setOk] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showDoc, setShowDoc] = useState(false);
  const ontologyId = ontologies[0]?.id ?? "";

  useEffect(() => {
    void api<McpInfo>("/api/mcp/info").then((data) => {
      setInfo(data);
      const first = data.tools.find((tool) => tool.name === "search_schema") ?? data.tools[0];
      if (first) { setActiveName(first.name); setArgumentsText(JSON.stringify(exampleArguments(first, ontologyId), null, 2)); }
    }).catch(fail);
    // 只在挂载时取一次；本体 id 变了下面那个 effect 会重填示例参数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = useMemo(() => info?.tools.find((tool) => tool.name === activeName) ?? null, [info, activeName]);

  const select = useCallback((tool: McpTool) => {
    setActiveName(tool.name);
    setArgumentsText(JSON.stringify(exampleArguments(tool, ontologyId), null, 2));
    setResponse("");
    setShowDoc(false);
  }, [ontologyId]);

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
      </div>

      <div className="mcp-body">
        <aside className="mcp-tools panel functional-panel">
          <div className="mcp-tools-head">
            <span className="eyebrow">工具</span>
            <b>{info.tools.length} 个</b>
          </div>
          {info.groups.map((group) => {
            const tools = info.tools.filter((tool) => tool.group === group.key);
            if (!tools.length) return null;
            return (
              <div className="mcp-group" key={group.key}>
                <div className="mcp-group-head">
                  <b>{group.label}</b>
                  <small>{group.description}</small>
                </div>
                {tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    className={`mcp-tool${tool.name === activeName ? " active" : ""}`}
                    onClick={() => select(tool)}
                  >
                    <b>{tool.title}</b>
                    <code>{tool.name}</code>
                  </button>
                ))}
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
                  <button className="action primary compact" disabled={busy} onClick={() => void run()}>
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
                  <small>application/json</small>
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
                  {response && (
                    <span className={`mcp-status${ok ? " ok" : " bad"}`}>
                      {ok ? <Check size={12} /> : <AlertCircle size={12} />}{ok ? "成功" : "出错"}
                    </span>
                  )}
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
