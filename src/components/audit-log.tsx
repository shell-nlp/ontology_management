"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, RefreshCcw } from "lucide-react";
import { api } from "@/lib/api-client";
import { AUDIT_ACTIONS, AUDIT_SCOPE_OPTIONS, auditActionLabel, auditActionsForScope, isAuditFailure, type AuditScope } from "@/lib/audit";

/**
 * 审计记录（backlog U2）：发布 / 失败 / 图引擎与数据资源变更 / 草稿写入 / 动作执行，
 * 以前只在 PostgreSQL 的 `audit_entries` 里躺着，这里给它们一个界面。
 *
 * 与「版本记录」「动作决策记录」的关系：三处读的是同一张表 ——
 * 版本记录是它的一个切片（按版本号），决策记录是另一个切片（按动作前缀），
 * 这一页是**全平台视角**：谁、什么时候、对哪个本体存储做了什么。
 *
 * 过滤与分页都在服务端做（表会一直长），这里只保存条件并渲染当页。
 */

/** `/api/audit` 返回的一条记录（形状跟着 `@/lib/platform-db` 的 AuditEntry）。 */
type AuditRow = {
  id: string;
  actorEmail: string | null;
  targetId: string | null;
  action: string;
  details: Record<string, unknown>;
  createdAt: string;
};

type AuditPayload = {
  scope: AuditScope;
  entries: AuditRow[];
  total: number;
  targets: { id: string; name: string; kind: string }[];
  actors: { id: string; email: string }[];
};

const PAGE_SIZE = 50;

export function AuditLog({ fail }: { fail: (reason: unknown) => void }) {
  const [scope, setScope] = useState<AuditScope>("changes");
  const [action, setAction] = useState("");
  const [actorId, setActorId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [payload, setPayload] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async (nextOffset: number) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ scope, limit: String(PAGE_SIZE), offset: String(nextOffset) });
      if (action) params.set("action", action);
      if (actorId) params.set("actorId", actorId);
      if (targetId) params.set("targetId", targetId);
      // 日期框给的是本地日历日，转成带时区的时间戳再传，服务端按时间戳比较。
      if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set("to", new Date(`${to}T23:59:59`).toISOString());
      setPayload(await api<AuditPayload>(`/api/audit?${params.toString()}`));
      setOffset(nextOffset);
    } catch (reason) {
      fail(reason);
    } finally {
      setLoading(false);
    }
  }, [scope, action, actorId, targetId, from, to, fail]);

  // 过滤条件一改就回到第一页：留着旧页码会让人以为"过滤没生效"。
  useEffect(() => {
    // 放进微任务里再读：effect 里同步 setState（loading 标记）会触发级联渲染，
    // react-hooks/set-state-in-effect 盯着这一点；和本仓库其它"api(...).then(setState)"一个路子。
    void Promise.resolve().then(() => load(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, action, actorId, targetId, from, to]);

  const targetNames = useMemo(() => new Map((payload?.targets ?? []).map((target) => [target.id, target.name])), [payload]);
  const actionOptions = useMemo(() => {
    const codes = auditActionsForScope(scope) ?? AUDIT_ACTIONS.map((item) => item.code);
    return codes.map((code) => ({ code, label: auditActionLabel(code) }));
  }, [scope]);

  const entries = payload?.entries ?? [];
  const total = payload?.total ?? 0;
  const scopeHint = AUDIT_SCOPE_OPTIONS.find((option) => option.value === scope)?.hint ?? "";

  return (
    <section className="stack audit-log">
      <div className="view-switcher" aria-label="审计范围">
        {AUDIT_SCOPE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={scope === option.value ? "active" : ""}
            aria-pressed={scope === option.value}
            onClick={() => {
              setScope(option.value);
              // 换了范围，原来选的动作可能已经不在范围内（服务端会拒绝这种组合）。
              const codes = auditActionsForScope(option.value);
              if (action && codes && !codes.includes(action)) setAction("");
            }}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="panel functional-panel">
        <div className="section-toolbar">
          <div className="audit-filters">
            <select value={action} onChange={(event) => setAction(event.target.value)} title="按动作过滤">
              <option value="">全部动作</option>
              {actionOptions.map((option) => <option key={option.code} value={option.code}>{option.label}</option>)}
            </select>
            <select value={actorId} onChange={(event) => setActorId(event.target.value)} title="按操作人过滤">
              <option value="">全部操作人</option>
              {(payload?.actors ?? []).map((actor) => <option key={actor.id} value={actor.id}>{actor.email}</option>)}
            </select>
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)} title="按本体存储过滤">
              <option value="">全部本体存储</option>
              {(payload?.targets ?? []).map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
            </select>
            <label>从<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
            <label>到<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
            {(action || actorId || targetId || from || to) && <button className="action compact" onClick={() => { setAction(""); setActorId(""); setTargetId(""); setFrom(""); setTo(""); }}>清空筛选</button>}
          </div>
          <div className="audit-summary">
            <span>{total} 条记录</span>
            <button className="action compact" disabled={loading} onClick={() => void load(offset)}><RefreshCcw size={14} />{loading ? "读取中…" : "刷新"}</button>
          </div>
        </div>

        <p className="subtle audit-hint">{scopeHint}</p>

        <div className="audit-table">
          <div className="table-row audit-head"><span>时间</span><span>动作</span><span>操作人</span><span>本体存储</span><span>详情</span></div>
          {entries.map((row) => {
            const version = typeof row.details.versionId === "string" ? row.details.versionId : "";
            const virtualTarget = typeof row.details.virtualTargetId === "string";
            const storage = row.targetId ? targetNames.get(row.targetId) ?? row.targetId : virtualTarget ? "内置类型图" : "平台级";
            const open = openId === row.id;
            return (
              <div key={row.id} className={`audit-row-wrap${open ? " open" : ""}`}>
                <button className="table-row audit-row" onClick={() => setOpenId(open ? null : row.id)}>
                  <span className="audit-time">{formatTime(row.createdAt)}</span>
                  <span className={isAuditFailure(row.action) ? "audit-action failed" : "audit-action"}>
                    {auditActionLabel(row.action)}
                    {version ? <code>版本 {version.slice(0, 8)}</code> : null}
                  </span>
                  <span>{row.actorEmail ?? "—"}</span>
                  <span>{storage}</span>
                  <span className="audit-toggle">查看详情<ChevronDown size={13} /></span>
                </button>
                {open ? <pre className="audit-details">{JSON.stringify(row.details, null, 2)}</pre> : null}
              </div>
            );
          })}
          {!entries.length && <p className="empty">{loading ? "正在读取审计记录…" : "没有符合条件的记录。"}</p>}
        </div>

        {total > PAGE_SIZE && <div className="audit-pager">
          <button className="action compact" disabled={loading || offset === 0} onClick={() => void load(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={14} />上一页</button>
          <span>第 {offset + 1}–{Math.min(offset + entries.length, total)} 条 / 共 {total} 条</span>
          <button className="action compact" disabled={loading || offset + PAGE_SIZE >= total} onClick={() => void load(offset + PAGE_SIZE)}>下一页<ChevronRight size={14} /></button>
        </div>}
      </div>
    </section>
  );
}

/** 时间按本机时区显示到秒：审计要能对上"几点几分做的"。 */
function formatTime(value: string) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}
