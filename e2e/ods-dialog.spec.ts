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

test("表清单优先显示对象类型和 ODS 使用的表，并标注用途", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  let dddOdsDeleted = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let json: unknown = {};
    if (path === "/api/auth/session") {
      json = { user: { id: "user", email: "fixture@example.test", roleId: "admin", roleName: "管理员", permissions: ["ontology.read", "datasource.read", "datasource.write", "instance.read", "target.read"] } };
    } else if (path === "/api/targets") {
      json = [{ id: targetId, name: "验收", kind: "EMBEDDED", uri: "", options: {} }];
    } else if (path === "/api/ontologies") {
      json = [{ id: targetId, name: "验收本体", target_id: targetId, color: "#2563eb", tags: [], storage: { id: targetId, name: "验收", kind: "EMBEDDED", uri: "", managed: true }, versions: { published: 1, draft: null }, statistics: { objectTypes: 1, relationTypes: 0, objects: 0, relationships: 0 } }];
    } else if (path === "/api/ontology") {
      json = [{
        id: versionId,
        target_id: targetId,
        version_number: 1,
        status: "PUBLISHED",
        definition: {
          groups: [],
          interfaces: [],
          metrics: [],
          entityTypes: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              name: "专线产品用户",
              properties: [],
              sources: [
                { id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "BBB_BOUND_ONLY", primaryKey: ["USER_ID"] },
                { id: "extra", dataSourceId: sourceId, schema: "GISTOOLS", view: "DDD_BOTH", primaryKey: ["USER_ID"] },
              ],
            },
          ],
          relationshipTypes: [],
          actionTypes: [],
          rules: [],
        },
      }];
    } else if (path === "/api/instances/types") {
      json = { labels: [], relationshipTypes: [], propertyKeys: [] };
    } else if (path === "/api/data-sources") {
      json = [{ id: sourceId, name: "oracle-test", kind: "ORACLE", kindLabel: "Oracle", modelLabel: "关系库", host: "39.164.136.34", port: 1251, databaseName: "orcl", schemaName: "GISTOOLS", username: "sk_ws", options: {}, enabled: true, createdAt: "2026-10-20T00:00:00Z", address: "oracle-test · orcl / GISTOOLS" }];
    } else if (path === `/api/data-sources/${sourceId}/views`) {
      json = {
        views: [
          { schema: "GISTOOLS", name: "AAA_UNUSED", kind: "table", columnCount: 2, comment: "未使用表" },
          { schema: "GISTOOLS", name: "BBB_BOUND_ONLY", kind: "table", columnCount: 2, comment: "只绑对象类型" },
          { schema: "GISTOOLS", name: "CCC_ODS_ONLY", kind: "table", columnCount: 2, comment: "只有 ODS" },
          { schema: "GISTOOLS", name: "DDD_BOTH", kind: "table", columnCount: 2, comment: "对象类型与 ODS" },
        ],
        fetched_at: "2026-10-20T00:00:00Z",
        from_cache: false,
      };
    } else if (path.startsWith(`/api/data-sources/${sourceId}/views/`)) {
      json = {
        fields: [
          { name: "USER_ID", dataType: "VARCHAR2", typeDetail: "VARCHAR2(32)", nullable: false, primaryKey: true, unique: true, comment: "用户 ID", position: 0 },
          { name: "CUST_NAME", dataType: "VARCHAR2", typeDetail: "VARCHAR2(200)", nullable: true, primaryKey: false, unique: false, comment: "客户名称", position: 1 },
        ],
        preview: { columns: ["USER_ID", "CUST_NAME"], rows: [{ USER_ID: "1001", CUST_NAME: "测试客户" }], truncated: false },
        fetched_at: "2026-10-20T00:00:00Z",
        from_cache: false,
      };
    } else if (path === "/api/ods/ods-ddd" && method === "DELETE") {
      dddOdsDeleted = true;
      json = { ok: true };
    } else if (path === "/api/ods") {
      json = {
        sources: [
          { id: "ods-ccc", dataSourceId: sourceId, schemaName: "GISTOOLS", tableName: "CCC_ODS_ONLY", status: "RUNNING", enabled: true, rowCount: 0, lastError: null },
          ...(dddOdsDeleted ? [] : [{ id: "ods-ddd", dataSourceId: sourceId, schemaName: "GISTOOLS", tableName: "DDD_BOTH", status: "READY", enabled: true, rowCount: 1689, lastError: null }]),
        ],
      };
    } else if (path === "/api/ods/jobs") {
      json = { jobs: [] };
    }
    await route.fulfill({ json });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "数据资源", exact: true }).click();
  await expect(page.locator(".drs-list-row")).toHaveCount(4);

  const names = await page.locator(".drs-list-row .drs-list-text b").allTextContents();
  expect(names).toEqual(["DDD_BOTH", "BBB_BOUND_ONLY", "CCC_ODS_ONLY", "AAA_UNUSED"]);
  await expect(page.locator(".drs-list-row").first()).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("对象类型与 ODS 表优先排列", { exact: true })).toBeVisible();

  const both = page.locator(".drs-list-row").filter({ hasText: "DDD_BOTH" });
  await expect(both.getByText("对象类型", { exact: true })).toBeVisible();
  await expect(both.getByText("ODS 可读取", { exact: true })).toBeVisible();
  const removeOds = page.getByRole("button", { name: "删除 ODS", exact: true });
  await expect(removeOds).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("catalog-priority-actions.png"), fullPage: true });
  page.once("dialog", (dialog) => void dialog.accept());
  await removeOds.click();
  await expect(both.getByText("ODS 可读取", { exact: true })).toHaveCount(0);
  await expect(both.getByText("对象类型", { exact: true })).toBeVisible();
  await expect(removeOds).toHaveCount(0);
  const boundOnly = page.locator(".drs-list-row").filter({ hasText: "BBB_BOUND_ONLY" });
  await expect(boundOnly.getByText("对象类型", { exact: true })).toBeVisible();
  const odsOnly = page.locator(".drs-list-row").filter({ hasText: "CCC_ODS_ONLY" });
  await expect(odsOnly.getByText("ODS 同步中", { exact: true })).toBeVisible();
  await expect(page.locator(".drs-list-row").filter({ hasText: "AAA_UNUSED" }).locator(".drs-list-signals")).toHaveCount(0);

  await page.screenshot({ path: test.info().outputPath("catalog-priority.png"), fullPage: true });
});

