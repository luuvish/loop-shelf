import type { DeletionReceipt } from "../src/shared/deletions.ts";
import { useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Bookmark, BookmarkDraft } from "../src/shared/bookmarks.ts";
import { ApiError, errorMessage, type BookmarkApi } from "./api.ts";
import { ConnectionBlocked } from "./connection.ts";
import { Icon } from "./icons.tsx";

export function Dialog({ title, children, onClose, busy = false, className }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const blocked = useContext(ConnectionBlocked);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (blocked) return;
    dialog.showModal();
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
    else dialog.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      previousFocus.current = document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement) ? document.activeElement : null;
      dialog.close(); if (trigger?.isConnected) trigger.focus();
    };
  }, [blocked]);
  return <dialog ref={ref} className={className} aria-labelledby="dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']")]
      .filter((element) => element.getClientRects().length > 0);
    const first = controls[0], last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); return; }
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }}>
    <header className="dialog-header"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} disabled={busy} aria-label="닫기"><Icon name="close" /></button></header>
    {children}
  </dialog>;
}

const blank: BookmarkDraft = { title: "", url: "", note: "", favorite: false };
const draftOf = (item: Bookmark): BookmarkDraft => ({ title: item.title, url: item.url, note: item.note, favorite: item.favorite });

export function BookmarkEditor({ item, api, onClose, onSaved }: {
  item: Bookmark | null; api: BookmarkApi; onClose: () => void; onSaved: (message: string) => void;
}) {
  const [base, setBase] = useState(item);
  const [draft, setDraft] = useState<BookmarkDraft>(item ? draftOf(item) : blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Bookmark | null>(null);
  const pending = useRef(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setConflict(false); setLatest(null);
    try {
      if (base) { await api.update(base, draft); onSaved("북마크를 수정했습니다."); }
      else {
        const result = await api.create(draft);
        if (!result.created) {
          setError(`이미 내 선반에 저장한 주소입니다. 기존 제목과 메모는 그대로 유지했습니다.${result.item.rootId !== result.item.id ? " 대표 북마크의 출처 관리에서 확인할 수 있습니다." : ""}`);
        } else onSaved("내 선반에 북마크를 추가했습니다.");
      }
    } catch (cause) { setError(errorMessage(cause)); setConflict(cause instanceof ApiError && cause.status === 409); }
    finally { pending.current = false; setBusy(false); }
  }
  async function getLatest() {
    if (!base || pending.current) return;
    pending.current = true; setBusy(true);
    try { setLatest(await api.get(base.id)); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <Dialog title={item ? "북마크 편집" : "새 북마크"} onClose={onClose} busy={busy}>
    <p className="dialog-description">앨범 주소와 기억하고 싶은 이야기를 담아 두세요.</p>
    {base && base.sourceCount > 1 && <p className="field-help">이 창에서는 선택한 북마크만 수정합니다. 연결된 다른 출처의 내용은 유지됩니다.</p>}
    <form onSubmit={(event) => { void save(event); }}>
      <fieldset disabled={busy}>
        <label htmlFor="bookmark-title">제목 <span className="required">필수</span></label>
        <input id="bookmark-title" required maxLength={300} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="기억하고 싶은 앨범 이름" />
        <label htmlFor="bookmark-url">앨범 주소 <span className="required">필수</span></label>
        <input id="bookmark-url" type="url" required maxLength={2048} aria-describedby="url-help" value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://…" />
        <p id="url-help" className="field-help">KHInsider 또는 Zophar의 HTTPS 앨범 페이지를 지원합니다. 제목과 수록곡을 자동으로 가져오지는 않습니다.</p>
        <label htmlFor="bookmark-note">메모 <span className="optional">선택</span></label>
        <textarea id="bookmark-note" maxLength={10000} rows={4} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="좋아하는 곡, 처음 들었던 순간…" />
        <label className="checkbox-label"><input type="checkbox" checked={draft.favorite} onChange={(event) => setDraft({ ...draft, favorite: event.target.checked })} />즐겨찾기에 추가</label>
      </fieldset>
      {error && <div className="form-error" role="alert">{error}</div>}
      {conflict && base && <div className="conflict-panel">
        <p>작성 중인 내용은 유지됩니다. 저장된 최신 내용을 먼저 확인해 주세요.</p>
        <button type="button" className="secondary small" disabled={busy} onClick={() => { void getLatest(); }}>최신 내용 확인</button>
        {latest && <><div className="latest-content"><strong>{latest.title}</strong><p>{latest.url}</p><p>{latest.note || "메모 없음"}</p><p>즐겨찾기: {latest.favorite ? "사용" : "사용 안 함"}</p></div>
          {latest.version !== base.version ? <div className="conflict-actions">
            <button type="button" className="secondary small" onClick={() => { setBase(latest); setDraft(draftOf(latest)); setConflict(false); setError(""); }}>최신 내용으로 다시 편집</button>
            <button type="button" className="secondary small" onClick={() => { setBase(latest); setConflict(false); setError("최신 변경을 확인했습니다. 저장하면 내 입력으로 바뀝니다."); }}>내 입력 유지하고 다시 저장 준비</button>
          </div> : <p>변경된 버전이 없습니다. 이미 저장한 다른 북마크의 주소인지 확인해 주세요.</p>}
        </>}
      </div>}
      <footer className="dialog-actions"><button type="button" className="secondary" onClick={onClose} disabled={busy}>취소</button><button className="primary" disabled={busy || conflict}>{busy ? "저장 중…" : "저장"}</button></footer>
    </form>
  </Dialog>;
}

export function DeleteDialog({ item, api, onClose, onDeleted, onManage }: { item: Bookmark; api: BookmarkApi; onClose: () => void; onDeleted: (receipt: DeletionReceipt, title: string) => void; onManage: () => void }) {
  const [current, setCurrent] = useState(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const pending = useRef(false);
  const operation = useRef(crypto.randomUUID());
  async function remove() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { const receipt = await api.deleteWithUndo(current, operation.current); onDeleted(receipt, current.title); }
    catch (cause) { setError(errorMessage(cause)); setConflict(cause instanceof ApiError && cause.code === "conflict"); }
    finally { pending.current = false; setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try { setCurrent(await api.get(item.id)); operation.current = crypto.randomUUID(); setConflict(false); setError("최신 내용으로 갱신했습니다. 삭제할지 다시 확인해 주세요."); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <Dialog title="선반에서 삭제할까요?" onClose={onClose} busy={busy}>
    <div className="delete-summary"><strong>{current.title}</strong><p>{current.note || "메모 없음"}</p></div>
    {current.sourceCount > 1 ? <p className="dialog-description">연결된 출처가 있습니다. 출처 관리에서 먼저 연결을 해제한 뒤 원하는 북마크만 삭제해 주세요.</p> : <p className="dialog-description">북마크와 메모를 선반에서 삭제합니다. 삭제 후 60초 동안 이 창에서 되돌릴 수 있습니다. 창을 닫거나 새로고침·로그아웃하면 되돌리기 안내가 사라집니다.</p>}
    {error && <p className="form-error" role="alert">{error} 통신 실패로 결과가 불확실하면 이 창의 삭제 버튼으로 다시 확인해 주세요.</p>}
    {conflict && <button className="secondary" disabled={busy} onClick={() => { void reload(); }}>최신 내용 확인</button>}
    <footer className="dialog-actions"><button className="secondary" onClick={onClose} disabled={busy}>취소</button>{current.sourceCount > 1 ? <button className="primary" onClick={onManage} disabled={busy}>출처 관리</button> : <button className="danger" onClick={() => { void remove(); }} disabled={busy || conflict}>{busy ? "삭제 중…" : "삭제"}</button>}</footer>
  </Dialog>;
}
