import { defineConfig } from "vite";
import { buildPwa } from "./scripts/build-pwa.ts";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: "web",
  plugins: [react(), { name: "loopshelf-pwa", apply: "build", async closeBundle() { await buildPwa(fileURLToPath(new URL("./dist", import.meta.url))); } }],
  server: {
    fs: {
      allow: [fileURLToPath(new URL("./web", import.meta.url))],
      deny: ["**/.env*", "**/*.{crt,pem,key,sqlite,sqlite-*,db,db-*}", "**/.git/**", "**/.local/**"],
    },
  },
  build: { outDir: "../dist", emptyOutDir: true },
});
