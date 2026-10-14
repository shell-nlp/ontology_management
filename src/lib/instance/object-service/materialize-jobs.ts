import { materializeObjectType, materializeRelationshipType, resolveObjectContext } from "@/lib/instance/object-service";
import { DEFAULT_MATERIALIZE_PAGE_SIZE } from "@/lib/instance/materialize-limits";
import { MaterializationJobEntity, jsonValue, platformRepo } from "@/lib/platform/db";
import type { MaterializeCursor } from "@/lib/instance/object-service/types";

/**
 * 游标值落库前的编码：`Date` 存不得 JSON 原样（会被拍成字符串，续跑时绑回去类型就变了），
 * 所以包成 `{ __date: ISO }`；解码时还原成 Date。其余标量原样存。
 * 这是**纯函数**，有单测 —— 它错了的表现是"续跑时翻页翻错"，很难现场看出来。
 */
function encodeCursorValue(value: unknown): unknown {
  return value instanceof Date ? { __date: value.toISOString() } : value;
}

function decodeCursorValue(value: unknown): unknown {
  if (value && typeof value === "object" && "__date" in (value as Record<string, unknown>)) {
    const date = new Date(String((value as Record<string, unknown>).__date ?? ""));
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}

/** 游标 → 可落库的形状（空游标一律 null，别存一个没用的空壳）。 */
export function encodeCursor(cursor: MaterializeCursor | null): { columns: string[]; values: unknown[] } | null {
  if (!cursor || !cursor.columns.length || cursor.columns.length !== cursor.values.length) return null;
  return { columns: [...cursor.columns], values: cursor.values.map(encodeCursorValue) };
}

/** 落库的形状 → 游标；形状不对一律当"没有游标"（宁可退回 OFFSET，也不拿半截游标去翻页）。 */
export function decodeCursor(value: unknown): MaterializeCursor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { columns?: unknown; values?: unknown };
  if (!Array.isArray(record.columns) || !Array.isArray(record.values)) return null;
  const columns = record.columns.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (!columns.length || columns.length !== record.values.length) return null;
  return { columns, values: record.values.map(decodeCursorValue) };
}

/**
 * 整份物化的**后台任务**（2026-10-12 用户要求：默认不限制 + 放后台跑 + 能看进度）。
 *
 * 三个刻意的设计：
 * 1. **一个任务 = 一个类型**（对象类型或关系类型）：批量物化就是排一串任务；进度按类型报，取消也按类型取消，
 *    不做"一个大任务里塞 42 个类型"那种没法局部重试的形态。
 * 2. **全局串行**（并发 1）：并行物化会同时压业务库，进度与失败归因也会乱。
 * 3. **状态在内存**（挂 `globalThis`，与智能问答的 run-registry 同一条口径）：接口进程重启会丢任务，
 *    但物化本身是幂等的（重跑一遍即可），所以不值得为它先落一张任务表。要跨重启续跑就得落库 —— Backlog 未排期。
 */
export type MaterializeJobStatus = "QUEUED" | "RUNNING" | "DONE" | "CANCELLED" | "FAILED" | "INTERRUPTED";

/** 物化的东西是**对象类型**还是**关系类型**（边）—— 两者都是"一个类型一批"。 */
export type MaterializeJobKind = "OBJECT_TYPE" | "RELATIONSHIP_TYPE";

export type MaterializeJob = {
  id: string;
  targetId: string;
  kind: MaterializeJobKind;
  entityType: string;
  status: MaterializeJobStatus;
  /** 已读行数（进行中的进度）。 */
  scanned: number;
  /** 已写索引条数。 */
  rows: number;
  pages: number;
  /** 源报告的总数（有的源不给）；只知道上限时就写 maxRows。 */
  total: number | null;
  truncated: boolean;
  message: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** 已请求取消、但当前这一页还没读完（取消只在页边界生效，界面显示「取消中…」）。 */
  cancelRequested: boolean;
};

type JobState = MaterializeJob & {
  versionId: string | null;
  pageSize: number;
  maxRows: number | null;
  /** 断点：这一趟从第几条开始读（0 = 从头）。 */
  startOffset: number;
  /** 这一趟开始时接的游标（续跑才有）；与 startOffset 一起决定从哪儿接着读。 */
  startCursor: MaterializeCursor | null;
  /** 最近一次"可以接着续"的位置（每读完一页更新），落库供中断后续跑用。 */
  cursor: MaterializeCursor | null;
};

