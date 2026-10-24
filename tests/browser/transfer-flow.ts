import { readFile } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";
import type { BookmarkArchive } from "../../src/shared/transfer.ts";
import type { BookmarkConnections } from "../../src/shared/bookmarks.ts";

export async function transferFlow(page: Page, testInfo: TestInfo, rootId: string) {
  const headers = { origin: "http://127.0.0.1:4187" };
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByRole("button", { name: "데이터 관리", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "데이터 내보내기·가져오기", exact: true });
  const input = dialog.getByLabel("LoopShelf JSON 파일", { exact: true });
  const select = async (value: unknown, name = "loopshelf-test.json") => {
    await input.setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
    await expect(dialog.getByRole("button", { name: "파일 검사", exact: true })).toBeEnabled();
  };
  const preview = async () => {
    await dialog.getByRole("button", { name: "파일 검사", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toBeVisible();
  };
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "JSON 내보내기", exact: true }).click();
  const file = await downloaded; expect(file.suggestedFilename()).toMatch(/^loopshelf-\d{4}-\d{2}-\d{2}\.json$/);
  const path = testInfo.outputPath("library.json"); await file.saveAs(path);
  const archive = JSON.parse(await readFile(path, "utf8")) as BookmarkArchive;
  expect(archive.bookmarks).toHaveLength(3); expect(archive.connections).toHaveLength(2);
  await input.setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("not JSON") });
  await expect(dialog.getByRole("alert")).toContainText("JSON 파일을 읽을 수 없습니다");
  await expect(dialog.getByRole("button", { name: "파일 검사", exact: true })).toHaveCount(0);
  await select(archive); await preview();
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText("동일 항목3개");
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("동일한 3개는 유지");
  const conflict = structuredClone(archive); conflict.bookmarks[0]!.note = "충돌하는 백업 메모";
  await select(conflict); await preview();
  await expect(dialog.getByRole("alert")).toContainText("충돌이 있어");
  await expect(dialog.getByRole("button", { name: "확인하고 가져오기", exact: true })).toHaveCount(0);
  await dialog.getByRole("region", { name: "가져오기 검사 결과" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("import-conflict.png") });

  // Remove only these synthetic records through authenticated APIs, then restore the downloaded file.
  for (const connection of archive.connections) {
    const group = await (await page.request.get(`/api/bookmarks/${rootId}/connections`)).json() as BookmarkConnections;
    const member = group.members.find((item) => item.id === connection.memberId)!;
    expect((await page.request.delete(`/api/bookmarks/${rootId}/connections`, { headers, data: { version: group.root.version, memberId: member.id, memberVersion: member.version } })).ok()).toBe(true);
  }
  for (const item of archive.bookmarks) {
    const current = await (await page.request.get(`/api/bookmarks/${item.id}`)).json();
    expect((await page.request.delete(`/api/bookmarks/${item.id}`, { headers, data: { version: current.version } })).status()).toBe(204);
  }
  await select(archive); await preview();
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText("추가3개");
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText("출처 연결: 2개");
  await dialog.getByRole("region", { name: "가져오기 검사 결과" }).scrollIntoViewIfNeeded();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("import-preview.png") });

  const extra = (await (await page.request.post("/api/bookmarks", { headers, data: {
    title: "[검증용] 검사 후 변경", url: `https://www.zophar.net/music/snes/transfer-concurrent-${testInfo.project.name}.html`,
  } })).json()).item;
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("파일을 다시 검사");
  expect((await page.request.get(`/api/bookmarks/${rootId}`)).status()).toBe(404);
  await page.request.delete(`/api/bookmarks/${extra.id}`, { headers, data: { version: extra.version } });
  await preview();

  // Simulate a committed write whose response was lost. Rechecking must report identical items.
  await page.route("**/api/library/import", async (route) => {
    const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort();
  });
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("연결하지 못했습니다");
  await expect(dialog.getByRole("button", { name: "확인하고 가져오기", exact: true })).toHaveCount(0);
  await page.unroute("**/api/library/import"); await preview();
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText("동일 항목3개");
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("동일한 3개는 유지");
  const restored = await (await page.request.get("/api/library/export")).json() as BookmarkArchive;
  expect(restored.bookmarks).toEqual(archive.bookmarks); expect(restored.connections).toEqual(archive.connections);
  await dialog.getByRole("button", { name: "완료", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "3개 출처 · 개인 연결", exact: true })).toBeVisible();
}
