import { platformQuery, withPlatformTransaction } from "@/lib/platform-db";
import type { HistoryTurn } from "@/lib/reasoning/history";
import { conversationTitle } from "@/lib/reasoning/conversation-view";
import type { ConversationDetail, ConversationMessage, ConversationSummary } from "@/lib/reasoning/conversation-view";
import type { ReasoningRun } from "@/lib/reasoning/types";

/**
 * 智能问答的对话历史：谁能看到哪些记录、一轮问答怎么落库。
 *
 * 两个归属条件缺一不可：
 * - **属于提问的人**：换个人登进来看到的是他自己的记录；
 * - **属于当前本体**：正常按 ontology_id 归，只有直接选中一条未纳管的存储资源
 *   （没有本体）时才退化成按 target_id 归。
 *
 * 落库时机在「一轮问答真正跑完」之后：失败的一轮不留记录，历史里只出现有结论的问答，
 * 不会出现"点进去只有半句话"的记录。
 *
 * **被用户叫停的一轮是例外里的例外**（2026-09-17）：它不算失败 —— 跑出过步骤 / 思考 / 半截结论
 * 就照常记下来（`run.stopped` 为 true，界面回看时标「已停止」），什么都没跑出来才不记。
 * 判定在 `/api/reasoning/stream` 里，这里只负责写。
 */

export type ConversationScope = {
  /** 当前本体；直接选中未纳管的存储资源时为 null。 */
  ontologyId: string | null;
  targetId: string;
};

export type { ConversationDetail, ConversationMessage, ConversationSummary } from "@/lib/reasoning/conversation-view";

/**
 * 归属条件。`IS NOT DISTINCT FROM` 让"没有本体"也能用同一个谓词表达，
 * 不必在 SQL 里写两套分支；$2 为空时再用 $3 按落点兜底。
 */
const SCOPE = `c.created_by = $1
        AND c.ontology_id IS NOT DISTINCT FROM $2
        AND ($2 IS NOT NULL OR c.target_id = $3)`;

function clampLimit(limit: number | undefined) {
  return Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
}

export async function listConversations(scope: ConversationScope, userId: string, limit?: number): Promise<ConversationSummary[]> {
  const result = await platformQuery<{ id: string; title: string; turns: string | number; created_at: Date | string; updated_at: Date | string }>(
    `SELECT c.id, c.title, COUNT(m.id) AS turns, c.created_at, c.updated_at
       FROM ontology_platform.reasoning_conversations c
       LEFT JOIN ontology_platform.reasoning_messages m ON m.conversation_id = c.id
      WHERE ${SCOPE}
      GROUP BY c.id
      ORDER BY c.updated_at DESC
      LIMIT $4`,
    [userId, scope.ontologyId, scope.targetId, clampLimit(limit)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    turns: Number(row.turns),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function getConversation(scope: ConversationScope, userId: string, conversationId: string): Promise<ConversationDetail | null> {
  const head = await platformQuery<{ id: string; title: string; created_at: Date | string; updated_at: Date | string }>(
    `SELECT c.id, c.title, c.created_at, c.updated_at
       FROM ontology_platform.reasoning_conversations c
      WHERE c.id = $4 AND ${SCOPE}`,
    [userId, scope.ontologyId, scope.targetId, conversationId],
  );
  const conversation = head.rows[0];
  if (!conversation) return null;

  // 一轮问答可能同时落进来，所以排序要带上 id，保证两次读到同一个顺序。
  const rows = await platformQuery<{
    id: string;
    question: string;
    answer: string;
    thinking: string;
    thinking_on: boolean;
    run: ReasoningRun | null;
    error: string | null;
    created_at: Date | string;
  }>(
    `SELECT id, question, answer, thinking, thinking_on, run, error, created_at
       FROM ontology_platform.reasoning_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );

  return {
    id: conversation.id,
    title: conversation.title,
    turns: rows.rowCount ?? rows.rows.length,
    createdAt: new Date(conversation.created_at).toISOString(),
    updatedAt: new Date(conversation.updated_at).toISOString(),
    messages: rows.rows.map((row): ConversationMessage => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      thinking: row.thinking,
      thinkingOn: row.thinking_on,
      run: row.run ?? null,
      error: row.error,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function deleteConversation(scope: ConversationScope, userId: string, conversationId: string): Promise<boolean> {
  // 消息靠外键 ON DELETE CASCADE 一起走，不必手动清。
  const result = await platformQuery(
    `DELETE FROM ontology_platform.reasoning_conversations c WHERE c.id = $4 AND ${SCOPE}`,
    [userId, scope.ontologyId, scope.targetId, conversationId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * 多轮上下文要的那一份：**已经压好的摘要** + 摘要覆盖到哪一条 + 这段对话里的全部轮次。
 *
 * 和 `getConversation` 分开是有意的：那个是给界面看的（标题、时间、整份 run），
 * 这个是给推理用的（轨迹能少则少，摘要进度要单独读）。
 */
export type ConversationContext = {
  /** 已经压好的摘要；没有就是空串。 */
  summary: string;
  /** 摘要覆盖到最后哪一条消息（id）；空串表示还没压过。 */
  summaryThrough: string;
  /** 这段对话里已有的轮次，按时间正序。 */
  turns: HistoryTurn[];
};

export async function loadConversationContext(scope: ConversationScope, userId: string, conversationId: string): Promise<ConversationContext | null> {
  // 归属条件必须先过一遍：客户端手里的 id 是会被改的，不能拿它去读别人的对话。
  const head = await platformQuery<{ history_summary: string | null; history_summary_through: string | null }>(
    `SELECT c.history_summary, c.history_summary_through
       FROM ontology_platform.reasoning_conversations c
      WHERE c.id = $4 AND ${SCOPE}`,
    [userId, scope.ontologyId, scope.targetId, conversationId],
  );
  if (!head.rows.length) return null;
  const rows = await platformQuery<{ id: string; question: string; answer: string; run: ReasoningRun | null }>(
    `SELECT id, question, answer, run
       FROM ontology_platform.reasoning_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );
  return {
    summary: head.rows[0].history_summary ?? "",
    summaryThrough: head.rows[0].history_summary_through ?? "",
    turns: rows.rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      // 老记录没有 steps（那时还没记轨迹）：回放时就是"本轮没有调用工具"，如实呈现。
      steps: row.run?.steps ?? [],
      images: row.run?.attachments?.length ?? 0,
    })),
  };
}

