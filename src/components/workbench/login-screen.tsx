"use client";

import { type User, Notice } from "@/components/workbench/shared";
import { useState } from "react";
import { GitBranch } from "lucide-react";
import { api } from "@/lib/api-client";
import { setSessionToken } from "@/lib/session-token";





export function Login({ onSuccess }: { onSuccess: (user: User) => Promise<void> }) {
  const [email, setEmail] = useState("admin@example.com"); const [password, setPassword] = useState(""); const [error, setError] = useState("");
  return <main className="login-screen"><form className="login-card" onSubmit={async (event) => { event.preventDefault(); try { setError(""); const data = await api<User & { token: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }); const { token, ...me } = data; setSessionToken(token); await onSuccess(me); } catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败"); } }}><div className="login-mark"><GitBranch size={25} /></div><p>ONTOLOGY CONTROL</p><h1>登录本体平台</h1><label>邮箱<input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required /></label><label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" required autoFocus /></label><Notice message={error || null} error /><button className="action primary" type="submit">登录</button></form></main>;
}
