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
export type ToolSpec = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /**
   * 暂时不使用的工具：留在这份目录里，MCP 调试页会把它灰着显示（说明它存在），
   * 但**不暴露**给模型、也不给外部 MCP 客户端 —— 它们只能看到没被标记的那些。
   * 要恢复就把这个标记去掉，实现本来就在 `runReasoningTool` 里。
   */
  disabled?: boolean;
};

export type ReasoningEvidence = {
  kind: "OBJECT" | "RELATIONSHIP" | "OBJECT_TYPE" | "RELATION_TYPE" | "ACTION" | "GROUP" | "INTERFACE";
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
  /**
   * 行上的「这一步拿到了什么」（`6 行` / `表结构 · 原始 DDL` / `命中 2 个概念`），
   * 由 tool-summary.ts 按工具如实生成。**不要拿 evidence 的条数替代它**：查数据与看结构的
   * 工具按设计不产出证据，用证据数会显示成"无命中"，看着像工具什么都没查到。
   * 旧对话历史里存的运行记录没有这个字段，界面要能兜底。
   */
  summary?: string;
};

/**
 * 提问时一起带上的图片。
 *
 * 存的就是 data URL（`data:image/png;base64,...`）：它既是发给模型的多模态输入，
 * 也是历史回看时显示的那张图 —— 不再单独存一份二进制，免得"库里一份、界面上又一份"。
 * 体积由 attachments.ts 的上限兜住（浏览器侧先缩图再发）。
 */
export type ReasoningAttachment = {
  name: string;
  mediaType: string;
  dataUrl: string;
  width: number;
  height: number;
  /** 编码后的字节数（估算），界面上标出来让人知道模型收到的这张图有多大。 */
  bytes: number;
};

/**
 * 这一轮带了哪些历史上下文。
 *
 * 界面照它显示「上下文 N 轮 · 已压缩 M 轮」，审计照它记一笔；
 * 压缩失败这类情况随 `warning` 出来，而不是把整轮问答抛掉。
 */
export type ReasoningContext = {
  /** 原样回放的历史轮数。 */
  verbatimTurns: number;
  /** 累计压进摘要的轮数（含以前压的）。 */
  compressedTurns: number;
  /** 摘要的字符数。 */
  summaryChars: number;
  /** 原样那几轮占的字符数。 */
  chars: number;
  warning?: string;
};

export type ReasoningUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type ReasoningRun = {
  question: string;
  /** 这一轮连图一起问的图片。旧记录没有这个字段，界面要能兜底。 */
  attachments?: ReasoningAttachment[];
  /** 这一轮回放了哪些历史上下文。旧记录没有这个字段，界面要能兜底。 */
  context?: ReasoningContext;
  answer: string;
  /** 模型的思考过程，累加所有轮次。关闭思考或模型不支持时是空串。 */
  reasoning: string;
  steps: ReasoningStep[];
  evidence: ReasoningEvidence[];
  usage: ReasoningUsage;
  elapsedMs: number;
  model: string;
  /**
   * 实际用掉的推理步数（一次「模型调用」算一步，一步里模型可以并发调多个工具），
   * 以及这一轮允许的上限。`steps.length` 是工具调用次数，两个数字不是一回事。
   */
  stepCount: number;
  maxSteps: number;
  /** 步数用满时置位：模型是被拦停的，结论可能不完整。 */
  truncated: boolean;
  /**
   * 用户中途点了「停止」（或关掉页面）：这一轮是**被叫停的**，不是失败的。
   * 已经跑出来的思考、步骤与半截结论照常收尾成一份运行记录，界面据此标「已停止」。
   * 旧记录没有这个字段，界面要能兜底。
   */
  stopped?: boolean;
};

/** 单个工具的执行结果：给模型看的载荷 + 抽出来的证据。 */
export type ToolOutcome = {
  payload: unknown;
  evidence: Omit<ReasoningEvidence, "step">[];
};
