"use client";

import { AlertCircle, CheckCircle2, X } from "lucide-react";

/**
 * 行内提示：长在内容里的那种（登录卡片）。工作台里的全局提示走下面的 `Toast`。
 */

export function Notice({ message, error, onDismiss }: { message: string | null; error?: boolean; onDismiss?: () => void }) {
  if (!message) return null;
  return <div className={error ? "notice error" : "notice"}>{error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}{message}{onDismiss && <button className="notice-close" onClick={onDismiss}><X size={14} /></button>}</div>;
}

/**
 * 全局提示：**底部居中的浮层吐司**。用户口径（2026-10-10）：「当前账号没有这个权限。最好是弹出的，
 * 而不是在最上面」—— 压在页头会把内容往下顶，而且滚到页面下半截就看不见了。
 *
 * 成功类提示由 `notify()` 的 5 秒计时器收起；错误（`error`）等用户自己关，权限类的话要让人读完。
 * z-index 比 `.dialog-backdrop`（120）高：在弹窗里保存失败时也要看得见。
 *
 * 位置别挪回右下角：Next.js 开发模式那个圆形 dev 按钮就压在右下角，会盖住关闭按钮。
 */

export function Toast({ message, error, onDismiss }: { message: string | null; error?: boolean; onDismiss?: () => void }) {
  if (!message) return null;
  return <div className="toast-stack" role="status" aria-live="polite">
    <div className={error ? "toast error" : "toast"}>
      {error ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
      <span>{message}</span>
      {onDismiss && <button type="button" className="toast-close" title="关闭" onClick={onDismiss}><X size={14} /></button>}
    </div>
  </div>;
}


