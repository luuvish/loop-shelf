import { test, expect, type Page } from "@playwright/test";

const origin = "http://127.0.0.1:4189";
const headers = { origin };
async function ready(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function cachedPaths(page: Page) {
  return page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys()) {
      if (name.startsWith("loopshelf-shell-v1-")) for (const request of await (await caches.open(name)).keys()) result.push(new URL(request.url).pathname);
    }
    return result.sort();
  });
}

test("offline shell, memory-only drafts and session revalidation protect private data", async ({ page, context }, testInfo) => {
  await page.request.post("/__test/pwa-release", { headers, data: { variant: "base" } });
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await ready(page);
  const paths = await cachedPaths(page);
  expect(paths).toContain("/index.html");
  expect(paths.every((path) => /^(\/index\.html|\/manifest\.webmanifest|\/favicon\.svg|\/icons\/[\w-]+\.png|\/assets\/[\w-]+\.(css|js))$/u.test(path))).toBe(true);
  await page.getByLabel("이메일", { exact: true }).fill("alice@example.test");
  await page.getByLabel("비밀번호", { exact: true }).fill("browser-test-password-123");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
  const title = `PWA 개인 북마크 ${testInfo.project.name}`;
  await page.getByRole("button", { name: "북마크 추가", exact: true }).click();
  await page.getByLabel("제목 필수").fill(title);
  await page.getByLabel("앨범 주소 필수").fill(`https://www.zophar.net/music/snes/${testInfo.project.name}.html`);
  await page.getByLabel("메모 선택").fill("캐시에 없어야 하는 개인 메모");
  await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("article", { name: title, exact: true })).toBeVisible();
  const snapshot = await page.evaluate(async () => {
    const output = [];
    for (const path of ["/api/auth/get-session", "/api/bookmarks", "/api/library/export"]) {
      const response = await fetch(path); output.push({ status: response.status, cache: response.headers.get("cache-control"), data: await response.text() });
    }
    return output;
  });
  expect(snapshot.every((entry) => entry.status === 200 && entry.cache === "no-store")).toBe(true);
  expect(snapshot[2]!.data).toContain(title);
  expect(await cachedPaths(page)).toEqual(paths);
  await page.getByRole("button", { name: `${title} 편집` }).click();
  await page.getByLabel("메모 선택").fill("이 창에서만 유지되는 초안");
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("article")).not.toBeVisible();
  await page.getByRole("button", { name: "연결 다시 확인" }).click();
  await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("offline.png") });
  await context.setOffline(false);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("메모 선택")).toHaveValue("이 창에서만 유지되는 초안");
  // No automatic mutation was queued while disconnected.
  const archive = await (await page.request.get("/api/library/export")).json();
  expect(JSON.stringify(archive)).not.toContain("이 창에서만 유지되는 초안");
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  // Change the real cookie session while the browser is offline, as another client can.
  expect((await page.request.post("/api/auth/sign-out", { headers, data: {} })).ok()).toBe(true);
  expect((await page.request.post("/api/auth/sign-in/email", { headers, data: { email: "bob@example.test", password: "browser-test-password-123" } })).ok()).toBe(true);
  await context.setOffline(false);
  await expect(page.getByRole("heading", { name: "첫 번째 음악을 놓아 보세요" })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(await page.evaluate(() => document.body.textContent)).not.toContain(title);
  expect(await page.locator("textarea").count()).toBe(0);
  expect(await cachedPaths(page)).toEqual(paths);
  await page.getByRole("button", { name: "내 계정", exact: true }).click();
  await page.getByText("앱 설치·업데이트", { exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("오프라인 안내가 준비되었습니다");
  await page.screenshot({ path: testInfo.outputPath("installation-help.png") });
  await page.getByRole("dialog").getByRole("button", { name: "로그아웃", exact: true }).click();
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  expect(await cachedPaths(page)).toEqual(paths);
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  expect(await page.evaluate(() => document.body.textContent)).not.toContain(title);
  const privateFetch = await page.evaluate(async () => { try { await fetch("/api/bookmarks"); return "unexpected response"; } catch { return "offline"; } });
  expect(privateFetch).toBe("offline");
  await context.setOffline(false);
  await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
  expect(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: await indexedDB.databases() }))).toEqual({ local: 0, session: 0, databases: [] });
  expect(errors).toEqual([]);
});

test("failed releases preserve the shell; valid updates wait for every open client", async ({ page, context }, testInfo) => {
  await page.request.post("/__test/pwa-release", { headers, data: { variant: "base" } });
  await ready(page);
  const initial = await page.evaluate(() => caches.keys());
  await page.request.post("/__test/pwa-release", { headers, data: { variant: "broken" } });
  const state = await page.evaluate(async () => {
    const registration = (await navigator.serviceWorker.getRegistration())!;
    const failed = new Promise<string>((resolve) => {
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing!;
        worker.addEventListener("statechange", () => { if (worker.state === "redundant") resolve(worker.state); });
      }, { once: true });
    });
    await registration.update(); return failed;
  });
  expect(state).toBe("redundant");
  expect(await page.evaluate(() => caches.keys())).toEqual(initial);
  expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);
  await page.request.post("/__test/pwa-release", { headers, data: { variant: "next" } });
  await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
  await page.getByText("앱 설치·업데이트", { exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "모든 LoopShelf 창" })).toBeVisible();
  await expect(page.getByText("앱 준비 또는 업데이트 확인에 실패했습니다. 연결 후 다시 확인해 주세요.")).not.toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill("unsaved@example.test");
  await page.locator(".pwa-info").screenshot({ path: testInfo.outputPath("update-ready.png") });
  const second = await context.newPage(); await ready(second);
  await expect(page.getByLabel("이메일", { exact: true })).toHaveValue("unsaved@example.test");
  await page.close();
  expect(await second.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
  await second.close();
  const reopened = await context.newPage(); await ready(reopened);
  await expect.poll(() => reopened.evaluate(() => caches.keys())).toEqual([`${initial[0]}-next`]);
  expect(await reopened.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);
  await context.setOffline(true); await reopened.reload();
  await expect(reopened.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
  await context.setOffline(false);
});
