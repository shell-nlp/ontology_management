import type { ReasoningAttachment } from "@/lib/reasoning/types";
import { mediaTypeOf } from "@/lib/reasoning/attachments";

export const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_EDGE = 1600;
/** 单张 data URL 的字符上限，比服务端那道（3.2M）留一点余量。 */
const MAX_IMAGE_CHARS = 2_800_000;

/** 读成可画的图：优先 createImageBitmap（快、不占 DOM），老浏览器退回 <img> + object URL。 */
async function loadDrawable(file: File) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(file);
    return { source: bitmap as CanvasImageSource, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(`「${file.name}」读不出来，换一张图试试。`));
      element.src = url;
    });
    return { source: image as CanvasImageSource, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (reason) {
    URL.revokeObjectURL(url);
    throw reason;
  }
}

/**
 * 图片进 state 之前先在浏览器里过一遍画布：长边超过 MAX_IMAGE_EDGE 就等比缩小，
 * 编码后仍然过大就换 JPEG 再压两次。
 *
 * 非缩不可的原因：模型看 1600px 已经够清楚，而原图直接 base64 进请求体与对话历史是几 MB 起，
 * 一次粘贴三张截图就能把一轮问答拖成几十秒。
 * 截图类图片保持原格式（PNG 的文字比 JPEG 清楚），照片才用 JPEG。
 */
export async function prepareImage(file: File): Promise<ReasoningAttachment> {
  if (!file.type.startsWith("image/")) throw new Error(`「${file.name}」不是图片。`);
  const drawable = await loadDrawable(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(drawable.width, drawable.height, 1));
    const width = Math.max(1, Math.round(drawable.width * scale));
    const height = Math.max(1, Math.round(drawable.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("这个浏览器画不了图（拿不到 canvas 上下文），换一个浏览器再试。");
    context.drawImage(drawable.source, 0, 0, width, height);
    const keep = ["image/png", "image/jpeg", "image/webp"].includes(file.type) ? file.type : "image/png";
    let dataUrl = canvas.toDataURL(keep, keep === "image/png" ? undefined : 0.86);
    if (dataUrl.length > MAX_IMAGE_CHARS) dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    if (dataUrl.length > MAX_IMAGE_CHARS) dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    if (dataUrl.length > MAX_IMAGE_CHARS) throw new Error(`「${file.name}」压缩完还是太大，换一张小一点的图。`);
    return {
      name: file.name || "粘贴的图片",
      // 压缩时可能换了格式，所以媒体类型看编码结果，不看原文件类型。
      mediaType: mediaTypeOf(dataUrl, keep),
      dataUrl,
      width,
      height,
      bytes: Math.round(((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4),
    };
  } finally {
    drawable.release();
  }
}

/** 字节数给人看的样子。 */
export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

