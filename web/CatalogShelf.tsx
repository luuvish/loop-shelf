import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CatalogLibraryItem, CatalogLibraryPage } from "../src/shared/catalog-library.ts";
import { ApiError, catalogApi, catalogError, type CatalogApi, type CatalogDraft, type User } from "./api.ts";
import { Dialog } from "./dialogs.tsx";
import { Icon } from "./icons.tsx";

import { sourceNames, kindLabel, useTask, statusOf, SourceInfo } from "./catalog-ui.tsx";
import { CatalogBrowser, CatalogCandidatePicker } from "./CatalogBrowser.tsx";
import { CatalogTrackSearch } from "./CatalogTrackSearch.tsx";
const draftOf = (item: CatalogLibraryItem): CatalogDraft => ({ titleOverride: item.titleOverride, note: item.note, favorite: item.favorite });
type Modal = { kind: "edit" | "delete"; item: CatalogLibraryItem } | { kind: "sources"; id: string } | { kind: "browse" | "tracks" } | null;


export function CatalogShelf({ user, refreshToken = 0 }: { user: User; refreshToken?: number }) {
  const api = useMemo(() => catalogApi(user.id, user.sessionId), [user.id, user.sessionId]);
  const [search, setSearch] = useState(""), [query, setQuery] = useState("");
  const [kind, setKind] = useState(""), [favorite, setFavorite] = useState(false), [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0), [page, setPage] = useState<CatalogLibraryPage | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(""), [notice, setNotice] = useState("");
  const [modal, setModal] = useState<Modal>(null);
  const heading = useRef<HTMLHeadingElement>(null), task = useTask();
  useEffect(() => { heading.current?.focus(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError(""); setPage(null);
    void api.list(query, kind, favorite, offset, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (!result.items.length && offset > 0) setOffset(0);
      else setPage(result);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setLoadError(catalogError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, query, kind, favorite, offset, revision, refreshToken]);
  function refresh() { setRevision((value) => value + 1); task.setError(""); }
  function changed(message: string, close = true) {
    if (close) setModal(null);
    setNotice(message); refresh();
    if (close) requestAnimationFrame(() => heading.current?.focus());
  }
  function submit(event: FormEvent) { event.preventDefault(); setQuery(search.trim()); setOffset(0); setNotice(""); refresh(); }
  function paginate(value: number) { setOffset(value); heading.current?.focus(); heading.current?.scrollIntoView({ block: "start" }); }
  return <>
    <div className="topline"><span>라이브러리 <span className="crumb">/</span> 저장한 카탈로그</span><span className="private-label"><span />나만의 컬렉션</span></div>
    <header className="page-header catalog-header"><div><span className="eyebrow">SAVED CATALOG</span><h1 ref={heading} tabIndex={-1}>저장한 카탈로그<span className="heading-dot">.</span></h1><p>앨범과 곡에 남긴 나의 제목, 메모와 즐겨찾기.</p></div><div className="catalog-header-actions"><button className="primary" disabled={task.busy} onClick={() => setModal({ kind: "browse" })}>카탈로그 둘러보기</button><button className="secondary" disabled={task.busy} onClick={() => setModal({ kind: "tracks" })}>수록곡 검색</button><button className="secondary" disabled={task.busy || loading} onClick={refresh}>카탈로그 새로고침</button></div></header>
    <section className="collection-banner catalog-banner" aria-label="카탈로그 안내"><div className="banner-icon" aria-hidden="true"><Icon name="info" /></div><div><strong>자료 종류와 보관 상태를 확인해 주세요</strong><p>합성 자료와 외부 자료 참조를 구분해 표시합니다. 원본이 없어도 개인 내용은 유지됩니다. 카탈로그 둘러보기는 합성 검증 자료이며 외부 자동 수집과 재생은 아직 제공하지 않습니다.</p></div></section>
    <p className="field-help catalog-backup">개인 내용과 출처 연결은 내 계정 → 데이터 관리의 카탈로그 JSON으로 보관합니다. 원본이 없는 설치에서는 미연결 항목으로 복원됩니다.</p>
    <div className="library-toolbar"><form className="search-form" role="search" onSubmit={submit}><Icon name="search" /><label className="sr-only" htmlFor="catalog-search">저장한 카탈로그 검색</label><input id="catalog-search" type="search" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} placeholder="제목·메모·연결한 앨범 제목" /><button>검색</button></form><span className="sort-label">최근 저장 순</span></div>
    <div className="catalog-filters"><label htmlFor="catalog-kind">항목 종류</label><select id="catalog-kind" value={kind} onChange={(event) => { setKind(event.target.value); setOffset(0); setNotice(""); }}><option value="">모두</option><option value="album">앨범</option><option value="track">트랙</option></select><label className="checkbox-label"><input type="checkbox" checked={favorite} onChange={(event) => { setFavorite(event.target.checked); setOffset(0); setNotice(""); }} />즐겨찾기만</label></div>
    {query && <div className="query-summary"><span>“{query}” 검색 결과</span><button className="text-button" onClick={() => { setSearch(""); setQuery(""); setOffset(0); }}>검색 초기화</button></div>}
    <div aria-live="polite">{notice && <p className="notice">{notice}</p>}</div>
    {task.error && <div className="error-box" role="alert"><p>{task.error}</p><button className="secondary small" onClick={refresh}>최신 목록 확인</button></div>}
    <section className="bookmarks-section" aria-label="저장한 카탈로그 항목" aria-busy={loading}>
      {loading ? <div className="loading-state" role="status"><span className="loading-dot" />저장한 카탈로그를 불러오는 중…</div>
        : loadError ? <div className="empty-state"><h2>카탈로그를 불러오지 못했어요</h2><p role="alert">{loadError}</p><button className="secondary" onClick={refresh}>다시 시도</button></div>
        : page?.items.length ? <>
          <div className="result-line"><span>{offset + 1}–{offset + page.items.length}번째 항목</span><span>내 계정에 저장한 자료</span></div>
          <div className="bookmark-grid">{page.items.map((item) => <article className={`bookmark-card catalog-card ${item.entity.sourceId}`} key={item.id} aria-label={item.title}>
            <div className="card-top"><div className="album-symbol" aria-hidden="true"><Icon name={item.entity.kind === "album" ? "shelf" : "note"} /></div><span className="source-badge">{sourceNames[item.entity.sourceId]}<br />{item.entity.kind === "album" ? "앨범" : "트랙"} · {kindLabel(item.entity)}</span><button className={`icon-button favorite-button ${item.favorite ? "is-favorite" : ""}`} aria-label={`${item.title} 즐겨찾기`} aria-pressed={item.favorite} disabled={task.busy || !!task.error} onClick={() => { void task.run(async (signal) => {
              await api.update(item, { favorite: !item.favorite }, signal);
              if (!signal.aborted) changed(item.favorite ? "즐겨찾기에서 해제했습니다." : "즐겨찾기에 추가했습니다.");
            }); }}><Icon name="star" filled={item.favorite} /></button></div>
            <h2>{item.title}</h2><p className={`catalog-state ${item.entity.presence === "removed" || item.entity.presence === "missing" ? "unavailable" : ""}`}>{statusOf(item.entity)}</p>
            {item.titleOverride !== null && <p className="field-help">내가 지정한 제목</p>}
            <p className={`card-note ${!item.note ? "no-note" : ""}`}>{item.note || "아직 메모가 없어요."}</p>
            <p className="card-date"><span>{item.sourceLinks.length ? `추가 출처 ${item.sourceLinks.length}개 · 개인 판단` : "원래 출처만"}</span><time dateTime={item.createdAt}>{new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(item.createdAt))}</time></p>
            <footer className="card-actions"><a className="external-link" href={item.entity.pageUrl} target="_blank" rel="noopener noreferrer" aria-label={`${item.title} ${item.entity.kind === "track" ? "소속 앨범 " : ""}원문 열기 (새 탭)`}>{item.entity.kind === "track" ? "소속 앨범" : "원문 열기"}<Icon name="arrow" /></a><div><button className="icon-button" aria-label={`${item.title} 출처 보기`} disabled={task.busy} onClick={() => setModal({ kind: "sources", id: item.id })}><Icon name="link" /></button><button className="icon-button" aria-label={`${item.title} 편집`} disabled={task.busy} onClick={() => setModal({ kind: "edit", item })}><Icon name="edit" /></button><button className="icon-button delete-button" aria-label={`${item.title} 삭제`} disabled={task.busy} onClick={() => setModal({ kind: "delete", item })}><Icon name="trash" /></button></div></footer>
          </article>)}</div>
          <nav className="pagination" aria-label="카탈로그 페이지"><button className="secondary small" disabled={offset === 0} onClick={() => paginate(Math.max(0, offset - 12))}>← 이전</button><span>{offset / 12 + 1} 페이지</span><button className="secondary small" disabled={page.nextOffset === null} onClick={() => paginate(page.nextOffset ?? 0)}>다음 →</button></nav>
        </> : <div className="empty-state"><div className="empty-record" aria-hidden="true"><span /></div><h2>{query || kind || favorite ? "조건에 맞는 카탈로그 항목이 없어요" : "저장한 카탈로그가 없어요"}</h2><p>{query || kind || favorite ? "검색어나 항목 종류·즐겨찾기 조건을 바꿔 보세요." : "카탈로그 둘러보기에서 앨범과 곡을 저장해 보세요.\n관리 중인 자료가 없다면 내 음악 선반에 앨범 주소를 직접 보관할 수 있습니다."}</p></div>}
    </section>
    {modal?.kind === "browse" && <CatalogBrowser api={api} onClose={() => setModal(null)} onSaved={() => changed("저장 상태를 목록에 반영했습니다.", false)} />}
    {modal?.kind === "tracks" && <CatalogTrackSearch user={user} onClose={() => setModal(null)} onSaved={() => changed("저장 상태를 목록에 반영했습니다.", false)} />}
    {modal?.kind === "edit" && <CatalogEditor item={modal.item} api={api} onClose={() => setModal(null)} onSaved={changed} />}
    {modal?.kind === "delete" && <CatalogDelete item={modal.item} api={api} onClose={() => setModal(null)} onDeleted={changed} />}
    {modal?.kind === "sources" && <CatalogSources id={modal.id} api={api} onClose={() => { setModal(null); requestAnimationFrame(() => heading.current?.focus()); }} onChanged={(message) => changed(message, false)} />}
  </>;
}

function CatalogEditor({ item, api, onClose, onSaved }: { item: CatalogLibraryItem; api: CatalogApi; onClose: () => void; onSaved: (message: string) => void }) {
  const [base, setBase] = useState(item), [draft, setDraft] = useState(draftOf(item));
  const [review, setReview] = useState(false), [latest, setLatest] = useState<CatalogLibraryItem | null>(null), [missing, setMissing] = useState(false);
  const task = useTask();
  function save(event: FormEvent) {
    event.preventDefault(); if (review || missing) return;
    void task.run(async (signal) => {
      await api.update(base, { ...draft, titleOverride: draft.titleOverride?.trim() || null }, signal);
      if (!signal.aborted) onSaved("카탈로그의 개인 내용을 수정했습니다.");
    }, (cause) => { if (!(cause instanceof ApiError && cause.status === 400)) { setReview(true); setLatest(null); } });
  }
  return <Dialog title="카탈로그 개인 내용 편집" onClose={onClose} busy={task.busy}>
    <p className="dialog-description">나의 저장 항목에만 적용됩니다. 원래 앨범·곡의 정보는 유지됩니다.</p>
    <p className="field-help">카탈로그 제목: {base.entity.title} · {statusOf(base.entity)}</p>
    <form onSubmit={save}><fieldset disabled={task.busy}>
      <label htmlFor="catalog-title">개인 제목 <span className="optional">선택</span></label><input id="catalog-title" value={draft.titleOverride ?? ""} maxLength={300} onChange={(event) => setDraft({ ...draft, titleOverride: event.target.value })} placeholder={base.entity.title} aria-describedby="catalog-title-help" />
      <p id="catalog-title-help" className="field-help">비워 두면 현재 카탈로그 제목을 사용합니다.</p>
      <label htmlFor="catalog-note">메모 <span className="optional">선택</span></label><textarea id="catalog-note" rows={5} maxLength={10000} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} />
      <label className="checkbox-label"><input type="checkbox" checked={draft.favorite} onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })} />즐겨찾기</label>
    </fieldset>{task.error && <p className="form-error" role="alert">{task.error}</p>}
    {review && <div className="conflict-panel"><p>입력한 내용은 유지했습니다. 저장 결과와 최신 값을 확인한 뒤 다시 저장해 주세요.</p><button className="secondary small" type="button" disabled={task.busy} onClick={() => { void task.run(async (signal) => {
      const current = await api.get(base.id, signal); if (!signal.aborted) { setLatest(current); setMissing(false); }
    }, (cause) => { if (cause instanceof ApiError && cause.status === 404) { setMissing(true); setLatest(null); } }); }}>최신 내용 확인</button>
      {missing && <p role="status">이미 삭제된 항목입니다. 이 창의 내용은 저장할 수 없습니다.</p>}
      {latest && <><div className="latest-content"><strong>현재 저장된 내용</strong><p>제목: {latest.title} {latest.titleOverride === null ? "(카탈로그 제목 사용)" : "(개인 제목)"}</p><p>메모: {latest.note || "없음"}</p><p>즐겨찾기: {latest.favorite ? "예" : "아니요"}</p></div><div className="conflict-actions">
        <button type="button" className="secondary small" disabled={task.busy} onClick={() => { setBase(latest); setReview(false); setLatest(null); task.setError(""); }}>내 입력을 유지하고 다시 편집</button>
        <button type="button" className="text-button" disabled={task.busy} onClick={() => { setBase(latest); setDraft(draftOf(latest)); setReview(false); setLatest(null); task.setError(""); }}>최신 내용으로 바꾸기</button>
      </div></>}
    </div>}
    <footer className="dialog-actions"><button type="button" className="secondary" disabled={task.busy} onClick={onClose}>취소</button><button className="primary" disabled={task.busy || review || missing}>{task.busy ? "저장 중…" : "저장"}</button></footer></form>
  </Dialog>;
}

