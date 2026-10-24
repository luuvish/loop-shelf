import { useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { LocalSearchAlbum, SearchResponse, SourceSearchResult } from "../src/shared/search.ts";
import type { AlbumSummary, SourceId } from "../src/sources/types.ts";
import { isPageUrl, normalizeAlbumUrl } from "../src/sources/urls.ts";
import { ApiError, errorMessage, searchApi, type SearchQuery, type User } from "./api.ts";
import { ConnectionBlocked } from "./connection.ts";
import { sourceNames } from "./catalog-ui.tsx";
import { sourceRetriable as retriable, sourceMessage as message, sourceTime as time } from "./source-ui.ts";
import { SourceAlbum } from "./SourceAlbum.tsx";
import type { SourceAlbumSelection } from "./source-album-response.ts";
import { Icon } from "./icons.tsx";

const sources = ["khinsider", "zophar"] as const;
type OpenAlbum = (album: AlbumSummary | LocalSearchAlbum) => void;
function Album({ album, synthetic, onOpen }: { album: AlbumSummary | LocalSearchAlbum; synthetic: boolean; onOpen: OpenAlbum }) {
  const link = normalizeAlbumUrl(album.sourceId, album.pageUrl);
  const safe = link?.externalKey === album.externalKey && link.pageUrl === album.pageUrl;
  return <li className="search-album"><div><h3>{album.title}</h3><p>{sourceNames[album.sourceId]}{synthetic ? " · 합성 자료" : ""}{album.titleKind === "source-display-label" ? " · 출처의 검색 표시명" : ""}</p>
    <p className="catalog-source-key">출처 식별명: {album.externalKey}</p>
    {"provenance" in album && <p>자료 확인 <time dateTime={album.provenance.capturedAt}>{time(album.provenance.capturedAt)}</time></p>}</div>
    {safe && <div className="search-album-actions"><button className="secondary small" onClick={() => onOpen(album)} aria-label={`${album.title} 상세 보기`}>상세 보기</button><a className="external-link" href={link.pageUrl} target="_blank" rel="noopener noreferrer" aria-label={`${album.title} 원문 열기 (새 탭)`}>원문 열기 <Icon name="arrow" /></a></div>}
  </li>;
}
function SourceResult({ source, synthetic, now, waitUntil, busy, onRetry, onOpen }: { source: SourceSearchResult; synthetic: boolean; now: number; waitUntil: number; busy: boolean; onRetry: () => void; onOpen: OpenAlbum }) {
  const { result, sourceId, policy } = source, failure = result.ok ? result.refreshFailure : result;
  const seconds = Math.max(0, Math.ceil((Math.max(waitUntil, failure?.retryAt ?? 0) - now) / 1000));
  const canRetry = failure && retriable(failure);
  return <section className="search-source" aria-label={`${sourceNames[sourceId]} 검색 결과`}>
    <header><h2>{sourceNames[sourceId]}</h2><span className="status-pill">{!result.ok ? result.code === "policy_disabled" ? "이용 조건 확인 중" : "조회하지 못함"
      : result.delivery.freshness === "stale" ? "이전 자료" : result.delivery.from === "cache" ? "보관된 자료" : "자료 확인됨"}</span></header>
    {!result.ok ? <p className="search-explanation">{message(result)}</p> : <>
      <p className="search-explanation">{result.delivery.from === "cache" ? "보관된 앨범 정보" : "이번 조회에서 받은 앨범 정보"} · 자료 확인 <time dateTime={result.provenance.capturedAt}>{time(result.provenance.capturedAt)}</time></p>
      {result.delivery.freshness === "stale" && <p className="notice">최신 여부를 다시 확인해야 하는 이전 자료입니다.</p>}
      <p className="field-help">보관 기한 <time dateTime={result.delivery.expiresAt}>{time(result.delivery.expiresAt)}</time></p>
      {failure && <p className="search-explanation">갱신 실패: {message(failure)}</p>}
      <p className="search-count">이 페이지에서 확인한 앨범 {result.data.albums.length}개 · 출처 표시 {result.data.reportedCount}개</p>
      {result.data.coverage === "partial-or-changed" && <p className="notice">일부 결과만 확인했습니다. 출처의 전체 결과와 다를 수 있습니다.</p>}
      {result.data.albums.length ? <ul className="search-albums">{result.data.albums.map((album) => <Album key={album.externalKey} album={album} synthetic={synthetic} onOpen={onOpen} />)}</ul>
        : <p className="search-empty">이 출처가 정상적으로 반환한 검색 결과는 0건입니다.</p>}
      {result.data.nextPageUrl && <p className="field-help">출처에 다음 페이지가 있으나 앱의 추가 조회는 아직 지원하지 않습니다.</p>}
      {result.provenance.pageUrl.startsWith("https://") && isPageUrl(sourceId, "search", result.provenance.pageUrl) && <a className="external-link" href={result.provenance.pageUrl} target="_blank" rel="noopener noreferrer">원문 검색 보기 <Icon name="arrow" /></a>}
      {result.warnings.length > 0 && <details className="search-warnings"><summary>자료 확인 안내</summary><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    </>}
    {!policy.collect.allowed && policy.display.allowed && <p className="field-help">새 자료 수집은 현재 허용되지 않습니다.</p>}
    {canRetry && <div className="search-retry"><button className="secondary small" disabled={busy || seconds > 0} onClick={onRetry}>{sourceNames[sourceId]} 다시 검색</button>
      {seconds > 0 && <span>{seconds}초 후 직접 다시 검색할 수 있습니다.</span>}</div>}
  </section>;
}

export function MusicSearch({ user, suspended, onBookmark }: { user: User; suspended: boolean; onBookmark: () => void }) {
  const api = useMemo(() => searchApi(user), [user.id, user.sessionId]);
  const blocked = useContext(ConnectionBlocked);
  const [albumSelection, setAlbumSelection] = useState<SourceAlbumSelection | null>(null);
  const [q, setQ] = useState(""), [selected, setSelected] = useState<SourceId[]>([]);
  const [result, setResult] = useState<SearchResponse | null>(null), [last, setLast] = useState<SearchQuery | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now()), [cooldowns, setCooldowns] = useState<Partial<Record<SourceId, number>>>({}), [retryAt, setRetryAt] = useState(0);
  const controller = useRef<AbortController | null>(null), sequence = useRef(0), heading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  function cancel() { sequence.current++; controller.current?.abort(); controller.current = null; setBusy(false); }
  function clear() { setAlbumSelection(null); cancel(); setResult(null); setLast(null); setError(""); setNotice(""); }
  useEffect(() => {
    heading.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const leave = () => { clear(); };
    const hidden = () => { if (document.hidden) clear(); };
    window.addEventListener("pagehide", leave);
    window.addEventListener("focus", leave); document.addEventListener("visibilitychange", hidden);
    return () => { sequence.current++; controller.current?.abort(); clearInterval(timer); window.removeEventListener("pagehide", leave);
      window.removeEventListener("focus", leave); document.removeEventListener("visibilitychange", hidden); };
  }, []);
  useEffect(() => {
    if (blocked || suspended) { clear(); setNotice("연결과 로그인을 확인한 뒤 직접 다시 검색해 주세요."); }
    if (suspended) { setQ(""); setSelected([]); }
  }, [blocked, suspended]);
  const waitUntil = Math.max(retryAt, ...selected.map((id) => cooldowns[id] ?? 0));
  async function run(input: SearchQuery) {
    if (controller.current || blocked || suspended) return;
    if (Date.now() < Math.max(retryAt, ...input.sources.map((id) => cooldowns[id] ?? 0))) return;
    if (!input.q.trim() || /[\u0000-\u001f\u007f\ud800-\udfff]/u.test(input.q)) { setError("앨범 이름을 입력해 주세요. 줄바꿈이나 제어 문자는 사용할 수 없습니다."); return; }
    const current = new AbortController(), id = ++sequence.current; controller.current = current;
    setBusy(true); setResult(null); setError(""); setNotice(""); setLast(input); setSelected(input.sources);
    try {
      const value = await api(input, current.signal);
      if (id !== sequence.current || current.signal.aborted) return;
      setResult(value);
      setCooldowns((previous) => {
        const next = { ...previous };
        for (const part of value.sources) { const failure = part.result.ok ? part.result.refreshFailure : part.result;
          if (failure?.retryAt) next[part.sourceId] = Math.max(next[part.sourceId] ?? 0, failure.retryAt); }
        return next;
      });
    } catch (cause) {
      if (id !== sequence.current || current.signal.aborted) return;
      if (cause instanceof ApiError && cause.retryAt) setRetryAt(cause.retryAt);
      setError(cause instanceof ApiError && cause.code === "invalid_response" ? "검색 응답을 확인하지 못했습니다. 자료 종류나 요청 정보가 일치하지 않습니다."
        : cause instanceof ApiError && cause.code === "search_timeout" || cause instanceof DOMException && cause.name === "TimeoutError"
          ? "검색 시간이 초과되었습니다. 확인하지 못한 결과는 표시하지 않습니다." : errorMessage(cause));
    } finally {
      if (id === sequence.current && !current.signal.aborted) {
        controller.current = null; setBusy(false); requestAnimationFrame(() => feedback.current?.focus());
      }
    }
  }
  function openAlbum(album: AlbumSummary | LocalSearchAlbum) {
    if (!result || busy) return;
    setAlbumSelection((current) => current ?? { ref: { sourceId: album.sourceId, externalKey: album.externalKey, pageUrl: album.pageUrl }, sampleKind: result.sampleKind });
  }
  function invalidateSearch() { setResult(null); setLast(null); setNotice("출처 상태가 바뀌어 이전 검색 자료를 지웠습니다. 검색을 다시 실행해 주세요."); }
  function closeAlbum() { setAlbumSelection(null); if (!result) requestAnimationFrame(() => heading.current?.focus()); }
  function submit(event: FormEvent) { event.preventDefault(); void run({ q: q.trim(), sources: selected, limit: 12, offset: 0 }); }
  const seconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  return <div className="music-search">
    {albumSelection && <SourceAlbum user={user} selection={albumSelection} now={now} waitUntil={Math.max(retryAt, cooldowns[albumSelection.ref.sourceId] ?? 0)}
      onInvalidate={invalidateSearch} onClose={closeAlbum} onLimited={(until, scope) => {
        if (scope === "http") setRetryAt((previous) => Math.max(previous, until));
        else setCooldowns((previous) => ({ ...previous, [albumSelection.ref.sourceId]: Math.max(previous[albumSelection.ref.sourceId] ?? 0, until) }));
      }} />}

    <div className="topline"><span>발견 <span className="crumb">/</span> 음악 검색</span><span className="private-label">앨범 · 출처별 검색</span></div>
    <header className="page-header"><div><span className="eyebrow">FIND YOUR NEXT SOUNDTRACK</span><h1 ref={heading} tabIndex={-1}>게임 음악 찾기<span className="heading-dot">.</span></h1><p>찾고 싶은 앨범을 입력하고, 출처별 결과를 확인하세요.</p></div></header>
    <aside className="collection-banner search-disclosure"><Icon name="info" /><div><strong>외부 소스의 이용 조건을 확인하고 있어요.</strong><p>현재 KHInsider·Zophar의 자동 수집은 비활성입니다. 주소를 알고 있다면 북마크로 보관할 수 있어요.</p></div><button className="text-button" onClick={onBookmark}>직접 북마크 <span aria-hidden="true">↗</span></button></aside>
    <form className="music-search-form" role="search" aria-label="통합 음악 검색" onSubmit={submit}>
      <label htmlFor="music-query">앨범 이름</label><div className="music-query-row"><input id="music-query" type="search" maxLength={200} required value={q} placeholder="기억에 남은 게임 음악" onChange={(event) => { clear(); setQ(event.target.value); }} />
        <button className="primary" disabled={busy || !q.trim() || seconds > 0 || blocked || suspended}><Icon name="search" />검색</button></div>
      <fieldset><legend>함께 검색할 외부 소스</legend><div className="search-source-options">{sources.map((id) => <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={(event) => { clear(); setSelected(event.target.checked ? [...selected, id] : selected.filter((value) => value !== id)); }} /><span>{sourceNames[id]}</span></label>)}</div>
        <p className="field-help">선택한 출처에만 요청합니다. 선택하지 않으면 로컬 카탈로그만 조회합니다. 개인 북마크와 메모는 포함하지 않습니다.</p></fieldset>
      {seconds > 0 && <p className="field-help">요청 제한으로 {seconds}초 후 다시 검색할 수 있습니다. 자동으로 재시도하지 않습니다.</p>}
    </form>
    <div ref={feedback} tabIndex={-1} className="search-feedback" aria-live="polite">
      {busy && <div className="search-progress"><p role="status"><span className="loading-dot" /> 출처를 확인하는 중…</p><button className="secondary small" onClick={() => { clear(); setNotice("검색을 취소했습니다. 다시 검색하려면 검색 버튼을 눌러 주세요."); }}>검색 취소</button></div>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <div className="error-box"><p role="alert">{error}</p>{last && <button className="secondary small" disabled={busy || now < retryAt || seconds > 0} onClick={() => { void run(last); }}>다시 검색</button>}</div>}
    </div>
    {result && <section className="search-results" aria-label="통합 검색 결과">
      <header className="search-summary"><h2>“{result.query}” 조회</h2><p role="status">{result.status === "failed" ? "검색을 완료하지 못했습니다. 아래 출처별 상태를 확인해 주세요." : result.status === "partial" ? "일부 자료만 확인했습니다. 출처별 상태가 다를 수 있습니다." : "요청한 범위의 조회를 마쳤습니다."}</p>
        {result.termination === "deadline" && <p>시간 제한으로 조회를 마쳤습니다. 확인된 부분만 표시합니다.</p>}
        {result.sampleKind === "synthetic" && <p className="notice">합성 검증 자료입니다. 실제 사이트 검색 결과가 아닙니다.</p>}
        <p className="field-help">조회 완료 <time dateTime={result.completedAt}>{time(result.completedAt)}</time> · 같은 제목도 출처별로 구분합니다.</p></header>
      <section className="search-source" aria-label="로컬 카탈로그 검색 결과"><header><h2>로컬 카탈로그</h2><span className="status-pill">{result.local.ok ? "보관된 카탈로그" : result.local.code === "sample_kind_unavailable" ? "조회 준비 중" : "조회하지 못함"}</span></header>
        {result.local.ok ? <><p className="search-explanation">출처에서 다시 확인하지 않은 자료입니다. 현재 채택된 앨범 제목으로 조회합니다.</p>
          {result.local.items.length ? <ul className="search-albums">{result.local.items.map((album) => <Album key={album.id} album={album} synthetic={result.sampleKind === "synthetic"} onOpen={openAlbum} />)}</ul> : <p className="search-empty">로컬 카탈로그에서 일치하는 앨범이 없습니다.</p>}
          <nav className="pagination" aria-label="로컬 검색 페이지"><button className="secondary small" disabled={busy || !last?.offset || now < retryAt} onClick={() => { if (last) void run({ ...last, sources: [], offset: Math.max(0, last.offset - 12) }); }}>← 이전</button><span>{Math.floor((last?.offset ?? 0) / 12) + 1} 페이지</span><button className="secondary small" disabled={busy || result.local.nextOffset === null || now < retryAt} onClick={() => { if (last && result.local.ok && result.local.nextOffset !== null) void run({ ...last, sources: [], offset: result.local.nextOffset }); }}>다음 →</button></nav></>
          : <p className="search-explanation">{message(result.local)}</p>}
      </section>
      {result.sources.length ? result.sources.map((source) => <SourceResult key={source.sourceId} source={source} synthetic={result.sampleKind === "synthetic"} now={now} waitUntil={Math.max(retryAt, cooldowns[source.sourceId] ?? 0)} busy={busy} onOpen={openAlbum} onRetry={() => { void run({ q: result.query, sources: [source.sourceId], limit: 12, offset: 0 }); }} />)
        : <p className="field-help">외부 소스는 요청하지 않았습니다.</p>}
      <p className="search-footnote">다시 검색하면 해당 출처와 로컬 자료를 새로 확인합니다. 원문 열기는 청취 기록을 만들지 않습니다. 검색 결과의 직접 저장과 앱 내 재생은 아직 지원하지 않습니다.</p>
    </section>}
    {!result && !busy && !error && !notice && <div className="search-start"><Icon name="search" /><h2>어떤 음악을 찾고 있나요?</h2><p>앨범 이름을 입력해 조회를 시작하세요.<br />결과와 초안은 이 화면에서만 유지됩니다.</p></div>}
  </div>;
}
