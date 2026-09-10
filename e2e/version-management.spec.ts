import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

function localCredentials() {
  const values = new Map<string, string>();
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0 && !line.trimStart().startsWith("#")) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return { email: values.get("BOOTSTRAP_ADMIN_EMAIL") ?? "", password: values.get("BOOTSTRAP_ADMIN_PASSWORD") ?? "" };
}

for (const viewport of [{ name: "desktop", width: 1440, height: 900 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`版本工作区在${viewport.name}视口可用`, async ({ page }) => {
    const credentials = localCredentials();
    test.skip(!credentials.email || !credentials.password, "本地环境未配置测试管理员。");
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("http://localhost:3011");
    await page.getByLabel("邮箱").fill(credentials.email);
    await page.getByLabel("密码").fill(credentials.password);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.locator(".version-bar")).toBeVisible();
    await expect(page.locator(".functional-content")).toBeVisible();
    await page.waitForTimeout(1000);
    if (viewport.name === "desktop") {
      const response = await page.request.post("http://localhost:3011/api/query", {
        data: { targetId: "00000000-0000-4000-8000-000000000000", query: "CREATE (n:ForbiddenProbe)", confirmWrite: true },
      });
      expect(response.status()).toBe(409);
    }
    const box = await page.locator(".version-bar").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    await page.screenshot({ path: test.info().outputPath(`version-workspace-${viewport.name}.png`), fullPage: true });
  });
}
