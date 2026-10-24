// Schema simulation only. These DTOs are generated locally; there is no capture or policy override.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { syntheticAlbum } from "../../scripts/benchmarks/catalog-fixture.ts";
export function simulateLiveCatalog(db: Database.Database, userId: string) {
  const sample = syntheticAlbum(3, 2); if (sample.data.kind !== "album") throw new Error();
  const data = sample.data;
  const albumId = randomUUID(), sourceId = randomUUID(), observationId = randomUUID(), now = Date.now();
  const trackIds = data.tracks.map(() => randomUUID()), itemIds: string[] = [];
  db.transaction(() => {
    db.prepare("INSERT INTO entity VALUES (?,'album','active','now')").run(albumId);
    db.prepare("INSERT INTO album(id,title) VALUES (?,?)").run(albumId, data.title);
    db.prepare("INSERT INTO source_entity(id,source_id,external_kind,external_key,entity_id,page_url) VALUES (?,'zophar','album',?,?,?)")
      .run(sourceId, data.externalKey, albumId, data.pageUrl);
    db.prepare(`INSERT INTO catalog_observation(id,source_entity_id,kind,sample_kind,page_url,captured_at,parsed_at,parser_version,
      body_sha256,fingerprint,data_sha256,tracks_sha256,data_json,warnings_json,retention_revision,expires_at)
      VALUES (?,?,'album','live-capture',?,?,?,'schema-simulation',?,?,?,?,?,'[]','unknown-simulation-policy',?)`)
      .run(observationId, sourceId, data.pageUrl, new Date(now - 1000).toISOString(), new Date(now - 1000).toISOString(),
        ...Array.from({ length: 4 }, () => "a".repeat(64)), JSON.stringify(data), new Date(now + 3600000).toISOString());
    db.prepare("INSERT INTO catalog_album_state VALUES (?,?,?,NULL,?,?,?)").run(albumId, sourceId, observationId, observationId, observationId, observationId);
    trackIds.forEach((id, i) => {
      db.prepare("INSERT INTO entity VALUES (?,'track','active','now')").run(id);
      db.prepare("INSERT INTO track(id,album_id,position,title,duration_ms) VALUES (?,?,?,?,120000)").run(id, albumId, i + 1, data.tracks[i]!.title);
      db.prepare("INSERT INTO catalog_track_origin VALUES (?,?,?)").run(id, observationId, `row:${i + 1}`);
      db.prepare("INSERT INTO catalog_track_binding VALUES (?,?,?)").run(observationId, i + 1, id);
    });
    for (const entityId of [albumId, ...trackIds]) {
      const id = randomUUID(); itemIds.push(id);
      db.prepare("INSERT INTO library_item(id,user_id,entity_id,note,favorite,created_at,updated_at) VALUES (?,?,?,'개인 메모',1,?,?)")
        .run(id, userId, entityId, new Date(now).toISOString(), new Date(now).toISOString());
    }
  }).immediate();
  return { albumId, sourceId, observationId, trackIds, itemIds, title: data.title, sample };
}
