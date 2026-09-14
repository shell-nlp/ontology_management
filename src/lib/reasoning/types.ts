/**
 * 推理工作区的公共类型。
 *
 * 一次推理（run）= 一串步骤（step）+ 结论（answer）+ 证据（evidence）。
 * 步骤记录模型调了哪个工具、入参是什么、拿到了什么、耗时多少；
 * 证据是从工具结果里挑出来的真实对象 / 关系 / 类型，界面上可点回对象页核对。
 */

/**
 * 工具的对外描述。**原始 JSON Schema 是唯一来源**：
 * AI SDK 用 jsonSchema() 包一层当 inputSchema，MCP 服务端直接把同一份暴露给外部客户端，
 * 不会出现"两边各维护一份 schema、改了一边忘了另一边"。
 */
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };

export type ReasoningEvidence = {
  kind: "OBJECT" | "RELATIONSHIP" | "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION";
  /** 图库里的真实标识：对象是快照 id，类型是类名，动作是定义里的 id。 */
  id: string;
  label: string;
  /** 来自哪一步（步骤序号从 1 开始），界面上可以跳回那一步。 */
  step: number;
};

export type ReasoningStep = {
  index: number;
  tool: string;
  arguments: Record<string, unknown>;
  /** 工具返回给模型的内容（已按上限截断），界面展开时展示。 */
  result: string;
  ok: boolean;
  elapsedMs: number;
  evidence: ReasoningEvidence[];
};

export type ReasoningUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ReasoningRun = {
  question: string;
  answer: string;
  /** 模型的思考过程，累加所有轮次。关闭思考或模型不支持时是空串。 */
  reasoning: string;
  steps: ReasoningStep[];
  evidence: ReasoningEvidence[];
  usage: ReasoningUsage;
  elapsedMs: number;
  model: string;
  /** 达到步数上限时置位：结论可能不完整。 */
  truncated: boolean;
};

/** 单个工具的执行结果：给模型看的载荷 + 抽出来的证据。 */
export type ToolOutcome = {
  payload: unknown;
  evidence: Omit<ReasoningEvidence, "step">[];
};
