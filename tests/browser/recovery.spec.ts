import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/database/connection.ts";
import { BookmarkStore } from "../../src/library/bookmarks.ts";
import type { Bookmark, BookmarkConnections } from "../../src/shared/bookmarks.ts";

const origin = "http://127.0.0.1:4190", headers = { origin };
const password = "recovery-test-password-123";
async function login(page: Page, email: string) {
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill(password);
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "내 음악 선반." })).toBeVisible();
}

test("operator backup and fresh-path recovery preserve libraries through a real server restart and PWA reconnect", async ({ page, context, browser }, testInfo) => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-browser-recovery-"));
  const original = join(directory, "original.sqlite"), snapshot = join(directory, "snapshot.sqlite"), restored = join(directory, "restored.sqlite");
  const env = { ...process.env, DATABASE_PATH: original, APP_ORIGIN: origin, PORT: "4190", BETTER_AUTH_SECRET: randomBytes(32).toString("hex") };
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  const run = (script: string, args: string[], input = "") => {
    // Actual operator entry points, explicit temporary environment; never read the operator's .env.
    const result = spawnSync(process.execPath, [script, ...args], { env, input, encoding: "utf8", timeout: 15000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain(password);
    return result.stdout;
  };
  let stop: (() => Promise<void>) | undefined;
  async function start() {
    const child = spawn(process.execPath, ["src/server/main.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    stop = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await closed; } finally { clearTimeout(timeout); }
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error(`Server startup timed out: ${output}`)), 15000);
      const ready = () => { if (output.includes(`LoopShelf listening at ${origin}`)) finish(); };
      const failed = () => finish(new Error(`Server exited before ready: ${output}`));
      const finish = (error?: Error) => {
        clearTimeout(timeout); child.stdout.off("data", ready); child.off("close", failed); child.off("error", finish);
        if (error) reject(error); else resolve();
      };
      child.stdout.on("data", ready); child.once("close", failed); child.once("error", finish);
    });
  }
  const bobContext = await browser.newContext({ baseURL: origin });
  try {
    run("scripts/database.ts", ["migrate"]);
    for (const name of ["alice", "bob"]) run("scripts/account.ts", ["create", "--email", `${name}@example.test`, "--name", name], `${password}\n`);
    await start();
    await page.goto("/");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await login(page, "alice@example.test");
    const session = (await (await page.request.get("/api/auth/get-session")).json()).session;
    const title = "[합성 검증] 복원할 음악", note = "백업 시점의 개인 메모";
    await page.getByRole("button", { name: "북마크 추가", exact: true }).click();
    await page.getByLabel("제목 필수").fill(title);
    await page.getByLabel("앨범 주소 필수").fill("https://downloads.khinsider.com/game-soundtracks/album/recovery-test");
    await page.getByLabel("메모 선택").fill(note);
    await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
    const card = page.getByRole("article", { name: title, exact: true });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: `${title} 즐겨찾기`, exact: true }).click();
    await expect(card.getByRole("button", { name: `${title} 즐겨찾기`, exact: true })).toHaveAttribute("aria-pressed", "true");
    const root: Bookmark = (await (await page.request.get("/api/bookmarks")).json()).items[0];
    const memberResponse = await page.request.post("/api/bookmarks", { headers, data: {
      title: "[합성 검증] 원래 출처", note: "별칭검색 月影", url: "https://www.zophar.net/music/snes/recovery-test.html",
    } });
    expect(memberResponse.status()).toBe(201);
    const member: Bookmark = (await memberResponse.json()).item;
    const connected = await page.request.post(`/api/bookmarks/${root.id}/connections`, { headers, data: { version: root.version, memberId: member.id, memberVersion: member.version } });
    expect(connected.status()).toBe(200);
    const saved: BookmarkConnections = await connected.json();
    const bob = await bobContext.newPage();
    await bob.goto("/"); await login(bob, "bob@example.test");
    const bobResponse = await bob.request.post("/api/bookmarks", { headers, data: { title: "Bob만의 음악", note: "다른 계정의 개인 메모", url: member.url } });
    expect(bobResponse.status()).toBe(201);
    const bobItem: Bookmark = (await bobResponse.json()).item;

    // Snapshot committed WAL while the production server is still running.
    expect(run("scripts/database.ts", ["backup", "--output", snapshot])).toContain("Backup verified");
    const digest = () => createHash("sha256").update(readFileSync(snapshot)).digest("hex");
    const snapshotHash = digest();
    expect((await page.request.patch(`/api/bookmarks/${root.id}`, { headers, data: { version: saved.root.version, note: "백업 이후 변경" } })).status()).toBe(200);
    const later = await page.request.post("/api/bookmarks", { headers, data: { title: "백업 이후 추가", url: member.url.replace("recovery-test", "after-backup") } });
    expect(later.status()).toBe(201);
    const laterId: string = (await later.json()).item.id;
    await page.reload();
    await card.getByRole("button", { name: `${title} 편집` }).click();
    await page.getByLabel("메모 선택").fill("복구 전 세션의 미저장 초안");
    await context.setOffline(true);
    await expect(page.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
    await stop!(); stop = undefined;
    const offlinePage = await context.newPage();
    await offlinePage.goto("/");
    await expect(offlinePage.getByRole("heading", { name: "연결이 필요해요" })).toBeVisible();
    expect(await offlinePage.evaluate(() => document.body.textContent)).not.toContain(title);
    await offlinePage.screenshot({ path: testInfo.outputPath("recovery-offline.png") });

    expect(run("scripts/database.ts", ["restore", "--input", snapshot, "--output", restored])).toContain("sessions, verification tokens and session-owned undo receipts removed");
    expect(digest()).toBe(snapshotHash);
    env.DATABASE_PATH = restored;
    run("scripts/database.ts", ["migrate"]);
    await start();
    // Both cookies really came from the backed-up database; neither may regain access.
    expect((await page.request.get("/api/bookmarks")).status()).toBe(401);
    expect((await bob.request.get("/api/bookmarks")).status()).toBe(401);
    await context.setOffline(false);
    await expect(page.getByRole("button", { name: "로그인", exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await login(page, "alice@example.test");
    await expect(card).toContainText(note);
    await expect(card.getByRole("button", { name: `${title} 즐겨찾기`, exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByRole("button", { name: "2개 출처 · 개인 연결", exact: true })).toBeVisible();
    expect(await (await page.request.get(`/api/bookmarks/${root.id}/connections`)).json()).toEqual(saved);
    expect((await page.request.get(`/api/bookmarks/${laterId}`)).status()).toBe(404);
    expect((await page.request.patch(`/api/bookmarks/${root.id}`, { headers: { ...headers, "x-loopshelf-session": session.id }, data: { version: saved.root.version, note: "stale draft" } })).status()).toBe(401);
    await page.getByLabel("내 북마크 검색").fill("月影");
    await page.getByRole("button", { name: "검색", exact: true }).click();
    await expect(card).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(1);
    await card.getByRole("button", { name: `${title} 편집` }).click();
    await page.getByLabel("메모 선택").fill("복구 후 브라우저에서 수정");
    await page.getByRole("dialog").getByRole("button", { name: "저장", exact: true }).click();
    await expect(card).toContainText("복구 후 브라우저에서 수정");
    await page.reload(); await expect(card).toContainText("복구 후 브라우저에서 수정");
    await page.screenshot({ path: testInfo.outputPath("recovered-library.png") });

    await bob.goto("/"); await login(bob, "bob@example.test");
    await expect(bob.getByRole("article", { name: bobItem.title, exact: true })).toBeVisible();
    expect((await (await bob.request.get("/api/bookmarks")).json()).items).toEqual([bobItem]);
    expect((await bob.request.get(`/api/bookmarks/${root.id}`)).status()).toBe(404);
    expect((await bob.request.patch(`/api/bookmarks/${root.id}`, { headers, data: { version: saved.root.version, note: "cross-account" } })).status()).toBe(404);
    expect((await (await page.request.get(`/api/bookmarks/${root.id}`)).json()).note).toBe("복구 후 브라우저에서 수정");
    const old = openDatabase(original);
    try {
      expect(new BookmarkStore(old).get(session.userId, root.id).note).toBe("백업 이후 변경");
      expect(new BookmarkStore(old).get(session.userId, laterId).id).toBe(laterId);
    } finally { old.close(); }
    expect(digest()).toBe(snapshotHash);
    expect(await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) paths.push(new URL(request.url).pathname);
      return { privatePaths: paths.filter((path) => path.startsWith("/api/")), local: localStorage.length, session: sessionStorage.length, databases: await indexedDB.databases() };
    })).toEqual({ privatePaths: [], local: 0, session: 0, databases: [] });
    expect(errors).toEqual([]);
  } finally {
    await bobContext.close();
    await stop?.();
    rmSync(directory, { recursive: true, force: true });
  }
});
