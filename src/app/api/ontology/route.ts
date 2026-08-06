import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { ensureVersionSnapshot, initializeVersionSnapshot } from "@/lib/version-snapshot";
import type { QueryResultRow } from "pg";

type OntologyVersionRow = QueryResultRow & { id: string; target_id: string; version_number: number; status: "DRAFT" | "PUBLISHED" | "ARCHIVED"; definition: unknown; created_at: Date; published_at: Date | null; artifact_path: string | null; entity_count: number; relationship_count: number; content_hash: string | null };
const createInput = z.object({ targetId: z.string().uuid(), baseVersionId: z.string().uuid().optional(), definition: ontologyDefinitionSchema.optional() });

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    const versions = await platformQuery<OntologyVersionRow>(
      `SELECT id, target_id, version_number, status, definition, created_at, published_at,
              artifact_path, entity_count, relationship_count, content_hash
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
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "目标不存在。" }, { status: 404 });
    const existingDraft = await platformQuery<{ id: string }>(
      "SELECT id FROM ontology_platform.ontology_versions WHERE target_id = $1 AND status = 'DRAFT' LIMIT 1", [input.targetId],
    );
    if (existingDraft.rows[0]) return NextResponse.json({ error: "该目标已有草稿，请先发布或继续编辑现有草稿。" }, { status: 409 });
    const baseResult = input.baseVersionId
      ? await platformQuery<{ id: string; target_id: string; definition: unknown }>("SELECT id, target_id, definition FROM ontology_platform.ontology_versions WHERE id = $1", [input.baseVersionId])
      : await platformQuery<{ id: string; target_id: string; definition: unknown }>("SELECT id, target_id, definition FROM ontology_platform.ontology_versions WHERE target_id = $1 AND status = 'PUBLISHED' ORDER BY published_at DESC LIMIT 1", [input.targetId]);
    const base = baseResult.rows[0];
    if (input.baseVersionId && (!base || base.target_id !== input.targetId)) return NextResponse.json({ error: "基础版本不存在或不属于当前目标。" }, { status: 404 });
    if (base) await ensureVersionSnapshot(base.id, target);
    const definition = input.definition ?? (base ? ontologyDefinitionSchema.parse(base.definition) : { entityTypes: [], relationshipTypes: [] });
    const next = await platformQuery<{ version: number }>(
      "SELECT COALESCE(max(version_number), 0) + 1 AS version FROM ontology_platform.ontology_versions WHERE target_id = $1", [input.targetId],
    );
    const id = crypto.randomUUID();
    await platformQuery(
      `INSERT INTO ontology_platform.ontology_versions (id, target_id, version_number, status, definition, created_by)
       VALUES ($1, $2, $3, 'DRAFT', $4, $5)`, [id, input.targetId, next.rows[0]?.version ?? 1, JSON.stringify(definition), user.id],
    );
    try {
      const manifest = await initializeVersionSnapshot(id, target, base?.id);
      await writeAuditEntry({ actorId: user.id, targetId: input.targetId, action: "VERSION_DRAFT_CREATED", details: { versionId: id, baseVersionId: base?.id ?? null, entityCount: manifest.entityCount, relationshipCount: manifest.relationshipCount } });
      return NextResponse.json({ id, versionNumber: next.rows[0]?.version ?? 1, status: "DRAFT", definition, entity_count: manifest.entityCount, relationship_count: manifest.relationshipCount }, { status: 201 });
    } catch (error) {
      await platformQuery("DELETE FROM ontology_platform.ontology_versions WHERE id = $1", [id]);
      throw error;
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建本体草稿。" }, { status: 400 });
  }
}
