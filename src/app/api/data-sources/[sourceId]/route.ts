import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { dataSourcePatch, resolvePort } from "@/lib/data-source/input";
import { getDataSource, normalizeDataSourceKind, parseDataSourceOptions, publicDataSource } from "@/lib/data-sources";
import { requireRole } from "@/lib/auth";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";

export async function GET(_request: NextRequest, context: { params: Promise<{ sourceId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { sourceId } = await context.params;
    const source = await getDataSource(sourceId);
    if (!source) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    return NextResponse.json(publicDataSource(source));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取数据资源。" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ sourceId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { sourceId } = await context.params;
    const input = dataSourcePatch.parse(await request.json());
    const current = await getDataSource(sourceId);
    if (!current) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });

    const kind = input.kind ? normalizeDataSourceKind(input.kind) : current.kind;
    // 密码留空表示"保持不变"：编辑连接信息时不该被迫重填密码。
    const credential = typeof input.password === "string" && input.password.length > 0 ? encryptSecret(input.password) : current.credential_secret;
    const next = {
      name: input.name ?? current.name,
      kind,
      host: input.host ?? current.host,
      port: input.port ? resolvePort(kind, input.port) : resolvePort(kind, current.port),
      database_name: input.databaseName ?? current.database_name,
      schema_name: input.schemaName ?? current.schema_name,
      username: input.username ?? current.username,
      credential_secret: credential,
      options: input.options ? parseDataSourceOptions(input.options) : current.options,
      enabled: input.enabled ?? current.enabled,
    };
    await platformQuery(
      `UPDATE ontology_platform.data_sources
       SET name = $2, kind = $3, host = $4, port = $5, database_name = $6, schema_name = $7, username = $8, credential_secret = $9, options = $10, enabled = $11
       WHERE id = $1`,
      [sourceId, next.name, next.kind, next.host, next.port, next.database_name, next.schema_name, next.username, next.credential_secret, JSON.stringify(next.options), next.enabled],
    );
    await writeAuditEntry({ actorId: user.id, action: "DATA_SOURCE_UPDATED", details: { dataSourceId: sourceId, name: next.name, kind: next.kind, enabled: next.enabled } });
    return NextResponse.json(publicDataSource({ ...current, ...next }));
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法更新数据资源。" }, { status });
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ sourceId: string }> }) {
  try {
    const user = await requireRole("ADMIN");
    const { sourceId } = await context.params;
    const current = await getDataSource(sourceId);
    if (!current) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    // 审计先写：data_sources 删除后再补就找不到这条来源了。
    await writeAuditEntry({ actorId: user.id, action: "DATA_SOURCE_DELETED", details: { dataSourceId: sourceId, name: current.name, kind: current.kind } });
    await platformQuery(`DELETE FROM ontology_platform.data_sources WHERE id = $1`, [sourceId]);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法删除数据资源。" }, { status });
  }
}
