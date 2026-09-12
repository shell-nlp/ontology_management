import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import { dataSourceInput, resolvePort } from "@/lib/data-source/input";
import type { DataSourceRecord } from "@/lib/data-source/types";
import { listDataSources, normalizeDataSourceKind, parseDataSourceOptions, publicDataSource } from "@/lib/data-sources";
import { requireRole } from "@/lib/auth";
import { platformQuery, writeAuditEntry } from "@/lib/platform-db";

export async function GET() {
  try {
    await requireRole("VIEWER");
    const sources = await listDataSources();
    return NextResponse.json(sources.map(publicDataSource));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error && error.message === "UNAUTHORIZED" ? "未授权。" : "无法读取数据资源。" }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const user = await requireRole("ADMIN");
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
    await platformQuery(
      `INSERT INTO ontology_platform.data_sources (id, name, kind, host, port, database_name, schema_name, username, credential_secret, options, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [record.id, record.name, record.kind, record.host, record.port, record.database_name, record.schema_name, record.username, record.credential_secret, JSON.stringify(record.options), record.enabled],
    );
    await writeAuditEntry({ actorId: user.id, action: "DATA_SOURCE_CREATED", details: { dataSourceId: record.id, name: record.name, kind: record.kind, host: record.host, databaseName: record.database_name } });
    return NextResponse.json(publicDataSource(record), { status: 201 });
  } catch (error) {
    const status = error instanceof Error && error.message === "UNAUTHORIZED" ? 401 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法创建数据资源。" }, { status });
  }
}
