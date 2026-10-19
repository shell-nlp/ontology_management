"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { GitBranch, ShieldCheck } from "lucide-react";
import { api } from "@/lib/shared/client/api-client";
import { Login } from "@/components/workbench/login-screen";
import { type User } from "@/components/workbench/shared";
import "./oauth-consent.css";

/**
 * 授权同意页（外部 MCP 客户端把人送过来时看到的那一屏）。
 *
 * 三条界面规矩：
 * 1. **说清是谁在要权限**：客户端名字 + 它会拿到什么（MCP 只读工具）；
 * 2. **说清是拿谁的**：默认就是当前登录账号，换账号要先退出登录（不在这儿做"以他人身份授权"）；
 * 3. **不猜、不判**：合法性与"能不能回跳"全由 `/api/oauth/authorize` 说了算，这里只负责显示与点击。
 */

type Preview = {
  client: { id: string; name: string; source: string; redirectUri: string };
  scope: string;
  user: { email: string; roleName: string } | null;
};

type FailurePayload = { error_description?: string; redirect?: string | null };

function failureFrom(reason: unknown): { message: string; redirect: string | null } {
  const payload = (reason as { payload?: FailurePayload })?.payload;
  return {
    message: payload?.error_description ?? (reason instanceof Error ? reason.message : "授权请求无效。"),
    redirect: payload?.redirect ?? null,
  };
}

export function OAuthConsent() {
  const search = useSearchParams();
  const query = search.toString();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<{ message: string; redirect: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * 拉预览这一步分成"只取数"和"写进状态"两半：
   * 效果里只负责取数 + 写状态（用 alive 防串台），事件回调（登录成功）复用同一个取数函数 ——
   * 这样既没有"同步在 effect 里 setState"，也不用把同一段 fetch 写两遍。
   */
  const fetchPreview = useCallback(async (): Promise<{ ok: true; data: Preview } | { ok: false; error: { message: string; redirect: string | null } }> => {
    try {
      return { ok: true, data: await api<Preview>(`/api/oauth/authorize?${query}`) };
    } catch (reason) {
      return { ok: false, error: failureFrom(reason) };
    }
  }, [query]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const result = await fetchPreview();
      if (!alive) return;
      if (result.ok) {
        setPreview(result.data);
        setError(null);
      } else {
        setError(result.error);
        setPreview(null);
      }
    })();
    return () => { alive = false; };
  }, [fetchPreview]);

  /** 登录成功后不需要跳转：重新拉一次预览，页面自然变成「允许 / 拒绝」。 */
  const onSignedIn = useCallback(async (_user: User) => {
    const result = await fetchPreview();
    if (result.ok) {
      setPreview(result.data);
      setError(null);
    } else {
      setError(result.error);
      setPreview(null);
    }
  }, [fetchPreview]);

  const decide = async (decision: "allow" | "deny") => {
    setBusy(true);
    try {
      const body = Object.fromEntries(new URLSearchParams(query).entries());
      const data = await api<{ redirect: string }>("/api/oauth/authorize", { method: "POST", body: JSON.stringify({ ...body, decision }) });
      window.location.assign(data.redirect);
    } catch (reason) {
      setError(failureFrom(reason));
      setBusy(false);
    }
  };

  if (error) {
    return (
      <main className="login-screen">
        <section className="login-card consent-card">
          <div className="login-mark"><GitBranch size={25} /></div>
          <p>ONTOLOGY CONTROL</p>
          <h1>这次授权没法继续</h1>
          <p className="consent-lede">{error.message}</p>
          {error.redirect && (
            <button type="button" className="action" onClick={() => window.location.assign(error.redirect as string)}>返回客户端</button>
          )}
        </section>
      </main>
    );
  }

  if (!preview) {
    return (
      <main className="login-screen">
        <section className="login-card consent-card"><p className="consent-lede">正在核对这次授权请求…</p></section>
      </main>
    );
  }

  if (!preview.user) {
    return <Login onSuccess={onSignedIn} />;
  }

  return (
    <main className="login-screen">
      <section className="login-card consent-card">
        <div className="login-mark"><ShieldCheck size={25} /></div>
        <p>MCP 外部接入</p>
        <h1>允许这个客户端访问？</h1>

        <dl className="consent-facts">
          <div><dt>客户端</dt><dd>{preview.client.name}</dd></div>
          <div><dt>用哪个账号授权</dt><dd>{preview.user.email}（{preview.user.roleName}）</dd></div>
          <div><dt>它能做什么</dt><dd>查询本体的对象类型、关系与数据（<strong>只读</strong>，改不了任何东西）</dd></div>
          <div><dt>授权给谁</dt><dd>{preview.client.redirectUri}</dd></div>
        </dl>

        <p className="consent-note">
          授权后，这个客户端<b>以你上面那个账号的身份</b>调用 MCP 只读工具：你能看到的数据它才看得到。
          账号被停用或改了角色，它的访问立刻跟着变。随时可以在「MCP 调试 → MCP 接入」里删掉这个客户端。
        </p>

        <div className="consent-actions">
          <button type="button" className="action primary" disabled={busy} onClick={() => void decide("allow")}>
            {busy ? "处理中…" : "允许"}
          </button>
          <button type="button" className="action" disabled={busy} onClick={() => void decide("deny")}>拒绝</button>
        </div>
      </section>
    </main>
  );
}
