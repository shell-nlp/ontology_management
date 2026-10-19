import { api } from "@/lib/shared/client/api-client";

export type ReasoningStatus = { configured: boolean; model: string | null };
export type ConversationSummaryApi = { id: string; title: string; updatedAt?: string; createdAt?: string; [key: string]: unknown };

export const reasoningApi = {
  status: () => api<ReasoningStatus>("/api/reasoning/status"),
  conversations: (targetId: string) => api<{ conversations: ConversationSummaryApi[] }>(`/api/reasoning/conversations?targetId=${encodeURIComponent(targetId)}`),
  conversation: <T>(targetId: string, id: string) => api<T>(`/api/reasoning/conversations/${encodeURIComponent(id)}?targetId=${encodeURIComponent(targetId)}`),
  deleteConversation: (targetId: string, id: string) => api(`/api/reasoning/conversations/${encodeURIComponent(id)}?targetId=${encodeURIComponent(targetId)}`, { method: "DELETE" }),
};
