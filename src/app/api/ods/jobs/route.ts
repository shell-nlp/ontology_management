import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { withPermission } from "@/lib/platform/route-guard";
import { listOdsJobs } from "@/lib/instance/ods/service";

export const GET = withPermission("datasource.read", async (request: NextRequest) => {
  try {
    const sourceId = request.nextUrl.searchParams.get("sourceId")?.trim() || undefined;
    return NextResponse.json({ jobs: await listOdsJobs(sourceId) });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "读取 ODS 同步任务失败。") }, { status: apiErrorStatus(error) });
  }
});
