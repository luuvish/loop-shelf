import { DeletionUndo, type PendingDeletion } from "./DeletionUndo.tsx";
import type { DeletionReceipt } from "../src/shared/deletions.ts";
import { PwaInfo, PwaUpdateNotice } from "./PwaInfo.tsx";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Bookmark, BookmarkPage } from "../src/shared/bookmarks.ts";
import { bookmarkApi, errorMessage, type User } from "./api.ts";
import { BookmarkEditor, DeleteDialog, Dialog } from "./dialogs.tsx";
import { Brand, Icon } from "./icons.tsx";
import { ConnectionsDialog } from "./Connections.tsx";
import { TransferDialog } from "./Transfer.tsx";
import { CatalogShelf } from "./CatalogShelf.tsx";
import { MusicSearch } from "./MusicSearch.tsx";

const sourceNames = { khinsider: "KHInsider", zophar: "Zophar’s Domain" };
type Modal = { kind: "editor"; item: Bookmark | null } | { kind: "delete"; item: Bookmark } | { kind: "connections"; itemId: string } | { kind: "sources" | "account" | "transfer" } | null;

export function Library({ user, onLogout }: { user: User; onLogout: () => Promise<void> }) {
  const api = useMemo(() => bookmarkApi(user.id, user.sessionId), [user.id, user.sessionId]);
  const [view, setView] = useState<"bookmarks" | "catalog" | "search">("bookmarks");
  const [favorite, setFavorite] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [page, setPage] = useState<BookmarkPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [deleted, setDeleted] = useState<PendingDeletion[]>([]);
  const [modal, setModal] = useState<Modal>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mutation = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    if (view !== "bookmarks") return;
    const controller = new AbortController();
    setLoading(true); setError(""); setPage(null);
    void api.list(query, favorite, offset, controller.signal).then((result) => {
      if (!controller.signal.aborted) {
        // A deletion/filter change can empty the current page. Return to the first page.
        if (!result.items.length && offset > 0) setOffset(0);
        else setPage(result);
      }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [api, query, favorite, offset, revision, view]);
  function changed(message: string) {
    setModal(null); setNotice(message); setActionError(""); setRevision((value) => value + 1);
    requestAnimationFrame(() => heading.current?.focus());
  }
  function deletionCompleted(receipt: DeletionReceipt, title: string) {
    if (receipt.state === "deleted") {
      const now = performance.now();
      setDeleted((items) => [...items.filter((item) => item.deadline > now && item.id !== receipt.id), { ...receipt, title, deadline: now + receipt.remainingMs }]);
    }
    changed(receipt.state === "deleted" ? "북마크를 삭제했습니다. 아래 안내에서 되돌릴 수 있습니다." : "이미 복구된 삭제 요청입니다. 최신 선반을 불러왔습니다.");
  }
  function filter(value: boolean) { setView("bookmarks"); setFavorite(value); setOffset(0); setNotice(""); setActionError(""); }
  function submitSearch(event: FormEvent) { event.preventDefault(); setQuery(search.trim()); setOffset(0); setRevision((value) => value + 1); setNotice(""); }
  async function toggle(item: Bookmark) {
    if (mutation.current) return;
    mutation.current = true; setPending(item.id); setActionError("");
    try { await api.update(item, { favorite: !item.favorite }); changed(item.favorite ? "즐겨찾기에서 해제했습니다." : "즐겨찾기에 추가했습니다."); }
    catch (cause) { setActionError(errorMessage(cause)); }
    finally { mutation.current = false; setPending(null); }
  }
  async function logout() {
    if (mutation.current) return;
    mutation.current = true; setPending("logout"); setActionError("");
    try { await onLogout(); }
    catch (cause) { setActionError(`로그아웃을 완료하지 못했습니다. ${errorMessage(cause)}`); setModal(null); }
    finally { mutation.current = false; setPending(null); }
  }
  function paginate(value: number) { setOffset(value); main.current?.scrollIntoView({ block: "start" }); heading.current?.focus(); }
  return <div className="app-shell">
    <a className="skip-link" href="#library-main">본문으로 이동</a>
    <aside className="sidebar"><Brand /><p className="sidebar-caption">A HOME FOR YOUR GAME MUSIC</p>
      <nav aria-label="내 라이브러리"><span className="nav-label">MY COLLECTION</span><button className={view === "bookmarks" && !favorite ? "nav-item active" : "nav-item"} aria-current={view === "bookmarks" && !favorite ? "page" : undefined} disabled={!!pending} onClick={() => filter(false)}><Icon name="shelf" />내 음악 선반</button><button className={view === "bookmarks" && favorite ? "nav-item active" : "nav-item"} aria-current={view === "bookmarks" && favorite ? "page" : undefined} disabled={!!pending} onClick={() => filter(true)}><Icon name="star" />즐겨찾기</button><button className={`nav-item catalog-nav ${view === "catalog" ? "active" : ""}`} aria-current={view === "catalog" ? "page" : undefined} disabled={!!pending} onClick={() => { setView("catalog"); setActionError(""); }}><Icon name="note" />저장한 카탈로그</button><button className={`nav-item ${view === "search" ? "active" : ""}`} aria-current={view === "search" ? "page" : undefined} disabled={!!pending} onClick={() => { setView("search"); setActionError(""); }}><Icon name="search" />음악 검색</button></nav>
      <div className="sidebar-bottom"><button className="source-link" onClick={() => setModal({ kind: "sources" })}><Icon name="info" />소스 이용 안내<span aria-hidden="true">↗</span></button><div className="account-row"><button className="account-button" aria-label="내 계정" onClick={() => setModal({ kind: "account" })}><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span><strong>{user.name}</strong><small>개인 라이브러리</small></span></button><button className="icon-button logout-button" aria-label="로그아웃" disabled={!!pending} onClick={() => { void logout(); }}><Icon name="logout" /></button></div></div>
    </aside>
    <main id="library-main" className="library-main" ref={main} tabIndex={-1}>
      <PwaUpdateNotice />
      {view === "search" ? <><MusicSearch user={user} suspended={pending === "logout"} onBookmark={() => { setView("bookmarks"); setModal({ kind: "editor", item: null }); }} />{actionError && <p className="form-error" role="alert">{actionError}</p>}</>
        : view === "catalog" ? <><CatalogShelf user={user} refreshToken={revision} />{actionError && <p className="form-error" role="alert">{actionError}</p>}</> : <>
      <div className="topline"><span>라이브러리 <span className="crumb">/</span> {favorite ? "즐겨찾기" : "내 북마크"}</span><span className="private-label"><span />나만의 컬렉션</span></div>
      <header className="page-header"><div><span className="eyebrow">{favorite ? "ON REPEAT" : "MY MUSIC SHELF"}</span><h1 ref={heading} tabIndex={-1}>
      {favorite ? "오래 곁에 둘 음악" : "내 음악 선반"}<span className="heading-dot">.</span></h1><p>좋아하는 게임의 음악과, 그때의 기억을 모아 두세요.</p></div><button className="primary add-bookmark" onClick={() => setModal({ kind: "editor", item: null })} disabled={!!pending}><Icon name="plus" />북마크 추가</button></header>
      <section className="collection-banner" aria-label="북마크 안내"><div className="banner-icon" aria-hidden="true"><Icon name="note" /></div><div><strong>마음에 남은 음악을 발견했다면</strong><p>KHInsider·Zophar 앨범 주소로 내 선반을 채워 보세요.</p></div><button className="text-button" onClick={() => setModal({ kind: "sources" })}>이용 안내 <span aria-hidden="true">↗</span></button></section>
      <div className="library-toolbar"><form className="search-form" role="search" onSubmit={submitSearch}><Icon name="search" /><label className="sr-only" htmlFor="shelf-search">내 북마크 검색</label><input id="shelf-search" type="search" maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="제목이나 메모로 찾아보세요" /><button type="submit">검색</button></form><span className="sort-label">최근 저장 순</span></div>
      {query && <div className="query-summary"><span>“{query}” 검색 결과</span><button className="text-button" onClick={() => { setSearch(""); setQuery(""); setOffset(0); }}>검색 초기화</button></div>}
      <div className="feedback" aria-live="polite">{notice && <p className="notice">{notice}</p>}</div>
      {deleted.length > 0 && <DeletionUndo items={deleted} api={api} onDismiss={(id) => setDeleted((items) => items.filter((item) => item.id !== id))} onChanged={changed} />}
      {actionError && <div className="error-box" role="alert"><p>{actionError}</p><button className="secondary small" onClick={() => { setRevision((value) => value + 1); setActionError(""); }}>목록 새로고침</button></div>}
      <section className="bookmarks-section" aria-label={favorite ? "즐겨찾는 북마크" : "저장한 북마크"} aria-busy={loading}>
        {loading ? <div className="loading-state" role="status"><span className="loading-dot" />음악 선반을 불러오는 중…</div> : error ? <div className="empty-state"><Icon name="info" /><h2>선반을 불러오지 못했어요</h2><p role="alert">{error}</p><button className="secondary" onClick={() => setRevision((value) => value + 1)}>다시 시도</button></div> : page?.items.length ? <>
          <div className="result-line"><span>{offset + 1}–{offset + page.items.length}번째 북마크</span><span>직접 저장한 앨범 링크</span></div>
          <div className="bookmark-grid">{page.items.map((item) => <article className={`bookmark-card ${item.sourceId}`} key={item.id} aria-label={item.title}>
            <div className="card-top"><div className="album-symbol" aria-hidden="true"><Icon name="shelf" /></div><span className="source-badge">{sourceNames[item.sourceId]}</span><button className={`icon-button favorite-button ${item.favorite ? "is-favorite" : ""}`} aria-label={`${item.title} 즐겨찾기`} aria-pressed={item.favorite} disabled={!!pending} onClick={() => { void toggle(item); }}><Icon name="star" filled={item.favorite} /></button></div>
            <h2>{item.title}</h2>{item.sourceCount > 1 && <button className="connection-badge" onClick={() => setModal({ kind: "connections", itemId: item.id })}><Icon name="link" />{item.sourceCount}개 출처 · 개인 연결</button>}<p className={`card-note ${!item.note ? "no-note" : ""}`}>{item.note || "아직 메모가 없어요."}</p><p className="card-date"><span>직접 저장</span><time dateTime={item.createdAt}>{new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "short", day: "numeric" }).format(new Date(item.createdAt))}</time></p>
            <footer className="card-actions"><a className="external-link" href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`${item.title} 원문 열기 (새 탭)`}>원문 열기<Icon name="arrow" /></a><div><button className="icon-button" aria-label={`${item.title} 출처 관리`} disabled={!!pending} onClick={() => setModal({ kind: "connections", itemId: item.id })}><Icon name="link" /></button><button className="icon-button" aria-label={`${item.title} 편집`} disabled={!!pending} onClick={() => setModal({ kind: "editor", item })}><Icon name="edit" /></button><button className="icon-button delete-button" aria-label={`${item.title} 삭제`} disabled={!!pending} onClick={() => setModal({ kind: "delete", item })}><Icon name="trash" /></button></div></footer>
          </article>)}</div>
          <nav className="pagination" aria-label="북마크 페이지"><button className="secondary small" disabled={offset === 0} onClick={() => paginate(Math.max(0, offset - 12))}>← 이전</button><span>{offset / 12 + 1} 페이지</span><button className="secondary small" disabled={page.nextOffset === null} onClick={() => paginate(page.nextOffset ?? 0)}>다음 →</button></nav>
        </> : <div className="empty-state"><div className="empty-record" aria-hidden="true"><span /></div><span className="eyebrow">{query ? "NO MATCHES YET" : "MAKE ROOM FOR MEMORIES"}</span><h2>{query ? "일치하는 북마크가 없어요" : favorite ? "특별히 좋아하는 음악을 골라 보세요" : "첫 번째 음악을 놓아 보세요"}</h2><p>{query ? "다른 제목이나 메모의 단어로 검색해 보세요." : favorite ? "북마크의 별을 누르면 이곳에 모아 볼 수 있어요." : "좋아하는 앨범의 주소 하나면 충분해요.\n나만의 음악 선반이 여기서 시작됩니다."}</p>{!favorite && !query && <button className="primary" onClick={() => setModal({ kind: "editor", item: null })}><Icon name="plus" />첫 북마크 추가</button>}</div>}
      </section>
      </>}
      <footer className="main-footer"><span>작은 선반, 오래 남을 음악.</span><span>LOOPSHELF · PERSONAL LIBRARY</span></footer>
    </main>
    {modal?.kind === "editor" && <BookmarkEditor item={modal.item} api={api} onClose={() => setModal(null)} onSaved={changed} />}
    {modal?.kind === "transfer" && <TransferDialog api={api} onClose={() => setModal(null)} onChanged={() => { setRevision((value) => value + 1); setNotice(""); setActionError(""); }} />}
    {modal?.kind === "delete" && <DeleteDialog item={modal.item} api={api} onClose={() => setModal(null)} onDeleted={deletionCompleted} onManage={() => setModal({ kind: "connections", itemId: modal.item.id })} />}
    {modal?.kind === "connections" && <ConnectionsDialog itemId={modal.itemId} api={api} onClose={() => { setModal(null); requestAnimationFrame(() => heading.current?.focus()); }} onChanged={() => { setRevision((value) => value + 1); setNotice(""); setActionError(""); }} />}
    {modal?.kind === "sources" && <Dialog title="소스 이용 안내" onClose={() => setModal(null)}><p className="dialog-description">지금은 앨범 주소를 직접 저장하고 원문 사이트에서 살펴볼 수 있습니다.</p>{(["khinsider", "zophar"] as const).map((id) => <section className="source-info" key={id}><h3>{sourceNames[id]}</h3><span className="status-pill">직접 북마크 가능</span><p>자동 검색·수록곡 불러오기·앱 내 재생은 지원 준비 중입니다. 외부 이용 조건을 확인한 뒤 제공합니다.</p></section>)}<p className="field-help">북마크의 제목과 메모는 직접 입력한 내용입니다. 원문을 열어도 청취 이력은 생성하지 않습니다.</p></Dialog>}
    {modal?.kind === "account" && <Dialog title="내 계정" onClose={() => setModal(null)} busy={pending === "logout"}><dl className="account-details"><dt>이름</dt><dd>{user.name}</dd><dt>이메일</dt><dd>{user.email}</dd></dl><p className="dialog-description">비밀번호 재설정은 운영자에게 요청해 주세요.</p><PwaInfo /><footer className="dialog-actions"><button className="primary" disabled={!!pending} onClick={() => setModal({ kind: "transfer" })}>데이터 관리</button><button className="secondary" disabled={!!pending} onClick={() => { void logout(); }}>{pending === "logout" ? "로그아웃 중…" : "로그아웃"}</button></footer></Dialog>}
  </div>;
}
