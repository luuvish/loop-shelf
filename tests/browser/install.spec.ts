import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Chromium installs, launches a standalone window, and uninstalls the real manifest", async () => {
  const directory = mkdtempSync(join(tmpdir(), "loopshelf-install-"));
  // Full Chromium's headless mode supports app windows; the headless shell does not.
  const context = await chromium.launchPersistentContext(directory, { channel: "chromium", headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  });
  const manifestId = "http://127.0.0.1:4189/";
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  let installed = false;
  try {
    await page.goto(manifestId); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const manifest = await cdp.send("Page.getAppManifest");
    expect(manifest.errors).toEqual([]);
    expect((await cdp.send("Page.getInstallabilityErrors")).installabilityErrors).toEqual([]);
    await cdp.send("PWA.install", { manifestId }); installed = true;
    await cdp.send("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" });
    const result = await cdp.send("PWA.launch", { manifestId }); expect(result.targetId).toBeTruthy();
    await expect.poll(async () => {
      for (const candidate of context.pages()) if (candidate.url().startsWith(manifestId) && await candidate.evaluate(() => matchMedia("(display-mode: standalone)").matches)) return true;
      return false;
    }).toBe(true);
  } finally {
    try { if (installed) await cdp.send("PWA.uninstall", { manifestId }); }
    finally { await context.close(); rmSync(directory, { recursive: true, force: true }); }
  }
});
