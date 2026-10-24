import { useEffect, useRef, useState } from "react";
import type { SavedCatalogEntity } from "../src/shared/catalog-library.ts";
import { catalogError } from "./api.ts";
import { Icon } from "./icons.tsx";
export const sourceNames = { khinsider: "KHInsider", zophar: "Zophar’s Domain" };
// Abort detached UI work; an aborted write may still commit, so retries always read the server first.
export function useTask() {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const locked = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function run(work: (signal: AbortSignal) => Promise<void>, failed?: (cause: unknown) => void) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    const current = new AbortController(); controller.current = current;
    try { await work(current.signal); }
    catch (cause) { if (!current.signal.aborted) { setError(catalogError(cause)); failed?.(cause); } }
    finally { locked.current = false; if (!current.signal.aborted) setBusy(false); }
  }
  return { busy, error, setError, run };
}

export function statusOf(entity: SavedCatalogEntity) {
  if (entity.contentState === "unresolved") return "원본 카탈로그 미연결";
  if (entity.contentState === "removed") return "소스 콘텐츠 제거됨";
  if (entity.contentState === "expired") return "외부 정보 보관 종료 · 개인 내용 유지";
  if (entity.presence === "missing") return "현재 수록 목록에서 누락";
  if (entity.lifecycle === "unavailable" || entity.sourceAvailability === "not_found") return "현재 이용 불가";
  if (entity.sourceAvailability === "blocked") return "출처 접근 차단";
  if (entity.kind === "track") return `현재 수록 순서 ${entity.position}`;
  return "소스별 앨범";
}
export const kindLabel = (entity: SavedCatalogEntity) => entity.sampleKind === "synthetic" ? "합성 자료" : "외부 자료 참조";
export function SourceInfo({ entity }: { entity: SavedCatalogEntity }) {
  return <div className="catalog-source-info"><strong className="connection-title">{entity.title}</strong>
    <p className="connection-meta">{sourceNames[entity.sourceId]} · {kindLabel(entity)} · {statusOf(entity)}</p>
    <p className="catalog-source-key">출처 식별명: {entity.externalKey}</p>
    <a className="external-link" href={entity.pageUrl} target="_blank" rel="noopener noreferrer">{entity.kind === "track" ? "소속 앨범 원문 열기" : "앨범 원문 열기"}<Icon name="arrow" /></a>
  </div>;
}
