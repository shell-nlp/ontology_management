import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";
import { getOdsQueryExecutor, getOdsStore } from "@/lib/infrastructure/ods";
import { OdsSourceEntity, jsonValue, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import { compileQuerySql, resolveQueryDsl, toQueryDsl } from "@/lib/query-dsl";
import { caseDefinition, telecomCaseSql, telecomScope } from "../query-dsl-case.fixture";

const enabled = Boolean(process.env.DATABASE_URL && process.env.CLICKHOUSE_URL);
it.skipIf(!enabled)("真实 CH ODS 与 PostgreSQL 对拍：原 SQL、NULL、空集、精确小数与大整数", async () => {
  const token = randomUUID().replace(/-/g, "").slice(0, 16);
  const configId = randomUUID(), dsId = randomUUID();
  const tableName = `case_${token}`, chTable = `ods_case_${token}`;
  const definition = caseDefinition(dsId, tableName, "pg_temp");
  const pg = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, query_timeout: 10000 });
  await pg.connect();
  const store = getOdsStore();
  const repo = await platformRepo(OdsSourceEntity);
  const columns = [
    { name: "ROW_ID", sourceType: "INTEGER", clickhouseType: "Int64", primaryKey: true },
    ...["USER_ID", "CUST_ID", "ZX_FLAG", "STATS"].map((name) => ({ name, sourceType: "TEXT", clickhouseType: "String", primaryKey: false })),
    { name: "ZX_COUNT", sourceType: "BIGINT", clickhouseType: "Int64", primaryKey: false },
    { name: "STATIS_DATE", sourceType: "DATE", clickhouseType: "Date", primaryKey: false },
    { name: "FEE", sourceType: "NUMERIC(18,2)", clickhouseType: "Decimal(18, 2)", primaryKey: false },
    { name: "BIG_ID", sourceType: "NUMERIC(20)", clickhouseType: "Int64", primaryKey: false },
  ].map((column) => ({ ...column, nullable: !column.primaryKey, comment: "条件聚合契约测试列" }));
  const spec = { sourceId: configId, tableName: chTable, primaryKeyColumns: ["ROW_ID"], columns };
  const data = [
    { ROW_ID: 1, USER_ID: "U1", CUST_ID: "C1", ZX_FLAG: "1", STATS: "0", ZX_COUNT: 2, STATIS_DATE: "2026-09-13", FEE: "0.10", BIG_ID: "9007199254740993" },
    { ROW_ID: 2, USER_ID: "U1", CUST_ID: "C1", ZX_FLAG: "1", STATS: "0", ZX_COUNT: 3, STATIS_DATE: "2026-09-13", FEE: "0.20", BIG_ID: "9007199254740994" },
    { ROW_ID: 3, USER_ID: "U2", CUST_ID: "C2", ZX_FLAG: "2", STATS: "0", ZX_COUNT: 1, STATIS_DATE: "2026-09-13", FEE: "0.30", BIG_ID: "9007199254740993" },
    { ROW_ID: 4, USER_ID: "U3", CUST_ID: "C3", ZX_FLAG: "1", STATS: "1", ZX_COUNT: 7, STATIS_DATE: "2026-09-13", FEE: "100.00", BIG_ID: "9007199254740993" },
    { ROW_ID: 5, USER_ID: null, CUST_ID: "C2", ZX_FLAG: "1", STATS: "0", ZX_COUNT: null, STATIS_DATE: "2026-09-13", FEE: null, BIG_ID: null },
    { ROW_ID: 6, USER_ID: "U4", CUST_ID: null, ZX_FLAG: null, STATS: "0", ZX_COUNT: 4, STATIS_DATE: "2026-09-13", FEE: null, BIG_ID: null },
    { ROW_ID: 7, USER_ID: "U5", CUST_ID: "C5", ZX_FLAG: "1", STATS: "0", ZX_COUNT: 10, STATIS_DATE: "2026-09-14", FEE: "100.00", BIG_ID: null },
    { ROW_ID: 8, USER_ID: "U6", CUST_ID: "C6", ZX_FLAG: "1", STATS: null, ZX_COUNT: 100, STATIS_DATE: "2026-09-13", FEE: "100.00", BIG_ID: null },
  ];
  try {
    await pg.query(`CREATE TEMP TABLE "${tableName}" ("ROW_ID" integer PRIMARY KEY, "USER_ID" text, "CUST_ID" text, "ZX_FLAG" text, "STATS" text, "ZX_COUNT" bigint, "STATIS_DATE" date, "FEE" numeric(18,2), "BIG_ID" numeric(20,0))`);
    const names = Object.keys(data[0]);
    for (const row of data) await pg.query(`INSERT INTO "${tableName}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, names.map((name) => row[name as keyof typeof row]));
    await store.writeFull({ spec, rows: (async function* () { yield* data; })(), batchId: Date.now() });
    await repo.save(repo.create({ id: configId, dataSourceId: dsId, schemaName: "pg_temp", tableName, tableKind: "table", columns: jsonValue(columns), primaryKeyColumns: jsonValue(["ROW_ID"]), watermarkColumn: "", syncMode: "FULL", enabled: true, chTable, status: "READY", lastSyncAt: new Date(), rowCount: String(data.length), createdAt: new Date(), updatedAt: new Date() }));
    const numeric = (rows: unknown[][]) => rows.map((row) => row.map((value) => value === null ? null : Number(value)));
    const canonical = (rows: unknown[][]) => rows.map((row) => row.map((value) => {
      if (value === null) return null;
      if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("执行器把大整数转换成了不安全的 Number");
      const text = String(value);
      if (!/^-?\d+(?:\.\d+)?$/.test(text)) return text;
      return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
    }));
    const compare = async (sql: string, parameters = {}, exact = false) => {
      const plan = resolveQueryDsl(definition, toQueryDsl(sql, definition, parameters));
      const compiled = compileQuerySql(plan, "POSTGRES");
      const values: unknown[] = [];
      const statement = compiled.statement.replace(/:p\d+\b/g, (name) => { values.push(compiled.parameters[name.slice(1)]); return `$${values.length}`; });
      const baseline = await pg.query({ text: statement, values, rowMode: "array" });
      const ch = await getOdsQueryExecutor().executeLogicalQuery(plan);
      expect(ch, "必须真实命中 ClickHouse ODS").not.toBeNull();
      expect(canonical(ch!.rows)).toEqual(canonical(baseline.rows));
      return exact ? canonical(ch!.rows) : numeric(ch!.rows);
    };
    expect(await compare(telecomCaseSql)).toEqual([[3, 10, 2, 1, 5]]);
    expect(await compare(`SELECT SUM(CASE WHEN ZX_FLAG = '1' THEN FEE ELSE 0 END) AS F, COUNT(DISTINCT CASE WHEN ZX_FLAG = '1' THEN BIG_ID END) AS B FROM 专线产品用户 WHERE ${telecomScope}`)).toEqual([[0.3, 2]]);
    expect(await compare(`SELECT SUM(CASE WHEN ZX_FLAG='1' THEN BIG_ID ELSE 0 END) AS B FROM 专线产品用户 WHERE ${telecomScope}`, {}, true)).toEqual([["18014398509481987"]]);
    expect(await compare(`SELECT SUM(CASE WHEN ZX_FLAG = 'missing' THEN ZX_COUNT END) AS S, AVG(CASE WHEN ZX_FLAG = 'missing' THEN ZX_COUNT END) AS A, COUNT(DISTINCT CASE WHEN ZX_FLAG = 'missing' THEN USER_ID END) AS C FROM 专线产品用户 WHERE ${telecomScope}`)).toEqual([[null, null, 0]]);
    expect(await compare(telecomCaseSql.replace("STATS NOT IN ('1','3')", "ROW_ID = 0"))).toEqual([[0, null, 0, 0, null]]);
    await compare(`SELECT SUM(CASE WHEN ZX_FLAG='1' THEN 1 WHEN ZX_FLAG='1' THEN 99 ELSE -1 END) AS N, MIN(CASE WHEN STATS = '0' THEN ZX_COUNT END) AS M, MAX(CASE WHEN STATS = '0' THEN ZX_COUNT END) AS X FROM 专线产品用户 WHERE ${telecomScope}`);
    await compare("SELECT COUNT(CASE WHEN NOT (ZX_FLAG IN ('1', NULL)) THEN USER_ID END) AS N, SUM(CASE WHEN ZX_FLAG = :flag THEN ZX_COUNT ELSE :fallback END) AS S FROM 专线产品用户", { flag: "1", fallback: 0 });
    await compare("SELECT SUM(CASE WHEN ZX_FLAG='1' THEN NULL END) AS N FROM 专线产品用户");
    await compare(`SELECT COUNT(DISTINCT CASE WHEN ZX_FLAG='1' THEN TRUE ELSE FALSE END) AS N FROM 专线产品用户 WHERE ${telecomScope}`);
    await compare(`SELECT ZX_FLAG AS T, SUM(CASE WHEN STATS='0' THEN ZX_COUNT ELSE 0 END) AS N FROM 专线产品用户 WHERE ${telecomScope} GROUP BY ZX_FLAG ORDER BY T`);
    await repo.update({ id: configId }, { columns: jsonValue(columns.filter((column) => column.name !== "FEE")) });
    const allowed = resolveQueryDsl(definition, toQueryDsl(telecomCaseSql, definition));
    expect(await getOdsQueryExecutor().executeLogicalQuery(allowed)).not.toBeNull();
    const missing = resolveQueryDsl(definition, toQueryDsl("SELECT SUM(CASE WHEN ZX_FLAG='1' THEN FEE ELSE 0 END) AS F FROM 专线产品用户", definition));
    expect(await getOdsQueryExecutor().executeLogicalQuery(missing)).toBeNull();
  } finally {
    await store.drop(configId, chTable).catch(() => undefined);
    await repo.delete({ id: configId }).catch(() => undefined);
    await pg.end(); // PostgreSQL 临时表随会话释放，不触及业务表
  }
}, 60_000);
