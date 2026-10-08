import { describe, expect, it } from "vitest";
import { cachedColumnValueIndex, ensureColumnProfile } from "@/lib/column-profile";
import { listDataSources } from "@/lib/data-sources";
import { rankSchemaConcepts, schemaConcepts } from "@/lib/reasoning/tools";
import type { OntologyDefinition } from "@/lib/ontology";

/**
 * 列画像的**真实通道**契约：真采一次 Oracle → 写平台库缓存 → 第二次命缓存 → 进取值索引 → 能被检索命中。
 *
 * **默认跳过**（和 `object-index/postgres.contract.test.ts` 同一个理由）：`pnpm test` 不该依赖数据库与业务库。
 * 要真跑，把两个坐标用环境变量传进来（挑一张**被对象类型绑定**的表，因为没绑定的表按设计不采）：
 *
 *   $env:DATABASE_URL="<平台库>"; $env:ONTOLOGY_PROFILE_DATA_SOURCE="oracle-test"; `
 *   $env:ONTOLOGY_PROFILE_TABLE="GISTOOLS.TB_MK_GRP_ALL_SMDK_QUERY_DAY"
 *   node ./node_modules/vitest/vitest.mjs run tests/lib/column-profile.contract.test.ts
 *
 * 它会往 `ontology_platform.column_profiles` 写一行（同一张表覆盖），不会动本体定义。
 */
const profileTarget = process.env.ONTOLOGY_PROFILE_TABLE?.trim() ?? "";
const dataSourceName = process.env.ONTOLOGY_PROFILE_DATA_SOURCE?.trim() ?? "";
const enabled = Boolean(process.env.DATABASE_URL && profileTarget && dataSourceName);
const [SCHEMA, TABLE] = (() => {
  const [schema, ...rest] = profileTarget.split(".");
  return rest.length ? [schema, rest.join(".")] : [process.env.ONTOLOGY_PROFILE_SCHEMA?.trim() ?? "", schema];
})();

function definitionFor(dataSourceId: string): OntologyDefinition {
  return {
    groups: [], interfaces: [], metrics: [],
    entityTypes: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "行业端口短彩信产品用户",
      description: "",
      displayProperty: "",
      groupId: "",
      implements: [],
      properties: [{ name: "用户状态", dataType: "TEXT", required: false, unique: false, indexed: false, sourceField: "USR_STATUS" }],
      sources: [{ id: "primary", dataSourceId, schema: SCHEMA, view: TABLE, primaryKey: [], titleField: "" }],
    }],
    relationshipTypes: [], actionTypes: [], rules: [],
  } as unknown as OntologyDefinition;
}

describe("列画像真实通道", () => {
  it.skipIf(!enabled)("需要 DATABASE_URL + ONTOLOGY_PROFILE_DATA_SOURCE + ONTOLOGY_PROFILE_TABLE：见文件头", () => {
    // 真正的用例在下面那条；这条只是"为什么没跑"的说明。
  });

  it.skipIf(!enabled)("采样一次 → 写缓存 → 第二次命中缓存 → 进取值索引 → 检索命中", async () => {
    const record = (await listDataSources()).find((item) => item.name === dataSourceName);
    expect(record, `本机要有叫 ${dataSourceName} 的数据资源`).toBeTruthy();
    const definition = definitionFor(record!.id);

    const first = await ensureColumnProfile({ definition, record: record!, view: { schema: SCHEMA, name: TABLE } });
    console.log("首次:", JSON.stringify({ cached: first.cached, warning: first.warning, sampleSize: first.profile?.sampleSize, columns: first.profile?.columns }));
    expect(first.warning).toBeUndefined();
    expect(first.profile?.sampleSize).toBeGreaterThan(0);

    const second = await ensureColumnProfile({ definition, record: record!, view: { schema: SCHEMA, name: TABLE } });
    expect(second.cached).toBe(true);
    expect(second.profile?.columns).toEqual(first.profile?.columns);

    const index = await cachedColumnValueIndex(definition);
    console.log("取值索引:", JSON.stringify([...index.entries()].map(([key, columns]) => [key, [...columns.keys()]])));
    expect(index.get(`${SCHEMA}.${TABLE}`)?.get("USR_STATUS")).toEqual(first.profile?.columns[0].values);

    // 走到检索层：真实采样出来的码值要能被 search_schema 以 matched=value 命中，并给出落点。
    const value = first.profile!.columns[0].values.find((item) => item.trim().length >= 2)!;
    const ranked = rankSchemaConcepts(schemaConcepts(definition, null, [], index), value, 20);
    const hit = ranked.find((item) => item.source_column === "USR_STATUS");
    console.log("取值检索:", JSON.stringify({ value, matched: hit?.matched, name: hit?.name, bound_table: hit?.bound_table }));
    expect(hit?.matched).toBe("value");
  }, 120_000);
});
