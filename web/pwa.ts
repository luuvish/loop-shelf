import { useSyncExternalStore } from "react";

type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
type State = { supported: boolean; ready: boolean; update: boolean; installable: boolean; standalone: boolean; failed: boolean };
let state: State = { supported: true, ready: false, update: false, installable: false, standalone: false, failed: false };
let prompt: InstallPrompt | undefined;
let registration: ServiceWorkerRegistration | undefined;
let lastCheck = 0;
const listeners = new Set<() => void>();
function publish(value: Partial<State>) { state = { ...state, ...value }; for (const listener of listeners) listener(); }
export function usePwa() { return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state); }
export async function installApp() {
  const pending = prompt;
  if (!pending) return;
  prompt = undefined; publish({ installable: false });
  try { await pending.prompt(); await pending.userChoice; } catch { /* Browser menu remains available. */ }
}
export async function checkUpdate() {
  if (!registration || !navigator.onLine) return;
  lastCheck = Date.now();
  try { await registration.update(); publish({ failed: false }); }
  catch { publish({ failed: true }); }
}

export async function startPwa() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) { publish({ supported: false }); return; }
  if (import.meta.env.DEV) {
    // This origin may previously have served a production build. Do not let its
    // worker shadow Vite assets, and never unregister another application's worker.
    for (const item of await navigator.serviceWorker.getRegistrations()) {
      const script = item.active?.scriptURL ?? item.waiting?.scriptURL ?? item.installing?.scriptURL;
      if (item.scope === `${location.origin}/` && script === `${location.origin}/sw.js`) await item.unregister();
    }
    for (const name of await caches.keys()) if (name.startsWith("loopshelf-shell-v1-")) await caches.delete(name);
    return;
  }
  const display = matchMedia("(display-mode: standalone)");
  const standalone = () => publish({ standalone: display.matches || (navigator as Navigator & { standalone?: boolean }).standalone === true });
  display.addEventListener("change", standalone); standalone();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); prompt = event as InstallPrompt; publish({ installable: true });
  });
  window.addEventListener("appinstalled", () => { prompt = undefined; publish({ installable: false }); });
  try {
    registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", type: "module", updateViaCache: "none" });
    const sync = () => publish({ ready: !!registration?.active, update: !!registration?.waiting });
    const observe = () => {
      const worker = registration?.installing;
      worker?.addEventListener("statechange", () => { sync(); if (worker.state === "installed" || worker.state === "activated") publish({ failed: false }); if (worker.state === "redundant") publish({ failed: true }); });
      sync();
    };
    registration.addEventListener("updatefound", observe); observe();
    navigator.serviceWorker.addEventListener("controllerchange", sync);
    const refresh = () => { if (Date.now() - lastCheck > 60000) void checkUpdate(); };
    window.addEventListener("focus", refresh); window.addEventListener("online", refresh);
  } catch { publish({ failed: true }); }
}
