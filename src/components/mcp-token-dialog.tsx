"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, KeyRound, Plus, X } from "lucide-react";
import { api } from "@/lib/framework/api-client";
import { copyText } from "@/lib/framework/clipboard";
import "./mcp-token-dialog.css";

/**
 * 「访问令牌」的专用管理弹窗（2026-10-08 用户口径：「访问令牌的管理可以专门弹出来一个界面进行管理」）。
 *
 * 为什么不留在页面里：令牌是**会增多的清单**（换个客户端、换台机器各配一条），
 * 一行行铺在「MCP 接入」里会把整页挤长，还要跟地址、配置片段抢注意力。
 * 弹窗一开只干一件事：签发 / 查看 / 撤销外部访问凭据。
 *
 * 页面（`mcp-studio.tsx`）只留一行摘要与入口，清单与明文都从这里回传 ——
 * 配置片段要跟着"当前拿在手上的那条"走，所以弹窗和页面共用一份状态。
 */

/** 清单里的一条令牌。**不含明文** —— 明文只在「查看」或刚生成那一次拿到。 */
export type McpTokenEntry = {
  id: string;
  name: string;
  hint: string;
  source: "PLATFORM" | "ENV";
  /** 平台生成的那条能撤销；`.env.local` 那条只能去改配置文件。 */
  platformManaged: boolean;
  createdAt: string | null;
  createdBy: string | null;
};

/** `/api/mcp/token` 的响应。 */
type TokenListResponse = {
  tokens: McpTokenEntry[];
  envConfigured: boolean;
  warning: string | null;
  revealed?: { id: string; token: string } | null;
};

/** 拿在手上的明文是哪一条。null = 现在没有展开任何一条。 */
export type RevealedToken = { id: string; token: string } | null;

/** 每行右侧那行小字：这条令牌是哪来的、什么时候生成的。 */
export function tokenOrigin(entry: McpTokenEntry) {
  if (!entry.platformManaged) return "环境变量 · 只能改配置文件撤销";
  return entry.createdAt
    ? `平台生成 · ${new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}`
    : "平台生成";
}

