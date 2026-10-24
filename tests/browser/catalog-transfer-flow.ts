import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";
import type { CatalogArchive, CatalogArchiveV2 } from "../../src/shared/catalog-transfer.ts";
import type { CatalogLibraryItem } from "../../src/shared/catalog-library.ts";

export async function catalogTransferFlow(page: Page, testInfo: TestInfo, rootId: string) {
  const dialog = page.getByRole("dialog"), headers = { origin: String(testInfo.project.use.baseURL) };
  const shot = async (name: string) => { await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }); };
  const manage = async () => { await page.getByRole("button", { name: "내 계정", exact: true }).click(); await dialog.getByRole("button", { name: "데이터 관리", exact: true }).click(); };
  const select = async (archive: CatalogArchive) => {
    await dialog.getByLabel("LoopShelf JSON 파일", { exact: true }).setInputFiles({ name: "catalog.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(archive)) });
    await dialog.getByRole("button", { name: "파일 검사", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toBeVisible();
  };
  const download = async () => {
    const wait = page.waitForEvent("download"); await dialog.getByRole("button", { name: "카탈로그 JSON 내보내기", exact: true }).click();
    const file = await wait; expect(file.suggestedFilename()).toContain("loopshelf-catalog-");
    return JSON.parse(await readFile((await file.path())!, "utf8")) as CatalogArchiveV2;
  };
  await manage(); const archive = await download(); expect(archive.format).toBe("loopshelf-catalog"); expect(archive.schemaVersion).toBe(2); expect(archive.items.length).toBeGreaterThan(12);
  expect(JSON.stringify(archive)).not.toContain("星の記憶 — 기억의 앨범"); expect(JSON.stringify(archive)).not.toContain("durationMs");
  await select(archive); await expect(dialog).toContainText("원본 미연결로 복원: 0개");
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText(`동일 항목${archive.items.length}개`);
  // Delete one save after preview: confirmation must reject the stale snapshot.
  const existing = (await (await page.request.get(`/api/library/catalog?q=${encodeURIComponent("새로 발견")}`)).json()).items[0] as CatalogLibraryItem;
  expect((await page.request.delete(`/api/library/catalog/${existing.id}`, { headers, data: { version: existing.version } })).status()).toBe(204);
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("검사 후 선반이나 파일이 바뀌었거나");
  await dialog.getByRole("button", { name: "파일 검사", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText("추가1개");
  await page.route("**/api/library/import", async (route) => { await route.fetch(); await route.abort(); });
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await page.unroute("**/api/library/import"); await dialog.getByRole("button", { name: "파일 검사", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText(`동일 항목${archive.items.length}개`);
  const restored = await (await page.request.get(`/api/library/catalog/${existing.id}`)).json() as CatalogLibraryItem;
  expect(restored.version).toBeGreaterThan(existing.version); expect(restored.entity.id).toBe(existing.entity.id);

  // Simulate a file from another installation: same URLs with different internal IDs stay unresolved.
  const incoming = structuredClone(archive); incoming.items = [structuredClone(archive.items.find((item) => item.id === rootId)!)];
  const item = incoming.items[0]!; item.reference.sampleKind = "live-capture"; item.id = randomUUID(); item.reference.entityId = randomUUID(); item.reference.albumId = item.reference.entityId;
  item.reference.source.id = randomUUID(); item.titleOverride = "[이식] 나의 앨범"; item.note = "<script>실행하지 않을 이식 메모</script>";
  for (const link of item.sourceLinks) { link.reference.sampleKind = "live-capture"; link.reference.entityId = randomUUID(); link.reference.albumId = link.reference.entityId; link.reference.source.id = randomUUID(); }
  await select(incoming); await expect(dialog).toContainText("원본 미연결로 복원: 1개");
  await dialog.getByRole("region", { name: "가져오기 검사 결과" }).scrollIntoViewIfNeeded(); await shot("catalog-import-preview");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "확인하고 가져오기", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("카탈로그 개인 항목 1개와 출처 연결 1개");
  const exported = await download(); expect(exported.items.find((row) => row.id === item.id)).toEqual(item);
  await select(incoming); await expect(dialog.getByRole("region", { name: "가져오기 검사 결과" })).toContainText("동일 항목1개");
  const different = structuredClone(incoming); different.items[0]!.note = "다른 내용";
  await select(different); await expect(dialog.getByRole("alert")).toContainText("충돌이 있어 아무것도 가져올 수 없습니다");
  await dialog.getByRole("alert").scrollIntoViewIfNeeded(); await shot("catalog-import-conflict");
  await dialog.getByRole("button", { name: "완료", exact: true }).click();
  async function search(value: string) { await page.getByLabel("저장한 카탈로그 검색", { exact: true }).fill(value); await page.getByRole("button", { name: "검색", exact: true }).click(); }
  await search("[이식]"); const card = page.getByRole("article", { name: item.titleOverride!, exact: true });
  await expect(card).toContainText("원본 카탈로그 미연결"); await expect(card).toContainText("외부 자료 참조"); await expect(card).toContainText("<script>실행하지 않을 이식 메모</script>");
  await card.scrollIntoViewIfNeeded(); await shot("catalog-imported-item");
  await card.getByRole("button", { name: `${item.titleOverride} 편집`, exact: true }).click();
  await page.getByLabel("메모 선택", { exact: true }).fill("편집한 이식 메모"); await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(card).toContainText("편집한 이식 메모");
  await card.getByRole("button", { name: `${item.titleOverride} 출처 보기`, exact: true }).click();
  await expect(dialog).toContainText("다른 설치에서 가져온 원본 미연결 항목"); await expect(dialog.getByRole("button", { name: "추가 출처 선택", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "이 출처 해제", exact: true }).click(); await dialog.getByRole("button", { name: "연결 해제 확인", exact: true }).click();
  await expect(dialog).toContainText("추가로 연결한 앨범이 없습니다"); await dialog.getByRole("button", { name: "완료", exact: true }).click();
  await card.getByRole("button", { name: `${item.titleOverride} 삭제`, exact: true }).click(); await dialog.getByRole("button", { name: "개인 저장 삭제", exact: true }).click();
  await expect(card).toHaveCount(0); expect((await page.request.get(`/api/library/catalog/${item.id}`)).status()).toBe(404);
  await search("기억"); await expect(page.getByRole("article", { name: "[합성] 星の記憶 — 기억의 앨범", exact: true })).toBeVisible();
}
