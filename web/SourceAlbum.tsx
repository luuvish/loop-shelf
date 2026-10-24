import { useEffect, useMemo, useRef, useState } from "react";
import type { SourceAlbumResponse } from "../src/shared/source-album.ts";
import type { SourceAlbumSelection } from "./source-album-response.ts";
import { ApiError, errorMessage, sourceAlbumApi, type User } from "./api.ts";
import { Dialog } from "./dialogs.tsx";
import { sourceNames } from "./catalog-ui.tsx";
import { sourceMessage, sourceRetriable, sourceTime } from "./source-ui.ts";
import { Icon } from "./icons.tsx";

export function SourceAlbum({ user, selection, now, waitUntil, onLimited, onInvalidate, onClose }: {
  user: User; selection: SourceAlbumSelection; now: number; waitUntil: number;
  onLimited: (until: number, scope: "source" | "http") => void;
  onInvalidate: () => void; onClose: () => void;
}) {
  const api = useMemo(() => sourceAlbumApi(user), [user.id, user.sessionId]);
  const [response, setResponse] = useState<SourceAlbumResponse | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [offset, setOffset] = useState(0);
  const expiry = useRef(0);
  const controller = useRef<AbortController | null>(null), sequence = useRef(0), feedback = useRef<HTMLDivElement>(null), tracksHeading = useRef<HTMLHeadingElement>(null);
  const seconds = Math.max(0, Math.ceil((waitUntil - now) / 1000));
  function cancel() { sequence.current++; controller.current?.abort(); controller.current = null; setBusy(false); setResponse(null); }
  async function read() {
    if (controller.current || Date.now() < waitUntil) return;
    const current = new AbortController(), id = ++sequence.current; controller.current = current;
    setBusy(true); setResponse(null); setError(""); setNotice(""); setOffset(0);
    try {
      const loaded = await api(selection, current.signal), value = loaded.response;
      if (current.signal.aborted || id !== sequence.current) return;
      const failure = value.result.ok ? value.result.refreshFailure : value.result;
      if (failure?.retryAt) onLimited(failure.retryAt, "source");
      if (!value.result.ok && ["content_removed", "policy_disabled", "blocked", "not_found", "policy_changed", "result_expired"].includes(value.result.code)) onInvalidate();
      expiry.current = performance.now() + (loaded.expiresInMs ?? 0); setResponse(value);
    } catch (cause) {
      if (current.signal.aborted || id !== sequence.current) return;
      if (cause instanceof ApiError && cause.retryAt) onLimited(cause.retryAt, "http");
      setError(cause instanceof ApiError && cause.code === "result_expired" ? "확인하는 동안 자료의 보관 기한이 지났습니다. 다시 조회해 주세요."
        : cause instanceof ApiError && cause.code === "invalid_response" ? "선택한 앨범의 응답을 확인하지 못했습니다. 출처·자료 종류·수록곡 정보가 일치하지 않습니다."
        : cause instanceof ApiError && cause.code === "album_timeout" || cause instanceof DOMException && cause.name === "TimeoutError"
          ? "상세 조회 시간이 초과되었습니다. 확인하지 못한 자료는 표시하지 않습니다." : errorMessage(cause));
      if (cause instanceof ApiError && ["invalid_response", "result_expired"].includes(cause.code)) onInvalidate();
    } finally {
      if (!current.signal.aborted && id === sequence.current) {
        controller.current = null; setBusy(false); requestAnimationFrame(() => feedback.current?.focus());
      }
    }
  }
  useEffect(() => {
    // Opening the dialog is an explicit user action. Defer past StrictMode's discarded first mount.
    let disposed = false;
    void Promise.resolve().then(() => { if (!disposed) void read(); });
    return () => { disposed = true; sequence.current++; controller.current?.abort(); };
  }, [api, selection]);
  useEffect(() => {
    if (!response?.result.ok) return;
    // Use server-relative remaining lifetime, not the browser's wall clock, and never refresh automatically.
    const remaining = Math.max(0, expiry.current - performance.now());
    const timer = setTimeout(() => { setResponse(null); setOffset(0); setNotice("자료의 보관 기한이 지나 상세를 지웠습니다. 다시 조회해 주세요."); onInvalidate(); }, Math.min(remaining, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [response]);
  const result = response?.result, failure = result?.ok ? result.refreshFailure : result;
  const canRead = !response || result?.ok || failure && sourceRetriable(failure);
  const detail = result?.ok ? result.data : null;
  function page(next: number) { setOffset(next); requestAnimationFrame(() => tracksHeading.current?.focus()); }
  return <Dialog title="소스 앨범 상세" onClose={onClose} className="source-album-dialog">
    <div className="source-album-detail">
      <div className="album-source-heading"><span className="eyebrow">{sourceNames[selection.ref.sourceId]}</span>
        <a className="external-link" href={selection.ref.pageUrl} target="_blank" rel="noopener noreferrer">앨범 원문 열기 <Icon name="arrow" /></a></div>
      <p className="catalog-source-key">출처 식별명: {selection.ref.externalKey}</p>
      {selection.sampleKind === "synthetic" && <p className="notice">합성 검증 항목에서 열었습니다. 실제 사이트 연동 성공을 의미하지 않습니다.</p>}
      <div className="source-album-feedback" ref={feedback} tabIndex={-1} aria-live="polite">
        {busy && <div className="search-progress"><p role="status"><span className="loading-dot" />앨범 정보를 확인하는 중…</p><button className="secondary small" onClick={() => { cancel(); setNotice("상세 조회를 취소했습니다. 자동으로 다시 요청하지 않습니다."); }}>조회 취소</button></div>}
        {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
        {response && <p role="status">{!result?.ok ? "앨범 정보를 확인하지 못했습니다. 수록곡 0개라는 뜻은 아닙니다."
          : response.status === "partial" ? "이전 자료 또는 갱신 실패가 있습니다. 아래 확인 시각을 참고하세요." : `앨범과 수록곡 ${detail!.tracks.length}개를 확인했습니다.`}</p>}
        {response?.termination === "deadline" && <p className="field-help">시간 제한으로 이번 조회를 마쳤습니다.</p>}
      </div>
      {failure && <p className={result?.ok ? "notice" : "search-explanation"}>{result?.ok ? "갱신 실패: " : ""}{sourceMessage(failure)}</p>}
      {response && !response.policy.collect.allowed && response.policy.display.allowed && <p className="field-help">새 자료 수집은 현재 허용되지 않습니다.</p>}
      {detail && result?.ok && <>
        <section className="source-album-information" aria-label="출처의 앨범 정보">
          <h3>{detail.title}</h3><p className="field-help">출처 상세 페이지의 앨범 제목입니다. 검색 목록의 표시명은 바꾸지 않습니다.</p>
          {response?.sampleKind === "synthetic" && <p className="notice">합성 검증 자료입니다. 실제로 수집한 앨범이 아닙니다.</p>}
          <span className="status-pill">{result.delivery.freshness === "stale" ? "이전 자료 · 최신 여부 확인 필요" : result.delivery.from === "cache" ? "보관된 앨범 정보" : "이번 조회에서 받은 앨범 정보"}</span>
          <p className="field-help">자료 확인 <time dateTime={result.provenance.capturedAt}>{sourceTime(result.provenance.capturedAt)}</time><br />보관 기한 <time dateTime={result.delivery.expiresAt}>{sourceTime(result.delivery.expiresAt)}</time></p>
          <dl className="source-album-facts"><div><dt>플랫폼</dt><dd>{detail.platforms.join(" · ") || "미확인"}</dd></div>
            <div><dt>출처 분류</dt><dd>{detail.sourceCategory ?? "미확인"}</dd></div><div><dt>출처 연도 표기</dt><dd>{detail.sourceYearLabel ?? "미확인"}</dd></div><div><dt>확인된 발매일</dt><dd>미확인</dd></div></dl>
          {detail.sourceClaims.length > 0 && <details className="source-album-claims"><summary>출처에 적힌 추가 정보</summary><p className="field-help">출처의 원문 주장입니다. 확정된 게임 관계나 발매 정보로 채택하지 않았습니다.</p><dl>{detail.sourceClaims.map((claim, i) => <div key={i}><dt>{claim.label}</dt><dd>{claim.value}</dd></div>)}</dl></details>}
          {result.warnings.length > 0 && <details className="search-warnings"><summary>자료 확인 안내</summary><ul>{result.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
        </section>
        <section className="source-album-tracks" aria-label="출처 수록곡"><h3 ref={tracksHeading} tabIndex={-1}>수록곡 <span>{detail.tracks.length}</span></h3>
          <p className="field-help">출처의 수록 순서입니다. 같은 표시 번호도 별도 곡으로 유지합니다.</p>
          <ol className="source-track-list" start={offset + 1}>{detail.tracks.slice(offset, offset + 20).map((track) => <li key={track.snapshotLocator}>
            <div className="source-track-number"><span>순서 {track.position}</span><strong>{track.displayNumber ?? "번호 미확인"}</strong></div>
            <div className="source-track-title"><h4>{track.title}</h4><p>{track.durationLabel === null ? "원문 길이 미확인" : `원문 길이 ${track.durationLabel}`}</p></div>
            <span className="source-track-duration">{track.durationSeconds === null ? "길이 미확인" : `${Math.floor(track.durationSeconds / 60)}:${String(track.durationSeconds % 60).padStart(2, "0")}`}</span>
          </li>)}</ol>
          {detail.tracks.length > 20 && <nav className="pagination" aria-label="상세 수록곡 페이지"><button className="secondary small" disabled={!offset} onClick={() => page(Math.max(0, offset - 20))}>← 이전</button><span>{Math.floor(offset / 20) + 1} / {Math.ceil(detail.tracks.length / 20)}</span><button className="secondary small" disabled={offset + 20 >= detail.tracks.length} onClick={() => page(offset + 20)}>다음 →</button></nav>}
        </section>
      </>}
      {seconds > 0 && <p className="notice" role="status">요청 제한으로 {seconds}초 후 직접 다시 조회할 수 있습니다. 자동으로 재시도하지 않습니다.</p>}
      <p className="source-album-footnote">조회한 앨범과 곡은 내 라이브러리에 자동 저장되지 않습니다. 앱 내 재생은 아직 지원하지 않으며 원문 열기는 청취 기록을 만들지 않습니다.</p>
      <footer className="dialog-actions">{canRead && <button className="secondary" disabled={busy || seconds > 0} onClick={() => { void read(); }}>{result?.ok ? "상세 새로고침" : "다시 조회"}</button>}<button className="primary" onClick={onClose}>검색으로 돌아가기</button></footer>
    </div>
  </Dialog>;
}
