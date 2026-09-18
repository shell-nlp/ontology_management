import { describe, expect, it } from "vitest";
import { attachmentsSchema, attachmentSchema } from "@/lib/reasoning/attachment-schema";
import {
  ATTACHMENT_LIMIT,
  ATTACHMENT_MAX_CHARS,
  IMAGE_ONLY_QUESTION,
  base64Of,
  effectiveQuestion,
  mediaTypeOf,
  userMessageContent,
} from "@/lib/reasoning/attachments";
import type { ReasoningAttachment } from "@/lib/reasoning/types";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function attachment(patch: Partial<ReasoningAttachment> = {}): ReasoningAttachment {
  return { name: "截图.png", mediaType: "image/png", dataUrl: png, width: 1, height: 1, bytes: 68, ...patch };
}

describe("问答附件（图片）", () => {
  it("只收图片：别的媒体类型一律挡在门外", () => {
    expect(attachmentSchema.safeParse(attachment()).success).toBe(true);
    expect(attachmentsSchema?.safeParse([attachment()]).success).toBe(true);
    const pdf = attachmentsSchema?.safeParse([attachment({ mediaType: "application/pdf", dataUrl: "data:application/pdf;base64,AAAA" })]);
    expect(pdf?.success).toBe(false);
  });

  it("张数与体积都有上限", () => {
    const tooMany = Array.from({ length: ATTACHMENT_LIMIT + 1 }, () => attachment());
    expect(attachmentsSchema?.safeParse(tooMany).success).toBe(false);
    const tooBig = attachmentsSchema?.safeParse([attachment({ dataUrl: `data:image/png;base64,${"A".repeat(ATTACHMENT_MAX_CHARS)}` })]);
    expect(tooBig?.success).toBe(false);
    // 不传就是不带图，照常通过。
    expect(attachmentsSchema?.safeParse(undefined).success).toBe(true);
  });

  it("给模型的是裸 base64 + 媒体类型，不带 data: 前缀", () => {
    expect(base64Of(png)).toBe(png.slice(png.indexOf(",") + 1));
    expect(base64Of("no-prefix")).toBe("no-prefix");
    // 压缩时可能换了格式，所以媒体类型以 data URL 自己写的为准。
    expect(mediaTypeOf(png, "image/jpeg")).toBe("image/png");
    expect(mediaTypeOf("garbage", "image/jpeg")).toBe("image/jpeg");
    const [text, ...files] = userMessageContent("这张图里有哪些客户？", [attachment()]);
    expect(text).toEqual({ type: "text", text: "这张图里有哪些客户？" });
    expect(files).toEqual([{ type: "file", mediaType: "image/png", data: { type: "data", data: base64Of(png) } }]);
  });

  it("只带图不带字时补一句默认问题，三处用的是同一个结果", () => {
    expect(effectiveQuestion("   ", [attachment()])).toBe(IMAGE_ONLY_QUESTION);
    expect(userMessageContent("", [attachment()])[0]).toEqual({ type: "text", text: IMAGE_ONLY_QUESTION });
    expect(effectiveQuestion("有文字", [attachment()])).toBe("有文字");
    // 既没有字也没有图：调用方据此回 400，不该拿一句空话去问模型。
    expect(effectiveQuestion("", [])).toBe("");
  });
});