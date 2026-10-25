// Only loaded by the disposable track-search E2E server; never a product fixture/administration route.
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { CatalogStore } from "../../src/catalog/store.ts";
import { syntheticAlbum } from "../../scripts/benchmarks/catalog-fixture.ts";
import { withDatabase } from "../../src/database/access.ts";
import { attachSyntheticRetention } from "../../src/catalog/retention.ts";

export async function installTrackSearchFixture(db: Database.Database, server: FastifyInstance) {
  const catalog = new CatalogStore(db), albums = new Map<string, { sourceEntityId: string; observationId: string }>();
  for (let i = 0; i < 3; i++) {
    const value = syntheticAlbum(i, i === 0 ? 26 : 14);
    if (value.data.kind !== "album") throw new Error("Expected album");
    value.data.title = `[합성] 기억의 선반 ${i + 1}`;
    value.data.tracks.forEach((row, n) => {
      row.title = `[합성] 기억의 곡 ${String(n + 1).padStart(2, "0")}`; row.displayNumber = "1";
      row.discLabel = null; row.durationSeconds = n === 0 ? null : n === 1 ? 0 : 120;
      row.durationLabel = n === 0 ? null : n === 1 ? "0:00" : "2:00";
    });
    if (i === 2) value.data.tracks[2]!.title = '[합성] 記憶 %_ <img src=x onerror="alert(1)">';
    const [entry] = await catalog.ingestSynthetic(value); albums.set(entry!.albumId, entry!);
  }
  server.post<{ Body: { albumId: string; action: "expire" | "remove" } }>("/__test/tracks", async (request, reply) => {
    const entry = albums.get(request.body.albumId); if (!entry) return reply.code(400).send();
    if (request.body.action === "remove") await catalog.removeSource({ sourceEntityId: entry.sourceEntityId, reason: "rights_request" });
    else if (request.body.action === "expire") await withDatabase(db, async () => db.transaction(() => attachSyntheticRetention(db, entry.observationId, "browser-expiry", new Date(Date.now() - 1000).toISOString())).immediate());
    else return reply.code(400).send();
    return { ok: true };
  });
}