test("发布缺少 READY ODS 时弹出阻塞项并可跳转到目标表", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path === "/api/auth/session") {
      json = { user: { id: "user", email: "fixture@example.test", roleId: "admin", roleName: "管理员", permissions: ["ontology.read", "ontology.write", "ontology.publish", "datasource.read", "datasource.write", "instance.read", "target.read"] } };
    } else if (path === "/api/targets") {
      json = [{ id: targetId, name: "验收", kind: "EMBEDDED", uri: "", options: {} }];
    } else if (path === "/api/ontologies") {
      json = [{ id: targetId, name: "验收本体", target_id: targetId, color: "#2563eb", tags: [], storage: { id: targetId, name: "验收", kind: "EMBEDDED", uri: "", managed: true }, versions: { published: 1, draft: 1 }, statistics: { objectTypes: 1, relationTypes: 0, objects: 0, relationships: 0 } }];
    } else if (path === "/api/ontology") {
      json = [{
        id: versionId,
        target_id: targetId,
        version_number: 2,
        status: "DRAFT",
        definition: {
          groups: [], interfaces: [], metrics: [],
          entityTypes: [{ id: "44444444-4444-4444-8444-444444444444", name: "客户", properties: [], sources: [{ id: "primary", dataSourceId: sourceId, schema: "GISTOOLS", view: "CUSTOMER", primaryKey: ["CUST_ID"] }] }],
          relationshipTypes: [], actionTypes: [], rules: [],
        },
      }];
    } else if (path === `/api/ontology/${versionId}/publish`) {
      json = {
        error: "有 1 个对象类型缺少可发布的 READY ODS 镜像。",
        blockers: [{
          entityTypeId: "44444444-4444-4444-8444-444444444444",
          entityType: "客户",
          dataSourceId: sourceId,
          schema: "GISTOOLS",
          table: "CUSTOMER",
          reason: "还没有配置 ODS 镜像。",
        }],
      };
      await route.fulfill({ status: 409, json });
      return;
    } else if (path === "/api/instances/types") {
      json = { labels: [], relationshipTypes: [], propertyKeys: [] };
    } else if (path === "/api/data-sources") {
      json = [{ id: sourceId, name: "oracle-test", kind: "ORACLE", kindLabel: "Oracle", modelLabel: "关系库", host: "39.164.136.34", port: 1251, databaseName: "orcl", schemaName: "GISTOOLS", username: "sk_ws", options: {}, enabled: true, createdAt: "2026-10-20T00:00:00Z", address: "oracle-test · orcl / GISTOOLS" }];
    } else if (path === `/api/data-sources/${sourceId}/views`) {
      json = { views: [{ schema: "GISTOOLS", name: "OTHER", kind: "table", columnCount: 1, comment: "其他表" }, { schema: "GISTOOLS", name: "CUSTOMER", kind: "table", columnCount: 2, comment: "目标表" }], fetched_at: "2026-10-20T00:00:00Z", from_cache: false };
    } else if (path.startsWith(`/api/data-sources/${sourceId}/views/`)) {
      json = {
        fields: [{ name: "CUST_ID", dataType: "VARCHAR2", typeDetail: "VARCHAR2(20)", nullable: false, primaryKey: true, unique: true, comment: "客户编号", position: 0 }],
        preview: { columns: ["CUST_ID"], rows: [{ CUST_ID: "A" }], truncated: false },
        fetched_at: "2026-10-20T00:00:00Z", from_cache: false,
      };
    } else if (path === "/api/ods") {
      json = { sources: [] };
    } else if (path === "/api/ods/jobs") {
      json = { jobs: [] };
    }
    await route.fulfill({ json });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "本体建模", exact: true }).click();
  await page.getByRole("button", { name: "发布", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "先补齐 READY 的 ODS 镜像" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("客户", { exact: true })).toBeVisible();
  await expect(dialog.getByText("GISTOOLS.CUSTOMER", { exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("ods-publish-blocker-dialog.png"), fullPage: true });
  await dialog.getByRole("button", { name: /去配置 ODS/ }).click();
  await expect(page.locator(".drs-list-row.active")).toContainText("CUSTOMER");
  await expect(page.getByText("GISTOOLS.CUSTOMER", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("ods-publish-blocker.png"), fullPage: true });
});