function CatalogDelete({ item, api, onClose, onDeleted }: { item: CatalogLibraryItem; api: CatalogApi; onClose: () => void; onDeleted: (message: string) => void }) {
  const [base, setBase] = useState(item), [review, setReview] = useState(false), task = useTask();
  return <Dialog title="카탈로그 저장 삭제" onClose={onClose} busy={task.busy}>
    <p className="dialog-description">이 항목의 내 제목·메모·즐겨찾기와 추가 출처 연결을 삭제합니다. 원래 카탈로그와 다른 사용자의 저장은 유지됩니다.</p>
    <div className="delete-summary"><strong>{base.title}</strong><p>{base.note || "메모 없음"}</p><p>추가 출처 {base.sourceLinks.length}개 · 즐겨찾기 {base.favorite ? "예" : "아니요"}</p></div>
    <p className="field-help">이 삭제에는 60초 되돌리기가 없습니다. 삭제 전에 내보낸 카탈로그 JSON으로 개인 내용을 복원할 수 있습니다.</p>
    {task.error && <p className="form-error" role="alert">{task.error}</p>}
    {review && <div className="conflict-panel"><p>삭제 결과를 확인하지 못했습니다. 최신 내용을 확인하고 다시 결정해 주세요.</p><button className="secondary small" disabled={task.busy} onClick={() => { void task.run(async (signal) => {
      const current = await api.get(base.id, signal); if (!signal.aborted) { setBase(current); setReview(false); }
    }, (cause) => { if (cause instanceof ApiError && cause.status === 404) onDeleted("이미 삭제된 저장 항목입니다. 최신 목록을 불러왔습니다."); }); }}>최신 내용 확인</button></div>}
    <footer className="dialog-actions"><button className="secondary" disabled={task.busy} onClick={onClose}>취소</button><button className="danger" disabled={task.busy || review} onClick={() => { void task.run(async (signal) => {
      await api.remove(base, signal); if (!signal.aborted) onDeleted("카탈로그의 개인 저장을 삭제했습니다.");
    }, () => setReview(true)); }}>{task.busy ? "삭제 중…" : "개인 저장 삭제"}</button></footer>
  </Dialog>;
}

