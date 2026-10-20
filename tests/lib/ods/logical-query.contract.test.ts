import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ontologyDefinitionSchema } from "@/lib/ontology";
import { OdsSourceEntity, jsonValue, platformRepo } from "@/lib/infrastructure/persistence/postgres";
import { getOdsQueryExecutor, getOdsStore } from "@/lib/infrastructure/ods";
import { resolveQueryDsl, toQueryDsl } from "@/lib/query-dsl";

const enabled = Boolean(process.env.CLICKHOUSE_URL && process.env.DATABASE_URL);

describe("ODS 查询 DSL 契约", () => {
  it.skipIf(!enabled)("从平台库解析 ODS 配置并直接在 ClickHouse 聚合", async () => {
    const dataSourceId = randomUUID();
    const configId = randomUUID();
    const tableName = `ods_query_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const definition = ontologyDefinitionSchema.parse({
      entityTypes: [{
        id: randomUUID(),
        name: "客户",
        properties: [
          { name: "客户编号", dataType: "TEXT", sourceField: "CUST_ID" },
          { name: "信用分", dataType: "INTEGER", sourceField: "SCORE" },
        ],
        sources: [{ id: "primary", dataSourceId, readMode: "ODS", schema: "S", view: "CUSTOMER", primaryKey: ["CUST_ID"] }],
      }],
      relationshipTypes: [],
    });
    const source = {
      sourceId: configId,
      tableName,
      primaryKeyColumns: ["CUST_ID"],
      columns: [
        { name: "CUST_ID", sourceType: "VARCHAR2(20)", clickhouseType: "String", nullable: false, primaryKey: true },
        { name: "SCORE", sourceType: "NUMBER(18)", clickhouseType: "Int64", nullable: true, primaryKey: false },
      ],
    };
    async function* rows() {
      yield { CUST_ID: "A", SCORE: 91 };
      yield { CUST_ID: "B", SCORE: 72 };
      yield { CUST_ID: "C", SCORE: 88 };
    }
    const repo = await platformRepo(OdsSourceEntity);
    try {
      await getOdsStore().writeFull({ spec: source, rows: rows(), batchId: Date.now() });
      await repo.save(repo.create({
        id: configId,
        dataSourceId,
        schemaName: "S",
        tableName: "CUSTOMER",
        tableKind: "table",
        columns: jsonValue(source.columns),
        primaryKeyColumns: jsonValue(["CUST_ID"]),
        watermarkColumn: "",
        syncMode: "FULL",
        enabled: true,
        chTable: tableName,
        status: "READY",
        lastSyncAt: new Date(),
        lastSyncJobId: null,
        rowCount: "3",
        lastError: null,
        lastWatermark: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      const plan = resolveQueryDsl(definition, toQueryDsl("SELECT COUNT(*) AS 条数, SUM(信用分) AS 总分 FROM 客户 WHERE 信用分 >= 80", definition));
      const result = await getOdsQueryExecutor().executeLogicalQuery(plan);
      expect(result).toMatchObject({ data_source: "ClickHouse ODS", columns: ["条数", "总分"] });
      expect(Number(result?.rows[0][0])).toBe(2);
      expect(Number(result?.rows[0][1])).toBe(179);
    } finally {
      await getOdsStore().drop(configId, tableName).catch(() => undefined);
      await repo.delete({ id: configId }).catch(() => undefined);
    }
  }, 20_000);
});
