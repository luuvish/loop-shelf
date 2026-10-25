import { useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CatalogTrackSearchItem, CatalogTrackSearchPage } from "../src/shared/catalog-track-search.ts";
import type { SourceId } from "../src/sources/types.ts";
import { ApiError, catalogTrackApi, errorMessage, type User } from "./api.ts";
import { validTrackQuery, type TrackQuery } from "./catalog-track-response.ts";
import { CatalogBrowser, type CatalogInitialTrack } from "./CatalogBrowser.tsx";
import { ConnectionBlocked } from "./connection.ts";
import { sourceNames } from "./catalog-ui.tsx";
import { sourceTime } from "./source-ui.ts";
import { Dialog } from "./dialogs.tsx";

export function CatalogTrackSearch({ user, onClose, onSaved }: { user: User; onClose: () => void; onSaved: () => void }) {
  const api = useMemo(() => catalogTrackApi(user), [user.id, user.sessionId]), blocked = useContext(ConnectionBlocked);
  const [q, setQ] = useState(""), [source, setSource] = useState<SourceId | "">("");
  const [page, setPage] = useState<CatalogTrackSearchPage | null>(null), [trail, setTrail] = useState<(string | null)[]>([]);
  const [selected, setSelected] = useState<CatalogInitialTrack | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [retryAt, setRetryAt] = useState(0), [now, setNow] = useState(Date.now());
  const controller = useRef<AbortController | null>(null), generation = useRef(0), feedback = useRef<HTMLDivElement>(null);
  const deadline = useRef<{ mono: number; wall: number } | null>(null);
  function clear(message = "") {
    generation.current++; controller.current?.abort(); controller.current = null; deadline.current = null;
    setBusy(false); setPage(null); setTrail([]); setSelected(null); setError(""); setNotice(message);
  }
  const expired = () => deadline.current !== null && (performance.now() >= deadline.current.mono || Date.now() >= deadline.current.wall);
  useEffect(() => {
    const leave = () => clear("화면을 다시 확인했습니다. 직접 검색해 최신 자료를 확인해 주세요.");
    const hidden = () => { if (document.hidden) leave(); };
    const timer = setInterval(() => {
      setNow(Date.now());
      if (expired()) clear("자료의 보관 기한이 지나 결과를 지웠습니다. 처음부터 다시 검색해 주세요.");
    }, 200);
    window.addEventListener("pagehide", leave); window.addEventListener("focus", leave); document.addEventListener("visibilitychange", hidden);
    return () => { generation.current++; controller.current?.abort(); clearInterval(timer);
      window.removeEventListener("pagehide", leave); window.removeEventListener("focus", leave); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  useEffect(() => { if (blocked) clear("연결과 로그인을 확인한 뒤 직접 다시 검색해 주세요."); }, [blocked]);
  function focusFeedback() { requestAnimationFrame(() => { feedback.current?.focus(); feedback.current?.scrollIntoView({ block: "nearest" }); }); }
  async function run(path: (string | null)[] = [null]) {
    if (controller.current || blocked || Date.now() < retryAt) return;
    if (!validTrackQuery(q)) { clear(); setError("곡 제목을 1–200자로 입력해 주세요. 공백만 있는 검색어나 제어 문자는 사용할 수 없습니다."); return; }
    const input: TrackQuery = { q, sourceId: source, cursor: path.at(-1) ?? null }, current = new AbortController(), id = ++generation.current;
    controller.current = current; deadline.current = null; setBusy(true); setPage(null); setTrail([]); setError(""); setNotice("");
    try {
      const result = await api.search(input, current.signal);
      if (id !== generation.current || current.signal.aborted) return;
      deadline.current = result.lifetime === null ? null : { mono: performance.now() + result.lifetime, wall: Date.now() + result.lifetime };
      setPage(result.page); setTrail(path);
    } catch (cause) {
      if (id !== generation.current || current.signal.aborted) return;
      if (cause instanceof ApiError && cause.retryAt) setRetryAt(cause.retryAt);
      setError(cause instanceof ApiError && cause.code === "cursor_invalidated" ? "수록 목록이 바뀌었거나 기준 곡을 더 이상 볼 수 없습니다. 처음부터 다시 검색해 주세요."
        : cause instanceof ApiError && cause.code === "invalid_response" ? "검색 응답의 자료 종류나 출처를 확인하지 못했습니다. 다시 검색해 주세요."
        : cause instanceof ApiError && cause.code === "result_expired" ? "자료의 보관 기한이 지났습니다. 처음부터 다시 검색해 주세요."
        : cause instanceof ApiError && cause.status === 409 ? "자료가 변경되어 확인하지 못했습니다. 처음부터 다시 검색해 주세요."
        : cause instanceof ApiError && cause.status === 400 ? "검색어와 출처 조건을 확인해 주세요."
        : cause instanceof DOMException && cause.name === "TimeoutError" ? "검색 시간이 초과되었습니다. 다시 검색해 주세요." : errorMessage(cause));
    } finally {
      if (id === generation.current && !current.signal.aborted) { controller.current = null; setBusy(false); focusFeedback(); }
    }
  }
  function openAlbum(item: CatalogTrackSearchItem) {
    if (busy || blocked || !page) return;
    if (expired()) { clear("자료의 보관 기한이 지났습니다. 처음부터 다시 검색해 주세요."); return; }
    setSelected({ albumId: item.album.id, trackId: item.id, position: item.position });
    setPage(null); setTrail([]); // Do not retain a hidden metadata page behind album navigation.
  }
  function submit(event: FormEvent) { event.preventDefault(); void run(); }
  if (selected) return <CatalogBrowser api={api.browse} initialTrack={selected} onSaved={onSaved}
    onClose={() => { clear("앨범에서 돌아왔습니다. 직접 다시 검색해 현재 목록을 확인해 주세요."); }} />;
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return <Dialog title="수록곡 검색" onClose={onClose} className="track-search-dialog">
    <p className="browse-disclosure">관리 중인 합성 검증 자료의 곡 제목을 검색합니다. 실제 사이트 검색이나 음악 재생은 하지 않습니다.</p>
    <form onSubmit={submit} className="track-search-form" aria-label="카탈로그 수록곡 검색">
      <label htmlFor="track-query">곡 제목</label><input id="track-query" type="search" maxLength={200} value={q} placeholder="기억에 남은 곡 제목" onChange={(event) => { clear(); setQ(event.target.value); }} />
      <div className="browse-filter-row"><label htmlFor="track-source">곡의 출처</label><select id="track-source" value={source} onChange={(event) => { clear(); setSource(event.target.value as SourceId | ""); }}><option value="">모든 출처</option><option value="khinsider">KHInsider</option><option value="zophar">Zophar’s Domain</option></select>
        <button className="primary small" disabled={busy || blocked || wait > 0 || !q.trim()}>곡 검색</button></div>
      <p className="field-help">앨범 제목이나 개인 메모는 포함하지 않습니다. 한글·일본어 한두 글자로도 찾을 수 있어요.</p>
    </form>
    <div ref={feedback} tabIndex={-1} className="browse-feedback">
      {busy && <div className="search-progress" role="status">수록곡을 찾는 중… <button className="secondary small" onClick={() => clear("검색을 취소했습니다. 직접 다시 검색할 수 있습니다.")}>검색 취소</button></div>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <div className="error-box"><p role="alert">{error}</p><button className="secondary small" disabled={busy || blocked || wait > 0} onClick={() => { void run(); }}>처음부터 다시 검색</button></div>}
      {wait > 0 && <p role="status">{wait}초 후 직접 다시 검색할 수 있습니다.</p>}
    </div>
    {page && <section aria-label="수록곡 검색 결과">
      <div className="track-search-summary"><h3>“{page.query}” 검색</h3><p>이번 페이지 {page.items.length}곡 · 합성 자료</p><p className="field-help">목록 확인 {sourceTime(page.checkedAt)} · 외부 사이트에서 새로 확인한 자료가 아닙니다.</p></div>
      {!page.items.length ? <p className="browse-empty">현재 조건에 맞는 수록곡이 없습니다. 새 설치에 관리 중인 자료가 없을 때도 목록이 비어 있습니다.</p>
        : <ol className="browse-list">{page.items.map((item) => <li className="track-search-entry" key={item.id} data-track-id={item.id}>
          <div><h4>{item.title}</h4><p className="track-album-title">{item.album.title}</p><p className="field-help">{sourceNames[item.album.sourceId]} · 현재 순서 {item.position} · 표시 번호 {item.displayNumber ?? "미확인"}{item.discLabel ? ` · 디스크 ${item.discLabel}` : ""} · {item.durationMs === null ? "길이 미확인" : `${Math.floor(item.durationMs / 60000)}:${String(Math.floor(item.durationMs / 1000) % 60).padStart(2, "0")}`}</p>
            {item.album.trackState === "review_required" && <p className="notice">변경 목록 검토 중 · 현재 채택된 곡입니다.</p>}
            <details className="track-evidence"><summary>앨범과 곡의 자료 근거</summary><p className="catalog-source-key">앨범 출처 식별명: {item.album.externalKey}</p><p>앨범 제목 확인: {sourceTime(item.album.provenance.capturedAt)}</p><p>곡 목록 확인: {sourceTime(item.provenance.capturedAt)}</p><p>앨범 제목 보관 기한: {item.album.provenance.expiresAt ? sourceTime(item.album.provenance.expiresAt) : "별도 기한 없음 (합성 자료)"}</p><p>곡 목록 보관 기한: {item.provenance.expiresAt ? sourceTime(item.provenance.expiresAt) : "별도 기한 없음 (합성 자료)"}</p><p>출처 링크는 소속 앨범의 주소입니다.</p></details>
          </div><div className="track-result-actions"><button className="secondary small" onClick={() => openAlbum(item)}>앨범에서 보기</button><a className="external-link" href={item.album.pageUrl} target="_blank" rel="noopener noreferrer">앨범 원문 열기</a></div>
        </li>)}</ol>}
      <nav className="pagination" aria-label="수록곡 검색 페이지"><button className="secondary small" disabled={busy || trail.length <= 1} onClick={() => { void run(trail.slice(0, -1)); }}>← 이전</button><span>{trail.length} 페이지</span><button className="secondary small" disabled={busy || page.nextCursor === null} onClick={() => { if (page.nextCursor) void run([...trail, page.nextCursor]); }}>다음 →</button></nav>
      <p className="field-help">페이지마다 현재 자료를 다시 확인합니다. 전체 곡 수나 고정된 목록을 뜻하지 않습니다. 저장은 앨범에서 곡을 확인한 뒤 할 수 있어요.</p>
    </section>}
    <footer className="dialog-actions"><button className="secondary" onClick={onClose}>완료</button></footer>
  </Dialog>;
}
