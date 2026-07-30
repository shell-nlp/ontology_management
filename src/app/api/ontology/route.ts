import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import type { QueryResultRow } from "pg";

type OntologyVersionRow = QueryResultRow & { id: string; target_id: string; version_number: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: unknown; created_at: Date; published_at: Date | null };
const createInput = z.object({ targetId: z.string().uuid(), definition: ontologyDefinitionSchema.default({ entityTypes: [], relationshipTypes: [] }) });

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const versions = await platformQuery<OntologyVersionRow>(
      `SELECT id, target_id, version_number, status, definition, created_at, published_at
       FROM ontology_platform.ontology_versions WHERE target_id = $1 ORDER BY version_number DESC`, [targetId],
    );
    return NextResponse.json(versions.rows);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取本体版本。" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = createInput.parse(await request.json());
    const next = await platformQuery<{ version: number }>(
      "SELECT COALESCE(max(version_number), 0) + 1 AS version FROM ontology_platform.ontology_versions WHERE target_id = $1", [input.targetId],
    );
    const id = crypto.randomUUID();
    await platformQuery(
      `INSERT INTO ontology_platform.ontology_versions (id, target_id, version_number, status, definition, created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5)`, [id, input.targetId, next.rows[0]?.version ?? 1, JSON.stringify(input.definition), user.id],
    );
    await writeAuditEntry({ actorId: user.id, targetId: input.targetId, action: "ONTOLOGY_DRAFT_CREATED", details: { versionId: id } });
    return NextResponse.json({ id, versionNumber: next.rows[0]?.version ?? 1, status: "DRAFT" }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建本体草稿。" }, { status: 400 });
  }
}
