import { NextRequest, NextResponse } from "next/server";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { AUDIT_SCOPE_OPTIONS, auditActionsForScope, normalizeAuditScope } from "@/lib/audit";
import { listPlatformAudit, listPlatformUsers } from "@/lib/platform-db";
import { listTargets } from "@/lib/targets";

/**
 * 审计记录（backlog U2）。
 *
 * 发布 / 失败 / 图引擎与数据资源变更、草稿写入、动作执行本来只有 PostgreSQL 里躺着的 `audit_entries`，
 * 界面上看不到。这一层把它读出来：**过滤、排序、分页都在服务端**（表会一直长），
 * 界面只拿当页数据 + 精确总数。
 *
 * 只有管理员能看：审计里有操作人邮箱、数据资源主机名这类信息，查看者没有理由看到。
 *
 * 参数：
 * - `scope=changes|all|actions|reads`（默认 `changes`，见 `@/lib/audit` 的范围定义）
 * - `action=` 单个动作码（在范围之内再收窄，用于"只看发布失败"这类排查）
 * - `targetId=` / `actorId=` / `from=` / `to=`（ISO 时间）
 * - `limit=`（默认 50，上限 200）/ `offset=`
 */
export async function GET(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const params = request.nextUrl.searchParams;
    const scope = normalizeAuditScope(params.get("scope"));
    const action = params.get("action")?.trim() ?? "";
    const scopedActions = auditActionsForScope(scope);
    // 指定了单个动作就以它为准，但**必须落在当前范围内**，否则会出现"范围说变更、列表却全是问答"。
    const actions = action ? (scopedActions ? scopedActions.filter((code) => code === action) : [action]) : scopedActions;
    if (action && actions && !actions.length) {
      return NextResponse.json({ error: `当前范围里没有动作「${action}」。` }, { status: 400 });
    }

    const from = parseTime(params.get("from"));
    const to = parseTime(params.get("to"));
    if (params.get("from") && !from) return NextResponse.json({ error: "起始时间不是合法的时间。" }, { status: 400 });
    if (params.get("to") && !to) return NextResponse.json({ error: "结束时间不是合法的时间。" }, { status: 400 });

    const limit = Number(params.get("limit") ?? "50");
    const offset = Number(params.get("offset") ?? "0");
    const [page, targets, actors] = await Promise.all([
      listPlatformAudit({
        actions,
        actorId: params.get("actorId")?.trim() || undefined,
        targetId: params.get("targetId")?.trim() || undefined,
        from: from ?? undefined,
        to: to ?? undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      }),
      listTargets(),
      listPlatformUsers(),
    ]);

    return NextResponse.json({
      scope,
      action,
      entries: page.entries,
      total: page.total,
      scopes: AUDIT_SCOPE_OPTIONS,
      targets: targets.map((target) => ({ id: target.id, name: target.name, kind: target.kind })),
      actors: actors.map((actor) => ({ id: actor.id, email: actor.email })),
    });
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取审计记录。") }, { status });
  }
}

/** 空的 / 非法的日期一律当成"没传"，由调用方决定是 400 还是忽略。 */
function parseTime(value: string | null): Date | null {
  if (!value) return null;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? null : time;
}
