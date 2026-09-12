"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, CircleSlash, Pencil, Play, Plus, ShieldAlert, Trash2, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { EntitySearchPicker, type EntitySearchResult } from "@/components/entity-search-picker";
import { actionInvolvement, validateActionDefinition } from "@/lib/action-engine";
import { propertyTypeOptions, ruleOperatorOptions, ruleOperatorsWithoutValue, type ActionEdit, type ActionParameter, type ActionType, type Definition, type OntologyRule, type Property, type RuleCondition, type RuleEffect } from "@/lib/ontology-draft";
import type { OntologyDefinition } from "@/lib/ontology";
import "./action-studio.css";

export type ActionFinding = { ruleId: string; ruleName: string; effect: RuleEffect; message: string; evidence: string[] };

export type ActionRunOutcome = {
  actionId: string;
  actionName: string;
  actionCode: string;
  verdict: "PASSED" | "BLOCKED";
  blockers: ActionFinding[];
  warnings: ActionFinding[];
  hidden: ActionFinding[];
  steps: string[];
  createdEntities: { id: string; label: string; display: string }[];
  subject: { id: string; label: string; display: string } | null;
  dryRun: boolean;
  applied: boolean;
};

type DecisionEntry = {
  id: string;
  action: string;
  actorEmail: string | null;
  createdAt: string;
  details: { actionName?: string; actionCode?: string; dryRun?: boolean; verdict?: string; subject?: { display?: string } | null; blockers?: { ruleName: string; message: string }[] };
};

