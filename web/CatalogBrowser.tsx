import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CatalogAlbumDetail, CatalogAlbumPage, CatalogCandidates, CatalogEntry } from "../src/shared/catalog-browse.ts";
import type { CatalogLibraryItem } from "../src/shared/catalog-library.ts";
import { ApiError, catalogError, type CatalogApi } from "./api.ts";
import { Dialog } from "./dialogs.tsx";
import { SourceInfo, sourceNames, useTask } from "./catalog-ui.tsx";

function BrowseFilters({ busy, initialQuery, onSearch }: { busy: boolean; initialQuery: { q: string; source: string }; onSearch: (q: string, source: string) => void }) {
  const [q, setQ] = useState(initialQuery.q), [source, setSource] = useState(initialQuery.source);
  function submit(event: FormEvent) { event.preventDefault(); onSearch(q.trim(), source); }
  return <form className="browse-filters" onSubmit={submit}><fieldset disabled={busy}>
    <label htmlFor="browse-query">앨범 제목 검색</label><input id="browse-query" type="search" value={q} maxLength={200} onChange={(event) => setQ(event.target.value)} placeholder="관리 중인 앨범 제목" />
    <div className="browse-filter-row"><label htmlFor="browse-source">출처</label><select id="browse-source" value={source} onChange={(event) => { setSource(event.target.value); onSearch(q.trim(), event.target.value); }}><option value="">모든 출처</option><option value="khinsider">KHInsider</option><option value="zophar">Zophar’s Domain</option></select><button className="secondary small">검색</button></div>
  </fieldset></form>;
}
function Pages({ offset, nextOffset, busy, onPage }: { offset: number; nextOffset: number | null; busy: boolean; onPage: (offset: number) => void }) {
  return <nav className="pagination" aria-label="탐색 페이지"><button className="secondary small" disabled={busy || !offset} onClick={() => onPage(Math.max(0, offset - 12))}>← 이전</button><span>{offset / 12 + 1} 페이지</span><button className="secondary small" disabled={busy || nextOffset === null} onClick={() => onPage(nextOffset ?? 0)}>다음 →</button></nav>;
}
const disclosure = <p className="browse-disclosure">합성 검증 자료입니다. 실제 사이트를 검색하거나 음악을 재생하지 않습니다.</p>;

