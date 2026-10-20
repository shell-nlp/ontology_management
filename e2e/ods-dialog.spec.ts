import { expect, test } from "@playwright/test";

const targetId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";

test("ODS 镜像弹窗在常见视口内完整渲染并可滚动正文", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown = {};
    if (path === "/api/auth/session") {
      json = { user: { id: "user", email: "fixture@example.test", roleId: "admin", roleName: "管理员", permissions: ["ontology.read", "datasource.read", "datasource.write", "instance.read", "target.read"] } };
    } else if (path === "/api/targets") {
      json = [{ id: targetId, name: "验收", kind: "EMBEDDED", uri: "", options: {} }];
    } else if (path === "/api/ontologies") {
      json = [{ id: targetId, name: "验收本体", target_id: targetId, color: "#2563eb", tags: [], storage: { id: targetId, name: "验收", kind: "EMBEDDED", uri: "", managed: true }, versions: { published: 1, draft: null }, statistics: { objectTypes: 1, relationTypes: 0, objects: 0, relationships: 0 } }];
    } else if (path === "/api/ontology") {
      json = [{ id: versionId, target_id: targetId, version_number: 1, status: "PUBLISHED", definition: { groups: [], interfaces: [], metrics: [], entityTypes: [], relationshipTypes: [], actionTypes: [], rules: [] } }];
    } else if (path === "/api/instances/types") {
      json = { labels: [], relationshipTypes: [], propertyKeys: [] };
    } else if (path === "/api/data-sources") {
      json = [{ id: sourceId, name: "oracle-test", kind: "ORACLE", kindLabel: "Oracle", modelLabel: "关系库", host: "39.164.136.34", port: 1251, databaseName: "orcl", schemaName: "GISTOOLS", username: "sk_ws", options: {}, enabled: true, createdAt: "2026-10-20T00:00:00Z", address: "oracle-test · orcl / GISTOOLS" }];
    } else if (path === `/api/data-sources/${sourceId}/views`) {
      json = { views: [{ schema: "GISTOOLS", name: "TB_MK_GRP_LINE_LIST_DAY", kind: "table", columnCount: 37, comment: "集团专线清单" }], fetched_at: "2026-10-20T00:00:00Z", from_cache: false };
    } else if (path === `/api/data-sources/${sourceId}/views/TB_MK_GRP_LINE_LIST_DAY`) {
      const names = ["STATIS_DATE", "AREA_CODE", "SALE_ID", "USER_ID", "SERV_NUMBER", "CUST_ID", "CUST_NAME", "SERV_LEVEL_ID", "OFFER_NAME", "STATS", "ZX_COUNT", "ORDER_DATE"];
      json = {
        fields: names.map((name, position) => ({ name, dataType: position === 0 ? "DATE" : name.includes("COUNT") ? "NUMBER" : "VARCHAR2", typeDetail: position === 0 ? "DATE" : name.includes("COUNT") ? "NUMBER(10)" : "VARCHAR2(32)", nullable: position !== 0, primaryKey: name === "STATIS_DATE", unique: false, comment: position === 0 ? "统计日期" : "业务字段", position })),
        preview: { columns: names.slice(0, 6), rows: [{ STATIS_DATE: "2026-08-19", AREA_CODE: "371", SALE_ID: "AA", USER_ID: "16510319321213", SERV_NUMBER: "93710998186", CUST_ID: "16540800372450" }], truncated: false },
        fetched_at: "2026-10-20T00:00:00Z",
        from_cache: false,
      };
    } else if (path === "/api/ods") {
      json = { sources: [] };
    } else if (path === "/api/ods/jobs") {
      json = { jobs: [] };
    }
    await route.fulfill({ json });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "数据资源", exact: true }).click();
  await expect(page.getByText("TB_MK_GRP_LINE_LIST_DAY", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "ODS 镜像", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "ODS 源表镜像" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeLessThanOrEqual(900);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  await expect(page.getByRole("button", { name: "关闭 ODS 镜像配置" })).toBeVisible();
  await expect(page.getByRole("button", { name: "保存配置", exact: true })).toBeVisible();

  const body = page.locator(".ods-dialog-body");
  expect(await body.evaluate((element) => getComputedStyle(element).overflowY)).toBe("auto");
  expect(await body.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("ods-dialog.png"), fullPage: true });
});
