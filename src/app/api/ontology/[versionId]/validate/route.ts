import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { ontologyDefinitionSchema, validateOntology } from "@/lib/ontology";
import { platformQuery } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import type { QueryResultRow } from "pg";

type VersionRow = QueryResultRow & { id: string; target_id: string; definition: unknown; status: string };

export async function POST(_: Request, context: { params: Promise<{ versionId: string }> }) {
  try {
    await requireRole("ADMIN");
    const { versionId } = await context.params;
    const version = await platformQuery<VersionRow>("SELECT id, target_id, definition, status FROM ontology_platform.ontology_versions WHERE id = $1", [versionId]);
    const row = version.rows[0];
    if (!row) return NextResponse.json({ error: "本体版本不存在。" }, { status: 404 });
    const target = await getTarget(row.target_id);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const violations = await validateOntology(target, ontologyDefinitionSchema.parse(row.definition));
    return NextResponse.json({ valid: violations.length === 0, violations });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "本体校验失败。" }, { status: 400 });
  }
}
