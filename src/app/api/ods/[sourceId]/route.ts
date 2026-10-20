import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { withPermission } from "@/lib/platform/route-guard";
import { deleteOdsSource, updateOdsSettings } from "@/lib/instance/ods/service";

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  autoReconcileHours: z.number().int().min(0).max(24 * 365).optional(),
}).refine((value) => value.enabled !== undefined || value.autoReconcileHours !== undefined, { message: "至少提供 enabled 或 autoReconcileHours。" });

export const PATCH = withPermission("datasource.write", async (request: NextRequest, context: { params: Promise<{ sourceId: string }> }) => {
  try {
    const { sourceId } = await context.params;
    const input = patchSchema.parse(await request.json());
    return NextResponse.json({ source: await updateOdsSettings(sourceId, input) });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "修改 ODS 配置失败。") }, { status: apiErrorStatus(error) });
  }
});

export const DELETE = withPermission("datasource.write", async (_request: NextRequest, context: { params: Promise<{ sourceId: string }> }) => {
  try {
    const { sourceId } = await context.params;
    await deleteOdsSource(sourceId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "删除 ODS 配置失败。") }, { status: apiErrorStatus(error) });
  }
});
