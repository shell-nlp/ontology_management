import { NextResponse } from "next/server";

/**
 * 登出：**空操作**。
 *
 * 会话是无状态 JWT，服务端根本不知道有这枚令牌，也没有 cookie 可以清
 * —— 真正的登出是前端把 localStorage 里那份丢掉（`clearSessionToken()`）。
 * 这个路由留着有两个原因：一是老脚本/书签还会 POST 它，回 404 会让人以为坏了；
 * 二是将来如果要加"令牌吊销名单"，落点就在这里。
 */
export async function POST() {
  return NextResponse.json({ ok: true });
}