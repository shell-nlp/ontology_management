import { materializeObjectType, resolveObjectContext } from "@/lib/instance/object-service";

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
export type MaterializeJobStatus = "QUEUED" | "RUNNING" | "DONE" | "CANCELLED" | "FAILED";

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

export function listMaterializeJobs(targetId?: string | null): MaterializeJob[] {
  const id = (targetId ?? "").trim();
  return [...registry().jobs.values()]
    .filter((job) => !id || job.targetId === id)
    .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
    .map(snapshot);
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
  }
  return snapshot(job);
}

/** 排队一个类型的整份物化；返回任务的当前快照（立刻可查进度）。 */
export function enqueueMaterializeJob(input: {
  targetId: string;
  entityType: string;
  versionId?: string | null;
  pageSize?: number;
  maxRows?: number | null;
}): MaterializeJob {
  const state = registry();
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
    message: null,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    versionId: input.versionId ?? null,
    pageSize: input.pageSize ?? 500,
    maxRows: typeof input.maxRows === "number" && input.maxRows > 0 ? input.maxRows : null,
    cancelRequested: false,
  };
  state.jobs.set(job.id, job);
  state.queue.push(job.id);
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
      try {
        const context = await resolveObjectContext(job.targetId, job.versionId);
        const result = await materializeObjectType(context, job.entityType, {
          pageSize: job.pageSize,
          maxRows: job.maxRows,
          onProgress: (progress) => {
            job.scanned = progress.scanned;
            job.rows = progress.rows;
            job.pages = progress.pages;
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
      }
    }
  } finally {
    state.running = false;
  }
}
