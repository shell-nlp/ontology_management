import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorStatus, apiErrorMessage } from "@/lib/platform/auth";
import { withPermission } from "@/lib/platform/route-guard";
import { listOdsSources, saveOdsSource } from "@/lib/instance/ods/service";

const saveSchema = z.object({
  dataSourceId: z.string().uuid(),
  schema: z.string().max(200).default(""),
  table: z.string().trim().min(1).max(200),
  tableKind: z.enum(["table", "view", "materialized-view"]).default("table"),
  columns: z.array(z.string().trim().min(1).max(200)).max(500).optional(),
  primaryKeyColumns: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  watermarkColumn: z.string().trim().max(200).default(""),
  syncMode: z.enum(["FULL", "INCREMENTAL"]).default("FULL"),
  enabled: z.boolean().optional(),
  autoReconcileHours: z.number().int().min(0).max(24 * 365).optional(),
});

export const GET = withPermission("datasource.read", async () => {
  try {
    return NextResponse.json({ sources: await listOdsSources() });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "读取 ODS 配置失败。") }, { status: apiErrorStatus(error) });
  }
});

export const POST = withPermission("datasource.write", async (request: NextRequest, _context, user) => {
  try {
    const input = saveSchema.parse(await request.json());
    return NextResponse.json({ source: await saveOdsSource(input, user) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "保存 ODS 配置失败。") }, { status: apiErrorStatus(error) });
  }
});
