import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { withPermission } from "@/lib/platform/route-guard";
import { enqueueOdsSync } from "@/lib/instance/ods/service";

const bodySchema = z.object({ mode: z.enum(["FULL", "INCREMENTAL"]).optional() }).default({});

export const POST = withPermission("datasource.write", async (request: NextRequest, context: { params: Promise<{ sourceId: string }> }, user) => {
  try {
    const { sourceId } = await context.params;
    const body = bodySchema.parse(await request.json().catch(() => ({})));
    return NextResponse.json({ job: await enqueueOdsSync(sourceId, user, body) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "启动 ODS 同步失败。") }, { status: apiErrorStatus(error) });
  }
});
