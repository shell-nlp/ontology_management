import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage, currentUser } from "@/lib/platform/auth";
import { writeAuditEntry } from "@/lib/platform/platform-db";
import { approveAuthorization, checkAuthorizationRequest, denyAuthorization, readAuthorizationParams } from "@/lib/oauth/authorize";
import { withPublic, withUser } from "@/lib/platform/route-guard";

/**
 * 授权的**决定**：浏览器里的用户在同意页点「允许 / 拒绝」之后调这里。
 *
 * 要平台会话（`Authorization: Bearer <会话令牌>`）：同意必须挂在**一个明确的账号**上，
 * 令牌将来就代表他。这里不做重定向，只回 `{ redirect }`，由页面把浏览器送过去 ——
 * 这样"回跳地址可不可信"的判断全在一处（`checkAuthorizationRequest`），页面不掺和安全判断。
 */
/**
 * 同意页开屏先问一次：这个请求合不合法、要授权给谁、现在是谁在登录。
 *
 * 放在**服务端**算，页面只管显示 —— 同意页不参与任何安全判断（"回调地址可不可信"只在
 * `checkAuthorizationRequest` 里判一次），它要是自己判一遍，早晚跟服务端判得不一样。
 */
export const GET = withPublic(async (request: NextRequest) => {
  try {
    const params = readAuthorizationParams(Object.fromEntries(new URL(request.url).searchParams.entries()));
    const check = await checkAuthorizationRequest(params);
    if (!check.ok) {
      return NextResponse.json(
        { error: check.error, error_description: check.description, redirect: check.redirect },
        { status: 400 },
      );
    }
    const user = await currentUser();
    return NextResponse.json({
      client: { id: check.client.id, name: check.client.name, source: check.client.source, redirectUri: check.redirectUri },
      scope: check.scope,
      /** 已经登录就直接显示"用哪个账号授权"，没登录页面会先让人登录。 */
      user: user ? { email: user.email, roleName: user.roleName } : null,
    });
  } catch (error) {
    return NextResponse.json({ error: "server_error", error_description: apiErrorMessage(error, "读取授权请求失败。") }, { status: apiErrorStatus(error) });
  }
});

export const POST = withUser(async (request: NextRequest, _context, user) => {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const params = readAuthorizationParams(body);

    // 先用服务端已有的规则判一遍：不通过就按"能不能回跳"决定是回 error 还是直接摆在页面上。
    const check = await checkAuthorizationRequest(params);
    if (!check.ok) {
      return NextResponse.json(
        { error: check.error, error_description: check.description, redirect: check.redirect },
        { status: 400 },
      );
    }

    /*
     * 同意（以及拒绝）都必须挂在一个**明确的账号**上 —— 令牌将来就代表他，
     * 所以这条路由包的是 `withUser`（没登录直接 401），而不是 `withPublic`；
     * 401 由 `lib/platform/route-guard.ts` 统一回，handler 里不再自己判。
     */

    if (body.decision === "deny") {
      return NextResponse.json({ redirect: denyAuthorization({ check, params }) });
    }

    const redirect = await approveAuthorization({ check, params, user });
    await writeAuditEntry({
      action: "OAUTH_AUTHORIZED",
      actorId: user.id,
      details: {
        clientId: check.client.id,
        clientName: check.client.name,
        scope: check.scope,
        redirectUri: check.redirectUri,
        note: "用户在同意页同意外部客户端代表他访问 MCP（只读）。",
      },
    });
    return NextResponse.json({ redirect });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "授权失败。") }, { status: apiErrorStatus(error) });
  }
});
