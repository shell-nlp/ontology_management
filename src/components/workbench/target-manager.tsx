"use client";

import { type Target } from "@/components/workbench/shared";
import { FormEvent, KeyboardEvent, useEffect, useState } from "react";
import { AlertCircle, Check, Database, Loader2, Pencil, PlugZap, Plus, Trash2, X } from "lucide-react";
import { GraphKindBadge, GraphKindChoice, GraphKindMark, capabilityLine } from "@/components/graph-kind-picker";
import { api } from "@/lib/framework/api-client";
import { CREATABLE_GRAPH_TARGET_KINDS, DEFAULT_GRAPH_TARGET_KIND, FRONTEND_GRAPH_TARGET_KINDS, graphTargetKindInfo, type GraphTargetKind } from "@/lib/framework/graph/types";





export type TargetFormState = { name: string; kind: GraphTargetKind; uri: string; databaseName: string; username: string; password: string; namedGraph: string };


export function defaultTargetForm(kind: GraphTargetKind): TargetFormState {
  const info = graphTargetKindInfo(kind);
  return { name: "", kind, uri: info.endpoint.example, databaseName: info.dataset?.example ?? "platform", username: info.credentials.usernameExample, password: "", namedGraph: "" };
}


export function formFromTarget(target: Target): TargetFormState {
  const namedGraph = target.options?.namedGraph;
  return { name: target.name, kind: target.kind, uri: target.uri, databaseName: target.databaseName, username: target.username, password: "", namedGraph: typeof namedGraph === "string" ? namedGraph : "" };
}


export function targetOptions(form: TargetFormState) {
  return form.namedGraph.trim() ? { namedGraph: form.namedGraph.trim() } : {};
}

/** 连接字段由后端类型元数据驱动，接入新的图数据库时这里不需要改动。 */

export function TargetFields({ form, setForm, editing = false }: { form: TargetFormState; setForm: (next: TargetFormState) => void; editing?: boolean }) {
  const info = graphTargetKindInfo(form.kind);
  const credentialRequired = info.credentials.required;
  return <>
    <label>名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：生产知识图谱" required /></label>
    {form.kind === "EMBEDDED" && <p className="subtle">定义和发布状态保存在平台，类型图按版本在内存中重建；不需要填写地址或凭据。Jena 存储仍可在上一步选择。</p>}
    {form.kind !== "EMBEDDED" && <>
    <label>{info.endpoint.label}<input value={form.uri} onChange={(event) => setForm({ ...form, uri: event.target.value })} placeholder={info.endpoint.placeholder} required /></label>
    {info.dataset && <label>{info.dataset.label}<input value={form.databaseName} onChange={(event) => setForm({ ...form, databaseName: event.target.value })} placeholder={info.dataset.placeholder} required /></label>}
    {form.kind === "JENA" && <label>命名图（可选）<input value={form.namedGraph} onChange={(event) => setForm({ ...form, namedGraph: event.target.value })} placeholder="留空写入默认图，例如 urn:ontology" /></label>}
    <label>{info.credentials.usernameLabel}<input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder={info.credentials.usernameExample} required={credentialRequired} /></label>
    <label>{info.credentials.passwordLabel}<input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} placeholder={editing ? "留空保持不变" : ""} required={credentialRequired && !editing} /></label>
    </>}
  </>;
}

/**
 * 弹窗里的「测试连接」。
 * 拿表单里当前的值试一次（编辑时密码留空就沿用已保存的凭据），不必先保存再回头验证。
 * 按钮和结果分成两块，由弹窗决定摆在哪：结果是整行的一行字，不用挤在按钮中间。
 */

export function useTargetProbe(form: TargetFormState, targetId?: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    try {
      setBusy(true);
      setResult(null);
      const health = await api<{ agent: string; address: string }>("/api/targets/test", {
        method: "POST",
        body: JSON.stringify({ kind: form.kind, uri: form.uri, databaseName: form.databaseName, username: form.username, password: form.password, options: targetOptions(form), targetId }),
      });
      setResult({ ok: true, text: form.kind === "EMBEDDED" ? `存储可用：${health.agent}` : `连上了：${health.agent} · ${health.address}` });
    } catch (reason) {
      setResult({ ok: false, text: reason instanceof Error ? reason.message : "连接失败。" });
    } finally {
      setBusy(false);
    }
  };
  return { busy, result, run };
}


export function TargetProbeButton({ busy, onRun }: { busy: boolean; onRun: () => void }) {
  return <span className="probe-slot">
    <button type="button" className="quiet-button" disabled={busy} onClick={onRun}>{busy ? <Loader2 size={14} className="probe-spin" /> : <PlugZap size={14} />}{busy ? "测试中…" : "测试存储"}</button>
  </span>;
}


