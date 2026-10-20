"use client";

import { useCallback, useEffect, useRef } from "react";
import { api } from "./api-client";

/** 页面只读请求随页面或本体切换取消；提交操作和后台任务不受影响。 */
export function usePageApi(scope = "") {
  const lifecycle = useRef({ scope, active: true, controller: null as AbortController | null });
  useEffect(() => {
    const gate = { scope, active: true, controller: null as AbortController | null };
    lifecycle.current = gate;
    return () => {
      gate.active = false;
      gate.controller?.abort();
      gate.controller = null;
    };
  }, [scope]);
  return useCallback(function request<T>(url: string, init?: RequestInit): Promise<T> {
    if ((init?.method ?? "GET").toUpperCase() !== "GET") return api<T>(url, init);
    const gate = lifecycle.current;
    if (!gate.active || gate.scope !== scope) return Promise.reject(new DOMException("页面已切换", "AbortError"));
    gate.controller ??= new AbortController();
    const signal = init?.signal ? AbortSignal.any([gate.controller.signal, init.signal]) : gate.controller.signal;
    return api<T>(url, { ...init, signal });
  }, [scope]);
}