/** 把摘要与"压到哪一条"一起存回去：下一轮只压新滚出窗口的那几轮。 */
export async function saveConversationSummary(conversationId: string, summary: string, throughMessageId: string): Promise<void> {
  await platformQuery(
    `UPDATE ontology_platform.reasoning_conversations
        SET history_summary = $2, history_summary_through = $3
      WHERE id = $1`,
    [conversationId, summary, throughMessageId],
  );
}

export type SaveTurnInput = {
  scope: ConversationScope;
  userId: string;
  /** 没有就给这段对话开一个新的；有就追加到它后面。 */
  conversationId: string | null;
  question: string;
  answer: string;
  thinking: string;
  thinkingOn: boolean;
  run: ReasoningRun | null;
  error: string | null;
};

/**
 * 把一轮问答写进历史，返回它属于哪段对话（新建的话就是新 id）。
 *
 * 传进来的 conversationId 必须属于当前人 + 当前本体：客户端手里的 id 是会被改的，
 * 直接拿它当条件写会让人把记录追加到别人的对话里。
 */
export async function saveTurn(input: SaveTurnInput): Promise<string> {
  return withPlatformTransaction(async (client) => {
    let conversationId = input.conversationId;
    if (conversationId) {
      const owned = await client.query<{ id: string }>(
        `SELECT c.id FROM ontology_platform.reasoning_conversations c WHERE c.id = $4 AND ${SCOPE}`,
        [input.userId, input.scope.ontologyId, input.scope.targetId, conversationId],
      );
      if (!owned.rows.length) throw new Error("这段对话已经不在了，或者不属于当前本体 / 当前账号。");
    } else {
      conversationId = crypto.randomUUID();
      await client.query(
        `INSERT INTO ontology_platform.reasoning_conversations (id, ontology_id, target_id, title, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [conversationId, input.scope.ontologyId, input.scope.targetId, conversationTitle(input.question), input.userId],
      );
    }

    await client.query(
      `INSERT INTO ontology_platform.reasoning_messages (id, conversation_id, question, answer, thinking, thinking_on, run, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        crypto.randomUUID(),
        conversationId,
        input.question,
        input.answer,
        input.thinking,
        input.thinkingOn,
        input.run ? JSON.stringify(input.run) : null,
        input.error,
      ],
    );
    await client.query("UPDATE ontology_platform.reasoning_conversations SET updated_at = NOW() WHERE id = $1", [conversationId]);
    return conversationId;
  });
}
