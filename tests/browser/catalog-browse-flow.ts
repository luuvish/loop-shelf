import { expect, type Page, type TestInfo } from "@playwright/test";
import type { CatalogLibraryItem } from "../../src/shared/catalog-library.ts";

/** Continues the same authenticated scenario; no extra login quota or production fixture route. */
export async function browseFlow(page: Page, testInfo: TestInfo, rootId: string) {
  const dialog = page.getByRole("dialog"), origin = String(testInfo.project.use.baseURL), headers = { origin };
  const shot = async (name: string) => { await page.screenshot({ path: testInfo.outputPath(`${name}.png`) }); };
  const noOverflow = async () => expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const query = async (q: string) => {
    await dialog.getByLabel("앨범 제목 검색", { exact: true }).fill(q);
    await dialog.getByRole("button", { name: "검색", exact: true }).click();
  };
  await page.route("**/api/catalog/albums?*", (route) => route.abort());
  await page.getByRole("button", { name: "카탈로그 둘러보기", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await page.unroute("**/api/catalog/albums?*"); await dialog.getByRole("button", { name: "최신 탐색 결과 확인" }).click();
  await expect(dialog.getByRole("button", { name: "앨범 보기", exact: true })).toHaveCount(12);
  await shot("catalog-browse"); await noOverflow();
  const pages = dialog.getByRole("navigation", { name: "탐색 페이지" });
  // The expired saved album stays on the private shelf, but is excluded from discovery.
  await pages.getByRole("button", { name: "다음 →" }).click(); await expect(dialog.getByRole("button", { name: "앨범 보기", exact: true })).toHaveCount(1);
  await query("없는 조건 100%"); await expect(dialog).toContainText("조건에 맞는 관리 앨범이 없습니다");
  await query(""); await dialog.getByLabel("출처", { exact: true }).selectOption("khinsider");
  await expect(dialog.getByRole("button", { name: "앨범 보기", exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "앨범 보기", exact: true }).first().click();
  await expect(dialog).toContainText("상세 수록곡은 아직 수집하지 않았습니다");
  await dialog.getByRole("button", { name: "앨범 저장", exact: true }).click(); await expect(dialog.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "← 앨범 목록" }).click();
  // Returning to the list retains source/search controls and the applied query.
  await expect(dialog.getByLabel("출처", { exact: true })).toHaveValue("khinsider");
  await dialog.getByLabel("출처", { exact: true }).selectOption("zophar"); await query("새로 발견");
  await expect(dialog.getByRole("button", { name: "앨범 보기", exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "앨범 보기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "곡 저장", exact: true })).toHaveCount(12);
  await expect(dialog.getByText("순서 2 · 표시 번호 102. · 2:01", { exact: true })).toBeVisible();
  await expect(dialog.getByText("순서 3 · 표시 번호 102. · 1:21", { exact: true })).toBeVisible();
  let writes = 0;
  await page.route("**/api/library/catalog", async (route) => {
    if (route.request().method() === "POST") { writes++; await new Promise((resolve) => setTimeout(resolve, 100)); }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "앨범 저장", exact: true }).dblclick();
  await expect(dialog.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled(); expect(writes).toBe(1);
  await page.unroute("**/api/library/catalog");
  await pages.getByRole("button", { name: "다음 →" }).click(); await expect(dialog.getByRole("button", { name: "곡 저장", exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("heading", { name: "[합성] 새 곡 13", exact: true })).toBeVisible();
  await page.route("**/api/library/catalog", async (route) => { if (route.request().method() === "POST") { await route.fetch(); await route.abort(); } else await route.continue(); });
  await dialog.getByRole("button", { name: "곡 저장", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await expect(dialog.getByRole("button", { name: "곡 저장", exact: true })).toBeDisabled();
  await page.unroute("**/api/library/catalog"); await dialog.getByRole("button", { name: "최신 탐색 결과 확인" }).click();
  await expect(dialog.getByRole("button", { name: "저장됨", exact: true })).toHaveCount(2);
  await shot("catalog-album-saved"); await noOverflow(); await dialog.getByRole("button", { name: "완료", exact: true }).click();
  const created = (await (await page.request.get(`/api/library/catalog?q=${encodeURIComponent("새로 발견")}`)).json()).items as CatalogLibraryItem[];
  expect(created).toHaveLength(1); expect(created[0]!.titleOverride).toBeNull();
  const tracks = (await (await page.request.get(`/api/library/catalog?q=${encodeURIComponent("새 곡 13")}&kind=track`)).json()).items;
  expect(tracks).toHaveLength(1);

  const rootTitle = "[합성] 星の記憶 — 기억의 앨범", path = `/api/library/catalog/${rootId}`;
  await page.getByRole("button", { name: `${rootTitle} 출처 보기`, exact: true }).click();
  await dialog.getByRole("button", { name: "추가 출처 선택", exact: true }).click();
  await dialog.getByLabel("출처", { exact: true }).selectOption("khinsider");
  await expect(dialog.getByRole("button", { name: "이 앨범 선택", exact: true })).toHaveCount(2);
  await dialog.getByRole("button", { name: "이 앨범 선택", exact: true }).first().click();
  await expect(dialog.getByRole("region", { name: "앨범 출처 연결 확인" })).toContainText("선택한 출처 식별명: sample-arrangement");
  await shot("catalog-candidate-confirm"); await noOverflow();
  await dialog.getByRole("button", { name: "선택 취소", exact: true }).click();
  const latest = await (await page.request.get(path)).json() as CatalogLibraryItem;
  expect(latest.sourceLinks).toHaveLength(0);
  await dialog.getByRole("button", { name: "이 앨범 선택", exact: true }).first().click();
  expect((await page.request.patch(path, { headers, data: { version: latest.version, note: latest.note } })).ok()).toBe(true);
  await dialog.getByRole("button", { name: "개인 연결 확인", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 변경");
  await expect(dialog.getByRole("button", { name: "이 앨범 선택", exact: true }).first()).toBeDisabled();
  await dialog.getByRole("button", { name: "최신 후보 확인", exact: true }).click();
  await dialog.getByRole("button", { name: "이 앨범 선택", exact: true }).first().click();
  await page.route(`**${path}/sources`, async (route) => { await route.fetch(); await route.abort(); });
  await dialog.getByRole("button", { name: "개인 연결 확인", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await page.unroute(`**${path}/sources`); await dialog.getByRole("button", { name: "최신 후보 확인", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "이 앨범 선택", exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "출처 관리로 돌아가기", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "이 출처 해제", exact: true })).toHaveCount(1);
  await dialog.getByRole("button", { name: "완료", exact: true }).click();
  await expect(page.getByRole("article", { name: rootTitle, exact: true })).toContainText("추가 출처 1개");
  expect((await (await page.request.get(path)).json()).sourceLinks).toHaveLength(1);
}
