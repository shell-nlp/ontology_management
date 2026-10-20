import { NextRequest, NextResponse } from "next/server";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { withPermission } from "@/lib/platform/route-guard";
import { cancelOdsSync } from "@/lib/instance/ods/service";

export const DELETE = withPermission("datasource.write", async (_request: NextRequest, context: { params: Promise<{ jobId: string }> }, user) => {
  try {
    const { jobId } = await context.params;
    return NextResponse.json({ job: await cancelOdsSync(jobId, user) });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "取消 ODS 同步失败。") }, { status: apiErrorStatus(error) });
  }
});
