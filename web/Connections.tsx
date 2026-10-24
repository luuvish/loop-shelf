import { useCallback, useEffect, useRef, useState } from "react";
import type { Bookmark, BookmarkConnections, BookmarkPage } from "../src/shared/bookmarks.ts";
import { errorMessage, type BookmarkApi } from "./api.ts";
import { Dialog } from "./dialogs.tsx";
import { Icon } from "./icons.tsx";

const sourceNames = { khinsider: "KHInsider", zophar: "Zophar’s Domain" };
type Selection = { action: "connect" | "disconnect"; item: Bookmark };

function SourceSummary({ item }: { item: Bookmark }) {
  return <><strong className="connection-title">{item.title}</strong><div className="connection-meta"><span>{sourceNames[item.sourceId]}</span><span>{item.favorite ? "★ 즐겨찾기" : "즐겨찾기 안 함"}</span></div>
    <details className="connection-details"><summary>원래 제목·주소·메모 확인</summary><p className="source-note">{item.note || "메모 없음"}</p><a href={item.url} target="_blank" rel="noopener noreferrer">{item.url}<Icon name="arrow" /></a></details></>;
}

export function ConnectionsDialog({ itemId, api, onClose, onChanged }: {
  itemId: string; api: BookmarkApi; onClose: () => void; onChanged: () => void;
}) {
  const [group, setGroup] = useState<BookmarkConnections | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [undo, setUndo] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [candidates, setCandidates] = useState<BookmarkPage | null>(null);
  const [searchError, setSearchError] = useState("");
  const pending = useRef(false);
  const read = useRef<AbortController | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    read.current?.abort();
    const controller = new AbortController(); read.current = controller;
    setLoading(true); setGroup(null); setSelection(null); setUndo(null); setError(""); setNotice("");
    try {
      const result = await api.connections(itemId, controller.signal);
      if (!controller.signal.aborted) { setGroup(result); setNeedsReload(false); setRevision((value) => value + 1); }
    } catch (cause) { if (!controller.signal.aborted) setError(errorMessage(cause)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [api, itemId]);
  useEffect(() => { void load(); return () => read.current?.abort(); }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    setCandidates(null); setSearchError("");
    void api.list(query, false, offset, controller.signal, true).then((result) => {
      if (!controller.signal.aborted) setCandidates(result);
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setSearchError(errorMessage(cause)); });
    return () => controller.abort();
  }, [api, query, offset, revision]);

  async function apply(operation: Selection) {
    if (!group || pending.current || needsReload) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (operation.action === "connect") {
        const result = await api.connect(group.root, operation.item);
        setGroup(result);
        setUndo({ action: "disconnect", item: result.members.find((member) => member.id === operation.item.id)! });
        setNotice("출처를 연결했습니다. 선반에는 대표 북마크 하나로 표시됩니다.");
      } else {
        const result = await api.disconnect(group.root, operation.item);
        setGroup(result.group); setUndo({ action: "connect", item: result.detached });
        setNotice("연결을 해제했습니다. 원래 ID와 내용 그대로 선반에 다시 표시됩니다.");
      }
      setSelection(null); setOffset(0); setRevision((value) => value + 1); onChanged();
    } catch (cause) { setError(errorMessage(cause)); setNeedsReload(true); }
    finally { pending.current = false; setBusy(false); requestAnimationFrame(() => status.current?.focus()); }
  }
  const disabled = busy || needsReload || loading;
  return <Dialog title="개인 출처 관리" onClose={onClose} busy={busy}>
    <p className="dialog-description">같은 음악으로 관리하고 싶은 북마크를 내 선반에서 연결하세요. 다른 버전·편곡은 별도로 두는 것을 권장합니다.</p>
    <div ref={status} tabIndex={-1} className="connection-feedback">
      {notice && <p className="notice" role="status">{notice}</p>}
      {undo && !needsReload && <button className="secondary small undo-connection" disabled={disabled} onClick={() => { void apply(undo); }}>방금 {undo.action === "disconnect" ? "연결" : "해제"} 되돌리기</button>}
      {error && <div className="form-error" role="alert">{error}<p>최신 출처를 불러오면 선택을 초기화하고 현재 상태를 확인합니다.</p><button className="secondary small" disabled={busy} onClick={() => { void load(); onChanged(); }}>최신 출처 불러오기</button></div>}
    </div>
    {loading ? <p className="connection-loading" role="status">출처를 불러오는 중…</p> : group && <>
      <section className="connection-section"><h3>대표 북마크 <span>{group.root.sourceCount}개 출처</span></h3><div className="connection-source representative"><SourceSummary item={group.root} /></div><p className="field-help">선반의 제목·메모·즐겨찾기 필터는 대표 북마크를 기준으로 합니다. 검색에는 연결된 출처의 제목과 메모도 포함합니다.</p></section>
      <section className="connection-section"><h3>연결된 출처</h3>{group.members.length ? <ul className="connection-list">{group.members.map((member) => <li className="connection-source" key={member.id}><SourceSummary item={member} /><button className="secondary small" disabled={disabled} aria-label={`${member.title} 연결 해제`} onClick={() => { setSelection({ action: "disconnect", item: member }); setUndo(null); }}>연결 해제</button></li>)}</ul> : <p className="field-help">아직 연결된 출처가 없습니다.</p>}</section>
      {selection ? <section className="connection-confirm" aria-label="출처 변경 확인"><h3>{selection.action === "connect" ? "이 북마크를 연결할까요?" : "별도 북마크로 분리할까요?"}</h3><SourceSummary item={selection.item} />
        <p>{selection.action === "connect" ? `“${group.root.title}”이 대표 항목으로 남습니다. 연결할 북마크의 ID·제목·메모·즐겨찾기는 보관하며, 해제하면 원래대로 돌아옵니다.` : "선택한 출처가 원래 ID·제목·메모·즐겨찾기를 유지한 별도 북마크로 돌아옵니다. 대표 북마크는 그대로 남습니다."}</p>
        <div className="connection-confirm-actions"><button className="secondary small" disabled={busy} onClick={() => setSelection(null)}>선택 취소</button><button className="primary small" disabled={disabled} onClick={() => { void apply(selection); }}>{busy ? "처리 중…" : selection.action === "connect" ? "선택한 출처 연결" : "별도 북마크로 분리"}</button></div>
      </section> : <section className="connection-section"><h3>저장한 북마크 연결</h3><p className="field-help">연결할 주소를 먼저 북마크로 저장해 주세요. 다른 항목에 연결되지 않은 북마크만 선택할 수 있습니다. 대표 포함 최대 20개입니다.</p>
        <form className="connection-search" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setOffset(0); setRevision((value) => value + 1); }}><label htmlFor="connection-search">연결할 북마크 검색</label><div><input id="connection-search" type="search" value={search} maxLength={200} disabled={busy} onChange={(event) => setSearch(event.target.value)} placeholder="제목 또는 메모" /><button className="secondary small" disabled={busy}>찾기</button></div></form>
        {searchError ? <div className="form-error" role="alert">{searchError}<button className="secondary small" onClick={() => setRevision((value) => value + 1)}>검색 다시 시도</button></div> : !candidates ? <p className="field-help" role="status">연결할 북마크를 찾는 중…</p> : <>
          <ul className="connection-list candidates">{candidates.items.filter((candidate) => candidate.id !== group.root.id).map((candidate) => <li key={candidate.id}><div><strong>{candidate.title}</strong><span>{sourceNames[candidate.sourceId]}{candidate.favorite ? " · ★ 즐겨찾기" : ""}</span></div><button className="secondary small" disabled={disabled || group.root.sourceCount >= 20} aria-label={`${candidate.title} 연결 선택`} onClick={() => { setSelection({ action: "connect", item: candidate }); setUndo(null); }}>선택</button></li>)}</ul>
          {!candidates.items.some((candidate) => candidate.id !== group.root.id) && <p className="field-help">이 페이지에 연결할 북마크가 없습니다.</p>}
          {(offset > 0 || candidates.nextOffset !== null) && <nav className="connection-pages" aria-label="연결 후보 페이지"><button className="secondary small" disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 12))}>이전 후보</button><span>{offset / 12 + 1} 페이지</span><button className="secondary small" disabled={busy || candidates.nextOffset === null} onClick={() => setOffset(candidates.nextOffset ?? 0)}>다음 후보</button></nav>}
        </>}
      </section>}
    </>}
    <footer className="dialog-actions"><button className="secondary" disabled={busy} onClick={onClose}>완료</button></footer>
  </Dialog>;
}
