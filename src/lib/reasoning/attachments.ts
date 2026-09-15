import type { ReasoningAttachment } from "@/lib/reasoning/types";

/**
 * 智能问答的多模态附件（图片）：上限、口径与"给模型的那份内容"。
 *
 * **这个模块必须是纯的**（不 import zod、不碰数据库）：界面要用 IMAGE_ONLY_QUESTION 与 mediaTypeOf，
 * 而 zod 的 schema 只有两个接口在用 —— 那是 attachment-schema.ts 的事，别混在一起，
 * 否则浏览器包里会平白多进一个 zod。
 *
 * 边界两道：**浏览器侧先缩图**（qa-studio.tsx 的 prepareImage：长边压到 1600、编码后还大就再压），
 * **服务端再兜一层**（attachment-schema.ts 用下面这几个数）。两道都要有 —— 只在前端挡，
 * 换个客户端就绕过去了；只在服务端挡，用户上传一张 20MB 的截图会先在网络上走一遍。
 *
 * 只带图、不带文字是允许的：那种情况用 IMAGE_ONLY_QUESTION 顶上。
 * 模型的入参里必须有一句人话，否则它不知道该拿这张图干什么。
 */

/** 一轮最多几张图。再多就该拆成几轮问，而不是塞成一份多模态长文。 */
export const ATTACHMENT_LIMIT = 4;
/** 单张 data URL 的字符上限（约 2.4MB 二进制）。 */
export const ATTACHMENT_MAX_CHARS = 3_200_000;
/** 一轮里所有图片合计的字符上限。 */
export const ATTACHMENT_TOTAL_CHARS = 8_000_000;
/** 带图不带字时补的默认问题。 */
export const IMAGE_ONLY_QUESTION = "请看这几张图片，并结合当前本体回答。";

/** data URL → 纯 base64。AI SDK 的 file part 要的是"裸 base64 + mediaType"，不带 data: 前缀。 */
export function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * 图片自己声明的媒体类型。**以 data URL 为准**，客户端那个字段只是兜底 ——
 * 因为浏览器侧压缩时可能把 PNG 换成了 JPEG，字段和实际内容会不一致。
 */
export function mediaTypeOf(dataUrl: string, fallback: string): string {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? fallback;
}

/**
 * 给模型的一条多模态消息：一句文字 + 每张图一个 file part。
 *
 * 形状与 AI SDK 的 `UserContent` 结构一致（这里不 import SDK 类型：这一层要能被纯函数单测）。
 */
export type UserMessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; data: { type: "data"; data: string } };

export function userMessageContent(question: string, attachments: readonly ReasoningAttachment[]): UserMessagePart[] {
  return [
    { type: "text", text: question.trim() || IMAGE_ONLY_QUESTION },
    ...attachments.map((item) => ({
      type: "file" as const,
      mediaType: mediaTypeOf(item.dataUrl, item.mediaType),
      data: { type: "data" as const, data: base64Of(item.dataUrl) },
    })),
  ];
}

/**
 * 这一轮真正的问题文本：带图不带字时补上默认那句。
 * **审计、对话历史、模型入参三处必须用同一个结果**，否则历史里会出现一条空标题的记录。
 */
export function effectiveQuestion(question: string, attachments: readonly ReasoningAttachment[] = []): string {
  const text = question.trim();
  if (text) return text;
  return attachments.length ? IMAGE_ONLY_QUESTION : "";
}