export interface CatalogInitialTrack { albumId: string; trackId: string; position: number }
export function CatalogBrowser({ api, onClose, onSaved, initialTrack }: { api: CatalogApi; onClose: () => void; onSaved: () => void; initialTrack?: CatalogInitialTrack }) {
  const [query, setQuery] = useState({ q: "", source: "", offset: 0 }), [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string | null>(initialTrack?.albumId ?? null), [trackOffset, setTrackOffset] = useState(initialTrack ? Math.floor((initialTrack.position - 1) / 12) * 12 : 0);
  const selectionChecked = useRef(false);
  const [page, setPage] = useState<CatalogAlbumPage | null>(null), [detail, setDetail] = useState<CatalogAlbumDetail | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [notice, setNotice] = useState("");
  const [uncertain, setUncertain] = useState(false), task = useTask(), content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError(""); setPage(null); setDetail(null);
    const read = selected ? api.album(selected, trackOffset, controller.signal).then((value) => {
      if (controller.signal.aborted) return;
      if (initialTrack && !selectionChecked.current && (value.album.entity.id !== initialTrack.albumId || !value.tracks.some((row) => row.entity.id === initialTrack.trackId)))
        throw new ApiError(409, "selection_changed");
      selectionChecked.current = true; setDetail(value);
    })
      : api.browse(query.q, query.source, query.offset, controller.signal).then((value) => { if (!controller.signal.aborted) setPage(value); });
    void read.then(() => { if (!controller.signal.aborted) { setUncertain(false); task.setError(""); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(catalogError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, query, selected, trackOffset, revision, task.setError, initialTrack]);
  function focusContent() { requestAnimationFrame(() => content.current?.focus()); }
  function refresh() { setRevision((value) => value + 1); onSaved(); }
  function save(entry: CatalogEntry) {
    if (entry.savedItemId || uncertain) return;
    void task.run(async (signal) => {
      const result = await api.create(entry.entity.id, signal);
      if (!signal.aborted) {
        setNotice(result.created ? "내 카탈로그에 저장했습니다." : "이미 저장한 항목입니다. 개인 내용은 그대로 유지했습니다.");
        refresh(); focusContent();
      }
    }, () => { setUncertain(true); setNotice("저장 결과를 확인한 후 다시 선택해 주세요."); focusContent(); });
  }
  const saveButton = (entry: CatalogEntry) => <button className="primary small" disabled={task.busy || loading || uncertain || !!entry.savedItemId} onClick={() => save(entry)}>{entry.savedItemId ? "저장됨" : entry.entity.kind === "album" ? "앨범 저장" : "곡 저장"}</button>;
  return <Dialog title={selected ? "카탈로그 앨범" : "카탈로그 둘러보기"} onClose={onClose} busy={task.busy}>
    {disclosure}
    {initialTrack ? <button className="text-button" disabled={task.busy} onClick={onClose}>← 수록곡 검색</button> : selected ? <button className="text-button" disabled={task.busy} onClick={() => { setSelected(null); setTrackOffset(0); setNotice(""); focusContent(); }}>← 앨범 목록</button>
      : <BrowseFilters busy={task.busy} initialQuery={query} onSearch={(q, source) => { setQuery({ q, source, offset: 0 }); setNotice(""); }} />}
    <div ref={content} tabIndex={-1} className="browse-feedback">{notice && <p className="notice" role="status">{notice}</p>}{task.error && <p className="form-error" role="alert">{task.error}</p>}</div>
    {(uncertain || loadError) && <div className="error-box">{loadError && <p role="alert">{loadError}</p>}<button className="secondary small" disabled={task.busy || loading} onClick={() => { setNotice(""); refresh(); }}>최신 탐색 결과 확인</button></div>}
    {loading && <p role="status">카탈로그를 불러오는 중…</p>}
    {!loading && !loadError && !selected && page && <>
      {page.items.length ? <ul className="browse-list">{page.items.map((entry) => <li key={entry.entity.id} className="browse-entry"><div><h3>{entry.entity.title}</h3><p className="field-help">{sourceNames[entry.entity.sourceId]} · 합성 자료{entry.savedItemId ? " · 내 카탈로그에 저장됨" : ""}</p><p className="catalog-source-key">출처 식별명: {entry.entity.externalKey}</p></div><button className="secondary small" disabled={task.busy} onClick={() => { setSelected(entry.entity.id); setTrackOffset(0); setNotice(""); focusContent(); }}>앨범 보기</button></li>)}</ul>
        : <p className="browse-empty">조건에 맞는 관리 앨범이 없습니다. 현재는 외부 자동 수집을 하지 않으므로 새 설치에서는 목록이 비어 있습니다.</p>}
      <Pages offset={query.offset} nextOffset={page.nextOffset} busy={task.busy} onPage={(offset) => { setQuery({ ...query, offset }); focusContent(); }} />
    </>}
    {!loading && !loadError && detail && <>
      <section className="browse-album"><SourceInfo entity={detail.album.entity} />{saveButton(detail.album)}</section>
      <h3 className="browse-track-heading">현재 수록곡</h3>
      {detail.trackState === "not_loaded" ? <p className="field-help">상세 수록곡은 아직 수집하지 않았습니다. 앨범 정보만 저장할 수 있습니다.</p>
        : <>{detail.trackState === "review_required" && <p className="notice">변경 목록 검토 중입니다. 현재 채택된 수록곡을 표시합니다.</p>}
          {!detail.tracks.length && <p className="field-help">이 페이지에 표시할 수록곡이 없습니다.</p>}
          <ol className="browse-list">{detail.tracks.map((entry) => <li key={entry.entity.id} className="browse-entry"><div>{entry.entity.id === initialTrack?.trackId && <span className="status-pill">검색에서 선택한 곡</span>}<h4>{entry.entity.title}</h4><p className="field-help">순서 {entry.entity.position} · 표시 번호 {entry.displayNumber ?? "미확인"}{entry.discLabel ? ` · 디스크 ${entry.discLabel}` : ""} · {entry.entity.durationMs === null ? "길이 미확인" : `${Math.floor(entry.entity.durationMs / 60000)}:${String(Math.floor(entry.entity.durationMs / 1000) % 60).padStart(2, "0")}`}</p></div>{saveButton(entry)}</li>)}</ol>
          <Pages offset={trackOffset} nextOffset={detail.nextOffset} busy={task.busy || uncertain} onPage={(offset) => { setTrackOffset(offset); focusContent(); }} />
        </>}
    </>}
    <footer className="dialog-actions"><button className="secondary" disabled={task.busy} onClick={onClose}>완료</button></footer>
  </Dialog>;
}

export function CatalogCandidatePicker({ api, id, onClose, onUpdated }: { api: CatalogApi; id: string; onClose: () => void; onUpdated: (item: CatalogLibraryItem) => void }) {
  const [query, setQuery] = useState({ q: "", source: "", offset: 0 }), [revision, setRevision] = useState(0);
  const [page, setPage] = useState<CatalogCandidates | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [choice, setChoice] = useState<CatalogEntry | null>(null), [fresh, setFresh] = useState(false), [notice, setNotice] = useState("");
  const task = useTask(), feedback = useRef<HTMLDivElement>(null), confirmation = useRef<HTMLElement>(null), updated = useRef(onUpdated); updated.current = onUpdated;
  useEffect(() => { if (choice) confirmation.current?.focus(); }, [choice]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(""); setFresh(false); setChoice(null); setPage(null);
    void api.candidates(id, query.q, query.source, query.offset, controller.signal).then((value) => {
      if (!controller.signal.aborted) { setPage(value); setFresh(true); task.setError(""); updated.current(value.target); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(catalogError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, id, query, revision, task.setError]);
  function focusFeedback() { requestAnimationFrame(() => feedback.current?.focus()); }
  return <Dialog title="추가 앨범 출처 선택" onClose={onClose} busy={task.busy}>
    {disclosure}<p className="dialog-description">내 저장 항목에 연결할 앨범을 직접 선택하세요. 음악의 동일성을 확정하거나 따로 저장한 항목을 합치지 않습니다.</p>
    <BrowseFilters busy={task.busy} initialQuery={query} onSearch={(q, source) => { setChoice(null); setQuery({ q, source, offset: 0 }); }} />
    <div ref={feedback} tabIndex={-1} className="browse-feedback">{notice && <p className="notice" role="status">{notice}</p>}{(task.error || error) && <p className="form-error" role="alert">{task.error || error}</p>}</div>
    <button className="secondary small" disabled={task.busy || loading} onClick={() => { setChoice(null); setNotice(""); setRevision((value) => value + 1); }}>최신 후보 확인</button>
    {loading && <p role="status">출처 후보를 불러오는 중…</p>}
    {!loading && page && <><p className="browse-target">연결 대상: <strong>{page.target.title}</strong><br /><span className="field-help">{sourceNames[page.target.entity.sourceId]} · 추가로 연결할 수 있는 출처 {page.remainingSlots}개</span></p>
      {!page.items.length && <p className="browse-empty">{page.remainingSlots ? "조건에 맞는 후보가 없습니다. 원래 출처와 내 계정에서 이미 연결한 출처는 제외됩니다." : "추가 출처 20개를 모두 연결했습니다. 기존 연결을 해제한 뒤 선택할 수 있습니다."}</p>}
      <ul className="browse-list">{page.items.map((entry) => <li key={entry.entity.id} className="browse-entry candidate-entry"><SourceInfo entity={entry.entity} /><button className="secondary small" disabled={task.busy || !fresh} onClick={() => { setChoice(entry); setNotice(""); }}>이 앨범 선택</button></li>)}</ul>
      <Pages offset={query.offset} nextOffset={page.nextOffset} busy={task.busy || !fresh} onPage={(offset) => { setChoice(null); setQuery({ ...query, offset }); focusFeedback(); }} />
      {choice && <section ref={confirmation} tabIndex={-1} className="connection-confirm" aria-label="앨범 출처 연결 확인"><h3>개인 출처로 연결할까요?</h3><p><strong>{page.target.title}</strong>에 <strong>{choice.entity.title}</strong> ({sourceNames[choice.entity.sourceId]})을 연결합니다.</p><p className="catalog-source-key">선택한 출처 식별명: {choice.entity.externalKey}</p><p className="field-help">개인 판단으로 저장되며 나중에 해제할 수 있습니다. 별도 저장 항목과 메모는 유지됩니다.</p><div className="connection-confirm-actions"><button className="secondary small" disabled={task.busy} onClick={() => setChoice(null)}>선택 취소</button><button className="primary small" disabled={task.busy || !fresh} onClick={() => { void task.run(async (signal) => {
        const current = await api.connect({ id, version: page.version }, choice.entity.sourceEntityId, signal);
        if (!signal.aborted) { updated.current(current); setChoice(null); setNotice("개인 출처를 연결했습니다."); setRevision((value) => value + 1); focusFeedback(); }
      }, () => { setFresh(false); setChoice(null); setNotice("결과가 달라졌을 수 있습니다. 최신 후보를 확인한 뒤 다시 선택해 주세요."); focusFeedback(); }); }}>개인 연결 확인</button></div></section>}
    </>}
    <footer className="dialog-actions"><button className="secondary" disabled={task.busy} onClick={onClose}>출처 관리로 돌아가기</button></footer>
  </Dialog>;
}
