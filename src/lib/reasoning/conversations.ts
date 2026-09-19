import type { SelectQueryBuilder } from "typeorm";
import { In } from "typeorm";
import { ConversationEntity, ConversationMessageEntity, jsonValue, platformRepo, repoIn, withPlatformTransaction } from "@/lib/db";
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

function clampLimit(limit: number | undefined) {
  return Math.min(200, Math.max(1, Math.floor(limit ?? 50)));
}

/**
 * 归属条件（用 ORM 的 where 表达，不再拼 SQL 片段）：
 * - 属于提问的人；
 * - 属于当前本体；没有本体（直接选中未纳管的存储资源）时退回按落点归。
 */
function scopedConversations(
  query: SelectQueryBuilder<ConversationEntity>,
  scope: ConversationScope,
  userId: string,
) {
  query.where("c.created_by = :userId", { userId });
  if (scope.ontologyId) {
    query.andWhere("c.ontology_id = :ontologyId", { ontologyId: scope.ontologyId });
  } else {
    query.andWhere("c.ontology_id IS NULL").andWhere("c.target_id = :targetId", { targetId: scope.targetId });
  }
  return query;
}

export async function listConversations(scope: ConversationScope, userId: string, limit?: number): Promise<ConversationSummary[]> {
  const repo = await platformRepo(ConversationEntity);
  const rows = await scopedConversations(repo.createQueryBuilder("c"), scope, userId)
    .orderBy("c.updated_at", "DESC")
    .limit(clampLimit(limit))
    .getMany();
  // 轮次用一条按 id 的批量查询数出来：TypeORM 1.x 去掉了 loadRelationCountAndMap，
  // 与其手写 COUNT/GROUP BY，不如让 ORM 取行、在这里数（上限 200 条对话，代价可忽略）。
  const ids = rows.map((row) => row.id);
  const turns = new Map<string, number>();
  if (ids.length) {
    const messages = await repoIn(repo.manager, ConversationMessageEntity).find({
      where: { conversationId: In(ids) },
      select: { id: true, conversationId: true },
    });
    for (const message of messages) turns.set(message.conversationId, (turns.get(message.conversationId) ?? 0) + 1);
  }
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    turns: turns.get(row.id) ?? 0,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }));
}

export async function getConversation(scope: ConversationScope, userId: string, conversationId: string): Promise<ConversationDetail | null> {
  const repo = await platformRepo(ConversationEntity);
  const conversation = await scopedConversations(repo.createQueryBuilder("c"), scope, userId)
    .andWhere("c.id = :conversationId", { conversationId })
    .getOne();
  if (!conversation) return null;

  // 一轮问答可能同时落进来，所以排序要带上 id，保证两次读到同一个顺序。
  const messages = await repoIn(repo.manager, ConversationMessageEntity).find({
    where: { conversationId },
    order: { createdAt: "ASC", id: "ASC" },
  });

  return {
    id: conversation.id,
    title: conversation.title,
    turns: messages.length,
    createdAt: new Date(conversation.createdAt).toISOString(),
    updatedAt: new Date(conversation.updatedAt).toISOString(),
    messages: messages.map((row): ConversationMessage => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      thinking: row.thinking,
      thinkingOn: row.thinkingOn,
      run: (row.run as ReasoningRun | null) ?? null,
      error: row.error,
      createdAt: new Date(row.createdAt).toISOString(),
    })),
  };
}

export async function deleteConversation(scope: ConversationScope, userId: string, conversationId: string): Promise<boolean> {
  // 消息靠外键 ON DELETE CASCADE 一起走，不必手动清。
  const repo = await platformRepo(ConversationEntity);
  const result = await scopedConversations(repo.createQueryBuilder("c"), scope, userId)
    .andWhere("c.id = :conversationId", { conversationId })
    .delete()
    .execute();
  return (result.affected ?? 0) > 0;
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
  const repo = await platformRepo(ConversationEntity);
  const head = await scopedConversations(repo.createQueryBuilder("c"), scope, userId)
    .andWhere("c.id = :conversationId", { conversationId })
    .getOne();
  if (!head) return null;
  const rows = await repoIn(repo.manager, ConversationMessageEntity).find({
    where: { conversationId },
    order: { createdAt: "ASC", id: "ASC" },
  });
  return {
    summary: head.historySummary ?? "",
    summaryThrough: head.historySummaryThrough ?? "",
    turns: rows.map((row) => ({
      id: row.id,
      question: row.question,
      answer: row.answer,
      // 老记录没有 steps（那时还没记轨迹）：回放时就是"本轮没有调用工具"，如实呈现。
      steps: (row.run as ReasoningRun | null)?.steps ?? [],
      images: (row.run as ReasoningRun | null)?.attachments?.length ?? 0,
    })),
  };
}

/** 把摘要与"压到哪一条"一起存回去：下一轮只压新滚出窗口的那几轮。 */
export async function saveConversationSummary(conversationId: string, summary: string, throughMessageId: string): Promise<void> {
  const repo = await platformRepo(ConversationEntity);
  await repo.update({ id: conversationId }, { historySummary: summary, historySummaryThrough: throughMessageId });
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
  return withPlatformTransaction(async (manager) => {
    const conversations = repoIn(manager, ConversationEntity);
    const messages = repoIn(manager, ConversationMessageEntity);
    let conversationId = input.conversationId;
    if (conversationId) {
      const owned = await scopedConversations(conversations.createQueryBuilder("c"), input.scope, input.userId)
        .andWhere("c.id = :conversationId", { conversationId })
        .getOne();
      if (!owned) throw new Error("这段对话已经不在了，或者不属于当前本体 / 当前账号。");
    } else {
      conversationId = crypto.randomUUID();
      await conversations.insert({
        id: conversationId,
        ontologyId: input.scope.ontologyId,
        targetId: input.scope.targetId,
        title: conversationTitle(input.question),
        createdBy: input.userId,
      });
    }

    await messages.insert({
      id: crypto.randomUUID(),
      conversationId,
      question: input.question,
      answer: input.answer,
      thinking: input.thinking,
      thinkingOn: input.thinkingOn,
      run: jsonValue(input.run ?? null),
      error: input.error,
    });
    await conversations.update({ id: conversationId }, { updatedAt: new Date() });
    return conversationId;
  });
}
