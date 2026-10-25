import { test, expect, type Page } from "@playwright/test";
import type { CatalogTrackSearchPage } from "../../src/shared/catalog-track-search.ts";
const password = "browser-test-password-123";
async function login(page: Page) {
  await page.getByLabel("이메일", { exact: true }).fill("alice@example.test"); await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click(); await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole("button", { name: "저장한 카탈로그", exact: true }).click();
  await page.getByRole("button", { name: "수록곡 검색", exact: true }).click();
  await expect(page.getByLabel("곡 제목", { exact: true })).toBeFocused();
}
function gate() { let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); return { waiting, release }; }
const path = "**/api/catalog/tracks?*";

test("track search uses current cursor pages and album saves while guarding expiry, cancellation and real session races", async ({ page, context }, info) => {
  const origin = String(info.project.use.baseURL), remote: string[] = [], errors: string[] = [], requests: URL[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => { if (!route.request().url().startsWith(`${origin}/`)) { remote.push(route.request().url()); await route.abort(); } else await route.continue(); });
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/catalog/tracks") requests.push(new URL(request.url())); });
  const dialog = page.getByRole("dialog"), query = page.getByLabel("곡 제목", { exact: true });
  const results = page.getByRole("region", { name: "수록곡 검색 결과", exact: true });
  const pages = page.getByRole("navigation", { name: "수록곡 검색 페이지", exact: true });
  const submit = () => dialog.getByRole("button", { name: "곡 검색", exact: true }).click();
  const search = async (q: string) => { await query.fill(q); await submit(); };
  const count = async (n: number) => expect(results.locator(".track-search-entry")).toHaveCount(n);
  const shot = async (name: string) => { await page.screenshot({ path: info.outputPath(`${name}.png`) });
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); };
  await page.goto("/"); await login(page); await open(page); expect(requests).toHaveLength(0);
  await search("기억"); await count(12); await expect(results).toContainText("합성 자료"); await expect(results).toContainText("길이 미확인"); await expect(results).toContainText("0:00");
  await expect(results.locator(".track-search-entry").first()).toContainText("표시 번호 1");
  await results.getByText("앨범과 곡의 자료 근거", { exact: true }).first().click(); await expect(results).toContainText("곡 목록 확인");
  await shot("track-results");
  const firstIds = await results.locator("[data-track-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-track-id")));
  await pages.getByRole("button", { name: "다음 →" }).click(); await count(12); await expect(pages).toContainText("2 페이지");
  expect(requests.at(-1)!.searchParams.has("cursor")).toBe(true); expect(requests.every((u) => !u.searchParams.has("offset"))).toBe(true);
  await pages.getByRole("button", { name: "← 이전" }).click(); await count(12); await expect(pages).toContainText("1 페이지");
  expect(await results.locator("[data-track-id]").evaluateAll((els) => els.map((el) => el.getAttribute("data-track-id")))).toEqual(firstIds);
  await search("記"); await count(1); await expect(results).toContainText('<img src=x onerror="alert(1)">'); await expect(results.locator("img")).toHaveCount(0);
  await search("%_"); await count(1);
  await search("없는 곡"); await count(0); await expect(results).toContainText("조건에 맞는 수록곡이 없습니다");
  await search("곡 26"); await count(1);
  await dialog.getByLabel("곡의 출처").selectOption("zophar"); await expect(results).toHaveCount(0); const beforeFilter = requests.length;
  await submit(); await count(0); expect(requests).toHaveLength(beforeFilter + 1);
  await dialog.getByLabel("곡의 출처").selectOption("khinsider"); await submit(); await count(1);
  await results.getByRole("button", { name: "앨범에서 보기" }).click();
  await expect(dialog.getByRole("heading", { name: "카탈로그 앨범", exact: true })).toBeVisible();
  const selected = dialog.locator(".browse-entry").filter({ hasText: "검색에서 선택한 곡" });
  await expect(selected).toContainText("기억의 곡 26"); await expect(selected).toContainText("순서 26");
  let writes = 0;
  await page.route("**/api/library/catalog", async (route) => { if (route.request().method() === "POST") { writes++; await route.fetch(); await route.abort(); } else await route.continue(); });
  await selected.getByRole("button", { name: "곡 저장", exact: true }).dblclick(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다");
  expect(writes).toBe(1); await expect(selected.getByRole("button", { name: "곡 저장", exact: true })).toBeDisabled();
  await page.unroute("**/api/library/catalog"); await dialog.getByRole("button", { name: "최신 탐색 결과 확인" }).click();
  await expect(selected.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled(); await shot("track-album-saved");
  await dialog.getByRole("button", { name: "← 수록곡 검색" }).click(); await expect(results).toHaveCount(0); await expect(query).toHaveValue("곡 26");
  const saved = (await (await page.request.get(`/api/library/catalog?q=${encodeURIComponent("곡 26")}`)).json()).items;
  expect(saved).toHaveLength(1); expect(saved[0].titleOverride).toBeNull();
  await dialog.getByLabel("곡의 출처").selectOption("");

  // Actual server removal invalidates a previously issued cursor. No implicit first-page request.
  await search("기억"); await count(12);
  const session = (await (await page.request.get("/api/auth/get-session")).json()).session.id as string;
  const current = await (await page.request.get(`/api/catalog/tracks?q=${encodeURIComponent("기억")}&limit=12`, { headers: { "X-LoopShelf-Session": session } })).json() as CatalogTrackSearchPage;
  expect((await page.request.post("/__test/tracks", { headers: { origin }, data: { albumId: current.items[11]!.album.id, action: "remove" } })).ok()).toBe(true);
  const beforeStale = requests.length; await pages.getByRole("button", { name: "다음 →" }).click();
  await expect(dialog.getByRole("alert")).toContainText("처음부터 다시 검색"); await expect(results).toHaveCount(0); expect(requests).toHaveLength(beforeStale + 1); await shot("track-changed");
  await dialog.getByRole("button", { name: "처음부터 다시 검색" }).click(); await expect(results).toBeVisible();

  // Malformed context, URL and kind responses cannot be displayed or linked.
  for (const mode of ["url", "kind", "query"] as const) {
    await page.route(path, async (route) => { const response = await route.fetch(), body = await response.json() as CatalogTrackSearchPage;
      if (mode === "url") body.items[0]!.album.pageUrl = "javascript:alert(1)";
      if (mode === "kind") body.sampleKind = "live-capture" as typeof body.sampleKind;
      if (mode === "query") body.query = "different";
      await route.fulfill({ response, json: body }); });
    await submit(); await expect(dialog.getByRole("alert")).toContainText("자료 종류나 출처"); await expect(results).toHaveCount(0); await page.unroute(path);
  }
  // A displayed page and a response still awaiting session confirmation both expire conservatively.
  await page.route(path, async (route) => { const response = await route.fetch(), body = await response.json() as CatalogTrackSearchPage;
    body.items[0]!.album.provenance.expiresAt = new Date(Date.parse(body.checkedAt) + 1500).toISOString(); await route.fulfill({ response, json: body }); });
  await submit(); await expect(results).toBeVisible(); await expect(dialog).toContainText("보관 기한이 지나 결과를 지웠습니다"); await expect(results).toHaveCount(0);
  const authGate = gate(); let authSeen = false;
  await page.route("**/api/auth/get-session", async (route) => { authSeen = true; await authGate.waiting; await route.continue(); });
  await submit(); await expect.poll(() => authSeen).toBe(true); await new Promise((resolve) => setTimeout(resolve, 1600)); authGate.release();
  await expect(dialog.getByRole("alert")).toContainText("보관 기한이 지났습니다"); await expect(results).toHaveCount(0);
  await page.unroute("**/api/auth/get-session"); await page.unroute(path);

  // Cancelled late successes and 401s never update the active screen or expire its login.
  for (const action of ["edit", "cancel", "close"] as const) {
    const delayed = gate(); let seen = false;
    await page.route(path, async (route) => { const response = await route.fetch(); seen = true; await delayed.waiting;
      await route.fulfill(action === "cancel" ? { status: 401, json: { code: "unauthorized" } } : { response }).catch(() => {}); });
    await submit(); await expect.poll(() => seen).toBe(true);
    if (action === "edit") await query.fill("별도 검색어");
    if (action === "cancel") await dialog.getByRole("button", { name: "검색 취소" }).click();
    if (action === "close") await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    delayed.release(); await page.unroute(path); await expect(results).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "나의 선반으로" })).toHaveCount(0);
    if (action === "close") await page.getByRole("button", { name: "수록곡 검색", exact: true }).click();
    await query.fill("기억");
  }
  await submit(); await expect(results).toBeVisible();
  await context.setOffline(true); await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  await context.setOffline(false); await expect(dialog).toBeVisible(); await expect(results).toHaveCount(0); await expect(dialog).toContainText("직접 다시 검색");
  await submit(); await expect(results).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); delete (document as unknown as { hidden?: boolean }).hidden; });
  await expect(results).toHaveCount(0);
  await page.route(path, (route) => route.fulfill({ status: 429, headers: { "Retry-After": "1" }, json: { code: "rate_limited" } }));
  await submit(); await expect(dialog.getByRole("alert")).toContainText("요청이 많습니다"); await expect(dialog.getByRole("button", { name: "곡 검색", exact: true })).toBeDisabled();
  const limited = requests.length; await expect(dialog.getByRole("button", { name: "곡 검색", exact: true })).toBeEnabled(); expect(requests).toHaveLength(limited); await page.unroute(path);
  await page.route("**/api/auth/get-session", (route) => route.abort()); await submit(); await expect(dialog.getByRole("alert")).toContainText("서버에 연결하지 못했습니다"); await expect(results).toHaveCount(0); await page.unroute("**/api/auth/get-session");
  // Required response header mismatch removes all browser state.
  await page.route(path, async (route) => { const response = await route.fetch(); await route.fulfill({ response, headers: { ...response.headers(), "x-loopshelf-session": "wrong-session" } }); });
  await submit(); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await page.unroute(path);
  await login(page); await open(page); await expect(query).toHaveValue(""); await query.fill("기억");
  // A valid old session is not revoked by a separate login. Current-cookie confirmation still hides old responses.
  for (const success of [true, false]) {
    const delayed = gate(); let seen = false;
    await page.route(path, async (route) => { const response = await route.fetch(); seen = true; await delayed.waiting;
      await route.fulfill(success ? { response } : { status: 500, json: { code: "internal_error" } }).catch(() => {}); });
    await submit(); await expect.poll(() => seen).toBe(true);
    expect((await page.request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email: "bob@example.test", password } })).ok()).toBe(true);
    delayed.release(); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(results).toHaveCount(0); await page.unroute(path);
    if (success) { await login(page); await open(page); await query.fill("기억"); }
  }
  expect(remote).toEqual([]); expect(errors).toEqual([]);
});
