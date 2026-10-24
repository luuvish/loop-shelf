import { test, expect, type Page } from "@playwright/test";
import type { CatalogLibraryItem } from "../../src/shared/catalog-library.ts";

import { catalogTransferFlow } from "./catalog-transfer-flow.ts";
import { browseFlow } from "./catalog-browse-flow.ts";

const password = "browser-test-password-123";
const originalTitle = "[합성] 星の記憶 — 기억의 앨범";
async function login(page: Page, email: string) {
  await page.getByLabel("이메일", { exact: true }).fill(email); await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}
async function openShelf(page: Page) {
  await page.getByRole("button", { name: "저장한 카탈로그", exact: true }).click();
  await expect(page.getByRole("heading", { name: "저장한 카탈로그." })).toBeVisible();
}
async function search(page: Page, q: string) {
  await page.getByLabel("저장한 카탈로그 검색").fill(q);
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/library/catalog" && new URL(value.url()).searchParams.get("q") === q);
  await page.getByRole("button", { name: "검색", exact: true }).click(); await response;
  await expect(page.getByRole("region", { name: "저장한 카탈로그 항목", exact: true })).toHaveAttribute("aria-busy", "false");
}

test("saved synthetic catalog management preserves private drafts, source judgments and session boundaries", async ({ page, context }, testInfo) => {
  const origin = String(testInfo.project.use.baseURL), headers = { origin };
  const errors: string[] = [], remote: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    if (!route.request().url().startsWith(`${origin}/`)) { remote.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const shot = async (name: string) => { await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false }); };
  const noOverflow = async () => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); };
  const email = `${testInfo.project.name}@example.test`;
  await page.goto("/"); await login(page, email); await openShelf(page);
  await expect(page.getByText("자료 종류와 보관 상태를 확인해 주세요")).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(12); await noOverflow(); await shot("catalog-list");
  const pages = page.getByRole("navigation", { name: "카탈로그 페이지" });
  await pages.getByRole("button", { name: "다음 →" }).click(); await expect(page.getByRole("article")).toHaveCount(2);
  await pages.getByRole("button", { name: "← 이전" }).click(); await expect(page.getByRole("article")).toHaveCount(12);

  await search(page, "만료 뒤에도");
  const expired = page.getByRole("article", { name: "보관이 종료된 앨범", exact: true });
  await expect(expired).toContainText("외부 정보 보관 종료 · 개인 내용 유지");
  await expect(expired).toContainText("만료 뒤에도 남는 개인 메모");
  await noOverflow(); await shot("catalog-expired");
  await search(page, "[합성] 다른 앨범 10"); await expect(page.getByRole("article")).toHaveCount(0);
  await search(page, ""); await expect(page.getByRole("article")).toHaveCount(12);

  await page.route("**/api/library/catalog?*", (route) => route.abort());
  await page.getByRole("button", { name: "카탈로그 새로고침" }).click();
  await expect(page.getByRole("heading", { name: "카탈로그를 불러오지 못했어요" })).toBeVisible();
  await page.unroute("**/api/library/catalog?*"); await page.getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("article")).toHaveCount(12);
  await search(page, "日本語"); await expect(page.getByRole("article")).toHaveCount(1);
  const root = page.getByRole("article", { name: originalTitle, exact: true });
  const result = await page.request.get(`/api/library/catalog?q=${encodeURIComponent("日本語")}`);
  expect(result.headers()["cache-control"]).toBe("no-store");
  let saved = (await result.json()).items[0] as CatalogLibraryItem; const id = saved.id, path = `/api/library/catalog/${id}`;
  const get = async () => await (await page.request.get(path)).json() as CatalogLibraryItem;
  const otherPatch = async (note: string) => { saved = await get(); expect((await page.request.patch(path, { headers, data: { version: saved.version, note } })).ok()).toBe(true); };
  let mutations = 0;
  await page.route(`**${path}`, async (route) => { if (route.request().method() === "PATCH") { mutations++; await new Promise((resolve) => setTimeout(resolve, 100)); } await route.continue(); });
  await root.getByRole("button", { name: `${originalTitle} 즐겨찾기`, exact: true }).dblclick();
  await expect(root.getByRole("button", { name: `${originalTitle} 즐겨찾기`, exact: true })).toHaveAttribute("aria-pressed", "false"); expect(mutations).toBe(1);
  await page.unroute(`**${path}`);
  await page.getByLabel("즐겨찾기만", { exact: true }).check(); await expect(page.getByRole("heading", { name: "조건에 맞는 카탈로그 항목이 없어요" })).toBeVisible();
  await page.getByLabel("즐겨찾기만", { exact: true }).uncheck(); await expect(root).toBeVisible();
  await page.getByRole("button", { name: "검색 초기화" }).click(); await page.getByLabel("항목 종류", { exact: true }).selectOption("track");
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("article", { name: "[합성] 순서가 바뀐 곡", exact: true })).toContainText("현재 수록 순서 1");
  const missing = page.getByRole("article", { name: "[합성] 누락된 곡", exact: true }); await expect(missing).toContainText("현재 수록 목록에서 누락");
  await missing.getByRole("button", { name: "[합성] 누락된 곡 출처 보기", exact: true }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog).toContainText("트랙이 속한 앨범의 출처"); await shot("catalog-track-source"); await noOverflow(); await page.keyboard.press("Escape");
  await page.getByLabel("항목 종류", { exact: true }).selectOption(""); await search(page, "제거 뒤");
  await expect(page.getByRole("article")).toContainText("메타데이터가 제거된 앨범"); await expect(page.getByRole("article")).toContainText("소스 콘텐츠 제거됨");
  await expect(page.getByText("[합성] 제거 전에만 보이는 제목", { exact: true })).toHaveCount(0);
  await shot("catalog-removed");

  await search(page, "기억"); await root.getByRole("button", { name: `${originalTitle} 편집`, exact: true }).click();
  await expect(page.getByLabel("개인 제목 선택")).toBeFocused(); await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(root.getByRole("button", { name: `${originalTitle} 편집`, exact: true })).toBeFocused();
  await root.getByRole("button", { name: `${originalTitle} 편집`, exact: true }).click();
  await page.getByLabel("개인 제목 선택").fill("내가 고른 앨범"); await page.getByLabel("메모 선택").fill("<script>실행하지 않는 개인 초안</script>");
  await otherPatch("다른 창의 변경"); await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 변경"); await expect(page.getByLabel("메모 선택")).toHaveValue("<script>실행하지 않는 개인 초안</script>");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "최신 내용 확인", exact: true }).click(); await expect(dialog).toContainText("다른 창의 변경"); await shot("catalog-edit-conflict"); await noOverflow();
  await dialog.getByRole("button", { name: "내 입력을 유지하고 다시 편집" }).click(); await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).not.toBeVisible(); await expect(page.getByRole("article", { name: "내가 고른 앨범", exact: true })).toBeVisible();
  expect((await get()).titleOverride).toBe("내가 고른 앨범");
  await page.getByRole("button", { name: "내가 고른 앨범 편집", exact: true }).click(); await page.getByLabel("개인 제목 선택").fill("");
  await page.getByLabel("메모 선택").fill("응답 유실 뒤에도 보존한 내용");
  await page.route(`**${path}`, async (route) => { if (route.request().method() === "PATCH") { await route.fetch(); await route.abort(); } else await route.continue(); });
  await dialog.getByRole("button", { name: "저장", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await page.unroute(`**${path}`); await dialog.getByRole("button", { name: "최신 내용 확인", exact: true }).click();
  await expect(dialog.getByText("메모: 응답 유실 뒤에도 보존한 내용", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "최신 내용으로 바꾸기" }).click(); await expect(page.getByLabel("개인 제목 선택")).toHaveValue("");
  await dialog.getByRole("button", { name: "취소", exact: true }).click(); await page.getByRole("button", { name: "카탈로그 새로고침" }).click(); await expect(root).toBeVisible();
  expect((await get()).titleOverride).toBeNull();

  await root.getByRole("button", { name: `${originalTitle} 출처 보기`, exact: true }).click();
  await expect(dialog).toContainText("메타데이터가 제거된 앨범"); await expect(dialog).toContainText("개인 판단");
  await dialog.getByRole("button", { name: "이 출처 해제" }).click(); await dialog.getByRole("button", { name: "취소", exact: true }).click(); expect((await get()).sourceLinks).toHaveLength(1);
  await dialog.getByRole("button", { name: "이 출처 해제" }).click(); await otherPatch("출처 해제 전 변경");
  await dialog.getByRole("button", { name: "연결 해제 확인" }).click(); await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 변경");
  await expect(dialog.getByRole("button", { name: "이 출처 해제" })).toBeDisabled();
  await dialog.getByRole("button", { name: "최신 출처 확인" }).click(); await dialog.getByRole("button", { name: "이 출처 해제" }).click(); await shot("catalog-unlink");
  await page.route(`**${path}/sources`, async (route) => { await route.fetch(); await route.abort(); });
  await dialog.getByRole("button", { name: "연결 해제 확인" }).click(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await page.unroute(`**${path}/sources`); await dialog.getByRole("button", { name: "최신 출처 확인" }).click(); await expect(dialog).toContainText("추가로 연결한 앨범이 없습니다");
  expect((await get()).sourceLinks).toHaveLength(0); await dialog.getByRole("button", { name: "완료", exact: true }).click();
  await expect(root).toContainText("원래 출처만"); await expect(page.getByRole("heading", { name: "저장한 카탈로그." })).toBeFocused();

  // Offline hides private content and restores only a memory draft after real-session revalidation.
  await root.getByRole("button", { name: `${originalTitle} 편집`, exact: true }).click(); await page.getByLabel("메모 선택").fill("오프라인 동안의 메모");
  await context.setOffline(true); await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible(); await expect(dialog).not.toBeVisible();
  await context.setOffline(false); await expect(dialog).toBeVisible(); await expect(page.getByLabel("메모 선택")).toHaveValue("오프라인 동안의 메모");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("button", { name: "내 계정", exact: true }).click(); await dialog.getByRole("button", { name: "데이터 관리" }).click();
  await expect(dialog).toContainText("북마크 JSON과 카탈로그 JSON은 별도 파일입니다"); await shot("catalog-transfer-scope"); await dialog.getByRole("button", { name: "완료", exact: true }).click();

  await browseFlow(page, testInfo, id);
  await catalogTransferFlow(page, testInfo, id);

  // Expiring the cookie while a private draft is open cannot write under a different account.
  await root.getByRole("button", { name: `${originalTitle} 편집`, exact: true }).click(); await page.getByLabel("메모 선택").fill("다른 계정으로 넘어가면 안 되는 초안");
  await page.request.post("/api/auth/sign-out", { headers, data: {} });
  await page.request.post("/api/auth/sign-in/email", { headers, data: { email: "bob@example.test", password } });
  await dialog.getByRole("button", { name: "저장", exact: true }).click(); await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await login(page, "bob@example.test"); await openShelf(page); await expect(page.getByRole("heading", { name: "저장한 카탈로그가 없어요" })).toBeVisible();
  await shot("catalog-empty"); expect((await page.request.get(path)).status()).toBe(404);
  await page.getByRole("button", { name: "로그아웃", exact: true }).click(); await login(page, email); await openShelf(page); await search(page, "기억");
  expect((await get()).note).toBe("출처 해제 전 변경");
  await root.getByRole("button", { name: `${originalTitle} 삭제`, exact: true }).click(); await expect(dialog).toContainText("60초 되돌리기가 없습니다");
  await dialog.getByRole("button", { name: "취소", exact: true }).click(); expect((await page.request.get(path)).ok()).toBe(true);
  await root.getByRole("button", { name: `${originalTitle} 삭제`, exact: true }).click(); await otherPatch("삭제 전 최신 개인 메모");
  await dialog.getByRole("button", { name: "개인 저장 삭제" }).click(); await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 변경");
  await dialog.getByRole("button", { name: "최신 내용 확인" }).click(); await expect(dialog).toContainText("삭제 전 최신 개인 메모"); await shot("catalog-delete"); await noOverflow();
  await page.route(`**${path}`, async (route) => { if (route.request().method() === "DELETE") { await route.fetch(); await route.abort(); } else await route.continue(); });
  await dialog.getByRole("button", { name: "개인 저장 삭제" }).click(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  await page.unroute(`**${path}`); await dialog.getByRole("button", { name: "최신 내용 확인" }).click(); await expect(dialog).not.toBeVisible();
  expect((await page.request.get(path)).status()).toBe(404); await expect(page.getByRole("article")).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(remote).toEqual([]);
});
