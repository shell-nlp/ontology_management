"use client";

import { useMemo } from "react";
import { History, Loader2, Trash2 } from "lucide-react";
import { reasoningApi } from "@/lib/shared/client/reasoning-api";
import { conversationTimeLabel, groupConversationsByDay, type ConversationSummary } from "@/lib/reasoning/conversation-view";

/** 历史侧栏开没开记在本地：习惯开着的人，下次进来还是开着的。 */
export const HISTORY_OPEN_KEY = "ontology.qa.history";

export function loadHistoryOpen() {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem(HISTORY_OPEN_KEY) === "1"; } catch { return false; }
}

/** 读一个本体的历史列表。列表接口只回摘要，点开某一条才会取完整内容。 */
export function fetchConversations(targetId: string) {
  return reasoningApi.conversations(targetId).then((data) => data.conversations as ConversationSummary[]);
}

/**
 * 对话历史侧栏。
 *
 * 它和主区的关系是"记录"与"当前这一页"：点一条就把那次的完整过程（求证轨迹 / 结论 / 依据）
 * 铺回主区，和当时看到的一模一样。删除走就地二次确认 —— 历史是随手可删的东西，
 * 但也不该点一下就没了。
 */
/**
 * 侧栏的一行。**运行中的那一轮也在里面** —— 还没落库的新对话没有 ConversationSummary，
 * 就用它的运行 id 占一个位置，用户才看得到"后台还在跑"。
 */
export type RailItem = {
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
  running: boolean;
  /** 还没落库的那一轮：点不进去，也没有"删除"（历史里还没有它）。 */
  pending?: boolean;
};

export function HistoryRail({ items, loading, activeId, loadingId, confirmingId, onOpen, onAskDelete, onCancelDelete, onConfirmDelete }: {
  items: RailItem[];
  /** 列表正在读：侧栏先给一句"正在读取"，别让空列表看着像"确实没有记录"。 */
  loading: boolean;
  /** 当前画面正对着哪段对话；新开的一轮在服务端定下 id 之前是 null。 */
  activeId: string | null;
  loadingId: string | null;
  confirmingId: string | null;
  onOpen: (id: string) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (id: string) => void;
}) {
  const groups = useMemo(() => groupConversationsByDay(items), [items]);
  return (
    <aside className="qa-history" aria-label="对话历史">
      <header className="qa-history-head">
        <History size={14} />
        <span>对话历史</span>
        {items.length > 0 && <em>{items.length}</em>}
      </header>

      {!items.length ? (
        <p className="qa-history-empty">
          {loading
            ? "正在读取对话历史…"
            : "还没有历史对话。跑完一轮问答它就会留在这里 —— 只有跑出结论的才记，失败的不会占位置。"}
        </p>
      ) : (
        <div className="qa-history-body">
          {groups.map((group) => (
            <section className="qa-history-group" key={group.day}>
              <p className="qa-history-day">{group.day}</p>
              <ul>
                {group.items.map((item) => (
                  <li key={item.id} className={`qa-history-item${item.id === activeId ? " active" : ""}`}>
                    {confirmingId === item.id ? (
                      <div className="qa-history-confirm">
                        <span>删除这段对话？</span>
                        <div>
                          <button type="button" className="danger" onClick={() => onConfirmDelete(item.id)}>删除</button>
                          <button type="button" onClick={onCancelDelete}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* 运行中的那一行也要能点开（用户口径 2026-10-14）：点它就切到这一轮看进度。 */}
                        <button
                          type="button"
                          className="qa-history-open"
                          onClick={() => onOpen(item.id)}
                          title={item.pending ? `${item.title || "未命名对话"}（后台运行中，点开看这一轮）` : item.title}
                        >
                          <b>{item.title || "未命名对话"}</b>
                          <span className="qa-history-meta">
                            {loadingId === item.id && <Loader2 size={11} className="qa-spin" />}
                            {/* 后台还在跑的那些：列表上直接写"运行中"，不用点进去才知道。 */}
                            {item.running && <Loader2 size={11} className="qa-spin" />}
                            {item.turns > 0 && `${item.turns} 轮 · `}
                            {item.running ? "运行中" : conversationTimeLabel(item.updatedAt)}
                          </span>
                        </button>
                        {!item.pending && (
                          <button
                            type="button"
                            className="qa-history-remove"
                            onClick={() => onAskDelete(item.id)}
                            title="删除这段对话"
                            aria-label={`删除对话：${item.title || "未命名对话"}`}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </aside>
  );
}

