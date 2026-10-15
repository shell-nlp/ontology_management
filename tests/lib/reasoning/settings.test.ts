import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/reasoning/prompt";
import { loadReasoningSettings, reasoningSettingsPayload, REASONING_SETTINGS_KEY, saveReasoningSettings, systemPromptFieldValue } from "@/lib/reasoning/settings";

describe("reasoningSettingsPayload", () => {
  it("没设的项一律不带（服务端按不限制处理）", () => {
    expect(reasoningSettingsPayload({})).toEqual({});
  });

  it("设了就带上", () => {
    expect(reasoningSettingsPayload({ maxSteps: 5, toolResultLimit: 1000, sqlRowLimit: 50 })).toEqual({ maxSteps: 5, toolResultLimit: 1000, sqlRowLimit: 50 });
  });

  it("提示词等于默认、或只有空白时都不带（等于没改）", () => {
    expect(reasoningSettingsPayload({ systemPrompt: DEFAULT_SYSTEM_PROMPT })).toEqual({});
    expect(reasoningSettingsPayload({ systemPrompt: "   " })).toEqual({});
    expect(reasoningSettingsPayload({ systemPrompt: ` ${DEFAULT_SYSTEM_PROMPT} ` })).toEqual({});
  });

  it("改过就带上，并去掉首尾空白", () => {
    expect(reasoningSettingsPayload({ systemPrompt: "  你是专线业务助手。  " })).toEqual({ systemPrompt: "你是专线业务助手。" });
  });

  it("提示词和数字可以一起带", () => {
    expect(reasoningSettingsPayload({ systemPrompt: "自定义提示词", maxSteps: 8 })).toEqual({ maxSteps: 8, systemPrompt: "自定义提示词" });
  });

  it("思考开关只存本机，不进请求体", () => {
    expect(reasoningSettingsPayload({ thinking: false })).toEqual({});
    expect(reasoningSettingsPayload({ thinking: false, maxSteps: 5 })).toEqual({ maxSteps: 5 });
  });
});

describe("systemPromptFieldValue", () => {
  it("没改过时显示默认原文（用户要看得见默认提示词）", () => {
    expect(systemPromptFieldValue({})).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(systemPromptFieldValue({ systemPrompt: DEFAULT_SYSTEM_PROMPT })).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it("改过时显示改过的那段", () => {
    expect(systemPromptFieldValue({ systemPrompt: "自定义提示词" })).toBe("自定义提示词");
  });
});

describe("思考开关的本机读写", () => {
  it("存了 false 读回来就是关；开回来是删掉这一项，不是存 true", () => {
    const store = new Map<string, string>();
    const fakeLocalStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
    const host = globalThis as unknown as { window?: { localStorage: typeof fakeLocalStorage } };
    host.window = { localStorage: fakeLocalStorage };
    try {
      // 没存过 = 默认开。
      expect(loadReasoningSettings().thinking).toBeUndefined();
      saveReasoningSettings({ thinking: false, maxSteps: 6 });
      expect(store.get(REASONING_SETTINGS_KEY)).toContain('"thinking":false');
      expect(loadReasoningSettings()).toEqual({ maxSteps: 6, thinking: false });
      // 开回来 = 把这一项删掉（省略即默认开）。
      saveReasoningSettings({ maxSteps: 6 });
      expect(store.get(REASONING_SETTINGS_KEY)).toBe('{"maxSteps":6}');
      expect(loadReasoningSettings().thinking).toBeUndefined();
    } finally {
      delete host.window;
    }
  });
});