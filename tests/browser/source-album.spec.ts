import { test, expect, type Page, type Route } from "@playwright/test";
import { response, type Query } from "./search-fixture.ts";
import { albumResponse, type AlbumQuery } from "./source-album-fixture.ts";
import type { SourceAlbumResponse } from "../../src/shared/source-album.ts";

const password = "browser-test-password-123";
function gate() { let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); return { waiting, release }; }
async function login(page: Page) {
  await page.getByLabel("이메일", { exact: true }).fill("alice@example.test");
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}

test("source album detail preserves provenance and row identity with cancellation and session isolation", async ({ page, context }, testInfo) => {
  const origin = String(testInfo.project.use.baseURL), remote: string[] = [], errors: string[] = [], requests: AlbumQuery[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/source-album") requests.push(req.postDataJSON() as AlbumQuery); });
  await context.route("**/*", async (route) => {
    if (!route.request().url().startsWith(`${origin}/`)) { remote.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  await page.goto("/"); await login(page);
  let user = (await (await page.request.get("/api/auth/get-session")).json()).user as { id: string };
  let searchStale = false;
  await page.route("**/api/search", async (route) => {
    const value = response(route.request().postDataJSON() as Query);
    if (searchStale) for (const part of value.sources) if (part.sourceId === "zophar" && part.result.ok) {
      value.status = "partial"; part.result.delivery.freshness = "stale";
      part.result.refreshFailure = { ok: false, code: "network_error", stage: "transport" };
    }
    await route.fulfill({ contentType: "application/json", headers: {
    "Cache-Control": "no-store", "X-LoopShelf-User": user.id, "X-LoopShelf-Session": route.request().headers()["x-loopshelf-session"]!,
    }, body: JSON.stringify(value) });
  });
  const dialog = page.getByRole("dialog", { name: "소스 앨범 상세", exact: true });
  const info = dialog.getByRole("region", { name: "출처의 앨범 정보", exact: true });
  const tracks = dialog.getByRole("region", { name: "출처 수록곡", exact: true });
  const submit = page.getByRole("button", { name: "검색", exact: true });
  const results = page.getByRole("region", { name: "통합 검색 결과", exact: true });
  const bucket = (name: string) => page.getByRole("region", { name: `${name} 검색 결과`, exact: true });
  const open = (name = "KHInsider") => bucket(name).getByRole("button", { name: /상세 보기/ });
  const retry = () => dialog.getByRole("button", { name: /^(다시 조회|상세 새로고침)$/ });
  const close = async () => { await dialog.getByRole("button", { name: "닫기", exact: true }).click(); await expect(dialog).toHaveCount(0); };
  const search = async () => { await submit.click(); await expect(open()).toBeVisible(); };
  const enter = async () => {
    await page.getByRole("button", { name: "음악 검색", exact: true }).click();
    await page.getByLabel("앨범 이름", { exact: true }).fill("별의 기억");
    await page.getByLabel("KHInsider", { exact: true }).check(); await page.getByLabel("Zophar’s Domain", { exact: true }).check();
    await search();
  };
  const screenshot = async (name: string) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  };
  await enter(); expect(requests).toHaveLength(0);
  // The real API stays disabled. The search entry is synthetic, but this failure has no metadata.
  await open().click(); await expect(dialog).toContainText("이용 조건 확인 중");
  await expect(dialog).toContainText("수록곡 0개라는 뜻은 아닙니다"); await expect(retry()).toHaveCount(0);
  expect(requests.at(-1)).toEqual({ sourceId: "khinsider", externalKey: "star" });
  await screenshot("album-policy-disabled"); await close(); await expect(results).toHaveCount(0);

  // All subsequent successful responses are explicit synthetic fixtures. No ingestion or player is attached.
  let decorate = (value: SourceAlbumResponse) => value, pending: ReturnType<typeof gate> | null = null;
  let status = 200, badSession = false;
  await page.route("**/api/source-album", async (route: Route) => {
    const body = decorate(albumResponse(route.request().postDataJSON() as AlbumQuery)), delayed = pending;
    const capturedStatus = status, capturedUser = user.id, capturedSession = badSession ? "wrong-session" : route.request().headers()["x-loopshelf-session"]!;
    if (delayed) await delayed.waiting;
    await route.fulfill({ status: capturedStatus, contentType: "application/json", headers: {
      "Cache-Control": "no-store", "X-LoopShelf-User": capturedUser, "X-LoopShelf-Session": capturedSession,
      ...(capturedStatus === 429 ? { "Retry-After": "3" } : {}),
    }, body: JSON.stringify(capturedStatus === 429 ? { ok: false, code: "rate_limited" } : capturedStatus === 401 ? { ok: false, code: "unauthorized" }
      : capturedStatus === 504 ? { ok: false, code: "album_timeout" } : body) }).catch(() => {});
  });
  await search(); pending = gate(); const double = pending, initialCount = requests.length;
  await open().dblclick(); await expect(dialog.getByRole("button", { name: "조회 취소" })).toBeVisible();
  expect(requests).toHaveLength(initialCount + 1); double.release(); pending = null;
  await expect(info).toContainText("상세 앨범 제목"); await expect(info).toContainText("실제로 수집한 앨범이 아닙니다");
  await expect(tracks.getByRole("listitem")).toHaveCount(20);
  await expect(tracks.getByText("01", { exact: true })).toHaveCount(2);
  await expect(tracks.getByRole("listitem").first()).toContainText("원문 길이 미확인");
  await expect(tracks.getByRole("listitem").nth(1)).toContainText("반복 / ?");
  await info.getByText("출처에 적힌 추가 정보", { exact: true }).click();
  await expect(info).toContainText('<img src=x onerror="alert(1)">'); await expect(dialog.locator("img, audio, iframe")).toHaveCount(0);
  await expect(info).toContainText("1989?"); await expect(dialog.getByRole("button", { name: "저장", exact: true })).toHaveCount(0);
  await dialog.evaluate((el) => { el.scrollTop = 0; }); await screenshot("album-detail");
  const pageCount = requests.length;
  await tracks.getByRole("button", { name: "다음 →" }).click(); await expect(tracks.getByRole("listitem")).toHaveCount(1);
  await expect(tracks).toContainText("순서 21"); expect(requests).toHaveLength(pageCount); await screenshot("album-tracks");
  await dialog.getByRole("button", { name: "닫기", exact: true }).focus(); await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "검색으로 돌아가기" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(open()).toBeFocused();
  await expect(bucket("KHInsider").getByRole("heading", { name: "[합성] 별의 기억", exact: true })).toBeVisible();

  // Stale cache and explicit source cooldown are visible and retained when reopening the dialog.
  searchStale = true; await search();
  decorate = (value) => { value.status = "partial"; if (value.result.ok) {
    value.result.delivery.freshness = "stale"; value.result.delivery.freshUntil = value.result.provenance.capturedAt;
    value.result.refreshFailure = { ok: false, code: "rate_limited", stage: "transport", retryAt: Date.now() + 3500 };
  } return value; };
  await open("Zophar’s Domain").click(); await expect(info).toContainText("이전 자료"); await expect(dialog).toContainText("갱신 실패");
  expect(requests.at(-1)).toEqual({ sourceId: "zophar", externalKey: "nes/star" }); await expect(retry()).toBeDisabled();
  await close(); await expect(bucket("Zophar’s Domain").getByRole("button", { name: "Zophar’s Domain 다시 검색", exact: true })).toBeDisabled();
  const limitedCount = requests.length; await open("Zophar’s Domain").click(); await expect(retry()).toBeDisabled();
  await expect(retry()).toBeEnabled(); expect(requests).toHaveLength(limitedCount);
  decorate = (value) => value; await retry().click(); await expect(info).toBeVisible(); await close(); searchStale = false;

  // HTTP quotas also disable search, and never schedule an automatic retry.
  status = 429; await open().click(); await expect(retry()).toBeDisabled(); await screenshot("album-limited");
  await close(); await expect(submit).toBeDisabled(); const quotaCount = requests.length;
  await expect(submit).toBeEnabled(); expect(requests).toHaveLength(quotaCount); status = 200;

  // Closing or cancelling discards late replies, including a late 401, without clearing a newer dialog.
  pending = gate(); const cancelled = pending; status = 401; await open().click();
  await dialog.getByRole("button", { name: "조회 취소" }).click(); await expect(dialog).toContainText("취소했습니다");
  status = 200; pending = null; await retry().click(); await expect(info).toBeVisible(); cancelled.release(); await close();
  pending = gate(); const abandoned = pending; await open().click(); await expect(dialog.getByRole("button", { name: "조회 취소" })).toBeVisible();
  await page.keyboard.press("Escape"); pending = null; await open("Zophar’s Domain").click(); await expect(info).toBeVisible();
  abandoned.release(); await expect(dialog).toContainText("nes/star"); await close();

  // Removal invalidates old search metadata; parsing and HTTP timeouts remain retryable without fake zero rows.
  for (const [code, message] of [["parse_changed", "페이지 구성이 달라"], ["unsupported", "아직 지원하지"], ["blocked", "접근 제한"], ["not_found", "페이지를 찾을 수"], ["content_removed", "제거된 자료"]] as const) {
    await search(); decorate = (value) => { value.status = "failed"; value.result = { ok: false, code, stage: "album" }; return value; };
    await open().click(); await expect(dialog).toContainText(message); await expect(info).toHaveCount(0);
    await expect(dialog).toContainText("수록곡 0개라는 뜻은 아닙니다"); await close();
  }
  decorate = (value) => value; await search(); status = 504; await open().click();
  await expect(dialog.getByRole("alert")).toContainText("시간이 초과"); await expect(retry()).toBeEnabled(); status = 200; await close();
  // Mismatched identity/sample kind and expiry are rejected rather than rendered.
  for (const change of [
    (value: SourceAlbumResponse) => { value.ref.externalKey = "another-album"; },
    (value: SourceAlbumResponse) => { value.sampleKind = "live-capture"; },
    (value: SourceAlbumResponse) => { if (value.result.ok) value.result.data.tracks = []; },
  ]) {
    await search(); decorate = (value) => { change(value); return value; }; await open().click();
    await expect(dialog.getByRole("alert")).toContainText("일치하지 않습니다"); await expect(info).toHaveCount(0); await close();
  }
  decorate = (value) => { if (value.result.ok) {
    value.result.delivery.freshUntil = value.completedAt; value.result.delivery.expiresAt = new Date(Date.parse(value.completedAt) + 1500).toISOString();
  } return value; };
  await search(); await open().click(); await expect(info).toBeVisible(); await expect(dialog).toContainText("기한이 지나 상세를 지웠습니다");
  await expect(info).toHaveCount(0); await close(); await expect(results).toHaveCount(0);
  // Lifetime consumed while checking the actual session cannot become a new full lifetime in the UI.
  await search(); const authWait = gate(); let authSeen = false;
  await page.route("**/api/auth/get-session", async (route) => { authSeen = true; await authWait.waiting; await route.continue(); });
  await open().click(); await expect.poll(() => authSeen).toBe(true);
  await page.waitForTimeout(1600); // Deliberately exhaust this fixture's 1.5-second lifetime during authentication.
  authWait.release(); await expect(dialog.getByRole("alert")).toContainText("확인하는 동안 자료의 보관 기한");
  await page.unroute("**/api/auth/get-session"); await close(); decorate = (value) => value;

  await search(); pending = gate(); const offline = pending; await open().click(); await expect(dialog.getByRole("button", { name: "조회 취소" })).toBeVisible();
  await context.setOffline(true); await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  offline.release(); pending = null; const offlineCount = requests.length;
  await context.setOffline(false); await expect(submit).toBeVisible(); await expect(dialog).toHaveCount(0); await expect(results).toHaveCount(0);
  expect(requests).toHaveLength(offlineCount);
  // Valid old headers are insufficient when the browser cookie has switched to another account.
  await search(); pending = gate(); const switched = pending; await open().click(); await expect(dialog.getByRole("button", { name: "조회 취소" })).toBeVisible();
  expect((await page.request.post("/api/auth/sign-in/email", { headers: { origin }, data: { email: "bob@example.test", password } })).ok()).toBe(true);
  switched.release(); pending = null; await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(dialog).toHaveCount(0);
  user = (await (await page.request.get("/api/auth/get-session")).json()).user;
  await page.reload(); await enter(); badSession = true; await open().click();
  await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); badSession = false;
  await page.reload(); await enter(); status = 401; await open().click(); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); status = 200;
  await page.reload(); await enter(); await open().click(); await expect(info).toBeVisible();
  expect((await page.request.post("/api/auth/sign-out", { headers: { origin }, data: {} })).ok()).toBe(true);
  await page.evaluate(() => { const channel = new BroadcastChannel("loopshelf-auth"); channel.postMessage("changed"); channel.close(); });
  await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(remote).toEqual([]); expect(errors).toEqual([]);
});