type Registry = { jobs: Map<string, JobState>; queue: string[]; running: boolean };

function registry(): Registry {
  const holder = globalThis as typeof globalThis & { __ontologyMaterializeJobs?: Registry };
  holder.__ontologyMaterializeJobs ??= { jobs: new Map(), queue: [], running: false };
  return holder.__ontologyMaterializeJobs;
}

const snapshot = (job: JobState): MaterializeJob => ({
  id: job.id,
  targetId: job.targetId,
  kind: job.kind,
  entityType: job.entityType,
  status: job.status,
  scanned: job.scanned,
  rows: job.rows,
  pages: job.pages,
  total: job.total,
  truncated: job.truncated,
  message: job.message,
  queuedAt: job.queuedAt,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  cancelRequested: job.cancelRequested,
});

/** 写一行任务状态（入队 / 开始 / 每页 / 结束都调它）。失败不影响主流程 —— 物化本身照跑。 */
async function persist(job: JobState): Promise<void> {
  try {
    const repo = await platformRepo(MaterializationJobEntity);
    await repo.upsert(
      {
        id: job.id,
        targetId: job.targetId,
        kind: job.kind,
        entityType: job.entityType,
        status: job.status,
        scanned: String(Math.trunc(job.scanned)),
        rows: String(Math.trunc(job.rows)),
        pages: job.pages,
        truncated: job.truncated,
        message: job.message,
        // 游标按"能落库的形状"存（Date 要编码，见 encodeCursor）。
        cursor: job.cursor ? jsonValue(encodeCursor(job.cursor)) : null,
        queuedAt: new Date(job.queuedAt),
        startedAt: job.startedAt ? new Date(job.startedAt) : null,
        finishedAt: job.finishedAt ? new Date(job.finishedAt) : null,
        createdBy: null,
      },
      ["id"],
    );
  } catch {
    // 落库失败不该让物化失败：任务照跑，只是这次记录没留下。
  }
}

/**
 * 进程启动后第一次读历史时，把上一轮进程遗留的 QUEUED / RUNNING 标成 INTERRUPTED。
 * 物化是幂等的（重跑一遍即可），所以这里只如实标注，不尝试续跑。
 */
async function reconcileInterruptedOnce(): Promise<void> {
  const holder = globalThis as typeof globalThis & { __ontologyMaterializeReconciled?: boolean };
  if (holder.__ontologyMaterializeReconciled) return;
  holder.__ontologyMaterializeReconciled = true;
  try {
    const repo = await platformRepo(MaterializationJobEntity);
    /*
     * **只标"上一轮进程遗留"的行**：本进程内存里正在排队/运行的 id 要排除掉，
     * 否则第一次读历史会把当前正在跑的任务也标成 INTERRUPTED（真踩过）。
     */
    const liveIds = [...registry().jobs.values()]
      .filter((job) => job.status === "QUEUED" || job.status === "RUNNING")
      .map((job) => job.id);
    const query = repo
      .createQueryBuilder()
      .update()
      .set({ status: "INTERRUPTED", message: "进程重启，任务被中断（物化幂等，可以重新排队）。", finishedAt: new Date() })
      .where("status IN (:...statuses)", { statuses: ["QUEUED", "RUNNING"] });
    if (liveIds.length) query.andWhere("id NOT IN (:...liveIds)", { liveIds });
    await query.execute();
  } catch {
    holder.__ontologyMaterializeReconciled = false;
  }
}

