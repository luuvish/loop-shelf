import { test, expect, type Page, type Route } from "@playwright/test";
import { response, album, type Query } from "./search-fixture.ts";

const password = "browser-test-password-123";
function gate() { let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; }); return { waiting, release }; }
async function login(page: Page, email = "alice@example.test") {
  await page.getByLabel("이메일", { exact: true }).fill(email); await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click(); await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}
test("source album saving confirms private input, recovers lost results and isolates sessions", async ({ page, context }, info) => {
  const origin = String(info.project.use.baseURL), remote: string[] = [], errors: string[] = [], writes: Record<string, unknown>[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (req) => { if (new URL(req.url()).pathname === "/api/source-album/save") writes.push(req.postDataJSON() as Record<string, unknown>); });
  await context.route("**/*", async (route) => {
    if (!route.request().url().startsWith(`${origin}/`)) { remote.push(route.request().url()); await route.abort(); } else await route.continue();
  });
  await page.goto("/"); await login(page);
  let user = (await (await page.request.get("/api/auth/get-session")).json()).user as { id: string }, key = "save-first";
  await page.route("**/api/search", async (route) => {
    const value = response(route.request().postDataJSON() as Query);
    value.local = { ok: true, sampleKind: "synthetic", freshness: "not-revalidated", items: [], nextOffset: null };
    for (const part of value.sources) if (part.result.ok) part.result.data.albums = [album(part.sourceId, key)];
    await route.fulfill({ contentType: "application/json", headers: { "Cache-Control": "no-store", "X-LoopShelf-User": user.id,
      "X-LoopShelf-Session": route.request().headers()["x-loopshelf-session"]! }, body: JSON.stringify(value) });
  });
  const dialog = page.getByRole("dialog", { name: "소스 앨범 상세", exact: true }), panel = dialog.getByRole("region", { name: "앨범 저장 확인", exact: true });
  const note = panel.getByLabel("메모", { exact: false }), title = panel.getByLabel("나만의 제목", { exact: false });
  const confirm = panel.getByRole("button", { name: "확인하고 저장", exact: true });
  const search = async () => { await page.getByRole("button", { name: "검색", exact: true }).click(); await expect(page.getByRole("button", { name: /상세 보기/ })).toBeVisible(); };
  const enter = async () => {
    await page.getByRole("button", { name: "음악 검색", exact: true }).click();
    await page.getByLabel("앨범 이름", { exact: true }).fill("별의 기억"); await page.getByLabel("Zophar’s Domain", { exact: true }).check(); await search();
  };
  const open = async () => { await page.getByRole("button", { name: /상세 보기/ }).click(); await expect(panel).toContainText("저장 확인 가능"); };
  const close = async () => { await dialog.getByRole("button", { name: "닫기", exact: true }).click(); await expect(dialog).toHaveCount(0); };
  const next = async (name: string) => { await close(); key = name; await search(); await open(); };
  const edit = async (text: string) => { await panel.getByRole("button", { name: "내 선반에 저장", exact: true }).click(); await note.fill(text); };
  const prepare = async () => { await panel.getByRole("button", { name: "저장 내용 확인", exact: true }).click(); await expect(panel.getByRole("group", { name: "저장할 내용" })).toBeVisible(); };
  const recover = () => panel.getByRole("button", { name: "선반과 상세 다시 확인", exact: true });
  const screenshot = async (name: string) => {
    await panel.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true); await page.screenshot({ path: info.outputPath(`${name}.png`) });
  };
  await enter(); await open(); await edit("별을 기억하는 메모 <script>not code</script>"); await panel.getByLabel("즐겨찾기에 추가", { exact: true }).check();
  await expect(title).toHaveValue(""); await prepare(); await expect(panel).toContainText("현재 원본 제목 사용"); await screenshot("save-confirmation");
  // A real API commit with delayed delivery: repeated clicks issue only one write.
  let pending = gate();
  await page.route("**/api/source-album/save", async (route) => { const result = await route.fetch(); await pending.waiting; await route.fulfill({ response: result }).catch(() => {}); });
  const initial = writes.length; await confirm.dblclick(); await expect(panel.getByText("저장 결과를 확인하는 중…")).toBeVisible(); expect(writes.length).toBe(initial + 1);
  pending.release(); await expect(panel).toContainText("내 선반에 앨범을 저장했습니다.");
  expect(writes.at(-1)).toMatchObject({ sourceId: "zophar", externalKey: "nes/save-first", titleOverride: null, favorite: true });
  expect(Object.keys(writes.at(-1)!).sort()).toEqual(["sourceId", "externalKey", "expectedFingerprint", "titleOverride", "note", "favorite"].sort());
  await screenshot("save-complete"); await page.unroute("**/api/source-album/save");
  await close(); await open(); const count = writes.length; await panel.getByRole("button", { name: "내 선반에 저장", exact: true }).click();
  await expect(panel).toContainText("이미 내 선반에 저장되어 있습니다"); await expect(panel).toContainText("별을 기억하는 메모"); expect(writes.length).toBe(count);
  await panel.getByRole("button", { name: "저장한 카탈로그 확인 →" }).click(); await expect(page.getByRole("heading", { name: "저장한 카탈로그." })).toBeVisible();
  await expect(page.getByText("별을 기억하는 메모 <script>not code</script>", { exact: true })).toBeVisible(); await enter(); key = "save-conflict"; await search(); await open();

  // Another save can win after the lookup. A 200 response preserves that saved content, not the draft.
  await edit("덮어쓰면 안 되는 새 초안"); await prepare();
  await page.route("**/api/source-album/save", async (route) => {
    const first = await route.fetch({ postData: JSON.stringify({ ...route.request().postDataJSON(), note: "먼저 저장된 메모", titleOverride: "먼저 저장된 제목" }) }); expect(first.status()).toBe(201);
    const duplicate = await route.fetch(); expect(duplicate.status()).toBe(200); await route.fulfill({ response: duplicate });
  });
  await confirm.click(); await expect(panel).toContainText("이미 저장한 앨범입니다"); await expect(panel).toContainText("먼저 저장된 메모");
  await page.unroute("**/api/source-album/save"); await next("save-snapshot-conflict");

  // A changed observation requires another detail/owned-state check and a fresh confirmation, retaining the draft.
  let wrongFingerprint = true;
  await page.route("**/api/source-album", async (route) => { const result = await route.fetch(), value = await result.json();
    if (wrongFingerprint && value.save.status === "available") value.save.expectedFingerprint = "0".repeat(64);
    await route.fulfill({ response: result, body: JSON.stringify(value) }); });
  await dialog.getByRole("button", { name: "상세 새로고침", exact: true }).click(); await edit("변경 후에도 유지할 초안"); await title.fill("나만의 이름"); await prepare(); await confirm.click();
  await expect(panel).toContainText("앨범 정보가 바뀌었습니다"); await expect(note).toHaveValue("변경 후에도 유지할 초안"); await expect(confirm).toHaveCount(0);
  await expect(panel.getByText("재확인 필요", { exact: true })).toBeVisible();
  await screenshot("save-conflict"); wrongFingerprint = false; const beforeRefresh = writes.length; await recover().click();
  await expect(panel.getByRole("button", { name: "저장 내용 확인", exact: true })).toBeEnabled(); expect(writes.length).toBe(beforeRefresh); await expect(title).toHaveValue("나만의 이름");
  await prepare(); await confirm.click(); await expect(panel).toContainText("내 선반에 앨범을 저장했습니다"); await page.unroute("**/api/source-album");

  await next("save-lost"); await edit("응답 유실에도 남을 메모"); await prepare();
  await page.route("**/api/source-album/save", async (route) => { const result = await route.fetch(); expect(result.status()).toBe(201); await route.abort(); });
  await confirm.click(); await expect(recover()).toBeVisible(); const lostCount = writes.length; await page.unroute("**/api/source-album/save"); await recover().click();
  await expect(panel).toContainText("이미 내 선반에 저장되어 있습니다"); await expect(panel).toContainText("응답 유실에도 남을 메모"); expect(writes.length).toBe(lostCount);

  await next("save-cancelled"); await edit("취소한 초안"); await prepare(); pending = gate();
  await page.route("**/api/source-album/save", async (route) => { await pending.waiting; await route.fulfill({ status: 401, contentType: "application/json", body: '{"code":"unauthorized"}' }).catch(() => {}); });
  await confirm.click(); await panel.getByRole("button", { name: "저장 요청 취소", exact: true }).click(); pending.release();
  await expect(recover()).toBeVisible(); await expect(note).toHaveValue("취소한 초안"); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toHaveCount(0);
  await page.unroute("**/api/source-album/save"); pending = gate(); const refreshing = gate();
  await page.route("**/api/source-album", async (route) => { refreshing.release(); await pending.waiting;
    await route.fulfill({ status: 401, contentType: "application/json", body: '{"code":"unauthorized"}' }).catch(() => {}); });
  await recover().click(); await refreshing.waiting;
  await panel.getByRole("button", { name: "저장 요청 취소", exact: true }).click(); pending.release();
  await expect(recover()).toBeEnabled(); await expect(dialog.getByRole("region", { name: "출처의 앨범 정보", exact: true })).toHaveCount(0);
  await expect(note).toHaveValue("취소한 초안"); await page.unroute("**/api/source-album");
  await recover().click(); await expect(panel.getByRole("button", { name: "저장 내용 확인", exact: true })).toBeEnabled();

  await next("save-limited"); await edit("대기하는 초안"); await prepare();
  await page.route("**/api/source-album/save", async (route) => route.fulfill({ status: 429, headers: { "Retry-After": "2" }, contentType: "application/json", body: '{"code":"rate_limited"}' }));
  await confirm.click(); await expect(recover()).toBeDisabled(); await expect(dialog.getByRole("button", { name: "상세 새로고침", exact: true })).toBeDisabled();
  const limitedCount = writes.length; await expect(recover()).toBeEnabled(); expect(writes.length).toBe(limitedCount); await page.unroute("**/api/source-album/save");
  await recover().click(); await expect(note).toHaveValue("대기하는 초안");

  await next("save-expiry"); await page.route("**/api/source-album", async (route) => {
    const result = await route.fetch(), value = await result.json(); if (value.result.ok && value.save.status === "available") {
      value.result.delivery.freshUntil = value.save.validUntil = new Date(Date.parse(value.completedAt) + 2500).toISOString();
    } await route.fulfill({ response: result, body: JSON.stringify(value) });
  });
  await dialog.getByRole("button", { name: "상세 새로고침", exact: true }).click(); await edit("기한이 지나도 유지할 초안"); await prepare();
  const expiredCount = writes.length; await expect(panel).toContainText("저장 확인 기한이 지났거나 이전 자료");
  await expect(panel.getByRole("button", { name: "저장 내용 확인", exact: true })).toBeDisabled(); expect(writes.length).toBe(expiredCount); await expect(note).toHaveValue("기한이 지나도 유지할 초안");
  await page.unroute("**/api/source-album");

  await next("save-offline"); await edit("오프라인 중 메모 유지"); await context.setOffline(true); await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  await expect(dialog).not.toBeVisible(); const offlineCount = writes.length; await context.setOffline(false); await expect(dialog).toBeVisible();
  await expect(note).toHaveValue("오프라인 중 메모 유지"); await expect(recover()).toBeVisible(); expect(writes.length).toBe(offlineCount);
  await recover().click(); await expect(panel.getByRole("button", { name: "저장 내용 확인", exact: true })).toBeEnabled();

  // A failed current-cookie check never presents a committed response as confirmed success.
  await next("save-session-check"); await edit("세션 확인 대기 메모"); await prepare(); let failSession = false;
  await page.route("**/api/auth/get-session", async (route) => { if (failSession) await route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"unavailable"}' }); else await route.continue(); });
  await page.route("**/api/source-album/save", async (route) => { const result = await route.fetch(); failSession = true; await route.fulfill({ response: result }); });
  await confirm.click(); await expect(recover()).toBeVisible(); await expect(panel.getByText("내 선반에 앨범을 저장했습니다.", { exact: true })).toHaveCount(0);
  failSession = false; await page.unroute("**/api/auth/get-session"); await page.unroute("**/api/source-album/save"); await recover().click(); await expect(panel).toContainText("이미 내 선반에 저장되어 있습니다");

  await next("save-invalid-result"); await edit("검증할 저장 응답"); await prepare();
  await page.route("**/api/source-album/save", async (route) => { const result = await route.fetch(), value = await result.json();
    value.item.entity.externalKey = "nes/another"; value.item.note = "표시하면 안 되는 응답"; await route.fulfill({ response: result, body: JSON.stringify(value) }); });
  await confirm.click(); await expect(recover()).toBeVisible(); await expect(page.getByText("표시하면 안 되는 응답", { exact: true })).toHaveCount(0);
  await page.unroute("**/api/source-album/save"); await recover().click(); await expect(panel).toContainText("이미 내 선반에 저장되어 있습니다");

  await next("save-policy-change"); await edit("정책 변경 후 초안"); await prepare();
  await page.route("**/api/source-album/save", async (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"code":"policy_disabled"}' }));
  await confirm.click(); await expect(recover()).toBeVisible(); await expect(dialog.getByRole("region", { name: "출처의 앨범 정보", exact: true })).toHaveCount(0);
  await expect(note).toHaveValue("정책 변경 후 초안"); await page.unroute("**/api/source-album/save");

  // A different current cookie invalidates the old response even though the old session itself remains valid.
  await next("save-switch"); await edit("다른 계정에 보이면 안 되는 초안"); await prepare(); pending = gate(); const committed = gate();
  await page.route("**/api/source-album/save", async (route: Route) => { const result = await route.fetch(); committed.release(); await pending.waiting; await route.fulfill({ response: result }).catch(() => {}); });
  await confirm.click(); await committed.waiting;
  const loginOther = await page.request.post("/api/auth/sign-in/email", { headers: { Origin: origin }, data: { email: "bob@example.test", password } }); expect(loginOther.status()).toBe(200);
  pending.release(); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(dialog).toHaveCount(0);
  await page.unroute("**/api/source-album/save"); await login(page, "bob@example.test"); user = (await (await page.request.get("/api/auth/get-session")).json()).user;
  key = "save-switch"; await enter(); await page.getByRole("button", { name: /상세 보기/ }).click();
  // This long scenario reaches the real shared 30/minute budget. Keep the product limit
  // and use the same explicit retry a person would, after the advertised cooldown.
  await expect(panel.getByText("저장 확인 가능", { exact: true }).or(dialog.getByRole("alert"))).toBeVisible();
  if (await dialog.getByRole("alert").isVisible()) {
    await expect(dialog.getByRole("alert")).toContainText("요청이 많습니다");
    const retry = dialog.getByRole("button", { name: "다시 조회", exact: true });
    await expect(retry).toBeEnabled({ timeout: 65_000 }); await retry.click();
  }
  await expect(panel).toContainText("저장 확인 가능"); await edit("새 계정의 초안"); await expect(title).toHaveValue("");
  await expect(page.getByText("다른 계정에 보이면 안 되는 초안", { exact: true })).toHaveCount(0);
  // A failed response also rechecks the current cookie before retaining an account's draft.
  await prepare(); pending = gate(); const failed = gate();
  await page.route("**/api/source-album/save", async (route) => { failed.release(); await pending.waiting; await route.fulfill({ status: 409, contentType: "application/json", body: '{"code":"snapshot_changed"}' }).catch(() => {}); });
  await confirm.click(); await failed.waiting;
  expect((await page.request.post("/api/auth/sign-in/email", { headers: { Origin: origin }, data: { email: "alice@example.test", password } })).status()).toBe(200);
  pending.release(); await expect(page.getByRole("heading", { name: "나의 선반으로" })).toBeVisible(); await expect(dialog).toHaveCount(0);
  await page.unroute("**/api/source-album/save");
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(remote).toEqual([]); expect(errors).toEqual([]);
});
