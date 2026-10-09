import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { dataSourceInput, resolvePort } from "@/lib/data-source/input";
import type { DataSourceRecord } from "@/lib/data-source/types";
import { listDataSources, normalizeDataSourceKind, parseDataSourceOptions, publicDataSource } from "@/lib/data-sources";
import { apiErrorStatus, apiErrorMessage, requirePermission } from "@/lib/auth";
import { DataSourceEntity, jsonValue, platformRepo } from "@/lib/db";
import { writeAuditEntry } from "@/lib/platform-db";

export async function GET() {
  try {
    await requirePermission("datasource.read");
    const sources = await listDataSources();
    return NextResponse.json(sources.map(publicDataSource));
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法读取数据资源。") }, { status: apiErrorStatus(error) });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requirePermission("datasource.write");
    const input = dataSourceInput.parse(await request.json());
    const kind = normalizeDataSourceKind(input.kind);
    const record: DataSourceRecord = {
      id: crypto.randomUUID(),
      name: input.name,
      kind,
      host: input.host,
      port: resolvePort(kind, input.port),
      database_name: input.databaseName,
      schema_name: input.schemaName,
      username: input.username,
      credential_secret: input.password ? encryptSecret(input.password) : "",
      options: parseDataSourceOptions(input.options),
      enabled: input.enabled,
      created_at: new Date(),
    };
    const repo = await platformRepo(DataSourceEntity);
    await repo.insert({
      id: record.id,
      name: record.name,
      kind: record.kind,
      host: record.host,
      port: record.port,
      databaseName: record.database_name,
      schemaName: record.schema_name,
      username: record.username,
      credentialSecret: record.credential_secret,
      options: jsonValue(record.options),
      enabled: record.enabled,
    });
    await writeAuditEntry({ actorId: user.id, action: "DATA_SOURCE_CREATED", details: { dataSourceId: record.id, name: record.name, kind: record.kind, host: record.host, databaseName: record.database_name } });
    return NextResponse.json(publicDataSource(record), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: apiErrorMessage(error, "无法创建数据资源。") }, { status: apiErrorStatus(error) });
  }
}
