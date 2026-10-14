import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 守卫收口之后，401 / 403 的语义**只在 route-guard 里判一次** —— 所以它必须自己有测试。
 *
 * 这里 mock 掉 `requirePermission` / `requireUser`（它们要真会话与库），
 * 但 `apiErrorMessage` / `apiErrorStatus` 用**真实现**：状态码与那句话正是被测对象，
 * 换成假的就等于没测。
 */
const requirePermissionMock = vi.fn();
const requireUserMock = vi.fn();

vi.mock("@/lib/platform/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/auth")>();
  return { ...actual, requirePermission: (...args: unknown[]) => requirePermissionMock(...args), requireUser: (...args: unknown[]) => requireUserMock(...args) };
});

const { AUTH_EXPIRED_MESSAGE, FORBIDDEN_MESSAGE } = await import("@/lib/platform/auth");
const { withPermission, withUser, withPublic, withOwnAuth } = await import("@/lib/platform/route-guard");

const user = { id: "u-1", email: "a@b.c", roleId: "editor", roleName: "编辑者", permissions: ["ontology.read"] } as never;
const request = new NextRequest("http://localhost:3000/api/whatever");

describe("路由守卫（PEP）", () => {
  beforeEach(() => {
    requirePermissionMock.mockReset();
    requireUserMock.mockReset();
  });

  it("没登录回 401，登录了但没权限回 403（和以前一样，不是 401）", async () => {
    requirePermissionMock.mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    const unauthorized = await withPermission("ontology.read", async () => new Response("ok"))(request, {});
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: AUTH_EXPIRED_MESSAGE });

    requirePermissionMock.mockRejectedValueOnce(new Error("FORBIDDEN"));
    const forbidden = await withPermission("ontology.read", async () => new Response("ok"))(request, {});
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: FORBIDDEN_MESSAGE });
  });

  it("权限点原样传给 requirePermission（别在收口处串味）", async () => {
    requirePermissionMock.mockResolvedValueOnce(user);
    await withPermission("ontology.publish", async () => new Response("ok"))(request, {});
    expect(requirePermissionMock).toHaveBeenCalledWith("ontology.publish");
  });

  it("通过之后 handler 拿到已认证的用户，返回值原样透出", async () => {
    requirePermissionMock.mockResolvedValueOnce(user);
    const seen: unknown[] = [];
    const response = await withPermission("ontology.read", async (_request, context, handlerUser) => {
      seen.push(context, handlerUser);
      return new Response("done");
    })(request, { params: "ctx" });
    expect(await response.text()).toBe("done");
    expect(seen).toEqual([{ params: "ctx" }, user]);
  });

  it("withUser 只要求登录：没登录 401，通过后也注入用户", async () => {
    requireUserMock.mockRejectedValueOnce(new Error("UNAUTHORIZED"));
    expect((await withUser(async () => new Response("ok"))(request, {})).status).toBe(401);

    requireUserMock.mockResolvedValueOnce(user);
    let got: unknown = null;
    await withUser(async (_request, _context, handlerUser) => { got = handlerUser; return new Response("ok"); })(request, {});
    expect(got).toBe(user);
  });

  it("handler 自己抛的业务异常不在这里被吞（交给路由自己的 catch）", async () => {
    requirePermissionMock.mockResolvedValueOnce(user);
    await expect(withPermission("ontology.read", async () => { throw new Error("业务炸了"); })(request, {})).rejects.toThrow("业务炸了");
  });

  it("公开 / 自带鉴权的两条路不碰守卫，原样透传", async () => {
    await withPublic(async () => new Response("public"))(request, {});
    await withOwnAuth(async () => new Response("own"))(request, {});
    expect(requirePermissionMock).not.toHaveBeenCalled();
    expect(requireUserMock).not.toHaveBeenCalled();
  });
});