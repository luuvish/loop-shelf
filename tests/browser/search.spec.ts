import { test, expect, type Page, type Route } from "@playwright/test";
import { response, album, type Query } from "./search-fixture.ts";
import type { SearchResponse } from "../../src/shared/search.ts";

const password = "browser-test-password-123";
async function login(page: Page, email = "alice@example.test") {
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}
async function open(page: Page) {
  await page.getByRole("button", { name: "음악 검색", exact: true }).click();
  await expect(page.getByRole("heading", { name: "게임 음악 찾기." })).toBeFocused();
}
function gate() { let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); return { waiting, release }; }

test("integrated search distinguishes source states and protects cancellation and session boundaries", async ({ page, context }, testInfo) => {
  const origin = String(testInfo.project.use.baseURL), headers = { origin };
  const remote: string[] = [], errors: string[] = [], requests: Query[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", async (route) => {
    if (!route.request().url().startsWith(`${origin}/`)) { remote.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/search") requests.push(request.postDataJSON() as Query); });
  const shot = async (name: string) => { await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
    await page.screenshot({ path: testInfo.outputPath(`${name}-viewport.png`), fullPage: false }); };
  const noOverflow = async () => { expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); };
  const query = page.getByLabel("앨범 이름", { exact: true });
  const submit = page.getByRole("button", { name: "검색", exact: true });
  const local = page.getByRole("region", { name: "로컬 카탈로그 검색 결과", exact: true });
  const kh = page.getByRole("region", { name: "KHInsider 검색 결과", exact: true });
  const zophar = page.getByRole("region", { name: "Zophar’s Domain 검색 결과", exact: true });
  const results = page.getByRole("region", { name: "통합 검색 결과", exact: true });
  await page.goto("/"); await login(page); await open(page);
  await expect(page.getByRole("checkbox", { checked: true })).toHaveCount(0); expect(requests).toHaveLength(0);
  await noOverflow(); await shot("search-empty");
  await query.fill("  星の記憶  "); await submit.click();
  await expect(local).toContainText("결과가 0건이라는 뜻은 아닙니다"); await expect(results).toContainText("외부 소스는 요청하지 않았습니다");
  expect(requests.at(-1)).toEqual({ q: "星の記憶", sources: [], limit: 12, offset: 0 });
  await page.getByLabel("KHInsider", { exact: true }).check(); await page.getByLabel("Zophar’s Domain", { exact: true }).check(); await submit.click();
  await expect(kh).toContainText("이용 조건 확인 중"); await expect(zophar).toContainText("이용 조건 확인 중");
  await expect(results.getByRole("button", { name: /다시 검색/ })).toHaveCount(0);
  await shot("search-policy-disabled"); await noOverflow();

  // Successful source states are explicitly synthetic browser responses; the product policy stays disabled.
  let user = (await (await page.request.get("/api/auth/get-session")).json()).user as { id: string };
  let decorate = (value: SearchResponse) => value;
  let pending: ReturnType<typeof gate> | null = null, badSession = false, httpStatus = 200;
  const fulfill = async (route: Route) => {
    const input = route.request().postDataJSON() as Query, body = decorate(response(input));
    const capturedUser = user.id, capturedSession = route.request().headers()["x-loopshelf-session"]!;
    const status = httpStatus, mismatch = badSession, delayed = pending; if (delayed) await delayed.waiting;
    await route.fulfill({ status, contentType: "application/json", headers: {
      "Cache-Control": "no-store", "X-LoopShelf-User": capturedUser, "X-LoopShelf-Session": mismatch ? "wrong-session" : capturedSession,
      ...(status === 429 ? { "Retry-After": "2" } : {}),
    }, body: JSON.stringify(status === 429 ? { ok: false, code: "rate_limited" } : status === 401 ? { ok: false, code: "unauthorized" }
      : status === 504 ? { ok: false, code: "search_timeout" } : body) }).catch(() => {});
  };
  await page.route("**/api/search", fulfill);
  decorate = (value) => {
    value.status = "partial";
    for (const source of value.sources) {
      if (source.sourceId === "zophar") source.result = { ok: false, code: "timeout", stage: "transport" };
      else if (source.result.ok) {
        source.result.delivery.freshness = "stale"; source.result.refreshFailure = { ok: false, code: "network_error", stage: "transport" };
        source.result.data.reportedCount = 23; source.result.data.coverage = "partial-or-changed";
        source.result.data.nextPageUrl = "https://downloads.khinsider.com/search?search=star&page=2";
        source.result.data.albums.push(album("khinsider", "star-second")); source.result.warnings = ["[합성] 일부 목록만 확인했습니다."];
      }
    }
    return value;
  };
  pending = gate(); const first = pending; const count = requests.length;
  await submit.dblclick(); await expect(page.getByRole("button", { name: "검색 취소" })).toBeVisible();
  expect(requests).toHaveLength(count + 1); first.release(); pending = null;
  await expect(kh).toContainText("이전 자료"); await expect(kh).toContainText("출처 표시 23개");
  await expect(kh.getByRole("heading", { name: "[합성] 별의 기억", exact: true })).toHaveCount(2);
  await expect(results).toContainText("실제 사이트 검색 결과가 아닙니다"); await expect(kh).toContainText("앱의 추가 조회는 아직 지원하지 않습니다");
  await expect(zophar).toContainText("응답이 늦어"); await expect(page.locator("audio, iframe")).toHaveCount(0);
  await kh.getByText("자료 확인 안내", { exact: true }).click(); await expect(kh).toContainText("[합성] 일부 목록만 확인했습니다.");
  await shot("search-partial"); await noOverflow();
  decorate = (value) => value;
  await zophar.getByRole("button", { name: "Zophar’s Domain 다시 검색", exact: true }).click();
  await expect(zophar).toContainText("보관된 자료"); await expect(kh).toHaveCount(0);
  expect(requests.at(-1)?.sources).toEqual(["zophar"]);
  await expect(page.getByLabel("KHInsider", { exact: true })).not.toBeChecked();
  await local.getByRole("button", { name: "다음 →" }).click(); await expect(local).toContainText("[합성] 로컬 page-12");
  expect(requests.at(-1)).toMatchObject({ sources: [], offset: 12 }); await expect(zophar).toHaveCount(0);
  await local.getByRole("button", { name: "← 이전" }).click(); await expect(local).toContainText("[합성] 로컬 page-0");

  // Successful zero is different from parser failure; no HTML or untrusted URL becomes active content.
  decorate = (value) => {
    if (value.local.ok) { value.local.items = []; value.local.nextOffset = null; }
    for (const source of value.sources) if (source.result.ok) {
      source.result.data.albums = []; source.result.data.reportedCount = 0;
    }
    return value;
  };
  await page.getByLabel("KHInsider", { exact: true }).check(); await submit.click();
  await expect(kh).toContainText("정상적으로 반환한 검색 결과는 0건"); await expect(local).toContainText("일치하는 앨범이 없습니다");
  decorate = (value) => {
    for (const source of value.sources) if (source.result.ok) {
      source.result.data.albums = [{ ...album("khinsider", "hostile", '<img src=x onerror="alert(1)">'), pageUrl: "javascript:alert(1)" }];
    }
    return value;
  };
  await submit.click(); await expect(kh.getByRole("heading", { name: '<img src=x onerror="alert(1)">', exact: true })).toBeVisible();
  await expect(kh.locator("img")).toHaveCount(0); await expect(kh.getByRole("link", { name: /원문 열기/ })).toHaveCount(0);
  decorate = (value) => { value.sampleKind = "live-capture"; return value; };
  await submit.click(); await expect(page.getByRole("alert")).toContainText("자료 종류나 요청 정보가 일치하지 않습니다"); await expect(results).toHaveCount(0);

  decorate = (value) => { for (const source of value.sources) source.result = { ok: false, code: "rate_limited", stage: "transport", retryAt: Date.now() + 2200 }; value.status = "partial"; return value; };
  await submit.click(); await expect(kh.getByRole("button", { name: "KHInsider 다시 검색" })).toBeDisabled();
  await shot("search-cooldown"); const limitedCount = requests.length;
  await expect(kh.getByRole("button", { name: "KHInsider 다시 검색" })).toBeEnabled(); expect(requests).toHaveLength(limitedCount);
  decorate = (value) => { for (const source of value.sources) source.result = { ok: false, code: "parse_changed", stage: "parser" }; return value; };
  await kh.getByRole("button", { name: "KHInsider 다시 검색" }).click(); await expect(kh).toContainText("페이지 구성이 달라");
  httpStatus = 429; await submit.click(); await expect(page.getByRole("alert")).toContainText("요청이 많습니다");
  const apiLimitedCount = requests.length; await expect(submit).toBeDisabled(); await expect(submit).toBeEnabled(); expect(requests).toHaveLength(apiLimitedCount);
  httpStatus = 200; decorate = (value) => value;
  httpStatus = 504; await submit.click(); await expect(page.getByRole("alert")).toContainText("검색 시간이 초과되었습니다"); await expect(results).toHaveCount(0);
  httpStatus = 200;
  await page.route("**/api/auth/get-session", (route) => route.abort()); await submit.click();
  await expect(page.getByRole("alert")).toContainText("서버에 연결하지 못했습니다"); await expect(results).toHaveCount(0);
  await page.unroute("**/api/auth/get-session");

  // Query edits, explicit cancellation and navigation dispose pending work, even when its response arrives later.
  pending = gate(); const old = pending; await submit.click(); await expect(page.getByRole("button", { name: "검색 취소" })).toBeVisible();
  await query.fill("새 검색어"); pending = null; await expect(results).toHaveCount(0);
  await submit.click(); await expect(results).toContainText("“새 검색어” 조회");
  old.release(); await expect(results).toContainText("“새 검색어” 조회");
  pending = gate(); const cancelled = pending; await submit.click(); await page.getByRole("button", { name: "검색 취소" }).click(); cancelled.release(); pending = null;
  await expect(page.getByText(/검색을 취소했습니다/)).toBeVisible(); await expect(results).toHaveCount(0);
  pending = gate(); const left = pending; await submit.click(); await page.getByRole("button", { name: "내 음악 선반", exact: true }).click();
  left.release(); pending = null; await open(page); await expect(query).toHaveValue(""); await expect(results).toHaveCount(0);
  await query.fill("연결 복구"); pending = gate(); const offline = pending; await submit.click();
  await context.setOffline(true); await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  offline.release(); pending = null; const offlineCount = requests.length;
  await context.setOffline(false); await expect(query).toBeVisible(); await expect(query).toHaveValue("연결 복구");
  await expect(results).toHaveCount(0); expect(requests).toHaveLength(offlineCount);
  await submit.click(); await expect(results).toContainText("“연결 복구” 조회");

  // An old response with matching headers must also pass a fresh check of the current cookie session.
  pending = gate(); const switched = pending; await submit.click(); await expect(page.getByRole("button", { name: "검색 취소" })).toBeVisible();
  expect((await page.request.post("/api/auth/sign-in/email", { headers, data: { email: "bob@example.test", password } })).ok()).toBe(true);
  switched.release(); pending = null;
  await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(results).toHaveCount(0);
  await login(page, "bob@example.test"); user = (await (await page.request.get("/api/auth/get-session")).json()).user; await open(page);
  await expect(query).toHaveValue(""); await query.fill("세션 검증"); badSession = true; await submit.click();
  await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(results).toHaveCount(0);
  // These two mocked errors did not revoke the real cookie. Reload uses the real session, without another login attempt.
  badSession = false; await page.reload(); await open(page);
  await query.fill("만료 검증"); httpStatus = 401; await submit.click(); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible();
  httpStatus = 200; await page.reload(); await open(page);
  await query.fill("로그아웃 실패 검증"); await submit.click(); await expect(results).toBeVisible();
  await page.route("**/api/auth/sign-out", (route) => route.abort());
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("서버에 연결하지 못했습니다"); await expect(query).toHaveValue(""); await expect(results).toHaveCount(0);
  await page.unroute("**/api/auth/sign-out");
  await query.fill("로그아웃 검증"); pending = gate(); const loggingOut = pending; await submit.click();
  await page.getByRole("button", { name: "로그아웃", exact: true }).click();
  loggingOut.release(); pending = null; await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible();
  await login(page); await open(page); await expect(query).toHaveValue("");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole("button", { name: "직접 북마크" }).click(); await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape"); await noOverflow(); expect(remote).toEqual([]); expect(errors).toEqual([]);
});