type Props = {
  /** 管理令牌要 ADMIN；不是管理员就只读（按钮禁用 + 底下一句话）。 */
  canManage: boolean;
  /** 页面已经拿到的那份清单，用来避免开窗时闪一下"正在读取"。 */
  initialTokens: McpTokenEntry[];
  initialWarning?: string | null;
  onClose: () => void;
  /** 清单或"手上那条"变了：页面据此更新摘要，并把它写进接入配置片段。 */
  onState: (tokens: McpTokenEntry[], revealed: RevealedToken) => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

export function McpTokenDialog({ canManage, initialTokens, initialWarning = null, onClose, onState, notify, fail }: Props) {
  const [tokens, setTokens] = useState<McpTokenEntry[]>(initialTokens);
  const [warning, setWarning] = useState<string | null>(initialWarning);
  const [revealed, setRevealed] = useState<RevealedToken>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // 焦点落在"给新令牌起名"上：开窗后最常见的下一步就是发一条新的。
  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => () => { if (copyTimer.current !== null) window.clearTimeout(copyTimer.current); }, []);

  /** 三种操作的后半段一样：把服务端回的清单写回本地，并同步给页面。 */
  const apply = useCallback((state: TokenListResponse, next: RevealedToken) => {
    setTokens(state.tokens);
    setWarning(state.warning);
    setRevealed(next);
    onState(state.tokens, next);
  }, [onState]);

  const create = async () => {
    setBusy(true);
    try {
      const saved = await api<TokenListResponse & { created: { id: string; name: string; token: string } }>("/api/mcp/token", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      const next = { id: saved.created.id, token: saved.created.token };
      apply(saved, next);
      setName("");
      notify(`已生成令牌「${saved.created.name}」：点「复制」拿走它，接进客户端就能用。`);
      nameRef.current?.focus();
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  /** 查看 / 收起同一条：看哪条，页面上的接入配置片段就用哪条（片段只能带一个令牌）。 */
  const toggleReveal = async (entry: McpTokenEntry) => {
    if (revealed?.id === entry.id) {
      setRevealed(null);
      onState(tokens, null);
      return;
    }
    setBusy(true);
    try {
      const saved = await api<TokenListResponse>(`/api/mcp/token?reveal=${encodeURIComponent(entry.id)}`);
      apply(saved, saved.revealed ?? null);
      if (!saved.revealed) notify("这条取不出明文（多半是换过加密密钥），撤销它重新生成一条。");
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (entry: McpTokenEntry) => {
    if (!window.confirm(`撤销令牌「${entry.name}」？正在用它连的客户端会立刻断开，其它令牌不受影响。`)) return;
    setBusy(true);
    try {
      const saved = await api<TokenListResponse>(`/api/mcp/token?id=${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      apply(saved, revealed?.id === entry.id ? null : revealed);
      notify(`已撤销令牌「${entry.name}」。`);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (entry: McpTokenEntry, token: string) => {
    const done = await copyText(token);
    if (!done) { notify("复制失败，请手动选中这一段。"); return; }
    setCopied(entry.id);
    notify(`令牌「${entry.name}」已复制。`);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
  };

  return (
    <div
      className="dialog-backdrop mcp-key-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="mcp-key-dialog" role="dialog" aria-modal="true" aria-labelledby="mcp-key-title">
        <header className="mcp-key-head">
          <span className="mcp-key-mark"><KeyRound size={19} /></span>
          <div className="mcp-key-title">
            <span className="mcp-key-eyebrow">MCP / 外部访问凭据</span>
            <h2 id="mcp-key-title">访问令牌</h2>
          </div>
          <button type="button" className="mcp-key-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>

        <div className="mcp-key-body">
          <p className="mcp-key-lede">
            外部客户端拿这条令牌连 MCP：<code>Authorization: Bearer &lt;令牌&gt;</code>。
            一条令牌配一个客户端或一台机器，所以停用哪条只断哪条。
          </p>

          <ul className="mcp-key-list">
            {tokens.map((entry) => {
              const open = revealed?.id === entry.id;
              return (
                <li className={`mcp-key-item${open ? " open" : ""}`} key={entry.id}>
                  <span className={`mcp-key-notch${entry.platformManaged ? "" : " env"}`} aria-hidden="true" />
                  <div className="mcp-key-main">
                    <div className="mcp-key-line">
                      <b>{entry.name}</b>
                      <code className="mcp-key-fingerprint">{entry.hint}</code>
                      <span className="mcp-key-actions">
                        <button
                          type="button"
                          className="mcp-key-btn"
                          disabled={busy}
                          onClick={() => void toggleReveal(entry)}
                        >
                          {open ? "收起" : "查看"}
                        </button>
                        <button
                          type="button"
                          className="mcp-key-btn danger"
                          disabled={!canManage || !entry.platformManaged || busy}
                          onClick={() => void revoke(entry)}
                          title={entry.platformManaged
                            ? "删掉这条，只影响用它连的客户端"
                            : "这条来自服务端的 .env.local，只能去改配置文件"}
                        >
                          撤销
                        </button>
                      </span>
                    </div>
                    <small className="mcp-key-origin">{tokenOrigin(entry)}</small>
                    {open && revealed && (
                      <div className="mcp-key-secret">
                        <code>{revealed.token}</code>
                        <button type="button" className={`mcp-key-copy${copied === entry.id ? " done" : ""}`} onClick={() => void copy(entry, revealed.token)}>
                          {copied === entry.id ? <Check size={12} /> : <Copy size={12} />}
                          {copied === entry.id ? "已复制" : "复制"}
                        </button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
            {!tokens.length && (
              <li className="mcp-key-empty">还没有任何令牌：外部客户端现在连不上，在下面生成第一条。</li>
            )}
          </ul>

          {warning && <p className="mcp-key-warn"><AlertTriangle size={13} />{warning}</p>}

          <div className="mcp-key-create">
            <label className="mcp-key-field">
              <span>新令牌的名字</span>
              <input
                ref={nameRef}
                value={name}
                maxLength={60}
                placeholder="例如 Claude Desktop / 张三的笔记本"
                disabled={!canManage || busy}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void create(); } }}
              />
            </label>
            <button type="button" className="mcp-key-primary" disabled={!canManage || busy} onClick={() => void create()}>
              <Plus size={14} />生成令牌
            </button>
          </div>

          <p className="mcp-key-note">
            令牌的完整值只在生成那一刻展开一次；之后随时可以再「查看」。
            撤销立刻生效，已经连上的客户端下一次请求就会被拒。
          </p>
        </div>

        <footer className="mcp-key-foot">
          <span>{canManage ? "关掉这个窗口不会影响已经配好的客户端。" : "只有管理员能生成 / 查看 / 撤销令牌。"}</span>
          <button type="button" className="mcp-key-btn" onClick={onClose}>完成</button>
        </footer>
      </div>
    </div>
  );
}