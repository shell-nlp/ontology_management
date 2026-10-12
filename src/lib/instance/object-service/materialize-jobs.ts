import { materializeObjectType, resolveObjectContext } from "@/lib/instance/object-service";
import { MaterializationJobEntity, platformRepo } from "@/lib/platform/db";

/**
 * 整份物化的**后台任务**（2026-10-12 用户要求：默认不限制 + 放后台跑 + 能看进度）。
 *
 * 三个刻意的设计：
 * 1. **一个任务 = 一个对象类型**：批量物化就是排一串任务；进度按类型报，取消也按类型取消，
 *    不做"一个大任务里塞 42 个类型"那种没法局部重试的形态。
 * 2. **全局串行**（并发 1）：并行物化会同时压业务库，进度与失败归因也会乱。
 * 3. **状态在内存**（挂 `globalThis`，与智能问答的 run-registry 同一条口径）：接口进程重启会丢任务，
 *    但物化本身是幂等的（重跑一遍即可），所以不值得为它先落一张任务表。要跨重启续跑就得落库 —— Backlog 未排期。
 */
export type MaterializeJobStatus = "QUEUED" | "RUNNING" | "DONE" | "CANCELLED" | "FAILED" | "INTERRUPTED";

export type MaterializeJob = {
  id: string;
  targetId: string;
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
};

type JobState = MaterializeJob & {
  versionId: string | null;
  pageSize: number;
  maxRows: number | null;
  /** 断点：这一趟从第几条开始读（0 = 从头）。 */
  startOffset: number;
  cancelRequested: boolean;
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
});

/** 写一行任务状态（入队 / 开始 / 每页 / 结束都调它）。失败不影响主流程 —— 物化本身照跑。 */
async function persist(job: JobState): Promise<void> {
  try {
    const repo = await platformRepo(MaterializationJobEntity);
    await repo.upsert(
      {
        id: job.id,
        targetId: job.targetId,
        entityType: job.entityType,
        status: job.status,
        scanned: String(Math.trunc(job.scanned)),
        rows: String(Math.trunc(job.rows)),
        pages: job.pages,
        truncated: job.truncated,
        message: job.message,
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
    }));
  } catch {
    stored = [];
  }
  const live = [...registry().jobs.values()].filter((job) => !id || job.targetId === id).map(snapshot);
  const byId = new Map(stored.map((job) => [job.id, job]));
  for (const job of live) byId.set(job.id, job);
  return [...byId.values()].sort((left, right) => right.queuedAt.localeCompare(left.queuedAt)).slice(0, 50);
}

export function cancelMaterializeJob(jobId: string): MaterializeJob | null {
  const state = registry();
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (job.status === "DONE" || job.status === "FAILED" || job.status === "CANCELLED") return snapshot(job);
  job.cancelRequested = true;
  if (job.status === "QUEUED") {
    job.status = "CANCELLED";
    job.finishedAt = new Date().toISOString();
    job.message = "排队时被取消。";
    state.queue = state.queue.filter((id) => id !== jobId);
    void persist(job);
  }
  return snapshot(job);
}

/**
 * 取一个任务的**断点**（已经读到第几条）：内存里在跑/刚跑完的优先，其次读库里的历史行
 * （进程重启后任务只剩库里那一行，靠它才能续跑）。任务不存在返回 null。
 */
export async function jobCursor(jobId: string): Promise<number | null> {
  const live = registry().jobs.get(jobId);
  if (live) return live.scanned;
  try {
    const repo = await platformRepo(MaterializationJobEntity);
    const row = await repo.findOne({ where: { id: jobId } });
    return row ? Number(row.scanned ?? 0) : null;
  } catch {
    return null;
  }
}

/** 排队一个类型的整份物化；返回任务的当前快照（立刻可查进度）。 */
export function enqueueMaterializeJob(input: {
  targetId: string;
  entityType: string;
  versionId?: string | null;
  pageSize?: number;
  maxRows?: number | null;
  /** 从哪条记录断点续跑（传上一轮任务的 id）：取它的 scanned 当起点。 */
  resumeFromJobId?: string | null;
  /** 或直接给起点条数（内部用；与 resumeFromJobId 二选一）。 */
  startOffset?: number;
}): MaterializeJob {
  const state = registry();
  const previous = input.resumeFromJobId ? state.jobs.get(input.resumeFromJobId) : undefined;
  const startOffset = Math.max(0, Math.floor(input.startOffset ?? previous?.scanned ?? 0));
  const job: JobState = {
    id: crypto.randomUUID(),
    targetId: input.targetId,
    entityType: input.entityType,
    status: "QUEUED",
    scanned: 0,
    rows: 0,
    pages: 0,
    total: null,
    truncated: false,
    message: startOffset > 0 ? `从第 ${startOffset} 条继续（断点续跑）。` : null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    versionId: input.versionId ?? null,
    pageSize: input.pageSize ?? 500,
    maxRows: typeof input.maxRows === "number" && input.maxRows > 0 ? input.maxRows : null,
    startOffset,
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
        const result = await materializeObjectType(context, job.entityType, {
          pageSize: job.pageSize,
          maxRows: job.maxRows,
          startOffset: job.startOffset,
          onProgress: (progress) => {
            job.scanned = progress.scanned;
            job.rows = progress.rows;
            job.pages = progress.pages;
            // 每页一次（onProgress 本来就是按页触发的），不每行写。
            void persist(job);
          },
          shouldCancel: () => job.cancelRequested,
        });
        job.scanned = result.scanned;
        job.rows = result.rows;
        job.pages = result.pages;
        job.total = result.total;
        job.truncated = result.truncated;
        job.status = job.cancelRequested ? "CANCELLED" : "DONE";
        job.message = job.cancelRequested
          ? `已取消：取消前读入 ${job.scanned} 条，索引里是这一份不完整的数据（会如实标成"只补过一批"）。`
          : result.truncated
            ? `读到上限 ${job.maxRows ?? "—"} 行就停了：源里可能还有更多。`
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
