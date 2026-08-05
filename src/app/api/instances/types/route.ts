import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getTarget } from "@/lib/targets";
import { readRuntimeTypes } from "@/lib/instances";

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const types = await readRuntimeTypes(target);
    return NextResponse.json(types);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取运行时类型。" }, { status: 400 });
  }
}
