/**
 * 复制到剪贴板。
 *
 * 先走 Clipboard API（https 与 localhost 下可用），不可用时退回隐藏 textarea + execCommand ——
 * `navigator.clipboard` 在 http + 机器 IP 访问时是 undefined，而复制是这类页面的主要动作，
 * 不该挑环境（见 AGENTS 「不许直接用只在安全上下文里存在的浏览器 API」）。
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 落到下面的兜底
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 让浏览器下载一个需要带会话 cookie 的接口返回的文件。
 *
 * 用 fetch + Blob 而不是 `location.href = url`：这样能读到 `Content-Disposition` 里的文件名，
 * 失败时也能拿到服务端给的错误文案（直接跳转的话浏览器会展示一坨 JSON）。
 */
export async function downloadResponse(url: string, fallbackName: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof data.error === "string" && data.error.trim() ? data.error : `下载失败 (${response.status})`);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : fallbackName;
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  return name;
}