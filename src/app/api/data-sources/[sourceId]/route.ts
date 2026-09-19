import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { dataSourcePatch, resolvePort } from "@/lib/data-source/input";
import { getDataSource, normalizeDataSourceKind, parseDataSourceOptions, publicDataSource } from "@/lib/data-sources";
import { clearStructureCache } from "@/lib/data-source/structure-cache";
import { releaseDataSourcePool } from "@/lib/data-source/sql";
import { apiErrorMessage, isUnauthorized, requireRole } from "@/lib/auth";
import { DataSourceEntity, jsonValue, platformRepo } from "@/lib/db";
import { writeAuditEntry } from "@/lib/platform-db";

export async function GET(_request: NextRequest, context: { params: Promise<{ sourceId: string }> }) {
  try {
    await requireRole("VIEWER");
    const { sourceId } = await context.params;
    const source = await getDataSource(sourceId);
    if (!source) return NextResponse.json({ error: "数据资源不存在。" }, { status: 404 });
    return NextResponse.json(publicDataSource(source));
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取数据资源。") }, { status: 400 });
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
    const repo = await platformRepo(DataSourceEntity);
    await repo.update({ id: sourceId }, {
      name: next.name,
      kind: next.kind,
      host: next.host,
      port: next.port,
      databaseName: next.database_name,
      schemaName: next.schema_name,
      username: next.username,
      credentialSecret: next.credential_secret,
      options: jsonValue(next.options),
      enabled: next.enabled,
    });
    /*
     * 换了连接就作废结构缓存：缓存里存的是"那个库那个模式下的表清单"，
     * host / 库 / 模式 / 账号 / 密码 一变，旧清单就不成立了。
     * 只改名字或启用状态时留着它 —— 那种改动不影响库里的结构。
     */
    const connectionChanged = current.kind !== next.kind
      || current.host !== next.host
      || Number(current.port) !== Number(next.port)
      || current.database_name !== next.database_name
      || current.schema_name !== next.schema_name
      || current.username !== next.username
      || current.credential_secret !== next.credential_secret;
    if (connectionChanged) await clearStructureCache(sourceId);
    // 连接信息变了（D3）：顺手把旧连接池收掉，别让旧凭据的会话挂着。
    if (connectionChanged) await releaseDataSourcePool(sourceId);
    await writeAuditEntry({ actorId: user.id, action: "DATA_SOURCE_UPDATED", details: { dataSourceId: sourceId, name: next.name, kind: next.kind, enabled: next.enabled } });
    return NextResponse.json(publicDataSource({ ...current, ...next }));
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法更新数据资源。") }, { status });
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
    // 来源没了，连接池也收掉（D3）：不回收的话业务库那边会留着连不上的孤儿会话。
    await releaseDataSourcePool(sourceId);
    const repo = await platformRepo(DataSourceEntity);
    await repo.delete({ id: sourceId });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    const status = isUnauthorized(error) ? 401 : 400;
    return NextResponse.json({ error: apiErrorMessage(error, "无法删除数据资源。") }, { status });
  }
}
