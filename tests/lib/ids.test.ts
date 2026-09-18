import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newId", () => {
  it("有 crypto.randomUUID 时直接用原生实现", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID });
    expect(newId()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("没有 randomUUID（http + 机器 IP 的不安全上下文）时用 getRandomValues 自己拼 v4", () => {
    const source = new Uint8Array(16).map((_, index) => index + 1);
    vi.stubGlobal("crypto", { getRandomValues: (target: Uint8Array) => source.slice(0, target.length) });
    const id = newId();
    expect(id).toMatch(UUID_V4);
    expect(id).toBe("01020304-0506-4708-890a-0b0c0d0e0f10");
  });

  it("连 getRandomValues 都没有时退回时间戳 + 随机数，至少不抛异常", () => {
    vi.stubGlobal("crypto", undefined);
    const id = newId();
    expect(id.startsWith("id-")).toBe(true);
    expect(id.length).toBeGreaterThan(6);
  });

  it("Node 环境（服务端）走的还是原生 randomUUID", () => {
    expect(newId()).toMatch(UUID_V4);
  });
});
