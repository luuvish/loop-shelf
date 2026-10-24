import { useEffect, useRef, useState } from "react";
import type { DeletionReceipt } from "../src/shared/deletions.ts";
import { ApiError, errorMessage, type BookmarkApi } from "./api.ts";

export interface PendingDeletion extends DeletionReceipt { title: string; deadline: number }
export function DeletionUndo({ items, api, onDismiss, onChanged }: {
  items: PendingDeletion[]; api: BookmarkApi; onDismiss: (id: string) => void; onChanged: (message: string) => void;
}) {
  const [now, setNow] = useState(() => performance.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; message: string; unavailable: boolean } | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(performance.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  async function undo(item: PendingDeletion) {
    if (pending.current) return;
    pending.current = true; setBusy(item.id); setFailure(null);
    try {
      const result = await api.undoDeletion(item.id);
      onDismiss(item.id);
      onChanged(result.restored ? "북마크를 원래 내용으로 복구했습니다." : "이미 처리된 되돌리기입니다. 최신 선반을 불러왔습니다.");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "undo_conflict") onChanged("선반이 바뀌었습니다. 최신 내용을 확인해 주세요.");
      setFailure({ id: item.id, message: errorMessage(cause), unavailable: cause instanceof ApiError && cause.code === "undo_unavailable" });
    } finally { pending.current = false; setBusy(null); }
  }
  return <section className="undo-panel" aria-label="삭제 되돌리기">
    <h2>삭제한 북마크</h2><p className="field-help">삭제 후 60초 동안 이 창에서 되돌릴 수 있습니다. 새로고침·로그아웃하면 이 안내는 사라집니다.</p>
    <ul>{items.map((item) => {
      const seconds = Math.max(0, Math.ceil((item.deadline - now) / 1000));
      const unavailable = seconds === 0 || (failure?.id === item.id && failure.unavailable);
      return <li key={item.id}>
        <div className="undo-summary"><strong>{item.title}</strong><span className="field-help">{unavailable ? "복구 시간 만료 또는 세션 종료" : <><span aria-hidden="true">되돌리기 {seconds}초 남음</span><span className="sr-only">삭제 후 60초 이내에 되돌리기</span></>}</span></div>
        <div className="undo-actions"><button className="secondary small" disabled={!!busy || unavailable} onClick={() => { void undo(item); }}>{busy === item.id ? "복구 중…" : "되돌리기"}</button><button className="text-button" disabled={!!busy} onClick={() => onDismiss(item.id)} aria-label={`${item.title} 삭제 안내 닫기`}>닫기</button></div>
        {failure?.id === item.id && <p className="form-error" role="alert">{failure.message}{!unavailable && " 시간이 남아 있으면 다시 시도할 수 있습니다. 응답을 받지 못한 복구 요청도 중복으로 적용하지 않습니다."}</p>}
      </li>;
    })}</ul>
  </section>;
}
