import { test, expect } from "@playwright/test";

test("Vite middleware shares the actual login and Host/Origin boundary", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("이메일", { exact: true }).fill("alice@example.test");
  await page.getByLabel("비밀번호", { exact: true }).fill("browser-test-password-123");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  expect(await page.evaluate(async () => await caches.keys())).toEqual([]);
  expect((await page.request.get("/sw.js")).status()).toBe(404);
  expect((await page.request.get("/api/unknown")).status()).toBe(404);
  expect((await page.request.post("/api/bookmarks", { headers: { origin: "http://example.test" }, data: {} })).status()).toBe(403);
  const response = await page.request.get("/api/bookmarks");
  expect(response.headers()["cache-control"]).toBe("no-store");
  expect((await page.request.get(`/@fs/${process.cwd()}/package.json`)).status()).toBe(403);
});
