import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createTargetDriver } from "@/lib/neo4j";
import { getTarget } from "@/lib/targets";

export async function POST(_: Request, context: { params: Promise<{ targetId: string }> }) {
  try {
    await requireRole("ADMIN");
    const { targetId } = await context.params;
    const target = await getTarget(targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const driver = createTargetDriver(target);
    try {
      const server = await driver.getServerInfo();
      return NextResponse.json({ connected: true, address: server.address, agent: server.agent, protocolVersion: server.protocolVersion });
    } finally {
      await driver.close();
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法连接 Neo4j 目标。" }, { status: 400 });
  }
}
