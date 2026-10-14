"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check, Copy, ShieldCheck, Trash2, X } from "lucide-react";
import { api } from "@/lib/framework/api-client";
import { copyText } from "@/lib/framework/clipboard";
import "./mcp-token-dialog.css";

/**
 * 已注册的 OAuth 客户端（走授权码流程接 MCP 的那些）。
 *
 * 客户端是**自助注册**进来的：MCP 客户端第一次连接时会自己去 `POST /api/oauth/register`，
 * 所以这一屏不是"新建客户端"的地方，而是**给管理员看的**：谁的客户端连过、最近用没用、删掉不认识的。
 * 删除会把它的授权码与刷新令牌一起作废（服务端 `deleteClient` 里做）。
 */

export type OAuthClientEntry = {
  id: string;
  name: string;
  redirectUris: string[];
  source: string;
  createdAt: string;
  createdBy: string | null;
  disabled: boolean;
  lastUsedAt: string | null;
};

type Props = {
  /** 平台地址（用来拼下面三个可复制的地址）：由页面按"用户实际访问的地址"算好传进来。 */
  origin: string;
  canManage: boolean;
  onClose: () => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

function clientOrigin(entry: OAuthClientEntry) {
  const when = entry.lastUsedAt
    ? `最近换令牌：${new Date(entry.lastUsedAt).toLocaleString("zh-CN", { hour12: false })}`
    : "还没有换过令牌";
  const how = entry.source === "DCR" ? "客户端自助注册" : "管理员登记";
  const time = new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false });
  return `${how} · ${time} · ${when}`;
}

export function McpClientsDialog({ origin, canManage, onClose, notify, fail }: Props) {
  const [clients, setClients] = useState<OAuthClientEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const endpoints = [
    { key: "resource", label: "受保护资源元数据（客户端拿 401 后读它）", value: origin + "/.well-known/oauth-protected-resource" },
    { key: "as", label: "授权服务器元数据", value: origin + "/.well-known/oauth-authorization-server" },
    { key: "mcp", label: "MCP 资源地址", value: origin + "/api/mcp" },
  ];

  // 开窗时读一次清单：客户端很少变，而这一屏本来就是"看看现在有谁"。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await api<{ clients: OAuthClientEntry[] }>("/api/oauth/clients");
        if (!alive) return;
        setClients(data.clients);
      } catch (reason) {
        if (!alive) return;
        setClients([]);
        fail(reason);
      }
    })();
    return () => { alive = false; };
  }, [fail]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const copy = async (key: string, text: string) => {
    const done = await copyText(text);
    if (!done) { notify("复制失败，请手动选中这一段。"); return; }
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const remove = async (entry: OAuthClientEntry) => {
    if (!window.confirm(`删掉客户端「${entry.name}」？正在用它连的客户端会立刻断开，要重新授权。`)) return;
    setBusy(true);
    try {
      const data = await api<{ clients: OAuthClientEntry[] }>(`/api/oauth/clients?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      setClients(data.clients);
      notify(`已删除客户端「${entry.name}」。`);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop mcp-key-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="mcp-key-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-clients-title">
        <header className="mcp-key-head">
          <span className="mcp-key-mark"><ShieldCheck size={19} /></span>
          <div className="mcp-key-title">
            <span className="mcp-key-eyebrow">MCP / OAuth 授权</span>
            <h2 id="mcp-clients-title">OAuth 客户端</h2>
          </div>
          <button type="button" className="mcp-key-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <div className="mcp-key-body">
          <p className="mcp-key-lede">
            支持 OAuth 的客户端不需要手工贴令牌：它连上 MCP 后会被引导到这里注册、再打开授权页让你点「允许」，
            拿到的是<b>你的账号</b>的只读权限，1 小时过期、自动刷新。
          </p>

          <ul className="mcp-key-list">
            {endpoints.map((item) => (
              <li className="mcp-key-item" key={item.key}>
                <div className="mcp-key-main">
                  <div className="mcp-key-line">
                    <b>{item.label}</b>
                    <button type="button" className="mcp-key-btn" onClick={() => void copy(item.key, item.value)}>
                      {copied === item.key ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                  <small className="mcp-key-origin"><code>{item.value}</code></small>
                </div>
              </li>
            ))}
          </ul>

          <ul className="mcp-key-list">
            {(clients ?? []).map((entry) => (
              <li className="mcp-key-item" key={entry.id}>
                <div className="mcp-key-main">
                  <div className="mcp-key-line">
                    <b>{entry.name}</b>
                    <code className="mcp-key-fingerprint">{entry.id}</code>
                    <span className="mcp-key-actions">
                      <button type="button" className="mcp-key-btn danger" disabled={!canManage || busy} onClick={() => void remove(entry)} title="删掉这个客户端，并作废它的授权码与刷新令牌">
                        <Trash2 size={12} />删除
                      </button>
                    </span>
                  </div>
                  <small className="mcp-key-origin">{clientOrigin(entry)}</small>
                  <small className="mcp-key-owner">回调：{entry.redirectUris.join(" , ")}</small>
                </div>
              </li>
            ))}
            {clients && !clients.length && (
              <li className="mcp-key-empty">还没有客户端注册过：支持 OAuth 的客户端第一次连接时会自动出现在这里。</li>
            )}
            {clients === null && <li className="mcp-key-empty">正在读取…</li>}
          </ul>

          <p className="mcp-key-note">
            只认 https 回调地址（本机 localhost 允许 http）；回调地址必须与注册时一字不差。
            授权页上用户能看到「是哪个客户端、用哪个账号」，同意之后才会发码。
          </p>
          {!canManage && (
            <p className="mcp-key-warn"><AlertTriangle size={13} />只读：删除客户端要「管理 MCP 访问令牌」权限。</p>
          )}
        </div>

        <footer className="mcp-key-foot">
          <span>删掉客户端只影响它；已经发的访问令牌最多 1 小时后失效。</span>
          <button type="button" className="mcp-key-btn" onClick={onClose}>完成</button>
        </footer>
      </div>
    </div>
  );
}