export function TargetProbeResult({ result }: { result: { ok: boolean; text: string } | null }) {
  if (!result) return null;
  return <p className={result.ok ? "probe-text ok" : "probe-text error"}>{result.ok ? <Check size={13} /> : <AlertCircle size={13} />}{result.text}</p>;
}


export function TargetManager({ targets, refresh, selectedId, onSelect, onNew, canWrite, notify, fail }: { targets: Target[]; refresh: () => Promise<void>; selectedId: string; onSelect: (id: string) => void; onNew: () => void; canWrite: boolean; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  const [testing, setTesting] = useState(""); const [editing, setEditing] = useState<Target | null>(null); const [deleting, setDeleting] = useState("");
  const remove = async (target: Target) => { if (!window.confirm(`确定删除本体存储“${target.name}”及其全部本体版本？`)) return; try { setDeleting(target.id); await api(`/api/targets/${target.id}`, { method: "DELETE" }); notify("本体存储已删除。"); await refresh(); } catch (reason) { fail(reason); } finally { setDeleting(""); } };
   // 按后端分组展示，内置类型图与 Jena 仍可并存。
  const groups = FRONTEND_GRAPH_TARGET_KINDS.map((info) => ({ info, items: targets.filter((item) => item.kind === info.kind) }));
  const census = groups.filter((group) => group.items.length).map((group) => `${group.info.label} ${group.items.length}`).join(" · ");
  return <section className="stack">
    <div className="panel functional-panel target-action-bar"><div><span className="eyebrow">图引擎配置</span><b>{targets.length} 项可用图引擎</b><p className="subtle">{census ? `按引擎分组：${census}。` : "正在读取图引擎配置。"}内置类型图由平台自带；Jena 连接可按需添加。</p></div><button className="action primary" disabled={!canWrite} title={canWrite ? undefined : "当前角色没有「管理图引擎连接」权限"} onClick={onNew}><Plus size={15} />新建 Jena 连接</button></div>
    <div className="panel functional-panel target-list">{targets.length ? groups.map(({ info, items }) => items.length ? <div className="target-group" key={info.kind}><div className="target-group-head"><GraphKindBadge kind={info.kind} /><small>{info.description}</small></div>{items.map((target) => <div className={target.id === selectedId ? "target-row current" : "target-row"} key={target.id}><Database size={18} /><span><b>{target.name}</b><small>{target.kind === "EMBEDDED" ? "平台自带 · 新建本体时直接选择" : `${target.uri} / ${target.databaseName}`}</small></span>{target.id === selectedId ? <span className="target-current"><Check size={12} />当前本体存储</span> : <button className="action compact" onClick={() => onSelect(target.id)}>打开</button>}{target.kind === "EMBEDDED" ? <span className="target-current">无需配置</span> : <><button className="action compact" disabled={!canWrite || testing === target.id} title={canWrite ? undefined : "当前角色没有「管理图引擎连接」权限"} onClick={async () => { try { setTesting(target.id); const health = await api<{ connected: boolean; agent: string }>(`/api/targets/${target.id}/test`, { method: "POST" }); notify(`存储可用：${health.agent}`); } catch (reason) { fail(reason); } finally { setTesting(""); } }}>{testing === target.id ? "测试中" : "测试存储"}</button><button className="action compact" disabled={!canWrite} title={canWrite ? undefined : "当前角色没有「管理图引擎连接」权限"} onClick={() => setEditing(target)}><Pencil size={13} />编辑</button><button className="action compact danger" disabled={!canWrite || deleting === target.id} title={canWrite ? undefined : "当前角色没有「管理图引擎连接」权限"} onClick={() => void remove(target)}><Trash2 size={13} />{deleting === target.id ? "删除中" : "删除"}</button></>}</div>)}</div> : null) : <div className="target-empty"><Database size={22} /><b>正在加载存储资源</b><span>内置类型图由平台提供；需要外部 RDF 存储时可新建 Jena 连接。</span></div>}</div>
    {editing && <TargetEditDialog target={editing} onClose={() => setEditing(null)} onSaved={async () => { await refresh(); notify("本体存储已更新。"); }} fail={fail} />}
  </section>;
}

/** 新建本体存储：先选类型，再填连接信息。两步都收在同一个弹窗里，页面不再常驻一张空表单。 */

export function NewTargetDialog({ onClose, onCreated, notify, fail }: { onClose: () => void; onCreated: (target: Target) => void | Promise<void>; notify: (text: string) => void; fail: (reason: unknown) => void }) {
  // 只有一个可选引擎时就没有「选类型」这一步，直接进连接表单。
  const multipleKinds = CREATABLE_GRAPH_TARGET_KINDS.length > 1;
  const [step, setStep] = useState<1 | 2>(multipleKinds ? 1 : 2);
  const [kind, setKind] = useState<GraphTargetKind>(DEFAULT_GRAPH_TARGET_KIND);
  const [form, setForm] = useState<TargetFormState>(() => defaultTargetForm(DEFAULT_GRAPH_TARGET_KIND));
  const [busy, setBusy] = useState(false);
  const probe = useTargetProbe(form);
  const info = graphTargetKindInfo(kind);

  useEffect(() => {
    // 这里要的是浏览器原生事件；本文件里的 KeyboardEvent 是 React 的那个同名类型。
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pickKind = (next: GraphTargetKind) => { setKind(next); setForm((current) => ({ ...defaultTargetForm(next), name: current.name })); };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      setBusy(true);
      const target = await api<Target>("/api/targets", { method: "POST", body: JSON.stringify({ ...form, options: targetOptions(form) }) });
      notify(`${graphTargetKindInfo(target.kind).label} 本体存储已登记。${target.kind === "JENA" ? "凭据已加密保存。" : "无需外部图服务。"}`);
      await onCreated(target);
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="dialog graph-dialog new-target-dialog" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button>
      <span className="eyebrow">新建本体存储{multipleKinds ? ` · 步骤 ${step} / 2` : ""}</span>
      <h2>{step === 1 ? "选择存储后端" : kind === "EMBEDDED" ? "配置内置类型图" : `连接 ${info.label}`}</h2>
      <p>{step === 1 ? "内置类型图无需部署外部服务；Apache Jena 保持可用。" : info.description}</p>
      {multipleKinds && <ol className="wizard-steps">
        <li className={step === 1 ? "active" : "done"}><span>{step === 1 ? "1" : <Check size={12} />}</span>选择类型<em>{info.label}</em></li>
        <li className={step === 2 ? "active" : ""}><span>2</span>{kind === "EMBEDDED" ? "确认存储" : "填写连接信息"}</li>
      </ol>}
      {step === 1
        ? <GraphKindChoice value={kind} onChange={pickKind} />
        : <div className="dialog-form"><TargetFields form={form} setForm={setForm} /></div>}
      {step === 2 && <TargetProbeResult result={probe.result} />}
      <div className="kind-picker-foot">
        <span className="kind-picker-summary"><GraphKindMark mark={info.mark} accent={info.accent} size={16} />{info.label}<code>{capabilityLine(info)}</code></span>
        <div className="functional-actions">
          {step === 2 && multipleKinds && <button type="button" className="quiet-button" onClick={() => setStep(1)}>上一步</button>}
          {step === 1
            ? <><button type="button" className="quiet-button" onClick={onClose}>取消</button><button type="button" className="primary-button" onClick={() => setStep(2)}>下一步</button></>
            : <><TargetProbeButton busy={probe.busy} onRun={() => void probe.run()} /><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "登记中…" : "登记并选择"}</button></>}
        </div>
      </div>
    </form>
  </div>;
}


export function TargetEditDialog({ target, onClose, onSaved, fail }: { target: Target; onClose: () => void; onSaved: () => Promise<void>; fail: (reason: unknown) => void }) {
  const [form, setForm] = useState<TargetFormState>(() => formFromTarget(target));
  const [busy, setBusy] = useState(false);
  const probe = useTargetProbe(form, target.id);
  const save = async (event: FormEvent) => { event.preventDefault(); try { setBusy(true); const payload: Record<string, unknown> = { name: form.name, kind: form.kind, uri: form.uri, databaseName: form.databaseName, username: form.username, options: targetOptions(form) }; if (form.password) payload.password = form.password; await api<Target>(`/api/targets/${target.id}`, { method: "PATCH", body: JSON.stringify(payload) }); await onSaved(); onClose(); } catch (reason) { fail(reason); } finally { setBusy(false); } };
  return <div className="dialog-backdrop" role="presentation"><form className="dialog graph-dialog target-dialog" onSubmit={save}><button type="button" className="close-button" onClick={onClose} title="关闭"><X size={18} /></button><div className="dialog-icon"><Database size={22} /></div><span className="eyebrow">编辑本体存储</span><h2>{target.name}</h2><p>{target.kind === "EMBEDDED" ? "内置存储无需维护外部连接。" : "修改连接信息；密码留空表示保持原密码不变。"}</p><TargetFields form={form} setForm={setForm} editing /><TargetProbeResult result={probe.result} /><div className="dialog-actions"><TargetProbeButton busy={probe.busy} onRun={() => void probe.run()} /><button type="button" className="quiet-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}>{busy ? "保存中…" : "保存修改"}</button></div></form></div>;
}
