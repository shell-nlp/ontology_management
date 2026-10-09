"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, KeyRound, Lock, Pencil, Plus, Power, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api } from "@/lib/api-client";
import "./user-role-manager.css";

/**
 * 「用户与角色」：平台授权模型的操作台（2026-10-09 RBAC）。
 *
 * 两档，用平台统一的 `.view-switcher`：
 * - **用户**：账号清单 + 改角色 / 重置密码 / 停用 / 删除，以及建账号（管理员直接给初始密码）；
 * - **角色**：内置三档（只读）+ 自定义角色，右侧是**按模块成块的权限矩阵**。
 *
 * 三条从服务端来的口径，界面别自作主张：
 * 1. 内置角色（管理员 / 编辑者 / 查看者）不可改不可删 —— 权限集由 `@/lib/permissions` 决定，要定制就复制一份；
 * 2. `admin` 永远拥有全部权限（服务端直接短路，不看库里那行），所以它的矩阵是只读的全勾；
 * 3. "最后一个能管用户的账号"不许降级 / 停用 / 删除，服务端会回一句人话，这里原样显示。
 */

type PermissionSpec = { code: string; group: string; label: string; detail: string };
type RoleRecord = { id: string; name: string; description: string; builtin: boolean; permissions: string[]; userCount: number };
type UserRecord = { id: string; email: string; roleId: string; roleName: string; disabled: boolean; createdAt: string };

type Props = {
  /** 当前登录的人：用来标"我"，以及不让自己误删自己（服务端还会再拦一次）。 */
  me: { id: string; email: string };
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
};

/** 角色色点：一眼看出量级，不用逐条读矩阵。 */
function roleTone(role: RoleRecord | undefined): string {
  if (!role) return "soft";
  if (role.builtin) return role.id === "admin" ? "admin" : role.id === "editor" ? "editor" : "viewer";
  return "custom";
}

function describeRole(role: RoleRecord, all: PermissionSpec[]): string {
  if (role.id === "admin") return "全部权限";
  const granted = new Set(role.permissions);
  const groups = new Map<string, number>();
  for (const spec of all) if (granted.has(spec.code)) groups.set(spec.group, (groups.get(spec.group) ?? 0) + 1);
  if (!groups.size) return "没有任何权限";
  const parts = [...groups.entries()].map(([group, count]) => `${group} ${count}`);
  return `${role.permissions.length} / ${all.length} 个权限点 · ${parts.join(" · ")}`;
}

