import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { inspectCapturedPage, MAX_HTML_BYTES } from "../src/sources/parsers.ts";
import { normalizeAlbumUrl } from "../src/sources/urls.ts";
import { productAccess } from "../src/sources/policies.ts";
import { summarizeCapture } from "../src/sources/evidence.ts";
import type { CapturedPage, PageKind, SourceId } from "../src/sources/types.ts";

function capture(sourceId: SourceId = "zophar", kind: PageKind = "search"): CapturedPage {
  const origin = sourceId === "zophar" ? "https://www.zophar.net" : "https://downloads.khinsider.com";
  const path = kind === "search" ? "/search?search=sample" : sourceId === "zophar"
    ? "/music/nintendo-snes-spc/sample.html" : "/game-soundtracks/album/sample";
  return { sourceId, kind, url: origin + path, status: 200, headers: { "Content-Type": "text/html; charset=UTF-8" },
    html: readFileSync(new URL(`./fixtures/${sourceId}-${kind === "album" && sourceId === "khinsider" ? "search" : kind}.html`, import.meta.url), "utf8"),
    capturedAt: "2026-10-18T14:00:00Z", sampleKind: "synthetic" };
}
function failure(page: CapturedPage, code: string) {
  const result = inspectCapturedPage(page);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, code);
}

test("KHInsider preserves same-title source editions, columns and provenance", () => {
  const result = inspectCapturedPage(capture("khinsider"));
  assert.ok(result.ok && result.data.kind === "search");
  assert.equal(result.data.albums.length, 2);
  assert.equal(result.data.albums[0]?.title, "星の庭 & Echo");
  assert.deepEqual(result.data.albums[0]?.platforms, ["SNES", "Windows"]);
  assert.equal(result.data.albums[0]?.sourceCategory, "Arrangement");
  assert.equal(result.data.albums[1]?.sourceYearLabel, null);
  assert.notEqual(result.data.albums[0]?.externalKey, result.data.albums[1]?.externalKey);
  assert.equal(result.provenance.sampleKind, "synthetic");
  assert.match(result.provenance.bodySha256, /^[a-f\d]{64}$/);
});

test("Zophar includes only the music section and keeps platform source keys separate", () => {
  const result = inspectCapturedPage(capture());
  assert.ok(result.ok && result.data.kind === "search");
  assert.deepEqual(result.data.albums.map((album) => album.externalKey), ["nintendo-snes-spc/sample", "playstation-psf/sample"]);
  assert.equal(result.data.albums[0]?.titleKind, "source-display-label");
  assert.deepEqual(result.data.albums[0]?.platforms, []);
});

test("Zophar explicit empty state succeeds, missing structure does not", () => {
  const page = capture();
  page.html = readFileSync(new URL("./fixtures/zophar-empty.html", import.meta.url), "utf8");
  const result = inspectCapturedPage(page);
  assert.ok(result.ok && result.data.kind === "search");
  assert.equal(result.data.reportedCount, 0);
  page.html = '<div id="main"><h2>Search Results</h2><p>New layout</p></div>';
  failure(page, "parse_changed");
});

test("KHInsider synthetic zero marker is distinct from a missing album table", () => {
  const page = capture("khinsider");
  page.html = "<p>Found 0 matching albums.</p>";
  const result = inspectCapturedPage(page);
  assert.ok(result.ok && result.data.kind === "search" && result.data.albums.length === 0);
  page.html = "<p>Found 12 matching albums.</p>";
  failure(page, "parse_changed");
});

test("Zophar preserves repeated labels, loop versions and unknown dates/discs/durations", () => {
  const result = inspectCapturedPage(capture("zophar", "album"));
  assert.ok(result.ok && result.data.kind === "album");
  assert.equal(result.data.tracks.length, 4);
  assert.deepEqual(result.data.tracks.map((track) => track.position), [1, 2, 3, 4]);
  assert.equal(result.data.tracks[1]?.displayNumber, result.data.tracks[2]?.displayNumber);
  assert.notEqual(result.data.tracks[1]?.snapshotLocator, result.data.tracks[2]?.snapshotLocator);
  assert.equal(result.data.tracks[2]?.durationSeconds, 81);
  assert.equal(result.data.tracks[3]?.durationSeconds, null);
  assert.ok(result.data.tracks.every((track) => track.externalKey === null && track.discLabel === null));
  assert.equal(result.data.releaseDate, null);
  assert.equal(result.data.playback, "unverified");
  assert.ok(result.warnings.includes("duplicate_display_numbers"));
});

test("missing optional album metadata is retained as absent", () => {
  const page = capture("zophar", "album");
  page.html = page.html.replace(/<p>.*?<\/p>/g, "");
  const result = inspectCapturedPage(page);
  assert.ok(result.ok && result.data.kind === "album");
  assert.deepEqual(result.data.sourceClaims, []);
  assert.deepEqual(result.data.platforms, []);
});

test("missing title, empty tracklist, and changed row class are parser failures", () => {
  const page = capture("zophar", "album");
  for (const html of [page.html.replace('class="name"', 'class="new-name"'),
    page.html.replace(/<tr[\s\S]*?<\/tr>/g, ""), page.html.replaceAll("trackrow", "new-row")])
    failure({ ...page, html }, "parse_changed");
});

