import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, requireRole } from "@/lib/auth";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { createVersionRecord, deleteVersionRecord, ensureVersionSnapshot, initializeVersionSnapshot, listVersionRecords, withTargetLock } from "@/lib/version-snapshot";

const createInput = z.object({ targetId: z.string().uuid(), baseVersionId: z.string().uuid().optional(), definition: ontologyDefinitionSchema.optional() });

export async function GET(request: NextRequest) {
  try {
    await requireRole("VIEWER");
    const targetId = request.nextUrl.searchParams.get("targetId");
    if (!targetId) return NextResponse.json({ error: "targetId 不能为空。" }, { status: 400 });
    return NextResponse.json(await listVersionRecords(targetId));
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取本体版本。") }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = createInput.parse(await request.json());
    const target = await getTarget(input.targetId);
    if (!target) return NextResponse.json({ error: "本体存储不存在。" }, { status: 404 });
    return withTargetLock(input.targetId, async () => {
      const versions = await listVersionRecords(input.targetId);
      if (versions.some((version) => version.status === "DRAFT")) return NextResponse.json({ error: "该本体存储已有草稿，请先发布或继续编辑现有草稿。" }, { status: 409 });
      let base = input.baseVersionId
        ? versions.find((version) => version.id === input.baseVersionId) ?? null
        : versions.find((version) => version.status === "PUBLISHED") ?? null;
      if (input.baseVersionId && (!base || base.target_id !== input.targetId)) return NextResponse.json({ error: "基础版本不存在或不属于当前本体存储。" }, { status: 404 });
      if (base) await ensureVersionSnapshot(base.id, target);
      const definition = input.definition ?? base?.definition ?? { entityTypes: [], relationshipTypes: [] };
      const versionNumber = versions.reduce((max, version) => Math.max(max, version.version_number), 0) + 1;
      const record = await createVersionRecord({ targetId: input.targetId, versionNumber, createdBy: user.id, definition: ontologyDefinitionSchema.parse(definition) });
      try {
        const manifest = await initializeVersionSnapshot(record.id, target, base?.id);
        await writeAuditEntry({ actorId: user.id, targetId: input.targetId, action: "VERSION_DRAFT_CREATED", details: { versionId: record.id, baseVersionId: base?.id ?? null, entityCount: manifest.entityCount, relationshipCount: manifest.relationshipCount } });
        return NextResponse.json({ id: record.id, versionNumber: record.version_number, status: "DRAFT", definition, entity_count: manifest.entityCount, relationship_count: manifest.relationshipCount }, { status: 201 });
      } catch (error) {
        await deleteVersionRecord(record.id);
        throw error;
      }
    });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建本体草稿。") }, { status: 400 });
  }
}
