import { z } from "zod";
import { ATTACHMENT_LIMIT, ATTACHMENT_MAX_CHARS, ATTACHMENT_TOTAL_CHARS } from "@/lib/reasoning/attachments";

/**
 * 附件的**服务端**校验：客户端传上来的那张图必须落在这几条线里。
 * 口径与上限写在 attachments.ts（纯模块，界面也要用），这里只把它翻译成 zod。
 */
export const attachmentSchema = z.object({
  name: z.string().trim().max(120),
  /** 只收图片：别的类型（PDF、CSV）以后要走"数据资源"，不该从问答这个口子进来。 */
  mediaType: z.string().trim().regex(/^image\/[a-z0-9.+-]+$/i, "只支持图片。"),
  dataUrl: z.string().min(32).max(ATTACHMENT_MAX_CHARS),
  width: z.number().int().min(0).max(30_000),
  height: z.number().int().min(0).max(30_000),
  bytes: z.number().int().min(0).max(ATTACHMENT_MAX_CHARS),
});

export const attachmentsSchema = z
  .array(attachmentSchema)
  .max(ATTACHMENT_LIMIT, `一次最多带 ${ATTACHMENT_LIMIT} 张图片。`)
  .refine(
    (items) => items.reduce((sum, item) => sum + item.dataUrl.length, 0) <= ATTACHMENT_TOTAL_CHARS,
    "图片总量太大，请少带几张、或者换小一点的图。",
  )
  .optional();