/** 任务列表 = 库里的历史 ∪ 内存里正在跑的那几个（内存里的更新，同 id 覆盖库里的）。 */
export async function listMaterializeJobs(targetId?: string | null): Promise<MaterializeJob[]> {
  await reconcileInterruptedOnce();
  const id = (targetId ?? "").trim();
  let stored: MaterializeJob[] = [];
  try {
    const repo = await platformRepo(MaterializationJobEntity);
    const rows = await repo.find({
      where: id ? { targetId: id } : {},
      order: { queuedAt: "DESC" },
      take: 50,
    });
    stored = rows.map((row) => ({
      id: row.id,
      targetId: row.targetId,
      kind: (row.kind as MaterializeJobKind) ?? "OBJECT_TYPE",
      entityType: row.entityType,
      status: row.status as MaterializeJobStatus,
      scanned: Number(row.scanned ?? 0),
      rows: Number(row.rows ?? 0),
      pages: row.pages ?? 0,
      truncated: row.truncated ?? false,
      message: row.message,
      queuedAt: new Date(row.queuedAt).toISOString(),
      startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : null,
      finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      // 历史行不记源侧总数（表里没这列）：显示成"—"即可，进度看 scanned / rows。
      total: null,
      // 库里没有"取消中"这个态：历史行一律 false，正在跑的由内存快照覆盖。
      cancelRequested: false,
    }));
  } catch {
    stored = [];
  }
  const live = [...registry().jobs.values()].filter((job) => !id || job.targetId === id).map(snapshot);
  const byId = new Map(stored.map((job) => [job.id, job]));
  for (const job of live) byId.set(job.id, job);
  const ordered = [...byId.values()].sort((left, right) => right.queuedAt.localeCompare(left.queuedAt));
  /*
   * **一个类型只留最近一条**（用户口径 2026-10-12）。
   *
   * 同一个类型重跑几次，库里就会留好几行历史（还有进程重启遗留下来的 INTERRUPTED），列表里重复显示
   * 既看不出"这个类型现在怎么样了"，也没法对着某一条操作。最近那条就是它的现状（后面盖过前面）。
   * 要把某个类型的物化从头再来，对着下面那张类型表点「整份物化」就行 —— 不需要历史行。
   * 键用 `kind|entityType`：对象类型和关系类型可以重名，两者互不覆盖。
   */
  const latest = new Map<string, MaterializeJob>();
  for (const job of ordered) {
    const key = `${job.kind}|${job.entityType}`;
    if (!latest.has(key)) latest.set(key, job);
  }
  return [...latest.values()].slice(0, 50);
}

export function cancelMaterializeJob(jobId: string): MaterializeJob | null {
  const state = registry();
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELLED" || job.status === "INTERRUPTED") return snapshot(job);
  job.cancelRequested = true;
  if (job.status === "QUEUED") {
    job.status = "CANCELLED";
    job.finishedAt = new Date().toISOString();
    job.message = "排队时被取消。";
    state.queue = state.queue.filter((id) => id !== jobId);
    void persist(job);
  } else if (job.status === "RUNNING") {
    /*
     * **取消只在页边界生效**：正在跑的源查询掐不断（Oracle 一页可能几十秒），所以这里只把
     * "要取消"写进快照与库里（界面显示「取消中…」），等这一页读完，drain 再把它转成 CANCELLED。
     * **不要在这里把状态改成 CANCELLED** —— 任务其实还在写索引。没有这句反馈，用户会以为"点了取消没反应"。
     */
    job.message = "取消中…（正在读完当前这一页，读完就停）";
    void persist(job);
  }
  return snapshot(job);
}

/**
 * 取一个任务的**断点**（已经读到第几条）：内存里在跑/刚跑完的优先，其次读库里的历史行
 * （进程重启后任务只剩库里那一行，靠它才能续跑）。任务不存在返回 null。
 */
/**
 * 读一个任务的**续跑点**：读到第几条 + 当时的游标。
 *
 * 内存里有就直接用；没有（进程重启过）就**读库** —— 任务表里那两列就是为这件事存的，
 * 否则重启之后的"继续物化"会静默从 0 重头跑（大表上等于白跑一遍）。
 * 读库失败一律当"没有续跑点"（调用方会退回从头跑，安全方向）。
 */
export async function jobResumePoint(jobId: string): Promise<{ scanned: number; cursor: MaterializeCursor | null } | null> {
  const live = registry().jobs.get(jobId);
  if (live) return { scanned: live.scanned, cursor: live.cursor ?? live.startCursor ?? null };
  try {
    const repo = await platformRepo(MaterializationJobEntity);
    const row = await repo.findOne({ where: { id: jobId } });
    if (!row) return null;
    return { scanned: Number(row.scanned ?? 0), cursor: decodeCursor(row.cursor) };
  } catch {
    return null;
  }
}

