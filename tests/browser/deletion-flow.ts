import { expect, type Page, type TestInfo } from "@playwright/test";

export async function deletionFlow(page: Page, testInfo: TestInfo, id: string, title: string) {
  const headers = { origin: "http://127.0.0.1:4187" };
  const path = `/api/bookmarks/${id}`;
  const original = await (await page.request.get(path)).json();
  const card = page.getByRole("article", { name: title, exact: true });
  const panel = page.getByRole("region", { name: "삭제 되돌리기" });
  const dialog = page.getByRole("dialog");
  // Server committed the deletion but the browser lost the response. Retrying uses
  // the same operation ID, so the receipt is recovered rather than deleting anew.
  let operation = "";
  await page.route(`**${path}/deletion`, async (route) => {
    operation = route.request().postDataJSON().operationId as string;
    const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort();
  });
  await card.getByRole("button", { name: `${title} 삭제`, exact: true }).click();
  await expect(dialog).toContainText("60초");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("연결하지 못했습니다");
  expect((await page.request.get(path)).status()).toBe(404);
  await page.unroute(`**${path}/deletion`);
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(card).not.toBeVisible(); await expect(panel).toContainText(title);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: testInfo.outputPath("deletion-undo.png") });
  const restorePath = `/api/bookmark-deletions/${operation}/restore`;
  let restores = 0;
  await page.route(`**${restorePath}`, async (route) => {
    restores++; const result = await route.fetch(); expect(result.ok()).toBe(true); await route.abort();
  });
  await panel.getByRole("button", { name: "되돌리기", exact: true }).dblclick();
  await expect(panel.getByRole("alert")).toContainText("연결하지 못했습니다");
  expect(restores).toBe(1);
  await page.unroute(`**${restorePath}`);
  await panel.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(panel).not.toBeVisible(); await expect(card).toBeVisible();
  const restored = await (await page.request.get(path)).json();
  expect({ ...restored, version: original.version }).toEqual(original); expect(restored.version).toBeGreaterThan(original.version);
  expect((await page.request.patch(path, { headers, data: { version: original.version, note: "stale editor" } })).status()).toBe(409);

  // A newly bookmarked copy of the same URL is never overwritten by undo.
  await card.getByRole("button", { name: `${title} 삭제`, exact: true }).click();
  await dialog.getByRole("button", { name: "삭제", exact: true }).click(); await expect(panel).toBeVisible();
  const duplicate = await (await page.request.post("/api/bookmarks", { headers, data: { title: "다른 창에서 다시 저장", url: original.url, note: "새 내용을 보존" } })).json();
  await panel.getByRole("button", { name: "되돌리기", exact: true }).click();
  await expect(panel.getByRole("alert")).toContainText("덮어쓰지 않았습니다");
  await expect(page.getByRole("article", { name: "다른 창에서 다시 저장", exact: true })).toBeVisible();
  expect((await (await page.request.get(`/api/bookmarks/${duplicate.item.id}`)).json()).note).toBe("새 내용을 보존");
  await panel.screenshot({ path: testInfo.outputPath("deletion-conflict.png") });
  await page.request.delete(`/api/bookmarks/${duplicate.item.id}`, { headers, data: { version: duplicate.item.version } });
  await panel.getByRole("button", { name: "되돌리기", exact: true }).click(); await expect(card).toBeVisible();

  // Shorten only the browser's display budget; the exact server deadline is tested
  // with a deterministic clock in deletions.test.ts (no product clock bypass).
  const expiredTitle = `시간 만료 UI ${testInfo.project.name}`;
  const expiring = (await (await page.request.post("/api/bookmarks", { headers, data: {
    title: expiredTitle, url: `https://www.zophar.net/music/snes/expired-${testInfo.project.name}.html`,
  } })).json()).item;
  await page.reload();
  await page.route(`**/api/bookmarks/${expiring.id}/deletion`, async (route) => {
    const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), remainingMs: 500 } });
  });
  await page.getByRole("article", { name: expiredTitle, exact: true }).getByRole("button", { name: `${expiredTitle} 삭제`, exact: true }).click();
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(panel.getByRole("button", { name: "되돌리기", exact: true })).toBeDisabled();
  await expect(panel).toContainText("복구 시간 만료");
  await panel.screenshot({ path: testInfo.outputPath("deletion-expired.png") });
  await page.unroute(`**/api/bookmarks/${expiring.id}/deletion`);
  await panel.getByRole("button", { name: `${expiredTitle} 삭제 안내 닫기`, exact: true }).click();
  await expect(panel).not.toBeVisible(); await expect(card).toBeVisible();
}