function CatalogSources({ id, api, onClose, onChanged }: { id: string; api: CatalogApi; onClose: () => void; onChanged: (message: string) => void }) {
  const [item, setItem] = useState<CatalogLibraryItem | null>(null), [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false), [choice, setChoice] = useState<string | null>(null), [notice, setNotice] = useState("");
  const feedback = useRef<HTMLDivElement>(null), task = useTask();
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api.get(id, controller.signal).then((value) => { if (!controller.signal.aborted) { setItem(value); setFresh(true); } })
      .catch((cause: unknown) => { if (!controller.signal.aborted) task.setError(catalogError(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, id, task.setError]);
  function focusFeedback() { requestAnimationFrame(() => feedback.current?.focus()); }
  if (selecting && item) return <CatalogCandidatePicker api={api} id={id} onClose={() => setSelecting(false)} onUpdated={(value) => { setItem(value); setFresh(true); setChoice(null); onChanged("최신 출처 연결을 목록에 반영했습니다."); }} />;
  return <Dialog title="카탈로그 출처 보기" onClose={onClose} busy={task.busy}>
    <p className="dialog-description">원래 출처와 내가 연결한 앨범을 확인합니다. 추가 연결은 나의 판단이며 음악의 동일성을 확정하지 않습니다.</p>
    <div ref={feedback} tabIndex={-1} className="connection-feedback">{notice && <p className="notice" role="status">{notice}</p>}{task.error && <p className="form-error" role="alert">{task.error}</p>}</div>
    <button className="secondary small catalog-refresh" disabled={task.busy || loading} onClick={() => { setChoice(null); setFresh(false); void task.run(async (signal) => {
      const current = await api.get(id, signal); if (!signal.aborted) { setItem(current); setFresh(true); setNotice("최신 출처 연결을 확인했습니다."); onChanged("최신 출처 연결을 목록에 반영했습니다."); focusFeedback(); }
    }, (cause) => { if (cause instanceof ApiError && cause.status === 404) { setItem(null); onChanged("저장 항목이 없어 최신 목록을 불러왔습니다."); } }); }}>최신 출처 확인</button>
    {loading && <p role="status" className="connection-loading">출처를 불러오는 중…</p>}
    {item && <><section className="connection-section"><h3>원래 출처</h3><div className="connection-source representative"><SourceInfo entity={item.entity} /></div>
      {item.entity.kind === "track" && <p className="field-help">이 주소는 트랙이 속한 앨범의 출처입니다. 트랙별 원본 주소와 출처 연결은 아직 지원하지 않습니다.</p>}
    </section><section className="connection-section"><h3>내가 연결한 앨범 <span>{item.sourceLinks.length}개</span></h3>
      {item.sourceLinks.length ? <ul className="connection-list">{item.sourceLinks.map((link) => <li className="connection-source" key={link.source.sourceEntityId}><SourceInfo entity={link.source} /><p className="field-help">개인 판단 · {new Intl.DateTimeFormat("ko-KR").format(new Date(link.assertedAt))} 연결</p><button className="secondary small" disabled={task.busy || !fresh} onClick={() => setChoice(link.source.sourceEntityId)}>이 출처 해제</button>
        {choice === link.source.sourceEntityId && <div className="connection-confirm"><h4>이 앨범과의 개인 연결을 해제할까요?</h4><p>저장 항목과 개인 메모는 유지됩니다. 필요하면 추가 출처 선택에서 다시 연결할 수 있습니다.</p><div className="connection-confirm-actions"><button className="secondary small" disabled={task.busy} onClick={() => setChoice(null)}>취소</button><button className="primary small" disabled={task.busy || !fresh} onClick={() => { void task.run(async (signal) => {
          const current = await api.disconnect(item, link.source.sourceEntityId, signal);
          if (!signal.aborted) { setItem(current); setChoice(null); setNotice("개인 출처 연결을 해제했습니다."); onChanged("개인 출처 연결을 해제했습니다."); focusFeedback(); }
        }, () => { setFresh(false); setChoice(null); setNotice("응답 뒤 상태가 달라졌을 수 있습니다. 최신 출처 확인 후 다시 선택해 주세요."); focusFeedback(); }); }}>연결 해제 확인</button></div></div>}
      </li>)}</ul> : <p className="field-help">추가로 연결한 앨범이 없습니다.</p>}
      {item.entity.contentState === "unresolved" && <p className="field-help">다른 설치에서 가져온 원본 미연결 항목입니다. 개인 내용과 기존 연결의 해제는 가능하며 새 출처 연결은 지원하지 않습니다.</p>}
      {item.entity.kind === "album" && <button className="primary small" disabled={task.busy || !fresh || item.entity.contentState !== "active"} onClick={() => { setChoice(null); setSelecting(true); }}>추가 출처 선택</button>}
    </section></>}
    <footer className="dialog-actions"><button className="secondary" disabled={task.busy} onClick={onClose}>완료</button></footer>
  </Dialog>;
}
