import { afterEach, describe, expect, it, vi } from "vitest";
import { api, API_READ_TIMEOUT_MS } from "@/lib/shared/client/api-client";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function pendingFetch() {
  return vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
}
describe("交互读取生命周期", () => {
  it("GET 超时会真正取消 fetch，并给可操作的提示", async () => {
    vi.useFakeTimers();
    const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
    const result = api("/api/skills");
    const assertion = expect(result).rejects.toThrow("读取超时（30 秒）");
    await vi.advanceTimersByTimeAsync(API_READ_TIMEOUT_MS);
    await assertion;
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  });
  it("调用方取消不能被误报为超时", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", pendingFetch());
    const result = api("/api/objects", { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await assertion;
  });
  it("写入和后台任务提交不会套用 GET 超时", async () => {
    vi.useFakeTimers();
    const fetch = pendingFetch(); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const result = api("/api/reasoning/runs", { method: "POST", signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(API_READ_TIMEOUT_MS * 2);
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(false);
    controller.abort(); await assertion;
  });
  it("失败响应仍保留原状态码和详细上下文", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "没有权限", details: ["保留明细"] }), { status: 403 })));
    await expect(api("/api/mcp/info")).rejects.toMatchObject({ status: 403, payload: { details: ["保留明细"] } });
  });
});
