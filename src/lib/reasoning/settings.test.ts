import { describe, expect, it } from "vitest";
import { DEFAULT_SYSTEM_PROMPT } from "@/lib/reasoning/prompt";
import { reasoningSettingsPayload, systemPromptFieldValue } from "@/lib/reasoning/settings";

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