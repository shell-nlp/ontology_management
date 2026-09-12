import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { openDataSourceConnector } from "@/lib/data-source";
import { dataSourceInput, resolvePort } from "@/lib/data-source/input";
import { normalizeDataSourceKind } from "@/lib/data-sources";
import type { DataSourceRecord } from "@/lib/data-source/types";

/**
 * 试连一个还没保存的数据来源：向导里「测试连接」用的就是这里。
 * 只做一次连接与版本探测，不落库、不读业务数据。
 */
export async function POST(request: NextRequest) {
  try {
    await requireRole("ADMIN");
    const input = dataSourceInput.parse(await request.json());
    const kind = normalizeDataSourceKind(input.kind);
    // 过一遍校验后就丢：这里只是把表单参数拼成连接器认识的形状。
    const draft: DataSourceRecord = {
      id: "unsaved",
      name: input.name,
      kind,
      host: input.host,
      port: resolvePort(kind, input.port),
      database_name: input.databaseName,
      schema_name: input.schemaName,
      username: input.username,
      credential_secret: "",
      options: {},
      enabled: true,
      created_at: new Date(),
    };
    const connector = await openDataSourceConnector(draft, { username: input.username, password: input.password });
    const health = await connector.test();
    return NextResponse.json({ ...health, kind });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "连接失败。" }, { status: 400 });
  }
}