export function UserRoleManager({ me, notify, fail }: Props) {
  const [view, setView] = useState<"users" | "roles">("users");
  const [permissions, setPermissions] = useState<PermissionSpec[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [draftRole, setDraftRole] = useState<RoleRecord | null>(null);

  const load = useCallback(async () => {
    const [roleData, userData] = await Promise.all([
      api<{ roles: RoleRecord[]; permissions: PermissionSpec[] }>("/api/roles"),
      api<{ users: UserRecord[] }>("/api/users"),
    ]);
    setRoles(roleData.roles);
    setPermissions(roleData.permissions);
    setUsers(userData.users);
    return roleData.roles;
  }, []);

  useEffect(() => {
    load()
      .then((loaded) => setSelectedRoleId((current) => current ?? loaded[0]?.id ?? null))
      .catch(fail)
      .finally(() => setLoading(false));
    // 只在挂载时取一次；改动之后由各个动作自己刷。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedUser = users.find((user) => user.id === selectedUserId) ?? null;
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null;

  useEffect(() => {
    // 选中角色变了就把编辑缓冲重置成它当前的样子（避免把上一个角色的改动带过来）。
    setDraftRole(selectedRole ? { ...selectedRole, permissions: [...selectedRole.permissions] } : null);
  }, [selectedRoleId, roles]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const map = new Map<string, PermissionSpec[]>();
    for (const spec of permissions) map.set(spec.group, [...(map.get(spec.group) ?? []), spec]);
    return [...map.entries()];
  }, [permissions]);

  const run = async (action: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await action();
      notify(done);
    } catch (reason) {
      fail(reason);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="empty">正在读取用户与角色…</p>;

  return (
    <section className="rbac">
      <div className="view-switcher" aria-label="用户与角色">
        <button className={view === "users" ? "active" : ""} aria-pressed={view === "users"} onClick={() => setView("users")}>
          用户 <b>{users.length}</b>
        </button>
        <button className={view === "roles" ? "active" : ""} aria-pressed={view === "roles"} onClick={() => setView("roles")}>
          角色 <b>{roles.length}</b>
        </button>
      </div>

      {view === "users" ? (
        <UsersPane
          me={me}
          users={users}
          roles={roles}
          busy={busy}
          selected={selectedUser}
          onSelect={setSelectedUserId}
          run={run}
          reload={load}
          notify={notify}
        />
      ) : (
        <RolesPane
          roles={roles}
          grouped={grouped}
          all={permissions}
          busy={busy}
          selected={selectedRole}
          draft={draftRole}
          setDraft={setDraftRole}
          onSelect={setSelectedRoleId}
          run={run}
          reload={load}
          notify={notify}
          fail={fail}
        />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- 用户档 */

function UsersPane({ me, users, roles, busy, selected, onSelect, run, reload, notify }: {
  me: { id: string; email: string };
  users: UserRecord[];
  roles: RoleRecord[];
  busy: boolean;
  selected: UserRecord | null;
  onSelect: (id: string) => void;
  run: (action: () => Promise<void>, done: string) => Promise<void>;
  reload: () => Promise<RoleRecord[]>;
  notify: (text: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const role = roles.find((item) => item.id === selected?.roleId);
  const isMe = selected?.id === me.id;

  return (
    <div className="rbac-grid">
      <div className="panel functional-panel">
        <div className="rbac-pane-head">
          <span className="eyebrow">账号清单</span>
          <small>{users.length} 个账号</small>
        </div>
        <div className="rbac-rows">
          {users.map((user) => {
            const tone = roleTone(roles.find((item) => item.id === user.roleId));
            return (
              <button
                type="button"
                key={user.id}
                className={`rbac-row${selected?.id === user.id ? " selected" : ""}${user.disabled ? " off" : ""}`}
                onClick={() => onSelect(user.id)}
              >
                <span className={`rbac-dot ${tone}`} aria-hidden="true" />
                <span className="rbac-row-main">
                  <b>{user.email}{user.id === me.id && <em>我</em>}</b>
                  <small>{user.roleName}{user.disabled && " · 已停用"}</small>
                </span>
              </button>
            );
          })}
          {!users.length && <p className="empty">还没有账号。</p>}
        </div>

        <div className="rbac-create">
          <span className="eyebrow">新建账号</span>
          <label>
            <span>邮箱</span>
            <input value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@example.com" disabled={busy} />
          </label>
          <label>
            <span>初始密码</span>
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="直接给他一个初始密码" disabled={busy} />
          </label>
          <label>
            <span>角色</span>
            <select value={roleId} onChange={(event) => setRoleId(event.target.value)} disabled={busy}>
              <option value="">选择角色</option>
              {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <p className="rbac-hint">平台不校验密码强度，请自己用足够长的密码；建好后把密码直接发给本人（没有"首登强制改密"）。</p>
          <button
            type="button"
            className="action primary"
            disabled={busy || !email.trim() || !password || !roleId}
            onClick={() => void run(async () => {
              await api("/api/users", { method: "POST", body: JSON.stringify({ email, password, roleId }) });
              setEmail(""); setPassword(""); setRoleId("");
              await reload();
            }, "账号已创建。")}
          >
            <UserPlus size={15} />建立账号
          </button>
        </div>
      </div>

      <div className="panel functional-panel">
        {selected ? (
          <>
            <div className="rbac-pane-head">
              <span className="eyebrow">账号</span>
              <small>{selected.email}</small>
            </div>
            <div className="rbac-detail">
              <div className={`rbac-badge ${roleTone(role)}`}>
                <ShieldCheck size={15} />
                <span><b>{selected.roleName}</b><small>{role?.id === "admin" ? "全部权限" : role ? `${role.permissions.length} 个权限点` : ""}</small></span>
              </div>

              <label className="rbac-field">
                <span>角色</span>
                <select
                  value={selected.roleId}
                  disabled={busy}
                  onChange={(event) => void run(async () => {
                    await api(`/api/users/${selected.id}`, { method: "PATCH", body: JSON.stringify({ roleId: event.target.value }) });
                    await reload();
                  }, `已把 ${selected.email} 换成新角色。`)}
                >
                  {roles.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>

              <div className="rbac-field">
                <span>重置密码</span>
                <div className="rbac-inline">
                  <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="给一个新密码" disabled={busy} />
                  <button
                    type="button"
                    className="action compact"
                    disabled={busy || !newPassword}
                    onClick={() => void run(async () => {
                      await api(`/api/users/${selected.id}`, { method: "PATCH", body: JSON.stringify({ password: newPassword }) });
                      setNewPassword("");
                    }, `已重置 ${selected.email} 的密码。`)}
                  >
                    <KeyRound size={13} />重置
                  </button>
                </div>
              </div>

              <div className="rbac-actions">
                <button
                  type="button"
                  className="action compact"
                  disabled={busy}
                  onClick={() => void run(async () => {
                    await api(`/api/users/${selected.id}`, { method: "PATCH", body: JSON.stringify({ disabled: !selected.disabled }) });
                    await reload();
                  }, selected.disabled ? `已启用 ${selected.email}。` : `已停用 ${selected.email}，他的令牌下一次请求就失效。`)}
                >
                  <Power size={13} />{selected.disabled ? "启用" : "停用"}
                </button>
                <button
                  type="button"
                  className="action compact danger"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`删除账号「${selected.email}」？他历史上的审计记录会保留，只是操作人变空，无法恢复。`)) return;
                    void run(async () => {
                      await api(`/api/users/${selected.id}`, { method: "DELETE" });
                      onSelect("");
                      await reload();
                    }, `账号 ${selected.email} 已删除。`);
                  }}
                >
                  <Trash2 size={13} />删除
                </button>
                {isMe && <p className="rbac-hint">这是你自己的账号：平台会拦住"删掉最后一个能管用户的人"，所以删自己之前先给别人这个权限。</p>}
              </div>
            </div>
          </>
        ) : (
          <div className="rbac-empty">
            <Users size={20} />
            <b>选一个账号</b>
            <span>左边点一个人，这里能改他的角色、重置密码、停用或删除。</span>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 角色档 */

function RolesPane({ roles, grouped, all, busy, selected, draft, setDraft, onSelect, run, reload, notify, fail }: {
  roles: RoleRecord[];
  grouped: [string, PermissionSpec[]][];
  all: PermissionSpec[];
  busy: boolean;
  selected: RoleRecord | null;
  draft: RoleRecord | null;
  setDraft: (role: RoleRecord) => void;
  onSelect: (id: string) => void;
  run: (action: () => Promise<void>, done: string) => Promise<void>;
  reload: () => Promise<RoleRecord[]>;
  notify: (text: string) => void;
  fail: (reason: unknown) => void;
}) {
  const [newName, setNewName] = useState("");
  const builtin = Boolean(draft?.builtin);
  const dirty = Boolean(draft && selected && (draft.name !== selected.name || draft.description !== selected.description || draft.permissions.join() !== selected.permissions.join()));

  const toggle = (code: string) => {
    if (!draft || builtin) return;
    const next = draft.permissions.includes(code) ? draft.permissions.filter((item) => item !== code) : [...draft.permissions, code];
    setDraft({ ...draft, permissions: next });
  };

  return (
    <div className="rbac-grid">
      <div className="panel functional-panel">
        <div className="rbac-pane-head">
          <span className="eyebrow">角色清单</span>
          <small>{roles.length} 个角色</small>
        </div>
        <div className="rbac-rows">
          {roles.map((role) => (
            <button
              type="button"
              key={role.id}
              className={`rbac-row${selected?.id === role.id ? " selected" : ""}`}
              onClick={() => onSelect(role.id)}
            >
              <span className={`rbac-dot ${roleTone(role)}`} aria-hidden="true" />
              <span className="rbac-row-main">
                <b>{role.name}{role.builtin && <Lock size={11} />}</b>
                <small>{role.userCount} 个账号在用</small>
              </span>
            </button>
          ))}
        </div>
        <div className="rbac-create">
          <span className="eyebrow">新建角色</span>
          <label>
            <span>角色名称</span>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="例如：数据工程" disabled={busy} />
          </label>
          <p className="rbac-hint">新角色从零开始，建好之后在右边勾权限点。</p>
          <button
            type="button"
            className="action primary"
            disabled={busy || !newName.trim()}
            onClick={() => void run(async () => {
              await api("/api/roles", { method: "POST", body: JSON.stringify({ name: newName, permissions: [] }) });
              setNewName("");
              const loaded = await reload();
              const created = loaded.find((role) => role.name === newName.trim());
              if (created) onSelect(created.id);
            }, "角色已创建，去右边勾权限。")}
          >
            <Plus size={15} />新建角色
          </button>
        </div>
      </div>

      <div className="panel functional-panel">
        {draft && selected ? (
          <>
            <div className="rbac-pane-head">
              <span className="eyebrow">权限</span>
              <small>{describeRole(selected, all)}</small>
            </div>
            {builtin ? (
              <p className="rbac-note">
                <Lock size={13} />
                「{selected.name}」是内置角色，权限集由平台决定，不能改。要定制就新建一个角色，把下面这些点勾成你要的样子。
              </p>
            ) : (
              <div className="rbac-detail">
                <div className="rbac-inline">
                  <input
                    className="rbac-name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    disabled={busy}
                  />
                  <button
                    type="button"
                    className="action primary compact"
                    disabled={busy || !dirty || !draft.name.trim()}
                    onClick={() => void run(async () => {
                      await api(`/api/roles/${selected.id}`, { method: "PATCH", body: JSON.stringify({ name: draft.name, description: draft.description, permissions: draft.permissions }) });
                      await reload();
                    }, "角色已保存。")}
                  >
                    <Check size={13} />保存角色
                  </button>
                  <button
                    type="button"
                    className="action compact danger"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`删除角色「${selected.name}」？`)) return;
                      void run(async () => {
                        await api(`/api/roles/${selected.id}`, { method: "DELETE" });
                        onSelect("");
                        await reload();
                      }, "角色已删除。");
                    }}
                  >
                    <Trash2 size={13} />删除角色
                  </button>
                </div>
                <label className="rbac-field">
                  <span>说明</span>
                  <input
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    placeholder="这个角色是给谁用的"
                    disabled={busy}
                  />
                </label>
              </div>
            )}

            <div className="rbac-matrix">
              {grouped.map(([group, specs]) => (
                <section className="rbac-module" key={group}>
                  <header>
                    <b>{group}</b>
                    <small>{draft.permissions.filter((code) => specs.some((spec) => spec.code === code)).length} / {specs.length}</small>
                  </header>
                  {specs.map((spec) => {
                    const on = draft.permissions.includes(spec.code);
                    return (
                      <label className={`rbac-perm${on ? " on" : ""}${builtin ? " locked" : ""}`} key={spec.code}>
                        <input type="checkbox" checked={on} disabled={builtin || busy} onChange={() => toggle(spec.code)} />
                        <span className="rbac-perm-box" aria-hidden="true">{on && <Check size={11} />}</span>
                        <span className="rbac-perm-text">
                          <b>{spec.label}</b>
                          <small>{spec.detail}</small>
                          <code>{spec.code}</code>
                        </span>
                      </label>
                    );
                  })}
                </section>
              ))}
            </div>
          </>
        ) : (
          <div className="rbac-empty">
            <Pencil size={20} />
            <b>选一个角色</b>
            <span>左边点一个角色，这里能看到它的权限矩阵（按模块分块）。内置角色只读，自定义角色可以勾。</span>
          </div>
        )}
      </div>
    </div>
  );
}