for (const [status, code] of [[401, "blocked"], [403, "blocked"], [429, "rate_limited"],
  [404, "not_found"], [410, "not_found"], [500, "http_error"], [302, "http_error"]] as const) {
  test(`HTTP ${status} is ${code}, never zero results`, () => failure({ ...capture(), status }, code));
}

test("HTTP 200 bot challenge is blocked and KHInsider detail stays unsupported", () => {
  failure({ ...capture(), html: "<title>Just a moment...</title>" }, "blocked");
  failure(capture("khinsider", "album"), "unsupported");
  failure({ ...capture("khinsider", "album"), status: 403 }, "blocked");
});

test("JSON, oversized HTML and invalid capture context are rejected", () => {
  failure({ ...capture(), headers: { "content-type": "application/json" } }, "parse_changed");
  failure({ ...capture(), html: "x".repeat(MAX_HTML_BYTES + 1) }, "invalid_input");
  failure({ ...capture(), capturedAt: "not a date" }, "invalid_input");
  failure({ ...capture(), url: "https://localhost/search?search=x" }, "invalid_input");
  failure({ ...capture(), status: 0 }, "invalid_input");
  assert.ok(inspectCapturedPage({ ...capture(), url: "https://www.zophar.net/search?search=NieR%2FAutomata" }).ok);
});

test("unsafe or non-album URLs never become source references", () => {
  for (const url of ["javascript:alert(1)", "http://www.zophar.net/music/a/b.html",
    "https://www.zophar.net.evil.test/music/a/b.html", "https://user@www.zophar.net/music/a/b.html",
    "https://www.zophar.net:444/music/a/b.html", "https://127.0.0.1/music/a/b.html",
    "/music/year/1995.html", "/music/a/b%2fc.html", "/music/a/%2e%2e.html", "/music/a/b%252fc.html",
    "/music/a/../a/b.html", "/music/a/%FF.html", "/cheats/a/b.html", "/music/a/b.mp3"])
    assert.equal(normalizeAlbumUrl("zophar", url), null, url);
  assert.equal(normalizeAlbumUrl("zophar", "/music/a/sample.html?tracking=1#player")?.pageUrl,
    "https://www.zophar.net/music/a/sample.html");
});

test("invalid music links or changed KHInsider columns are explicit failures", () => {
  const page = capture();
  failure({ ...page, html: page.html.replace("/music/playstation-psf/sample.html", "https://evil.test/music/a/b.html") }, "parse_changed");
  const khi = capture("khinsider");
  failure({ ...khi, html: khi.html.replace("<th>Type</th>", "<th>Changed</th>") }, "parse_changed");
});

test("reported count mismatch is visible and safe next links remain page-only evidence", () => {
  const page = capture("khinsider");
  page.html = page.html.replace("Found 2", "Found 20") + '<a rel="next" href="?search=sample&amp;page=2">Next</a>';
  const result = inspectCapturedPage(page);
  assert.ok(result.ok && result.data.kind === "search");
  assert.equal(result.data.coverage, "partial-or-changed");
  assert.equal(result.data.resultLimit, null);
  assert.equal(result.data.nextPageUrl, "https://downloads.khinsider.com/search?search=sample&page=2");
  assert.ok(result.warnings.includes("reported_count_mismatch"));
  page.html = page.html.replace("?search=sample&amp;page=2", "https://evil.test/search?search=sample");
  const unsafe = inspectCapturedPage(page);
  assert.ok(unsafe.ok && unsafe.data.kind === "search");
  assert.equal(unsafe.data.nextPageUrl, null);
  assert.ok(unsafe.warnings.includes("invalid_next_page_link"));
});

test("contradictory zero results do not hide parsed rows", () => {
  const page = capture("khinsider");
  failure({ ...page, html: page.html.replace("Found 2", "Found 0") }, "parse_changed");
});

test("every product capability stays disabled while permission is unknown", () => {
  for (const source of ["khinsider", "zophar"] as const)
    for (const operation of ["search", "album", "cache", "display", "artwork", "directAudio", "embed"] as const)
      assert.deepEqual(productAccess(source, operation), { allowed: false, code: "policy_disabled",
        reason: `${operation}: permission is not established` });
});

test("audit summaries exclude source content and audio", () => {
  const page = capture("zophar", "album");
  const summary = JSON.stringify(summarizeCapture(page, inspectCapturedPage(page)));
  assert.ok(!summary.includes("庭の歌"));
  assert.ok(!summary.includes("<table"));
  assert.ok(summary.includes('"duplicateDisplayNumberCount":1'));
});

test("offline CLI parses fixtures and reports invalid arguments", () => {
  const result = spawnSync(process.execPath, ["scripts/inspect-source.ts", "--source", "zophar", "--kind", "search",
    "--input", "tests/fixtures/zophar-search.html", "--headers", "tests/fixtures/ok.headers",
    "--url", "https://www.zophar.net/search?search=sample", "--captured-at", "2026-10-18T14:00:00Z",
    "--sample-kind", "synthetic", "--summary"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).parse.parsedCount, 2);
  assert.equal(spawnSync(process.execPath, ["scripts/inspect-source.ts", "--fetch"]).status, 2);
});
