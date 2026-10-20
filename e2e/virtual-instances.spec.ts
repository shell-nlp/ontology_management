import { expect, test } from "@playwright/test";
import { ontologyDefinitionSchema } from "../src/lib/ontology";

const targetId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";
const dsId = "33333333-3333-4333-8333-333333333333";
const definition = ontologyDefinitionSchema.parse({ entityTypes: [{ id: "44444444-4444-4444-8444-444444444444", name: "客户", properties: [{ name: "编号", dataType: "TEXT", sourceField: "ID" }], sources: [{ id: "main", dataSourceId: dsId, schema: "S", view: "T", primaryKey: ["ID"] }] }] });

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    let json: unknown = {};
    if (p === "/api/auth/session") json = { user: { id: "user", email: "fixture@example.test", roleId: "admin", roleName: "管理员", permissions: ["ontology.read", "ontology.write", "instance.read", "instance.write", "target.read", "datasource.read"] } };
    else if (p === "/api/targets") json = [{ id: targetId, name: "验收", kind: "EMBEDDED", uri: "", options: {} }];
    else if (p === "/api/ontologies") json = [{ id: targetId, name: "验收本体", target_id: targetId, color: "#2563eb", tags: [], storage: { id: targetId, name: "验收", kind: "EMBEDDED", uri: "", managed: true }, versions: { published: 1, draft: null }, statistics: { objectTypes: 1, relationTypes: 0, objects: 0, relationships: 0 } }];
    else if (p === "/api/ontology") json = [{ id: versionId, target_id: targetId, version_number: 1, status: "PUBLISHED", definition }];
    else if (p === "/api/instances/types") json = { labels: [], relationshipTypes: [], propertyKeys: [] };
    else if (p === "/api/instances/meta") json = { labels: [], relationshipTypes: [], propertyKeys: [] };
    else if (p === "/api/data-sources") json = [];
    else if (p === "/api/objects/history") json = url.searchParams.has("snapshotId") ? { rows: [{ objectId: "frozen", entityType: "客户", title: "历史客户", properties: { 编号: "OLD" } }], total: 1 } : { snapshots: [{ id: versionId, status: "DONE", rows: 1, pages: 1, entityTypes: ["客户"], createdAt: "2026-10-20T00:00:00Z", finishedAt: "2026-10-20T00:00:01Z", message: "采集区间" }] };
    else if (p === "/api/objects") json = { rows: [{ objectId: targetId, entityType: "客户", properties: { 编号: "A" }, primaryKey: { ID: "A" }, origin: "source" }], total: 1, warnings: [] };
    else if (p === "/api/links") json = { links: [], warnings: [], truncated: false };
    else if (p === "/api/instances/graph") json = { nodes: [], relationships: [], warnings: [] };
    else if (p === "/api/object-search") json = { stats: { entries: 0, byLabel: [] }, capabilities: {} };
    await route.fulfill({ json });
  });
  await page.goto("/");
  await expect(page.locator(".functional-content")).toBeVisible();
});

test("历史弹窗回看冻结数据并预热当前页", async ({ page }) => {
  await page.getByRole("button", { name: "对象", exact: true }).click();
  await page.getByRole("button", { name: "历史数据", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "历史数据快照" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("history-dialog.png"), fullPage: true });
  await page.getByRole("button", { name: "查看", exact: true }).click();
  await expect(page.getByText("客户 / 历史客户", { exact: true })).toBeVisible();
  const warm = page.waitForRequest((request) => request.url().includes("warm=1"));
  await page.getByRole("button", { name: "预热", exact: true }).click();
  await warm;
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("全部标签直接显示虚拟对象，界面不再要求物化", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/objects?")) requests.push(request.url()); });
  await page.getByRole("button", { name: "对象", exact: true }).click();
  await expect(page.locator(".manager-row").filter({ hasText: "A" })).toBeVisible();
  expect(requests.some((url) => !new URL(url).searchParams.has("entityType"))).toBe(true);
  await expect(page.getByRole("button", { name: "索引与物化", exact: true })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "来源：物化索引", exact: true })).toHaveCount(0);
  await page.locator(".manager-row").filter({ hasText: "A" }).click();
  await expect(page.getByText("数据新鲜度取决于来源及 ODS 同步时间。", { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("virtual-objects.png"), fullPage: true });
});

test("图谱明确选择三跳，并将限制传到邻域接口", async ({ page }) => {
  await page.getByRole("button", { name: "实例图谱", exact: true }).click();
  await page.getByLabel("邻域跳数").selectOption("3");
  await page.locator("label.graph-head-filter").filter({ hasText: "业务对象" }).locator("select").selectOption("客户");
  const links = page.waitForRequest((request) => request.url().includes("/api/links?") && request.url().includes("depth=3"));
  await page.getByRole("button", { name: "从数据源加载", exact: true }).click();
  const request = await links;
  expect(new URL(request.url()).searchParams.get("maxLinks")).toBe("2000");
});
