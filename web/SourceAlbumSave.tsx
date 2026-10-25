import { useContext, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { CatalogLibraryItem } from "../src/shared/catalog-library.ts";
import type { SourceAlbumSelection } from "./source-album-response.ts";
import { ApiError, errorMessage, sourceSaveApi, type SourceAlbumView, type User } from "./api.ts";
import { ConnectionBlocked } from "./connection.ts";
import { sourceNames } from "./catalog-ui.tsx";
import { sourceTime } from "./source-ui.ts";

function saveMessage(code: string) {
  switch (code) {
    case "policy_disabled": return "이 출처의 보관 허용 여부를 확인하고 있어 지금은 저장할 수 없습니다.";
    case "storage_unavailable": return "이 자료의 저장 기능은 아직 준비 중입니다.";
    case "snapshot_changed": return "앨범 정보가 바뀌었습니다. 최신 상세를 확인한 뒤 다시 선택해 주세요.";
    case "refresh_required": case "result_expired": return "저장 확인 기한이 지났거나 이전 자료입니다. 상세를 다시 확인해 주세요.";
    case "policy_changed": return "출처의 이용 조건이 바뀌었습니다. 현재 상태를 다시 확인해 주세요.";
    case "content_removed": case "catalog_unavailable": return "현재 저장할 수 없는 자료입니다. 기존 개인 내용은 선반에서 확인할 수 있습니다.";
    case "invalid_response": return "저장 확인 정보를 검증하지 못했습니다. 최신 상태를 다시 확인해 주세요.";
    case "save_timeout": case "timeout": return "저장 결과를 제때 확인하지 못했습니다.";
    default: return "저장 가능 여부를 아직 확인하지 못했습니다.";
  }
}
export function SourceAlbumSave({ user, selection, response, deadline, now, waitUntil, detailBusy, onRefresh, onBusy, onLimited, onReject, onLibrary, onDraftChange }: {
  user: User; selection: SourceAlbumSelection; response: SourceAlbumView | null; deadline: number; now: number; waitUntil: number; detailBusy: boolean;
  onRefresh: (signal: AbortSignal) => Promise<SourceAlbumView | null>; onBusy: (busy: boolean) => void; onLimited: (until: number) => void;
  onReject: () => void; onLibrary: () => void; onDraftChange: (present: boolean) => void;
}) {
  const api = useMemo(() => sourceSaveApi(user), [user.id, user.sessionId]), blocked = useContext(ConnectionBlocked);
  const [mode, setMode] = useState<"idle" | "edit" | "confirm" | "recover" | "saved">("idle");
  const [draft, setDraft] = useState({ title: "", note: "", favorite: false });
  const [item, setItem] = useState<CatalogLibraryItem | null>(null), [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"lookup" | "save" | null>(null), [expired, setExpired] = useState(false), [confirmed, setConfirmed] = useState("");
  const pending = useRef<{ controller: AbortController; kind: "lookup" | "save" } | null>(null), feedback = useRef<HTMLDivElement>(null);
  const guidance = response?.save, available = guidance?.status === "available" && !expired && performance.now() < deadline && !blocked;
  const limited = now < waitUntil;
  function cancel(why: string) {
    const task = pending.current; pending.current = null; task?.controller.abort(); setBusy(null); onBusy(false); setConfirmed("");
    setItem(null); setMode("recover"); setMessage(why);
  }
  function begin(kind: "lookup" | "save") {
    if (pending.current || blocked) return null;
    const task = { controller: new AbortController(), kind }; pending.current = task; setBusy(kind); onBusy(true); setMessage(""); return task;
  }
  function isCurrent(task: NonNullable<typeof pending.current>) { return pending.current === task && !task.controller.signal.aborted; }
  function finish(task: NonNullable<typeof pending.current>) {
    if (!isCurrent(task)) return;
    pending.current = null; setBusy(null); onBusy(false); requestAnimationFrame(() => feedback.current?.focus());
  }
  useEffect(() => { onDraftChange(["edit", "confirm", "recover"].includes(mode)); }, [mode]);
  useEffect(() => () => { pending.current?.controller.abort(); pending.current = null; }, [api]);
  useEffect(() => {
    setConfirmed(""); setMode((value) => value === "confirm" ? "edit" : value);
    setExpired(guidance?.status === "available" && performance.now() >= deadline);
    if (guidance?.status !== "available") return;
    const timer = setTimeout(() => {
      setExpired(true); setConfirmed("");
      if (pending.current?.kind === "save") cancel("확인 기한이 지나 요청을 취소했습니다. 이미 저장되었을 수 있으니 선반과 상세를 다시 확인해 주세요.");
      else setMode((value) => value === "confirm" ? "edit" : value);
    }, Math.min(Math.max(0, deadline - performance.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [response, deadline]);
  useEffect(() => {
    if (blocked) cancel("연결 후 선반과 상세를 다시 확인해 주세요. 입력 내용은 이 창에만 유지되며 자동으로 저장하지 않습니다.");
  }, [blocked]);
  async function inspect(refresh: boolean) {
    if (detailBusy || limited || !refresh && !available) return;
    const task = begin("lookup"); if (!task) return;
    try {
      const existing = await api.lookup(selection, task.controller.signal);
      if (!isCurrent(task)) return;
      const latest = refresh ? await onRefresh(task.controller.signal) : response;
      if (!isCurrent(task)) return;
      setItem(existing); setConfirmed("");
      if (existing) { setMode("saved"); setMessage("이미 내 선반에 저장되어 있습니다. 기존 제목·메모·즐겨찾기를 유지했습니다."); }
      else if (latest) { setMode("edit"); setMessage(refresh ? "현재 원본에 연결된 저장 항목이 없습니다. 새 상세와 입력 내용을 확인한 뒤 저장해 주세요." : ""); }
      else { setMode("recover"); setMessage("상세 확인을 완료하지 못했습니다. 입력 내용은 유지됩니다."); }
    } catch (cause) {
      if (!isCurrent(task)) return;
      setMode("recover"); setMessage(errorMessage(cause));
      if (cause instanceof ApiError && cause.retryAt) onLimited(cause.retryAt);
    } finally { finish(task); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!available || guidance?.status !== "available" || limited || detailBusy || pending.current) return;
    if (mode === "edit") { setConfirmed(guidance.expectedFingerprint); setMode("confirm"); return; }
    if (mode !== "confirm" || confirmed !== guidance.expectedFingerprint) return;
    const task = begin("save"); if (!task) return;
    try {
      const saved = await api.save(selection, confirmed, { titleOverride: draft.title.trim() || null, note: draft.note, favorite: draft.favorite }, task.controller.signal);
      if (!isCurrent(task)) return;
      setItem(saved.item); setMode("saved"); setConfirmed("");
      setMessage((saved.created ? "내 선반에 앨범을 저장했습니다." : "이미 저장한 앨범입니다. 기존 개인 내용을 그대로 유지했습니다.")
        + (saved.trackState === "review_required" ? " 수록곡 변경은 검토 대기 중이며 기존 곡은 자동으로 바꾸지 않았습니다." : ""));
    } catch (cause) {
      if (!isCurrent(task)) return;
      setMode("recover"); setConfirmed(""); setItem(null);
      setMessage((cause instanceof ApiError && ["snapshot_changed", "policy_disabled", "policy_changed", "content_removed", "catalog_unavailable", "refresh_required", "result_expired", "invalid_response", "save_timeout", "timeout"].includes(cause.code)
        ? saveMessage(cause.code) : errorMessage(cause)) + " 저장되었을 수도 있으니 선반과 상세를 확인한 뒤 다시 선택해 주세요.");
      if (cause instanceof ApiError && cause.retryAt) onLimited(cause.retryAt);
      if (cause instanceof ApiError && ["policy_disabled", "policy_changed", "content_removed", "catalog_unavailable", "result_expired"].includes(cause.code)) onReject();
    } finally { finish(task); }
  }
  return <section className="source-save-panel" aria-label="앨범 저장 확인">
    <header><div><span className="eyebrow">KEEP THIS ALBUM</span><h3>내 선반에 보관</h3></div><span className="status-pill">{mode === "saved" ? "저장 확인됨" : mode === "recover" ? "재확인 필요" : available ? "저장 확인 가능" : "저장 준비 필요"}</span></header>
    <div ref={feedback} tabIndex={-1} aria-live="polite">
      {message && <p className="notice" role="status">{message}</p>}
      {busy && <p role="status">{busy === "save" ? "저장 결과를 확인하는 중…" : "내 선반을 확인하는 중…"}</p>}
    </div>
    {mode !== "saved" && !available && <p className="field-help">{expired ? saveMessage("result_expired") : guidance?.status === "unavailable" ? saveMessage(guidance.code) : "앨범 상세를 확인하면 저장 가능 여부를 안내합니다."}</p>}
    {available && guidance?.status === "available" && mode !== "saved" && mode !== "recover" && <p className="field-help">이 선택으로 저장 확인 가능한 시각: <time dateTime={guidance.validUntil}>{sourceTime(guidance.validUntil)}</time><br />앨범 정보 보관 기한: <time dateTime={guidance.retainUntil}>{sourceTime(guidance.retainUntil)}</time></p>}
    {mode === "idle" && available && <button className="primary" disabled={!!busy || detailBusy || limited} onClick={() => { void inspect(false); }}>내 선반에 저장</button>}
    {["edit", "confirm", "recover"].includes(mode) && <form onSubmit={(event) => { void submit(event); }}>
      <fieldset disabled={!!busy || mode === "confirm"}>
        <label htmlFor="source-save-title">나만의 제목 <span className="optional">선택</span></label>
        <input id="source-save-title" maxLength={300} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="비워 두면 원본 제목 사용" />
        <label htmlFor="source-save-note">메모 <span className="optional">선택</span></label>
        <textarea id="source-save-note" rows={3} maxLength={10000} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
        <label className="checkbox-label"><input type="checkbox" checked={draft.favorite} onChange={(e) => setDraft({ ...draft, favorite: e.target.checked })} />즐겨찾기에 추가</label>
      </fieldset>
      {mode === "confirm" && <div className="source-save-confirm" role="group" aria-label="저장할 내용">
        <strong>{response?.result.ok ? response.result.data.title : "선택한 앨범"}</strong><p>{sourceNames[selection.ref.sourceId]} · {user.email}</p>
        <p>개인 제목: {draft.title.trim() || "현재 원본 제목 사용"}</p><p className="source-save-note">메모: {draft.note || "없음"}</p><p>즐겨찾기: {draft.favorite ? "추가" : "추가 안 함"}</p>
        {selection.sampleKind === "synthetic" && <p>합성 검증 자료를 저장합니다. 실제 사이트 자료가 아닙니다.</p>}
      </div>}
      <div className="source-save-actions">
        {mode === "confirm" && <button type="button" className="secondary" disabled={!!busy} onClick={() => { setMode("edit"); setConfirmed(""); }}>입력 수정</button>}
        {mode !== "recover" && <button className="primary" disabled={!available || !!busy || detailBusy || limited}>{mode === "confirm" ? "확인하고 저장" : "저장 내용 확인"}</button>}
        {mode === "recover" && <button type="button" className="secondary" disabled={!!busy || detailBusy || limited} onClick={() => { void inspect(true); }}>선반과 상세 다시 확인</button>}
      </div>
    </form>}
    {busy && <button className="secondary small" onClick={() => cancel("요청을 취소했습니다. 이미 저장되었을 수 있으니 선반과 상세를 다시 확인해 주세요.")}>저장 요청 취소</button>}
    {mode === "saved" && item && <div className="source-save-confirm"><strong>{item.titleOverride ?? "저장한 앨범"}</strong><p className="source-save-note">{item.note || "메모 없음"}</p><p>즐겨찾기: {item.favorite ? "사용" : "사용 안 함"}</p><p className="field-help">{item.entity.contentState === "active" ? "개인 내용은 저장한 카탈로그에서 관리할 수 있습니다." : "원본이 미연결·만료·제거된 상태여도 개인 내용은 유지됩니다."}</p></div>}
    <p className="field-help">수록곡을 개별 저장하거나 음악 파일을 보관하지 않습니다. 원본 미연결 자료와 추가 출처로 연결한 항목은 별도로 확인해 주세요.</p>
    <button className="text-button" onClick={onLibrary}>저장한 카탈로그 확인 →</button>
  </section>;
}