/** 排队一个类型（对象类型 / 关系类型）的整份物化；返回任务的当前快照（立刻可查进度）。 */
export function enqueueMaterializeJob(input: {
  targetId: string;
  /** 不传 = 对象类型（老调用点不用改）。 */
  kind?: MaterializeJobKind;
  entityType: string;
  versionId?: string | null;
  pageSize?: number;
  maxRows?: number | null;
  /** 从哪条记录断点续跑（传上一轮任务的 id）：取它的 scanned + 游标当起点。 */
  resumeFromJobId?: string | null;
  /** 或直接给起点（内部用；与 resumeFromJobId 二选一）。 */
  startOffset?: number;
  startCursor?: MaterializeCursor | null;
}): MaterializeJob {
  const state = registry();
  const previous = input.resumeFromJobId ? state.jobs.get(input.resumeFromJobId) : undefined;
  const startOffset = Math.max(0, Math.floor(input.startOffset ?? previous?.scanned ?? 0));
  const startCursor = input.startCursor ?? previous?.cursor ?? null;
  const job: JobState = {
    id: crypto.randomUUID(),
    targetId: input.targetId,
    kind: input.kind ?? "OBJECT_TYPE",
    entityType: input.entityType,
    status: "QUEUED",
    scanned: 0,
    rows: 0,
    pages: 0,
    total: null,
    truncated: false,
    message: startOffset > 0
      ? `从第 ${startOffset} 条继续（断点续跑${startCursor ? "，接着用键集翻页" : ""}）。`
      : null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    versionId: input.versionId ?? null,
    pageSize: input.pageSize ?? DEFAULT_MATERIALIZE_PAGE_SIZE,
    maxRows: typeof input.maxRows === "number" && input.maxRows > 0 ? input.maxRows : null,
    startOffset,
    startCursor,
    cursor: startCursor,
    cancelRequested: false,
  };
  state.jobs.set(job.id, job);
  state.queue.push(job.id);
  void persist(job);
  void drain();
  return snapshot(job);
}

/** 串行取队列：一次只跑一个任务，跑完接着下一个。 */
async function drain(): Promise<void> {
  const state = registry();
  if (state.running) return;
  state.running = true;
  try {
    for (;;) {
      const nextId = state.queue.shift();
      if (!nextId) break;
      const job = state.jobs.get(nextId);
      if (!job || job.status !== "QUEUED") continue;
      job.status = "RUNNING";
      job.startedAt = new Date().toISOString();
      void persist(job);
      try {
        const context = await resolveObjectContext(job.targetId, job.versionId);
        const runOptions = {
          pageSize: job.pageSize,
          maxRows: job.maxRows,
          startOffset: job.startOffset,
          // 断点游标：有它才能接着用键集翻页（只靠条数还原不出游标，会退回 OFFSET）。
          startCursor: job.startCursor,
          onProgress: (progress: { scanned: number; rows: number; pages: number; cursor?: MaterializeCursor | null }) => {
            job.scanned = progress.scanned;
            job.rows = progress.rows;
            job.pages = progress.pages;
            if (progress.cursor) job.cursor = progress.cursor;
            // 每页一次（onProgress 本来就是按页触发的），不每行写。
            void persist(job);
          },
          shouldCancel: () => job.cancelRequested,
        };
        const result = job.kind === "RELATIONSHIP_TYPE"
          ? await materializeRelationshipType(context, job.entityType, runOptions)
          : await materializeObjectType(context, job.entityType, runOptions);
        job.scanned = result.scanned;
        job.rows = result.rows;
        job.pages = result.pages;
        job.total = result.total;
        job.truncated = result.truncated;
        job.status = job.cancelRequested ? "CANCELLED" : "DONE";
        /*
         * **告警要能看见**：物化出来的 warnings（主键折叠了多少行、少读了几行…）以前只活在返回值里，
         * 而后台任务只存 message —— 于是这些话说给谁都不算说。现在并进 message，面板那一行就能看到。
         */
        const notes = result.warnings.map((line) => line.trim()).filter(Boolean);
        job.message = job.cancelRequested
          ? `已取消：取消前读入 ${job.scanned} 条，索引里是这一份不完整的数据（会如实标成"只补过一批"）。`
          : result.truncated
            ? `读到上限 ${job.maxRows ?? "—"} 行就停了：源里可能还有更多。`
            : notes.length
              ? notes.join(" ").slice(0, 400)
              : null;
      } catch (error) {
        job.status = "FAILED";
        job.message = error instanceof Error ? error.message : "物化失败。";
      } finally {
        job.finishedAt = new Date().toISOString();
        void persist(job);
      }
    }
  } finally {
    state.running = false;
  }
}
