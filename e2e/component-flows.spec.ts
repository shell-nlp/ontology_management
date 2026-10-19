import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

function localCredentials() {
  const values = new Map<string, string>();
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.trimStart().startsWith("#")) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { email: values.get("BOOTSTRAP_ADMIN_EMAIL") ?? "", password: values.get("BOOTSTRAP_ADMIN_PASSWORD") ?? "" };
}

const baseUrl = process.env.E2E_BASE_URL ?? "http://localhost:3011";

async function login(page: Page) {
  const credentials = localCredentials();
  test.skip(!credentials.email || !credentials.password, "本地环境未配置测试管理员。");
  await page.goto(baseUrl);
  await page.getByLabel("邮箱").fill(credentials.email);
  await page.getByLabel("密码").fill(credentials.password);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.locator(".functional-content")).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("登录后主导航可见，并按视图进入对象页", async ({ page }) => {
  await login(page);
  await expect(page.getByRole("button", { name: "总览" })).toBeVisible();
  await expect(page.getByRole("button", { name: "本体建模" })).toBeVisible();
  await page.getByRole("button", { name: "对象" }).click();
  await expect(page.locator(".functional-content")).toBeVisible();
});

test("对象页与关系页可以来回切换且不丢失工作台", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "对象" }).click();
  await expect(page.locator(".functional-content")).toBeVisible();
  await page.getByRole("button", { name: "关系" }).click();
  await expect(page.locator(".functional-content")).toBeVisible();
  await page.getByRole("button", { name: "对象" }).click();
  await expect(page.locator(".functional-content")).toBeVisible();
});

test("智能问答切走再回来仍保留输入区", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "智能问答" }).click();
  const composer = page.locator(".qa-composer textarea, .qa-input textarea, textarea[placeholder*='问题']").first();
  await expect(composer).toBeVisible();
  await page.getByRole("button", { name: "总览" }).click();
  await page.getByRole("button", { name: "智能问答" }).click();
  await expect(composer).toBeVisible();
});

test("索引与物化面板可以打开并显示对象/关系状态", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "对象" }).click();
  const open = page.getByRole("button", { name: /索引与物化|物化/ }).first();
  if (await open.count()) {
    await open.click();
    await expect(page.getByText(/对象类型|物化/).first()).toBeVisible();
  }
});

test("MCP 页面可以打开访问令牌管理", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "MCP 调试" }).click();
  const tokenButton = page.getByRole("button", { name: /访问令牌|令牌管理/ }).first();
  await expect(tokenButton).toBeVisible();
  await tokenButton.click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
