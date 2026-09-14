/**
 * 智能问答的运行参数（「问答配置」抽屉里改的那几个数）。
 *
 * **默认全不限制**：想跑多少步、工具返回多长、一次取多少行，都由模型自己把握；
 * 只有你明确填了数字才按那个数卡。存在浏览器本地，一台机器一套，不跟着账号走。
 *
 * 除了三个数，还有一段**系统提示词**（`systemPrompt`）：留空 = 用 `prompt.ts` 里的默认提示词，
 * 抽屉里会把默认那段原文显示出来，改了就按改的走。本体概念清单由服务端自动接在后面，不用手写。
 *
 * 这里刻意只有这几个旋钮：能改的都是"影响结论完不完整 / 口味"的部分，
 * 真正保护数据库的那几条（只读事务、语句超时）不在其中，也不该被关掉。
 */

import { DEFAULT_SYSTEM_PROMPT, isCustomSystemPrompt } from "@/lib/reasoning/prompt";

export type ReasoningSettings = {
  /** 一次问答最多让模型走几步。留空 = 不限制（服务端兜底到 100，防死循环）。 */
  maxSteps?: number;
  /** 单个工具返回给模型的字符上限，超了就截断并提示模型。留空 = 不限制。 */
  toolResultLimit?: number;
  /** 数据资源查询一次最多取多少行。留空 = 不限制（服务端兜底到 5000，防一次拉爆内存）。 */
  sqlRowLimit?: number;
  /**
   * 自定义系统提示词。留空、或与默认那段一字不差 = 用默认提示词（请求里也不带这一项）。
   * 上限 20000 字，和服务端校验一致。
   */
  systemPrompt?: string;
};

/** 提示词长度上限：和服务端 `z.string().max(20000)` 对齐。 */
export const SYSTEM_PROMPT_LIMIT = 20_000;

export const REASONING_SETTINGS_KEY = "ontology.qa.settings";

/** 每个字段能填的范围。上界都是"防跑穿"的兜底，不是产品门槛。 */
export const REASONING_SETTING_RANGES = {
  maxSteps: { min: 1, max: 100, fallbackCeiling: 100 },
  toolResultLimit: { min: 500, max: 200_000 },
  sqlRowLimit: { min: 1, max: 5000, fallbackCeiling: 5000 },
} as const;

export const REASONING_SETTING_FIELDS = [
  {
    key: "maxSteps",
    label: "工具步数上限",
    hint: "一次问答最多让模型走几步。一步里可以并发调多个工具。",
    placeholder: "不限制",
    suffix: "步",
  },
  {
    key: "toolResultLimit",
    label: "工具结果上限",
    hint: "单个工具返回给模型的内容超过这个长度就截断（模型会看到「已截断」提示）。",
    placeholder: "不限制",
    suffix: "字",
  },
  {
    key: "sqlRowLimit",
    label: "取数行数上限",
    hint: "run_sql 一次最多返回多少行。填了只往下压，不会把默认值抬上去：留空时模型不指定就按 100 行（超过会在结果里标「已截断」）。",
    placeholder: "不限制",
    suffix: "行",
  },
] as const satisfies readonly { key: keyof ReasoningSettings; label: string; hint: string; placeholder: string; suffix: string }[];

/** 只有这三个是数字旋钮；`systemPrompt` 不在其中（它是文本，另有处理）。 */
type NumericSettingKey = keyof typeof REASONING_SETTING_RANGES;

function clampField(key: NumericSettingKey, value: unknown): number | undefined {
  const range = REASONING_SETTING_RANGES[key];
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < range.min) return undefined;
  return Math.min(range.max, Math.floor(numeric));
}

/** 读本机保存的参数；没存过、存坏了、字段超范围，都当"不限制"。 */
export function loadReasoningSettings(): ReasoningSettings {
  if (typeof window === "undefined") return {};
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(REASONING_SETTINGS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const input = raw as Record<string, unknown>;
    const prompt = typeof input.systemPrompt === "string" ? input.systemPrompt.slice(0, SYSTEM_PROMPT_LIMIT) : "";
    return {
      maxSteps: clampField("maxSteps", input.maxSteps),
      toolResultLimit: clampField("toolResultLimit", input.toolResultLimit),
      sqlRowLimit: clampField("sqlRowLimit", input.sqlRowLimit),
      // 没改过的提示词不存：省得本机存一大段和默认一样的文本，"恢复默认"也就等于清空这一项。
      systemPrompt: isCustomSystemPrompt(prompt) ? prompt : undefined,
    };
  } catch {
    return {};
  }
}

export function saveReasoningSettings(settings: ReasoningSettings) {
  try {
    window.localStorage.setItem(REASONING_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // 本机存储不可用时只影响"记住这些参数"
  }
}

export function clearReasoningSettings() {
  try {
    window.localStorage.removeItem(REASONING_SETTINGS_KEY);
  } catch {
    // 同上
  }
}

/** 把参数拼成请求体里那几项；没设的就不带，服务端按"不限制"处理。 */
export function reasoningSettingsPayload(settings: ReasoningSettings) {
  return {
    ...(settings.maxSteps ? { maxSteps: settings.maxSteps } : {}),
    ...(settings.toolResultLimit ? { toolResultLimit: settings.toolResultLimit } : {}),
    ...(settings.sqlRowLimit ? { sqlRowLimit: settings.sqlRowLimit } : {}),
    // 没改过就不带：服务端自己回退到默认提示词，改过才把这段传上去。
    ...(isCustomSystemPrompt(settings.systemPrompt) ? { systemPrompt: settings.systemPrompt!.trim() } : {}),
  };
}

/** 抽屉里文本框要显示的内容：没改过就显示默认那段（用户要"看得见默认提示词"）。 */
export function systemPromptFieldValue(settings: ReasoningSettings) {
  return isCustomSystemPrompt(settings.systemPrompt) ? settings.systemPrompt! : DEFAULT_SYSTEM_PROMPT;
}
