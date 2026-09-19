import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiErrorMessage, apiErrorStatus, requireRole } from "@/lib/auth";
import { graphTargetKindInfo, isGraphTargetKind } from "@/lib/graph/types";
import { createOntology, listOntologies } from "@/lib/ontologies";
import { writeAuditEntry } from "@/lib/platform-db";
import { getTarget } from "@/lib/targets";
import { listVersionRecords } from "@/lib/version-snapshot";

const ontologyCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).default(""),
  color: z.string().max(32).default(""),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).default([]),
  storageTargetId: z.string().uuid(),
});

/** 列表要展示的东西：本体 + 它落在哪 + 版本状态 + 类型与实例的数量。 */
async function withSummary() {
  const ontologies = await listOntologies();
  return Promise.all(ontologies.map(async (ontology) => {
    const storage = await getTarget(ontology.target_id);
    const records = storage ? await listVersionRecords(ontology.target_id).catch(() => []) : [];
    const draft = records.find((record) => record.status === "DRAFT") ?? null;
    const published = records.find((record) => record.status === "PUBLISHED") ?? null;
    const definition = published?.definition ?? draft?.definition ?? null;
    return {
      ...ontology,
      storage: storage
        ? {
            id: storage.id,
            name: storage.name,
            kind: storage.kind,
            kindLabel: isGraphTargetKind(storage.kind) ? graphTargetKindInfo(storage.kind).label : storage.kind,
            uri: storage.uri,
            managed: Boolean(ontology.owner_target_id) || Boolean(ontology.namespace && storage.kind === "EMBEDDED" && storage.options?.namedGraph === ontology.namespace),
          }
        : null,
      versions: {
        draft: draft?.version_number ?? null,
        published: published?.version_number ?? null,
      },
      statistics: {
        objectTypes: definition?.entityTypes.length ?? 0,
        relationTypes: definition?.relationshipTypes.length ?? 0,
        objects: published?.entity_count ?? draft?.entity_count ?? 0,
        relationships: published?.relationship_count ?? draft?.relationship_count ?? 0,
      },
    };
  }));
}

export async function GET() {
  try {
    await requireRole("VIEWER");
    // 存储资源不是本体：列表只展示用户显式创建或导入的本体。
    // 旧版「给未关联资源自动补本体」会把平台内置资源也误建成一条本体。
    return NextResponse.json(await withSummary());
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取本体列表。") }, { status: apiErrorStatus(error, 401) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
    const input = ontologyCreateInput.parse(await request.json());
    const ontology = await createOntology(input, user.id);
    await writeAuditEntry({
      actorId: user.id,
      targetId: ontology.target_id,
      action: "ONTOLOGY_CREATED",
      details: { ontologyId: ontology.id, name: ontology.name, storageTargetId: input.storageTargetId, namespace: ontology.namespace },
    });
    return NextResponse.json(ontology, { status: 201 });
  } catch (error) {
    const message = error instanceof z.ZodError ? (error.issues[0]?.message ?? "请求不合法。") : apiErrorMessage(error, "无法创建本体。");
    return NextResponse.json({ error: message }, { status: apiErrorStatus(error, 400) });
  }
}
