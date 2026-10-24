import { test, expect, type Page } from "@playwright/test";
import { deletionFlow } from "./deletion-flow.ts";
import { connectionsFlow } from "./connections-flow.ts";

const password = "browser-test-password-123";
const origin = "http://127.0.0.1:4187";
const headers = { origin };

async function login(page: Page, email: string) {
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("real sessions, personal bookmarks and resilient responsive flows", async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && message.text().includes("Content Security Policy")) errors.push(message.text()); });
  await context.route("**/*", async (route) => {
    if (!route.request().url().startsWith(`${origin}/`)) { remoteRequests.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const title = `[검증용] Chrono 기억 — ${testInfo.project.name}`;
  const url = `https://downloads.khinsider.com/game-soundtracks/album/browser-${testInfo.project.name}`;
  const shot = async (name: string) => { await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false }); };
  await page.goto("/");
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await shot("login"); await noOverflow(page);
  if (testInfo.project.name === "desktop") {
    await page.getByLabel("이메일", { exact: true }).fill("alice@example.test");
    await page.getByLabel("비밀번호", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("올바르지 않습니다");
  }
  await login(page, "alice@example.test");
  // Each viewport starts with the account's existing private records, if any.
  for (const item of (await (await page.request.get("/api/bookmarks")).json()).items) {
    await page.request.delete(`/api/bookmarks/${item.id}`, { headers, data: { version: item.version } });
  }
  await page.reload();
  await expect(page.getByRole("heading", { name: "첫 번째 음악을 놓아 보세요" })).toBeVisible();
  await shot("empty");
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("alice@example.test");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "이용 안내", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("자동 검색·수록곡 불러오기·앱 내 재생은 지원 준비 중");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "북마크 추가", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(page.getByLabel("제목 필수")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "닫기", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeFocused();
  await page.getByLabel("제목 필수").fill(title);
  await page.getByLabel("앨범 주소 필수").fill("https://example.com/album");
  await page.getByLabel("메모 선택").fill("[합성 검증 자료] 日本語 기억의 음악. 실제 수집 자료가 아닙니다.");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTPS 앨범 주소");
  await expect(page.getByLabel("제목 필수")).toHaveValue(title);
  await page.getByLabel("앨범 주소 필수").fill(url);
  await shot("editor");
  let submissions = 0;
  await page.route("**/api/bookmarks", async (route) => {
    if (route.request().method() === "POST") { submissions++; await new Promise((resolve) => setTimeout(resolve, 100)); }
    await route.continue();
  });
  await dialog.getByRole("button", { name: "저장", exact: true }).dblclick();
  await expect(dialog).not.toBeVisible();
  expect(submissions).toBe(1);
  await page.unroute("**/api/bookmarks");
  const card = page.getByRole("article", { name: title, exact: true });
  await expect(card).toBeVisible();
  let item = (await (await page.request.get("/api/bookmarks")).json()).items[0];
  const savedId = item.id;
  await expect(card.getByRole("link")).toHaveAttribute("target", "_blank");
  expect((await page.request.get("/api/bookmarks")).headers()["cache-control"]).toBe("no-store");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });

  await page.getByRole("button", { name: "북마크 추가", exact: true }).click();
  await page.getByLabel("제목 필수").fill("duplicate must not overwrite");
  await page.getByLabel("앨범 주소 필수").fill(url);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("이미 내 선반에 저장한 주소");
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await card.getByRole("button", { name: `${title} 즐겨찾기`, exact: true }).click();
  await expect(card.getByRole("button", { name: `${title} 즐겨찾기`, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "즐겨찾기", exact: true }).click();
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card.getByRole("button", { name: `${title} 즐겨찾기`, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("내 북마크 검색").fill("日本語");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(card).toBeVisible();
  await page.getByLabel("내 북마크 검색").fill("일치하지않음");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("heading", { name: "일치하는 북마크가 없어요" })).toBeVisible();
  await page.getByRole("button", { name: "검색 초기화" }).click();
  await card.getByRole("button", { name: `${title} 편집` }).click();
  await page.keyboard.press("Escape");
  await expect(card.getByRole("button", { name: `${title} 편집` })).toBeFocused();

  // Another authenticated request edits the same version while the dialog holds a draft.
  await card.getByRole("button", { name: `${title} 편집` }).click();
  await page.getByLabel("메모 선택").fill("내 입력을 보존하는 충돌 검증");
  item = await (await page.request.get(`/api/bookmarks/${savedId}`)).json();
  expect((await page.request.patch(`/api/bookmarks/${savedId}`, { headers, data: { version: item.version, note: "다른 창에서 변경한 메모" } })).ok()).toBe(true);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 수정");
  await expect(page.getByLabel("메모 선택")).toHaveValue("내 입력을 보존하는 충돌 검증");
  await dialog.getByRole("button", { name: "최신 내용 확인" }).click();
  await expect(dialog.getByText("다른 창에서 변경한 메모", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "내 입력 유지하고 다시 저장 준비" }).click();
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(card).toContainText("내 입력을 보존하는 충돌 검증");

  // A network failure leaves a draft editable, then the same operation can be retried.
  await card.getByRole("button", { name: `${title} 편집` }).click();
  await page.getByLabel("메모 선택").fill("연결 복구 후 저장한 메모");
  await page.route(`**/api/bookmarks/${savedId}`, async (route) => { if (route.request().method() === "PATCH") await route.abort(); else await route.continue(); });
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("연결하지 못했습니다");
  await expect(page.getByLabel("메모 선택")).toHaveValue("연결 복구 후 저장한 메모");
  await page.unroute(`**/api/bookmarks/${savedId}`);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(card).toContainText("연결 복구 후 저장한 메모");

  await deletionFlow(page, testInfo, savedId, title);
  await connectionsFlow(page, testInfo, savedId, title);

  // Populate a synthetic second page through the same authenticated, public API.
  for (let i = 0; i < 13; i++) expect((await page.request.post("/api/bookmarks", { headers, data: {
    title: `[검증용] Sound archive ${String(i).padStart(2, "0")}`, url: `https://www.zophar.net/music/snes/browser-${testInfo.project.name}-${i}.html`, note: "합성 브라우저 검증 자료 · 고요한 밤에 다시 듣고 싶은 음악", favorite: i % 3 === 0,
  } })).ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(12);
  await noOverflow(page); await shot("library");
  await page.getByRole("button", { name: "다음 →" }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `${title} 삭제` }).click();
  await dialog.getByRole("button", { name: "취소" }).click();
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `${title} 삭제` }).click();
  item = await (await page.request.get(`/api/bookmarks/${savedId}`)).json();
  await page.request.patch(`/api/bookmarks/${savedId}`, { headers, data: { version: item.version, note: "삭제 전에 변경된 내용" } });
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 수정");
  await dialog.getByRole("button", { name: "최신 내용 확인" }).click();
  await expect(dialog).toContainText("삭제 전에 변경된 내용");
  await dialog.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(card).not.toBeVisible();
  expect((await page.request.get(`/api/bookmarks/${savedId}`)).status()).toBe(404);

  // An unavailable list must be an error, never an empty collection.
  await page.route("**/api/bookmarks?*", (route) => route.fulfill({ status: 503, json: { code: "test_failure" } }));
  await page.getByRole("button", { name: "즐겨찾기", exact: true }).click();
  await expect(page.getByRole("heading", { name: "선반을 불러오지 못했어요" })).toBeVisible();
  await page.unroute("**/api/bookmarks?*");
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("article")).not.toHaveCount(0);

  const privateId = (await (await page.request.get("/api/bookmarks")).json()).items[0].id;
  const otherTab = await context.newPage();
  await otherTab.goto("/");
  await expect(otherTab.getByRole("article")).not.toHaveCount(0);
  await otherTab.getByRole("button", { name: "북마크 추가", exact: true }).click();
  await otherTab.getByLabel("제목 필수").fill("이전 계정의 다른 창 초안");
  await page.bringToFront();
  await page.route("**/api/auth/sign-out", (route) => route.abort());
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("로그아웃을 완료하지 못했습니다");
  await expect(page.getByRole("button", { name: "로그인", exact: true })).not.toBeVisible();
  await page.unroute("**/api/auth/sign-out");
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await expect(page.getByText("[검증용] Sound archive 00", { exact: true })).not.toBeVisible();
  expect((await page.request.get("/api/bookmarks")).status()).toBe(401);
  await expect(page.getByRole("region", { name: "삭제 되돌리기" })).not.toBeVisible();
  await expect(otherTab.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await expect(otherTab.getByRole("dialog")).not.toBeVisible();
  await login(page, "bob@example.test");
  await expect(page.getByRole("heading", { name: "첫 번째 음악을 놓아 보세요" })).toBeVisible();
  expect((await page.request.get(`/api/bookmarks/${privateId}`)).status()).toBe(404);
  await expect(otherTab.getByRole("heading", { name: "첫 번째 음악을 놓아 보세요" })).toBeVisible();
  expect(await otherTab.evaluate(() => document.body.textContent)).not.toContain("이전 계정의 다른 창 초안");
  await otherTab.close();

  // Remove the actual server session while an unsaved draft is open.
  await page.getByRole("button", { name: "북마크 추가", exact: true }).click();
  await page.getByLabel("제목 필수").fill("만료된 세션의 개인 초안");
  await page.getByLabel("앨범 주소 필수").fill(url);
  expect((await page.request.post("/api/auth/sign-out", { headers, data: {} })).ok()).toBe(true);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.body.textContent)).not.toContain("만료된 세션의 개인 초안");
  expect(remoteRequests).toEqual([]); expect(errors).toEqual([]);
});
