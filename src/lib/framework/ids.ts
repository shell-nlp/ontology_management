/**
 * 生成一个 UUID v4 字符串。**客户端要生成 id 就用它，不要直接写 `crypto.randomUUID()`。**
 *
 * 原因：`crypto.randomUUID` 属于**安全上下文**才有的 API —— https 或 localhost 之外（例如用机器 IP
 * 走 http 打开平台）`crypto` 对象在、但 `randomUUID` 是 `undefined`，一调用就抛
 * `crypto.randomUUID is not a function`，被 Next 的错误边界接住，整页变成
 * "This page couldn't load"（2026-09-14 用户报的：localhost 正常、IP 访问一点本体草稿就崩）。
 *
 * `crypto.getRandomValues` 在不安全上下文里也是可用的，所以优先用它自己拼一个 v4；
 * 连它都没有才退回时间戳 + 随机数 —— 这些 id 只用于前端草稿里的临时标识，不与服务端身份强绑定。
 */
export function newId(): string {
  const cryptoApi = typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // 版本 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