type Props = {
  definition: Definition;
  versionId?: string;
  targetId?: string;
  canEdit: boolean;
  /** 从对象详情页点动作进来时带上：直接选中这个动作，并预填主对象。 */
  initialRun?: { actionId: string; subject: EntitySearchResult } | null;
  onSave: (definition: Definition) => Promise<void>;
  onRan: () => void;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

const newAction = (scopeEntityTypeId = ""): ActionType => ({ id: crypto.randomUUID(), name: "", code: "", description: "", scopeEntityTypeId, params: [], edits: [] });
const newRule = (actionId = ""): OntologyRule => ({ id: crypto.randomUUID(), name: "", effect: "BLOCK", priority: 1, enabled: true, actionId, conditions: [], message: "" });
const newParam = (): ActionParameter => ({ code: "", name: "", kind: "ENTITY_REF", entityTypeId: "", dataType: "TEXT", required: true });
const newEdit = (): ActionEdit => ({ op: "CREATE_ENTITY", alias: "", entityTypeId: "", relationshipTypeId: "", entityRef: { kind: "PARAM", code: "" }, sourceRef: { kind: "PARAM", code: "" }, targetRef: { kind: "PARAM", code: "" }, assignments: [] });
const newCondition = (): RuleCondition => ({ subject: { kind: "PARAM", code: "", relationshipTypeId: "", direction: "OUT" }, property: "", operator: "EQUALS", compareValue: "" });

/** 弹窗打开时按 ESC 关闭。焦点可能在弹窗外的触发按钮上，所以监听 window 而不是弹窗自身。 */
function useEscapeToClose(onClose: () => void) {
  const handler = useRef(onClose);
  useEffect(() => { handler.current = onClose; }, [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") handler.current(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function typeName(definition: Definition, id: string) {
  return definition.entityTypes.find((item) => item.id === id)?.name ?? "";
}

function relationName(definition: Definition, id: string) {
  return definition.relationshipTypes.find((item) => item.id === id)?.name ?? "";
}

function propertiesOfEntityType(definition: Definition, id: string): Property[] {
  return definition.entityTypes.find((item) => item.id === id)?.properties ?? [];
}

function propertiesOfRelationType(definition: Definition, id: string): Property[] {
  return definition.relationshipTypes.find((item) => item.id === id)?.properties ?? [];
}

type ActionRef = { kind: "SUBJECT" | "PARAM" | "EDIT"; code: string };

/** 下拉里用 "KIND:code" 表示一个引用；SUBJECT 没有 code，所以拼出来是 "SUBJECT:"。 */
function encodeRef(ref: ActionRef) {
  return ref.kind === "SUBJECT" ? "SUBJECT:" : ref.code ? `${ref.kind}:${ref.code}` : "";
}

function parseRef(value: string): ActionRef {
  if (!value) return { kind: "PARAM", code: "" };
  const [kind, code = ""] = value.split(":");
  return { kind: kind as ActionRef["kind"], code };
}

/** 动作作用的类名；没配就是空串。 */
function scopeName(definition: Definition, action: ActionType | null | undefined) {
  if (!action?.scopeEntityTypeId) return "";
  return typeName(definition, action.scopeEntityTypeId);
}

/**
 * 可以选作条件主体 / 操作对象的三种东西，按"最好理解"的顺序排：
 * 先主对象（动作作用在谁身上），再入参，最后是本次新建出来的对象。
 */
function refOptions(definition: Definition, action: ActionType | null, options: { beforeIndex?: number } = {}) {
  if (!action) return [] as { value: string; label: string }[];
  const list: { value: string; label: string }[] = [];
  const scope = scopeName(definition, action);
  if (scope) list.push({ value: "SUBJECT:", label: `主对象（执行时选的那个${scope}）` });
  for (const parameter of action.params) {
    if (parameter.kind !== "ENTITY_REF") continue;
    list.push({ value: `PARAM:${parameter.code}`, label: `入参：${parameter.name || parameter.code}（${typeName(definition, parameter.entityTypeId) || "未选类型"}）` });
  }
  action.edits.slice(0, options.beforeIndex ?? action.edits.length).forEach((edit, index) => {
    if (edit.op !== "CREATE_ENTITY" || !edit.alias) return;
    list.push({ value: `EDIT:${edit.alias}`, label: `第 ${index + 1} 步新建的${typeName(definition, edit.entityTypeId) || "对象"}（${edit.alias}）` });
  });
  return list;
}

function describeRef(definition: Definition, action: ActionType, ref: ActionRef) {
  if (ref.kind === "SUBJECT") return `主对象（${scopeName(definition, action) || "未选类型"}）`;
  if (ref.kind === "PARAM") return `入参「${action.params.find((item) => item.code === ref.code)?.name ?? ref.code ?? "未选择"}」`;
  const index = action.edits.findIndex((item) => item.op === "CREATE_ENTITY" && item.alias === ref.code);
  return `第 ${index + 1} 步新建的「${ref.code || "未命名"}」`;
}

function describeValue(action: ActionType, value: { kind: "PARAM" | "CONST" | "NOW"; code: string; value: string }) {
  if (value.kind === "NOW") return "当前时间";
  if (value.kind === "CONST") return value.value === "" ? "（空）" : `「${value.value}」`;
  return action.params.find((item) => item.code === value.code)?.name ?? (value.code || "（未选择参数）");
}

function describeEdit(definition: Definition, action: ActionType, edit: ActionEdit) {
  const assignments = edit.assignments.map((item) => `${item.property} ← ${describeValue(action, item.value)}`).join("、");
  if (edit.op === "CREATE_ENTITY") return `新建 ${typeName(definition, edit.entityTypeId) || "（未选类型）"}${edit.alias ? `（记为 ${edit.alias}）` : ""}${assignments ? `：${assignments}` : ""}`;
  if (edit.op === "SET_PROPERTY") return `修改 ${describeRef(definition, action, edit.entityRef)}：${assignments || "（未配置）"}`;
  return `建立 ${describeRef(definition, action, edit.sourceRef)} —${relationName(definition, edit.relationshipTypeId) || "（未选关系）"}→ ${describeRef(definition, action, edit.targetRef)}`;
}

function describeCondition(definition: Definition, action: ActionType | null, condition: RuleCondition) {
  const subject = condition.subject.kind === "SUBJECT"
    ? `主对象（${scopeName(definition, action)}）`
    : condition.subject.kind === "PARAM"
      ? `入参「${action?.params.find((item) => item.code === condition.subject.code)?.name ?? condition.subject.code}」`
      : `第 ${(action?.edits.findIndex((item) => item.op === "CREATE_ENTITY" && item.alias === condition.subject.code) ?? -1) + 1} 步新建的「${condition.subject.code}」`;
  const hop = condition.subject.relationshipTypeId ? `沿「${relationName(definition, condition.subject.relationshipTypeId)}」${condition.subject.direction === "OUT" ? "出" : "入"}向的` : "";
  const operator = ruleOperatorOptions.find((item) => item.value === condition.operator)?.label ?? condition.operator;
  const value = ruleOperatorsWithoutValue.includes(condition.operator) ? "" : ` ${condition.compareValue}`;
  return `${hop}${subject || "（未选主体）"}.${condition.property || "（未选属性）"} ${operator}${value}`;
}

/** 草稿不存在时动作无处可写，界面必须说清楚，而不是给一个按不动的按钮。 */
export const ruleEffectOptions: { value: RuleEffect; label: string; hint: string }[] = [
  { value: "HIDE", label: "隐藏", hint: "命中后这个动作不出现在符合条件的主对象上（只看动作执行前就有的数据）。" },
  { value: "BLOCK", label: "拦截", hint: "命中后拒绝执行，并把原因与证据给用户看。" },
  { value: "WARN", label: "提示", hint: "命中后照常执行，只把原因提示给用户。" },
];

export function effectLabel(effect: RuleEffect) {
  return ruleEffectOptions.find((item) => item.value === effect)?.label ?? effect;
}

/** 一条规则命中后会发生什么，用一句话说清楚。 */
export function effectSentence(effect: RuleEffect) {
  if (effect === "HIDE") return "这个动作不出现在这类对象上";
  if (effect === "BLOCK") return "拒绝执行";
  return "给出提示";
}

export function ActionStudio({ definition, versionId, targetId, canEdit, initialRun, onSave, onRan, notify, fail }: Props) {
  const actions = definition.actionTypes;
  const rules = definition.rules;
  const [selectedId, setSelectedId] = useState(initialRun?.actionId ?? "");
  const [subject, setSubject] = useState<EntitySearchResult | null>(initialRun?.subject ?? null);
  const [actionDialog, setActionDialog] = useState<{ mode: "create" | "edit"; action: ActionType } | null>(null);
  const [ruleDialog, setRuleDialog] = useState<{ mode: "create" | "edit"; rule: OntologyRule } | null>(null);
  const [values, setValues] = useState<Record<string, { entity: EntitySearchResult | null; text: string }>>({});
  const [outcome, setOutcome] = useState<ActionRunOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [decisions, setDecisions] = useState<DecisionEntry[]>([]);

  const selected = actions.find((item) => item.id === selectedId) ?? actions[0] ?? null;

  const refreshDecisions = useCallback(async () => {
    if (!versionId) { setDecisions([]); return; }
    try {
      const data = await api<{ entries: DecisionEntry[] }>(`/api/ontology/${versionId}/decisions?limit=20`);
      setDecisions(data.entries);
    } catch { setDecisions([]); }
  }, [versionId]);

  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    void api<{ entries: DecisionEntry[] }>(`/api/ontology/${versionId}/decisions?limit=20`)
      .then((data) => { if (!cancelled) setDecisions(data.entries); })
      .catch(() => { if (!cancelled) setDecisions([]); });
    return () => { cancelled = true; };
  }, [versionId]);

  const commit = async (next: Definition) => onSave(next);
  const upsertAction = async (action: ActionType) => {
    await commit({ ...definition, actionTypes: actions.some((item) => item.id === action.id) ? actions.map((item) => item.id === action.id ? action : item) : [...actions, action] });
  };
  const removeAction = async (action: ActionType) => {
    if (!window.confirm(`删除动作「${action.name}」？绑定它的规则会失去动作，需要重新绑定。`)) return;
    setOutcome(null);
    await commit({ ...definition, actionTypes: actions.filter((item) => item.id !== action.id), rules: rules.map((item) => item.actionId === action.id ? { ...item, actionId: "" } : item) });
  };
  const upsertRule = async (rule: OntologyRule) => {
    await commit({ ...definition, rules: rules.some((item) => item.id === rule.id) ? rules.map((item) => item.id === rule.id ? rule : item) : [...rules, rule] });
  };
  const removeRule = async (rule: OntologyRule) => {
    if (!window.confirm(`删除规则「${rule.name}」？`)) return;
    await commit({ ...definition, rules: rules.filter((item) => item.id !== rule.id) });
  };
  const toggleRule = async (rule: OntologyRule) => upsertRule({ ...rule, enabled: !rule.enabled });

  const run = async (dryRun: boolean) => {
    if (!selected) return;
    if (!versionId) { fail("当前目标还没有草稿：动作只能写入草稿快照，请先在本体草稿页创建草稿。"); return; }
    if (selected.scopeEntityTypeId && !subject) { fail(`动作「${selected.name}」作用在「${scopeName(definition, selected)}」上，请先选择要执行的对象。`); return; }
    setBusy(true);
    try {
      const inputs = selected.params.map((parameter) => parameter.kind === "ENTITY_REF"
        ? { code: parameter.code, entityId: values[parameter.code]?.entity?.id ?? "" }
        : { code: parameter.code, value: values[parameter.code]?.text ?? "" });
      const result = await api<ActionRunOutcome>(`/api/ontology/${versionId}/actions`, { method: "POST", body: JSON.stringify({ actionId: selected.id, subjectEntityId: subject?.id, dryRun, inputs }) });
      setOutcome(result);
      if (result.applied) { notify(`动作「${result.actionName}」已写入草稿快照。`); onRan(); }
      else if (result.verdict === "BLOCKED") notify(`动作「${result.actionName}」被规则拦截，没有写入任何数据。`);
      await refreshDecisions();
    } catch (reason) { fail(reason); } finally { setBusy(false); }
  };

  const boundRules = (actionId: string) => rules.filter((item) => !item.actionId || item.actionId === actionId).length;

  return (
    <section className="stack">
      <div className="as-shell">
        <div className="panel as-panel">
          <div className="as-head">
            <div>
              <span className="eyebrow">动作</span>
              <h2>动作清单</h2>
              <p>动作是平台里唯一的业务写入口：把「一次业务动作的正确做法」固定成模板，规则再挂到动作上拦截。平台上没有的动作，就没有对应的写入口。</p>
            </div>
            <button className="action" disabled={!canEdit} onClick={() => setActionDialog({ mode: "create", action: newAction() })}><Plus size={15} />新建动作</button>
          </div>
          {actions.length ? (
            <div className="as-list">
              {actions.map((action) => (
                <div key={action.id} className={selected?.id === action.id ? "as-card selectable selected" : "as-card selectable"} onClick={() => { setSelectedId(action.id); setOutcome(null); }}>
                  <div className="as-card-top">
                    <b>{action.name || "（未命名动作）"}</b>
                    <code>{action.code || "no-code"}</code>
                    {scopeName(definition, action)
                      ? <span className="as-chip scope">定义在类「{scopeName(definition, action)}」上</span>
                      : <span className="as-chip blocker">未选主对象</span>}
                    <span className="as-chip muted">{boundRules(action.id)} 条规则</span>
                    <div className="as-card-actions">
                      <button className="ted-icon-button" title="编辑动作" disabled={!canEdit} onClick={(event) => { event.stopPropagation(); setActionDialog({ mode: "edit", action }); }}><Pencil size={13} /></button>
                      <button className="ted-icon-button danger" title="删除动作" disabled={!canEdit} onClick={(event) => { event.stopPropagation(); void removeAction(action).catch(fail); }}><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <p className="as-card-meta">
                    {action.params.length ? action.params.map((item) => `${item.name}（${item.kind === "ENTITY_REF" ? typeName(definition, item.entityTypeId) || "未选类型" : item.dataType}）`).join(" · ") : "无参数"}
                    {" → "}
                    {action.edits.length} 步操作
                  </p>
                  {(() => {
                    const involvement = actionInvolvement(definition, action);
                    if (!involvement.entityTypes.length && !involvement.relationshipTypes.length) return null;
                    return (
                      <div className="as-card-types">
                        {involvement.entityTypes.map((item) => <span className="as-type-chip entity" key={item.id}>{item.name}<em>{item.roles.join(" · ")}</em></span>)}
                        {involvement.relationshipTypes.map((item) => <span className="as-type-chip relation" key={item.id}>{item.name}<em>{item.roles.join(" · ")}</em></span>)}
                      </div>
                    );
                  })()}
                  {action.edits.length > 0 && <p className="as-card-recipe">{action.edits.map((edit) => describeEdit(definition, action, edit)).join(" → ")}</p>}
                </div>
              ))}
            </div>
          ) : (
            <p className="as-empty">还没有动作。先建一个「购票」这样的动作，把它要写哪些对象、哪些关系配成模板，规则再挂上去。</p>
          )}
        </div>

        <div className="panel as-panel">
          <div className="as-head">
            <div>
              <span className="eyebrow">规则</span>
              <h2>规则清单</h2>
              <p>规则绑在动作上，命中后有三种处置：隐藏（这个动作不出现在该对象上）、拦截（拒绝执行）、提示（只提醒）。结论都带规则名与证据。</p>
            </div>
            <button className="action" disabled={!canEdit} onClick={() => setRuleDialog({ mode: "create", rule: newRule(selected?.id ?? "") })}><Plus size={15} />新建规则</button>
          </div>
          {rules.length ? (
            <div className="as-list">
              {rules.map((rule) => {
                const action = actions.find((item) => item.id === rule.actionId) ?? null;
                return (
                  <div key={rule.id} className="as-card">
                    <div className="as-card-top">
                      <span className={`as-chip ${rule.effect === "BLOCK" ? "blocker" : rule.effect === "HIDE" ? "hide" : "warning"}`}>{effectLabel(rule.effect)}</span>
                      <b>{rule.name || "（未命名规则）"}</b>
                      {rule.enabled ? null : <span className="as-chip off">已停用</span>}
                      <div className="as-card-actions">
                        <button className="ted-icon-button" title={rule.enabled ? "停用规则" : "启用规则"} disabled={!canEdit} onClick={() => void toggleRule(rule).catch(fail)}>{rule.enabled ? <CircleSlash size={13} /> : <Check size={13} />}</button>
                        <button className="ted-icon-button" title="编辑规则" disabled={!canEdit} onClick={() => setRuleDialog({ mode: "edit", rule })}><Pencil size={13} /></button>
                        <button className="ted-icon-button danger" title="删除规则" disabled={!canEdit} onClick={() => void removeRule(rule).catch(fail)}><Trash2 size={13} /></button>
                      </div>
                    </div>
                    <p className="as-card-meta">绑定：{action ? action.name : "全部动作"} · 优先级 {rule.priority} · {rule.conditions.length} 个条件</p>
                    <p className="as-card-recipe">当 {rule.conditions.length ? rule.conditions.map((condition) => describeCondition(definition, action, condition)).join(" 且 ") : "（未配置条件）"} 时，{effectSentence(rule.effect)}{rule.message ? `：${rule.message}` : "。"}</p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="as-empty">还没有规则。例如「学生票须持学生资质」：条件盯住动作新建出来的票种与入参乘客的资质，处置写清楚拒绝原因。</p>
          )}
        </div>

        <div className="panel as-panel">
          <div className="as-head">
            <div>
              <span className="eyebrow">运行</span>
              <h2>{selected ? `运行「${selected.name || "未命名动作"}」` : "运行动作"}</h2>
              <p>{selected && scopeName(definition, selected) ? `这个动作定义在类「${scopeName(definition, selected)}」上：先选一个具体的${scopeName(definition, selected)}（属于这个类的对象），再填参数。干跑只算不写，执行才会写进草稿快照。` : "干跑只算不写：把执行后的样子算出来给规则看。执行才会写进草稿快照；被拦截时快照保持原样。"}</p>
            </div>
          </div>
          {selected ? (
            <>
              <div className="as-list">
                {selected.scopeEntityTypeId && (
                  <div className="as-param-row as-subject-row">
                    <div className="as-param-label">
                      <b>对哪个{scopeName(definition, selected) || "对象"}执行</b>
                      <small>主对象 · {scopeName(definition, selected) || "未选类型"}</small>
                    </div>
                    {versionId && targetId ? (
                      <EntitySearchPicker
                        targetId={targetId}
                        versionId={versionId}
                        labels={scopeName(definition, selected) ? [scopeName(definition, selected)] : []}
                        definition={definition}
                        placeholder={`搜索${scopeName(definition, selected) || "对象"}…`}
                        value={subject}
                        onChange={setSubject}
                      />
                    ) : <span className="as-chip muted">需要先用草稿保存一次</span>}
                  </div>
                )}
                {selected.params.length ? selected.params.map((parameter) => (
                  <div className="as-param-row" key={parameter.code}>
                    <div className="as-param-label">
                      <b>{parameter.name || parameter.code || "（未命名参数）"}{parameter.required ? "" : "（可选）"}</b>
                      <small>{parameter.kind === "ENTITY_REF" ? `对象 · ${typeName(definition, parameter.entityTypeId) || "未选类型"}` : `值 · ${parameter.dataType}`}</small>
                    </div>
                    {parameter.kind === "ENTITY_REF" ? (
                      versionId && targetId ? (
                        <EntitySearchPicker
                          targetId={targetId}
                          versionId={versionId}
                          labels={typeName(definition, parameter.entityTypeId) ? [typeName(definition, parameter.entityTypeId)] : []}
                          definition={definition}
                          placeholder={`搜索${typeName(definition, parameter.entityTypeId) || "对象"}…`}
                          value={values[parameter.code]?.entity ?? null}
                          onChange={(node) => setValues((current) => ({ ...current, [parameter.code]: { entity: node, text: current[parameter.code]?.text ?? "" } }))}
                        />
                      ) : (
                        <span className="as-chip muted">需要先用草稿保存一次</span>
                      )
                    ) : (
                      <input className="ted-input" value={values[parameter.code]?.text ?? ""} onChange={(event) => setValues((current) => ({ ...current, [parameter.code]: { entity: current[parameter.code]?.entity ?? null, text: event.target.value } }))} placeholder={`填写${parameter.name || "参数"}`} />
                    )}
                  </div>
                )) : <p className="as-empty">这个动作没有参数，选好主对象就可以直接干跑。</p>}
              </div>
              <div className="as-run-actions">
                <button className="action" disabled={!canEdit || busy || !versionId} onClick={() => void run(true)}><Play size={15} />{busy ? "运行中…" : "干跑"}</button>
                <button className="action primary" disabled={!canEdit || busy || !versionId} onClick={() => void run(false)}><ShieldAlert size={15} />执行</button>
              </div>
              {outcome && <OutcomePanel outcome={outcome} />}
            </>
          ) : (
            <p className="as-empty">先在左边选一个动作。</p>
          )}
        </div>

        <div className="panel as-panel">
          <div className="as-head">
            <div>
              <span className="eyebrow">决策</span>
              <h2>决策记录</h2>
              <p>每次干跑、执行、被拦截都会留一条：谁、什么时候、哪个动作、什么结果。</p>
            </div>
          </div>
          {decisions.length ? (
            <div className="as-decisions">
              {decisions.map((entry) => {
                const blocked = entry.action === "ACTION_BLOCKED";
                const dryRun = entry.details?.dryRun !== false && entry.action === "ACTION_DRY_RUN";
                return (
                  <div className="as-decision" key={entry.id}>
                    <span className={blocked ? "as-chip blocker" : "as-chip passed"}>{blocked ? "拦截" : entry.action === "ACTION_EXECUTED" ? "已执行" : "干跑"}</span>
                    <div>
                      <b>{entry.details?.actionName ?? "（动作）"}{dryRun ? "（干跑）" : ""}</b>
                      <small>
                        {entry.details?.subject?.display ? `作用于 ${entry.details.subject.display} · ` : ""}
                        {blocked && entry.details?.blockers?.length ? "命中：" + entry.details.blockers.map((item) => item.ruleName).join("、") : entry.actorEmail ?? "系统"}
                      </small>
                    </div>
                    <time>{new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="as-empty">还没有决策记录。运行一次动作就会出现在这里。</p>
          )}
        </div>
      </div>

      {actionDialog && (
        <ActionEditDialog
          definition={definition}
          action={actionDialog.action}
          mode={actionDialog.mode}
          onClose={() => setActionDialog(null)}
          onSave={async (action) => { await upsertAction(action); setSelectedId(action.id); }}
        />
      )}
      {ruleDialog && (
        <RuleEditDialog
          definition={definition}
          rule={ruleDialog.rule}
          mode={ruleDialog.mode}
          actions={actions}
          onClose={() => setRuleDialog(null)}
          onSave={upsertRule}
        />
      )}
    </section>
  );
}

function OutcomePanel({ outcome }: { outcome: ActionRunOutcome }) {
  const blocked = outcome.verdict === "BLOCKED";
  return (
    <div className={blocked ? "as-outcome blocked" : "as-outcome passed"}>
      <div className="as-verdict">
        {blocked ? <AlertTriangle size={16} /> : <Check size={16} />}
        <b>{blocked ? "被规则拦截，未写入" : outcome.applied ? "执行成功，已写入草稿快照" : "干跑通过，未写入"}</b>
        <span>{outcome.actionName} · {outcome.actionCode}</span>
        {outcome.subject && <span className="as-verdict-subject">作用于 {outcome.subject.label}「{outcome.subject.display}」</span>}
      </div>
      {outcome.blockers.map((finding) => <Finding key={finding.ruleId} finding={finding} level="blocker" />)}
      {outcome.warnings.map((finding) => <Finding key={finding.ruleId} finding={finding} level="warning" />)}
      {outcome.hidden.length > 0 && (
        <div className="as-hidden-note">
          <b><CircleSlash size={12} />这个动作本不该出现在该对象上</b>
          {outcome.hidden.map((finding) => <p key={finding.ruleId}>{finding.ruleName}{finding.message ? `：${finding.message}` : ""}</p>)}
        </div>
      )}
      {outcome.steps.length > 0 && (
        <div className="as-rail-block">
          <b>{outcome.applied ? "已执行的操作" : "计划的操作"}</b>
          <ol className="as-steps">{outcome.steps.map((step) => <li key={step}><span>{step}</span></li>)}</ol>
        </div>
      )}
      {outcome.createdEntities.length > 0 && (
        <div className="as-created">
          {outcome.createdEntities.map((entity) => <span key={entity.id}>{entity.label} <code>{entity.display}</code></span>)}
        </div>
      )}
    </div>
  );
}

function Finding({ finding, level }: { finding: ActionFinding; level: "blocker" | "warning" }) {
  return (
    <div className={`as-finding ${level}`}>
      <b>{level === "blocker" ? <ShieldAlert size={12} /> : <AlertTriangle size={12} />}{finding.ruleName}<span className="as-chip muted">{effectLabel(finding.effect)}</span></b>
      {finding.message && <p>{finding.message}</p>}
      {finding.evidence.length > 0 && <ul className="as-evidence">{finding.evidence.map((line) => <li key={line}>{line}</li>)}</ul>}
    </div>
  );
}

/** 引用一个对象：可以是动作入参，也可以是本动作前面新建出来的对象。 */
function RefSelect({ value, options, onChange, placeholder }: { value: ActionRef; options: { value: string; label: string }[]; onChange: (ref: ActionRef) => void; placeholder: string }) {
  const current = encodeRef(value);
  return (
    <select className="ted-select" value={current} onChange={(event) => {
      onChange(parseRef(event.target.value));
    }}>
      <option value="">{placeholder}</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

/** 属性赋值表：属性 ← 参数 / 固定值 / 当前时间。 */
function AssignmentList({ action, properties, rows, freeText, onChange }: {
  action: ActionType;
  properties: Property[];
  rows: { property: string; value: { kind: "PARAM" | "CONST" | "NOW"; code: string; value: string } }[];
  freeText?: boolean;
  onChange: (rows: ActionEdit["assignments"]) => void;
}) {
  const update = (index: number, patch: Partial<ActionEdit["assignments"][number]>) => onChange(rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  return (
    <div className="as-rail-block">
      <div className="as-subhead">
        <span>属性赋值</span>
        <button type="button" className="as-inline-add" onClick={() => onChange([...rows, { property: freeText ? "" : properties[0]?.name ?? "", value: { kind: "CONST", code: "", value: "" } }])}><Plus size={11} />加一条赋值</button>
      </div>
      {rows.length === 0 && <p className="as-card-meta">{freeText ? "没有赋值。属性名可以手写，因为改哪个类型要等运行到那一步才知道。" : "没有赋值。必填属性必须在这里给出取值，否则动作执行时会报缺少必填属性。"}</p>}
      {rows.map((row, index) => (
        <div className="as-assign" key={`${row.property}-${index}`}>
          {freeText
            ? <input className="ted-input" value={row.property} onChange={(event) => update(index, { property: event.target.value })} placeholder="属性名" />
            : <select className="ted-select" value={row.property} onChange={(event) => update(index, { property: event.target.value })}>{properties.map((property) => <option key={property.name} value={property.name}>{property.name}</option>)}</select>}
          <select className="ted-select" value={row.value.kind} onChange={(event) => update(index, { value: { kind: event.target.value as "PARAM" | "CONST" | "NOW", code: event.target.value === "PARAM" ? action.params[0]?.code ?? "" : "", value: "" } })}>
            <option value="PARAM">取参数</option>
            <option value="CONST">固定值</option>
            <option value="NOW">当前时间</option>
          </select>
          {row.value.kind === "CONST" && <input className="ted-input" value={row.value.value} onChange={(event) => update(index, { value: { ...row.value, value: event.target.value } })} placeholder="固定值" />}
          {row.value.kind === "PARAM" && <select className="ted-select" value={row.value.code} onChange={(event) => update(index, { value: { ...row.value, code: event.target.value } })}>{action.params.map((parameter) => <option key={parameter.code} value={parameter.code}>{parameter.name || parameter.code}</option>)}</select>}
          {row.value.kind === "NOW" && <span className="as-chip muted">运行时取当前时间</span>}
          <button type="button" className="ted-icon-button danger" title="删除这条赋值" onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 size={12} /></button>
        </div>
      ))}
    </div>
  );
}

/**
 * 动作编辑器：基本信息 + 参数 + 操作序列。
 * 右栏实时把这份配置读成一句"配方"，并列出定义体检发现的问题。
 */
function ActionEditDialog({ definition, action, mode, onClose, onSave }: { definition: Definition; action: ActionType; mode: "create" | "edit"; onClose: () => void; onSave: (action: ActionType) => Promise<void> }) {
  const [draft, setDraft] = useState<ActionType>(() => structuredClone(action));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (next: Partial<ActionType>) => setDraft((current) => ({ ...current, ...next }));
  const issues = useMemo(() => {
    const candidate: Definition = { ...definition, actionTypes: definition.actionTypes.some((item) => item.id === draft.id) ? definition.actionTypes.map((item) => item.id === draft.id ? draft : item) : [...definition.actionTypes, draft] };
    // 前端 Definition 允许 displayProperty 缺省，运行时结构与本体定义一致，这里按定义类型传即可。
    return validateActionDefinition(candidate as OntologyDefinition).filter((item) => item.rule === `动作.${draft.name}`).map((item) => item.message);
  }, [definition, draft]);

  const save = async () => {
    if (!draft.name.trim()) return setError("请填写动作名称。");
    if (!draft.code.trim()) return setError("请填写动作标识，它将来是给模型用的工具名。");
    if (!draft.scopeEntityTypeId) return setError("请选择作用对象：每个动作都要定义在一个类上。");
    if (issues.length) return setError(issues[0]);
    setBusy(true);
    try { await onSave({ ...draft, name: draft.name.trim(), code: draft.code.trim() }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败。"); }
    finally { setBusy(false); }
  };

  useEscapeToClose(onClose);
  return (
    <div className="dialog-backdrop ted-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ted-dialog">
        <header className="ted-head">
          <span className="ted-mark"><Play size={20} /></span>
          <div className="ted-title">
            <span className="ted-eyebrow">{mode === "create" ? "新增" : "编辑"}</span>
            <h2>{mode === "create" ? "新增动作" : `编辑动作「${action.name}」`}</h2>
          </div>
          <button type="button" className="ted-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="ted-body">
          <div className="ted-form">
            <div className="ted-grid-2">
              <label className="ted-field"><span>动作名称</span><input className="ted-input" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：购票" /></label>
              <label className="ted-field"><span>动作标识</span><input className="ted-input" value={draft.code} onChange={(event) => patch({ code: event.target.value })} placeholder="例如：buyTicket" /></label>
            </div>
            <label className="ted-field"><span>作用的类</span>
              <select className="ted-select" value={draft.scopeEntityTypeId} onChange={(event) => patch({ scopeEntityTypeId: event.target.value })}>
                <option value="">选择这个动作定义在哪个类上</option>
                {definition.entityTypes.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
              </select>
              <small>{draft.scopeEntityTypeId
                ? `动作定义在类「${typeName(definition, draft.scopeEntityTypeId)}」上：执行时必须先选一个属于这个类的对象（实例），规则和操作里用「主对象」引用它。`
                : "动作定义在类上，执行时针对属于这个类的一个对象（实例）。"}</small>
            </label>
            <label className="ted-field"><span>说明</span><input className="ted-input" value={draft.description} onChange={(event) => patch({ description: event.target.value })} placeholder="这个动作在一次业务里代表什么" /></label>

            <section className="ted-section">
              <div className="ted-section-head"><h3>参数</h3><em>{draft.params.length ? `${draft.params.length} 个` : "空"}</em></div>
              {draft.params.map((parameter, index) => (
                <div className="as-edit-row" key={`${parameter.code}-${index}`}>
                  <div className="as-edit-head">
                    <span>参数 {index + 1}</span>
                    <div className="as-card-actions"><button type="button" className="ted-icon-button danger" title="删除参数" onClick={() => patch({ params: draft.params.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>
                  </div>
                  <div className="as-edit-grid">
                    <label className="ted-field"><span>显示名</span><input className="ted-input" value={parameter.name} onChange={(event) => patch({ params: draft.params.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} placeholder="例如：乘客" /></label>
                    <label className="ted-field"><span>标识</span><input className="ted-input" value={parameter.code} onChange={(event) => patch({ params: draft.params.map((item, i) => i === index ? { ...item, code: event.target.value } : item) })} placeholder="例如：passenger" /></label>
                    <label className="ted-field"><span>取值方式</span>
                      <select className="ted-select" value={parameter.kind} onChange={(event) => patch({ params: draft.params.map((item, i) => i === index ? { ...item, kind: event.target.value as ActionParameter["kind"] } : item) })}>
                        <option value="ENTITY_REF">选择一个已有对象</option>
                        <option value="VALUE">填写一个值</option>
                      </select>
                    </label>
                    {parameter.kind === "ENTITY_REF" ? (
                      <label className="ted-field"><span>类</span>
                        <select className="ted-select" value={parameter.entityTypeId} onChange={(event) => patch({ params: draft.params.map((item, i) => i === index ? { ...item, entityTypeId: event.target.value } : item) })}>
                          <option value="">选择类型</option>
                          {definition.entityTypes.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
                        </select>
                      </label>
                    ) : (
                      <label className="ted-field"><span>值类型</span>
                        <select className="ted-select" value={parameter.dataType} onChange={(event) => patch({ params: draft.params.map((item, i) => i === index ? { ...item, dataType: event.target.value as Property["dataType"] } : item) })}>
                          {propertyTypeOptions.map((dataType) => <option key={dataType} value={dataType}>{dataType}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <label className="ted-toggle"><input type="checkbox" checked={parameter.required} onChange={(event) => patch({ params: draft.params.map((item, i) => i === index ? { ...item, required: event.target.checked } : item) })} />必填</label>
                </div>
              ))}
              <button type="button" className="as-inline-add" onClick={() => patch({ params: [...draft.params, newParam()] })}><Plus size={12} />添加参数</button>
            </section>

            <section className="ted-section">
              <div className="ted-section-head"><h3>操作序列</h3><em>{draft.edits.length ? `${draft.edits.length} 步` : "空"}</em></div>
              <p className="as-card-meta">按从上到下的顺序执行；任何一步不符合契约或必填，整次动作都不写库。</p>
              {draft.edits.map((edit, index) => (
                <div className="as-edit-row" key={index}>
                  <div className="as-edit-head">
                    <span>步 {index + 1}</span>
                    <select className="ted-select" value={edit.op} onChange={(event) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...newEdit(), op: event.target.value as ActionEdit["op"] } : item) })}>
                      <option value="CREATE_ENTITY">新建对象</option>
                      <option value="CREATE_RELATIONSHIP">建立关系</option>
                      <option value="SET_PROPERTY">修改属性</option>
                    </select>
                    <div className="as-card-actions"><button type="button" className="ted-icon-button danger" title="删除这一步" onClick={() => patch({ edits: draft.edits.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>
                  </div>
                  {edit.op === "CREATE_ENTITY" && (
                    <>
                      <div className="as-edit-grid">
                        <label className="ted-field"><span>类</span>
                          <select className="ted-select" value={edit.entityTypeId} onChange={(event) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, entityTypeId: event.target.value } : item) })}>
                            <option value="">选择类型</option>
                            {definition.entityTypes.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
                          </select>
                        </label>
                        <label className="ted-field"><span>别名（后面几步引用它）</span><input className="ted-input" value={edit.alias} onChange={(event) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, alias: event.target.value } : item) })} placeholder="例如：ticket" /></label>
                      </div>
                      <AssignmentList action={draft} properties={propertiesOfEntityType(definition, edit.entityTypeId)} rows={edit.assignments} onChange={(rows) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, assignments: rows } : item) })} />
                    </>
                  )}
                  {edit.op === "SET_PROPERTY" && (
                    <>
                      <label className="ted-field"><span>修改哪个对象</span>
                        <RefSelect value={edit.entityRef} options={refOptions(definition, draft, { beforeIndex: index })} onChange={(ref) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, entityRef: ref } : item) })} placeholder="选择对象" />
                      </label>
                      <AssignmentList action={draft} properties={[]} rows={edit.assignments} freeText onChange={(rows) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, assignments: rows } : item) })} />
                    </>
                  )}
                  {edit.op === "CREATE_RELATIONSHIP" && (
                    <>
                      <label className="ted-field"><span>关系类型</span>
                        <select className="ted-select" value={edit.relationshipTypeId} onChange={(event) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, relationshipTypeId: event.target.value } : item) })}>
                          <option value="">选择关系</option>
                          {definition.relationshipTypes.map((relation) => <option key={relation.id} value={relation.id}>{relation.name}（{typeName(definition, relation.sourceEntityTypeId) || "?"} → {typeName(definition, relation.targetEntityTypeId) || "?"}）</option>)}
                        </select>
                      </label>
                      <div className="as-edit-grid">
                        <label className="ted-field"><span>起点</span><RefSelect value={edit.sourceRef} options={refOptions(definition, draft, { beforeIndex: index })} onChange={(ref) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, sourceRef: ref } : item) })} placeholder="选择起点" /></label>
                        <label className="ted-field"><span>终点</span><RefSelect value={edit.targetRef} options={refOptions(definition, draft, { beforeIndex: index })} onChange={(ref) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, targetRef: ref } : item) })} placeholder="选择终点" /></label>
                      </div>
                      <AssignmentList action={draft} properties={propertiesOfRelationType(definition, edit.relationshipTypeId)} rows={edit.assignments} onChange={(rows) => patch({ edits: draft.edits.map((item, i) => i === index ? { ...item, assignments: rows } : item) })} />
                    </>
                  )}
                </div>
              ))}
              <button type="button" className="as-inline-add" onClick={() => patch({ edits: [...draft.edits, newEdit()] })}><Plus size={12} />添加一步操作</button>
            </section>
          </div>

          <aside className="ted-preview">
            <div className="as-rail-block">
              <b>这份配置会做什么</b>
              <p>
                {draft.scopeEntityTypeId ? `定义在「${typeName(definition, draft.scopeEntityTypeId)}」上的动作` : "还没有选作用的类"}
                <br />
                输入：{draft.params.length ? draft.params.map((item) => `${item.name || item.code || "?"}（${item.kind === "ENTITY_REF" ? typeName(definition, item.entityTypeId) || "未选类型" : item.dataType}）`).join(" · ") : "无参数"}
                <br />
                然后：{draft.edits.length ? draft.edits.map((edit) => describeEdit(definition, draft, edit)).join(" → ") : "（还没有操作）"}
              </p>
            </div>
            <div className="as-rail-block">
              <b>定义体检</b>
              {issues.length ? <ul className="as-rail-list">{issues.map((message) => <li key={message}>{message}</li>)}</ul> : <p>引用都成立。保存后动作会立刻出现在左侧清单里。</p>}
            </div>
            <p className="ted-note">动作定义保存在本体草稿里，随版本走；发布后导入图库的数据就是按这份模板写出来的。</p>
          </aside>
        </div>
        <footer className="ted-foot">
          {error ? <p className="ted-error"><AlertTriangle size={13} />{error}</p> : <p className="ted-hint">动作只写草稿快照，发布前不影响图库</p>}
          <div className="ted-foot-actions">
            <button type="button" className="quiet-button" onClick={onClose}>取消</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : mode === "create" ? "加入草稿" : "保存修改"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}

