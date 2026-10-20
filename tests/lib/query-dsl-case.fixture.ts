import { ontologyDefinitionSchema } from "@/lib/ontology";

export const telecomCaseSql = "SELECT COUNT(DISTINCT USER_ID) AS 状态正常用户数, SUM(ZX_COUNT) AS 状态正常专线条数, COUNT(DISTINCT CUST_ID) AS 订购集团单位数, COUNT(DISTINCT CASE WHEN ZX_FLAG = '1' THEN USER_ID END) AS 数据专线用户数, SUM(CASE WHEN ZX_FLAG = '1' THEN ZX_COUNT ELSE 0 END) AS 数据专线条数 FROM 专线产品用户 WHERE STATIS_DATE >= '2026-09-13' AND STATIS_DATE < '2026-09-14' AND STATS NOT IN ('1','3')";
export const telecomScope = "STATIS_DATE >= '2026-09-13' AND STATIS_DATE < '2026-09-14' AND STATS NOT IN ('1','3')";
export function caseDefinition(sourceId = "99999999-9999-4999-8999-999999999999", table = "CASE_LINES", schema = "S") {
  return ontologyDefinitionSchema.parse({ entityTypes: [{
    id: "11111111-1111-4111-8111-111111111111", name: "专线产品用户",
    properties: [
      { name: "ROW_ID", dataType: "INTEGER", sourceField: "ROW_ID", primaryKey: true },
      { name: "USER_ID", dataType: "TEXT", sourceField: "USER_ID" },
      { name: "CUST_ID", dataType: "TEXT", sourceField: "CUST_ID" },
      { name: "ZX_FLAG", dataType: "TEXT", sourceField: "ZX_FLAG" },
      { name: "ZX_COUNT", dataType: "INTEGER", sourceField: "ZX_COUNT" },
      { name: "STATIS_DATE", dataType: "DATE", sourceField: "STATIS_DATE" },
      { name: "STATS", dataType: "TEXT", sourceField: "STATS" },
      { name: "FEE", dataType: "DECIMAL", sourceField: "FEE" },
      { name: "BIG_ID", dataType: "INTEGER", sourceField: "BIG_ID" },
    ],
    sources: [{ id: "main", dataSourceId: sourceId, schema, view: table, primaryKey: ["ROW_ID"], readMode: "AUTO" }],
  }], relationshipTypes: [] });
}