/**
 * 规则编辑器：条件 + 级别 + 绑定动作。
 * 条件的取值来自绑定动作的参数与新建别名 —— 规则不是悬空的，它必须挂在动作上才有拦截点。
 */
function RuleEditDialog({ definition, rule, mode, actions, onClose, onSave }: { definition: Definition; rule: OntologyRule; mode: "create" | "edit"; actions: ActionType[]; onClose: () => void; onSave: (rule: OntologyRule) => Promise<void> }) {
  const [draft, setDraft] = useState<OntologyRule>(() => structuredClone(rule));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const patch = (next: Partial<OntologyRule>) => setDraft((current) => ({ ...current, ...next }));
  const action = actions.find((item) => item.id === draft.actionId) ?? null;
  // 隐藏只看动作执行前就存在的值，所以主体只能是主对象（或它的邻域）。
  const allSubjects = refOptions(definition, action);
  const subjects = draft.effect === "HIDE" ? allSubjects.filter((option) => option.value.startsWith("SUBJECT:")) : allSubjects;
  const issues = useMemo(() => {
    const candidate: Definition = { ...definition, rules: definition.rules.some((item) => item.id === draft.id) ? definition.rules.map((item) => item.id === draft.id ? draft : item) : [...definition.rules, draft] };
    return validateActionDefinition(candidate as OntologyDefinition).filter((item) => item.rule === `规则.${draft.name}`).map((item) => item.message);
  }, [definition, draft]);

  const save = async () => {
    if (!draft.name.trim()) return setError("请填写规则名称。");
    if (issues.length) return setError(issues[0]);
    setBusy(true);
    try { await onSave({ ...draft, name: draft.name.trim() }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败。"); }
    finally { setBusy(false); }
  };

  const updateCondition = (index: number, next: Partial<RuleCondition>) => patch({ conditions: draft.conditions.map((item, i) => i === index ? { ...item, ...next } : item) });
  const updateSubject = (index: number, next: Partial<RuleCondition["subject"]>) => patch({ conditions: draft.conditions.map((item, i) => i === index ? { ...item, subject: { ...item.subject, ...next } } : item) });
  /** 切到「隐藏」时把条件主体收回主对象：入参与新建对象在动作跑起来之前根本不存在。 */
  const applyEffect = (effect: RuleEffect) => {
    if (effect !== "HIDE") return patch({ effect });
    patch({ effect, conditions: draft.conditions.map((condition) => condition.subject.kind === "SUBJECT" ? condition : { ...condition, subject: { ...condition.subject, kind: "SUBJECT" as const, code: "" } }) });
  };

  useEscapeToClose(onClose);
  return (
    <div className="dialog-backdrop ted-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="ted-dialog">
        <header className="ted-head">
          <span className="ted-mark"><ShieldAlert size={20} /></span>
          <div className="ted-title">
            <span className="ted-eyebrow">{mode === "create" ? "新增" : "编辑"}</span>
            <h2>{mode === "create" ? "新增规则" : `编辑规则「${rule.name}」`}</h2>
          </div>
          <button type="button" className="ted-close" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>
        <div className="ted-body">
          <div className="ted-form">
            <div className="ted-grid-2">
              <label className="ted-field"><span>规则名称</span><input className="ted-input" value={draft.name} onChange={(event) => patch({ name: event.target.value })} placeholder="例如：学生票须持学生资质" /></label>
              <label className="ted-field"><span>绑定动作</span>
                <select className="ted-select" value={draft.actionId} onChange={(event) => patch({ actionId: event.target.value, conditions: [] })}>
                  <option value="">全部动作</option>
                  {actions.map((item) => <option key={item.id} value={item.id}>{item.name || item.code}</option>)}
                </select>
                <small>条件的主体来自动作的参数与新建别名，所以换动作会清空条件。</small>
              </label>
            </div>
            <div className="ted-grid-2">
              <label className="ted-field"><span>命中后</span>
                <select className="ted-select" value={draft.effect} onChange={(event) => applyEffect(event.target.value as RuleEffect)}>
                  {ruleEffectOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <small>{ruleEffectOptions.find((item) => item.value === draft.effect)?.hint}</small>
              </label>
              <label className="ted-field"><span>优先级</span><input className="ted-input" type="number" value={draft.priority} onChange={(event) => patch({ priority: Number(event.target.value) || 0 })} /></label>
            </div>
            <div className="ted-grid-2">
              <label className="ted-toggle"><input type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.target.checked })} />启用</label>
            </div>

            <section className="ted-section">
              <div className="ted-section-head"><h3>条件</h3><em>{draft.conditions.length ? `${draft.conditions.length} 个（全部满足才算命中）` : "空"}</em></div>
              {!action && <p className="as-card-meta">先选一个绑定动作，条件才能选到主体。</p>}
              {draft.conditions.map((condition, index) => (
                <div className="as-edit-row" key={index}>
                  <div className="as-edit-head">
                    <span>条件 {index + 1}</span>
                    <div className="as-card-actions"><button type="button" className="ted-icon-button danger" title="删除条件" onClick={() => patch({ conditions: draft.conditions.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>
                  </div>
                  <div className="as-edit-grid">
                    <label className="ted-field"><span>主体</span>
                        <select className="ted-select" value={encodeRef(condition.subject)} onChange={(event) => {
                        const ref = parseRef(event.target.value);
                        updateSubject(index, { kind: ref.kind, code: ref.code });
                      }}>
                        <option value="">选择要判断的对象</option>
                        {subjects.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="ted-field"><span>取邻域（可选）</span>
                      <select className="ted-select" value={condition.subject.relationshipTypeId} onChange={(event) => updateSubject(index, { relationshipTypeId: event.target.value })}>
                        <option value="">主体自身</option>
                        {definition.relationshipTypes.map((relation) => <option key={relation.id} value={relation.id}>沿「{relation.name}」</option>)}
                      </select>
                    </label>
                  </div>
                  {condition.subject.relationshipTypeId && (
                    <div className="as-edit-grid">
                      <label className="ted-field"><span>方向</span>
                        <select className="ted-select" value={condition.subject.direction} onChange={(event) => updateSubject(index, { direction: event.target.value as "OUT" | "IN" })}>
                          <option value="OUT">出向（主体是起点）</option>
                          <option value="IN">入向（主体是终点）</option>
                        </select>
                      </label>
                      <span />
                    </div>
                  )}
                  <div className="as-edit-grid">
                    <label className="ted-field"><span>属性</span><input className="ted-input" value={condition.property} onChange={(event) => updateCondition(index, { property: event.target.value })} placeholder="例如：票种" /></label>
                    <label className="ted-field"><span>判断</span>
                      <select className="ted-select" value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as RuleCondition["operator"] })}>
                        {ruleOperatorOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  </div>
                  {!ruleOperatorsWithoutValue.includes(condition.operator) && (
                    <label className="ted-field"><span>比较值</span><input className="ted-input" value={condition.compareValue} onChange={(event) => updateCondition(index, { compareValue: event.target.value })} placeholder="例如：学生票" /></label>
                  )}
                </div>
              ))}
              <button type="button" className="as-inline-add" disabled={!action} onClick={() => {
                const first = parseRef(subjects[0]?.value ?? "");
                const condition = newCondition();
                patch({ conditions: [...draft.conditions, { ...condition, subject: { ...condition.subject, kind: first.kind, code: first.code } }] });
              }}><Plus size={12} />添加条件</button>
            </section>

            <section className="ted-section">
              <div className="ted-section-head"><h3>处置动作</h3></div>
              <label className="ted-field"><span>命中后告诉用户什么</span>
                <textarea className="ted-input as-textarea" rows={3} value={draft.message} onChange={(event) => patch({ message: event.target.value })} placeholder="例如：拒绝出票：乘客不具备学生资质，学生票仅对完成资质认证的乘客发售。" />
              </label>
            </section>
          </div>

          <aside className="ted-preview">
            <div className="as-rail-block">
              <b>这条规则读出来是</b>
              <p>当 {draft.conditions.length ? draft.conditions.map((condition) => describeCondition(definition, action, condition)).join(" 且 ") : "（未配置条件）"} 时，{effectSentence(draft.effect)}{draft.message ? `，并说明：${draft.message}` : "。"}</p>
            </div>
            <div className="as-rail-block">
              <b>定义体检</b>
              {issues.length ? <ul className="as-rail-list">{issues.map((message) => <li key={message}>{message}</li>)}</ul> : <p>引用都成立。</p>}
            </div>
            <p className="ted-note">「隐藏」决定这个动作在这个对象上出不出得来，只能看动作执行前就有的数据；「拦截」拒绝执行；「提示」只提醒不拦。三种处置用同一条规则切换，条件不用重配。</p>
          </aside>
        </div>
        <footer className="ted-foot">
          {error ? <p className="ted-error"><AlertTriangle size={13} />{error}</p> : <p className="ted-hint">规则随草稿保存，发布后随版本生效</p>}
          <div className="ted-foot-actions">
            <button type="button" className="quiet-button" onClick={onClose}>取消</button>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? "保存中…" : mode === "create" ? "加入草稿" : "保存修改"}</button>
          </div>
        </footer>
      </div>
    </div>
  );
}
