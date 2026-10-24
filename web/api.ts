import type { DeletionReceipt, UndoResult } from "../src/shared/deletions.ts";
import type { Bookmark, BookmarkDraft, BookmarkPage, BookmarkConnections, DisconnectedBookmark } from "../src/shared/bookmarks.ts";
import type { BookmarkArchive, ImportPreview, ImportResult } from "../src/shared/transfer.ts";
import type { CatalogLibraryItem, CatalogLibraryPage } from "../src/shared/catalog-library.ts";
import type { CatalogAlbumPage, CatalogAlbumDetail, CatalogCandidates } from "../src/shared/catalog-browse.ts";
import type { CatalogArchiveV2 } from "../src/shared/catalog-transfer.ts";
import type { SearchResponse, SearchResult } from "../src/shared/search.ts";
import type { SourceId } from "../src/sources/types.ts";
import type { SourceAlbumResponse, SourceAlbumResult } from "../src/shared/source-album.ts";
import { validSourceAlbumResponse, type SourceAlbumSelection } from "./source-album-response.ts";

export interface User { id: string; name: string; email: string; sessionId: string }

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAt: number | undefined;
  constructor(status: number, code: string, retryAt?: number) { super(code); this.status = status; this.code = code; this.retryAt = retryAt; }
}

async function request<T>(path: string, init: RequestInit = {}, userId?: string, expectedSession?: string): Promise<T> {
  if (!navigator.onLine) throw new ApiError(0, "offline");
  const response = await fetch(`/api${path}`, {
    ...init, credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
  });
  init.signal?.throwIfAborted();
  if (userId && (response.status === 401 || (response.ok && (response.headers.get("X-LoopShelf-User") !== userId
    || expectedSession !== undefined && response.headers.get("X-LoopShelf-Session") !== expectedSession)))) {
    window.dispatchEvent(new Event("loopshelf:session-expired"));
    throw new ApiError(401, "unauthorized");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { code?: string };
    init.signal?.throwIfAborted();
    const retry = response.headers.get("Retry-After");
    const retryAt = retry ? /^\d+$/u.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry) : NaN;
    throw new ApiError(response.status, body.code ?? "request_failed", Number.isFinite(retryAt) ? retryAt : undefined);
  }
  const value = response.status === 204 ? undefined as T : await response.json() as T;
  init.signal?.throwIfAborted(); return value;
}

export const session = async (signal?: AbortSignal) => {
  const value = await request<{ user: Omit<User, "sessionId">; session: { id: string } } | null>("/auth/get-session", { signal: signal ?? null });
  return value ? { ...value.user, sessionId: value.session.id } : null;
};
export const signIn = (email: string, password: string) => request("/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email, password }) });
export const signOut = () => request("/auth/sign-out", { method: "POST", body: "{}" });

export interface SearchQuery { q: string; sources: SourceId[]; limit: number; offset: number }
async function confirmedSourceRequest<T>(path: string, input: unknown, user: User, signal: AbortSignal): Promise<T> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  const result = await request<T>(path, { method: "POST", body: JSON.stringify(input), signal: combined,
    headers: { "X-LoopShelf-Session": user.sessionId } }, user.id, user.sessionId);
  const current = await session(combined); combined.throwIfAborted();
  if (!current || current.id !== user.id || current.sessionId !== user.sessionId) {
    window.dispatchEvent(new Event("loopshelf:session-expired")); throw new ApiError(401, "session_changed");
  }
  return result;
}
export function sourceAlbumApi(user: User) {
  return async (selection: SourceAlbumSelection, signal: AbortSignal): Promise<{ response: SourceAlbumResponse; expiresInMs: number | null }> => {
    const started = performance.now();
    const { sourceId, externalKey } = selection.ref;
    const value = await confirmedSourceRequest<SourceAlbumResult>("/source-album", { sourceId, externalKey }, user, signal);
    if (!value.ok) throw new ApiError(400, value.code);
    if (!validSourceAlbumResponse(value, selection)) throw new ApiError(502, "invalid_response");
    // Conservatively deduct the whole request/session-check duration from server-relative remaining lifetime.
    const expiresInMs = value.result.ok ? Date.parse(value.result.delivery.expiresAt) - Date.parse(value.completedAt) - (performance.now() - started) : null;
    if (expiresInMs !== null && expiresInMs <= 0) throw new ApiError(410, "result_expired");
    return { response: value, expiresInMs };
  };
}
export function searchApi(user: User) {
  return async (input: SearchQuery, signal: AbortSignal): Promise<SearchResponse> => {
    const result = await confirmedSourceRequest<SearchResult>("/search", input, user, signal);
    if (!result.ok) throw new ApiError(400, result.code);
    const expected = [...input.sources].sort(), actual = result.sources.map((source) => source.sourceId).sort();
    if (result.query !== input.q.trim() || JSON.stringify(expected) !== JSON.stringify(actual)
      || !["synthetic", "live-capture"].includes(result.sampleKind)
      || result.local.ok && (result.local.sampleKind !== result.sampleKind || result.local.items.some((item) => item.provenance.sampleKind !== result.sampleKind))
      || result.sources.some(({ sourceId, result: part }) => part.ok && (part.provenance.sampleKind !== result.sampleKind || part.provenance.sourceId !== sourceId)))
      throw new ApiError(502, "invalid_response");
    return result;
  };
}

export function bookmarkApi(userId: string, sessionId: string) {
  const scoped = <T,>(path: string, init: RequestInit = {}) => request<T>(path, {
    ...init, headers: { ...init.headers, "X-LoopShelf-Session": sessionId },
  }, userId);
  return {
    exportArchive: (signal: AbortSignal) => scoped<BookmarkArchive>("/library/export", { signal }),
    exportCatalogArchive: (signal: AbortSignal) => scoped<CatalogArchiveV2>("/library/catalog/export", { signal }),
    previewImport: (archive: unknown, signal: AbortSignal) => scoped<ImportPreview>("/library/import/preview", { method: "POST", body: JSON.stringify({ archive }), signal }),
    importArchive: (archive: unknown, token: string, signal: AbortSignal) => scoped<ImportResult>("/library/import", { method: "POST", body: JSON.stringify({ archive, token }), signal }),
    list: (q: string, favorite: boolean, offset: number, signal: AbortSignal, standalone = false) => {
      const params = new URLSearchParams({ q, offset: String(offset), limit: "12" });
      if (favorite) params.set("favorite", "true");
      if (standalone) params.set("standalone", "true");
      return scoped<BookmarkPage>(`/bookmarks?${params}`, { signal });
    },
    get: (id: string) => scoped<Bookmark>(`/bookmarks/${id}`),
    create: (draft: BookmarkDraft) => scoped<{ item: Bookmark; created: boolean }>("/bookmarks", { method: "POST", body: JSON.stringify(draft) }),
    update: (item: Bookmark, draft: Partial<BookmarkDraft>) => scoped<Bookmark>(`/bookmarks/${item.id}`, { method: "PATCH", body: JSON.stringify({ ...draft, version: item.version }) }),
    deleteWithUndo: async (item: Bookmark, operationId: string) => {
      const started = performance.now();
      const receipt = await scoped<DeletionReceipt>(`/bookmarks/${item.id}/deletion`, { method: "POST", body: JSON.stringify({ version: item.version, operationId }) });
      return { ...receipt, remainingMs: Math.max(0, receipt.remainingMs - (performance.now() - started)) };
    },
    undoDeletion: (id: string) => scoped<UndoResult>(`/bookmark-deletions/${id}/restore`, { method: "POST", body: "{}" }),
    remove: (item: Bookmark) => scoped<void>(`/bookmarks/${item.id}`, { method: "DELETE", body: JSON.stringify({ version: item.version }) }),
    connections: (id: string, signal: AbortSignal) => scoped<BookmarkConnections>(`/bookmarks/${id}/connections`, { signal }),
    connect: (root: Bookmark, member: Bookmark) => scoped<BookmarkConnections>(`/bookmarks/${root.id}/connections`, {
      method: "POST", body: JSON.stringify({ version: root.version, memberId: member.id, memberVersion: member.version }),
    }),
    disconnect: (root: Bookmark, member: Bookmark) => scoped<DisconnectedBookmark>(`/bookmarks/${root.id}/connections`, {
      method: "DELETE", body: JSON.stringify({ version: root.version, memberId: member.id, memberVersion: member.version }),
    }),
  };
}

export type BookmarkApi = ReturnType<typeof bookmarkApi>;

export type CatalogDraft = Pick<CatalogLibraryItem, "titleOverride" | "note" | "favorite">;
export function catalogApi(userId: string, sessionId: string) {
  const authenticated = <T,>(path: string, init: RequestInit = {}) => request<T>(path, {
    ...init, headers: { ...init.headers, "X-LoopShelf-Session": sessionId },
  }, userId);
  const scoped = <T,>(path: string, init: RequestInit = {}) => authenticated<T>(`/library/catalog${path}`, init);
  const searchParams = (q: string, sourceId: string, offset: number) => {
    const params = new URLSearchParams({ q, offset: String(offset), limit: "12" });
    if (sourceId) params.set("sourceId", sourceId);
    return params;
  };
  return {
    browse: (q: string, sourceId: string, offset: number, signal: AbortSignal) => authenticated<CatalogAlbumPage>(`/catalog/albums?${searchParams(q, sourceId, offset)}`, { signal }),
    album: (id: string, offset: number, signal: AbortSignal) => authenticated<CatalogAlbumDetail>(`/catalog/albums/${id}?limit=12&offset=${offset}`, { signal }),
    create: (entityId: string, signal: AbortSignal) => scoped<{ item: CatalogLibraryItem; created: boolean }>("", { method: "POST", body: JSON.stringify({ entityId }), signal }),
    candidates: (id: string, q: string, sourceId: string, offset: number, signal: AbortSignal) => scoped<CatalogCandidates>(`/${id}/source-candidates?${searchParams(q, sourceId, offset)}`, { signal }),
    connect: (item: Pick<CatalogLibraryItem, "id" | "version">, sourceEntityId: string, signal: AbortSignal) => scoped<CatalogLibraryItem>(`/${item.id}/sources`, { method: "POST", body: JSON.stringify({ version: item.version, sourceEntityId }), signal }),
    list: (q: string, kind: string, favorite: boolean, offset: number, signal: AbortSignal) => {
      const params = new URLSearchParams({ q, offset: String(offset), limit: "12" });
      if (kind) params.set("kind", kind);
      if (favorite) params.set("favorite", "true");
      return scoped<CatalogLibraryPage>(`?${params}`, { signal });
    },
    get: (id: string, signal: AbortSignal) => scoped<CatalogLibraryItem>(`/${id}`, { signal }),
    update: (item: CatalogLibraryItem, draft: Partial<CatalogDraft>, signal: AbortSignal) => scoped<CatalogLibraryItem>(`/${item.id}`, {
      method: "PATCH", body: JSON.stringify({ ...draft, version: item.version }), signal,
    }),
    remove: (item: CatalogLibraryItem, signal: AbortSignal) => scoped<void>(`/${item.id}`, { method: "DELETE", body: JSON.stringify({ version: item.version }), signal }),
    disconnect: (item: CatalogLibraryItem, sourceEntityId: string, signal: AbortSignal) => scoped<CatalogLibraryItem>(`/${item.id}/sources`, {
      method: "DELETE", body: JSON.stringify({ version: item.version, sourceEntityId }), signal,
    }),
  };
}
export type CatalogApi = ReturnType<typeof catalogApi>;
export function catalogError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "catalog_unavailable") return "현재 이용할 수 없는 카탈로그입니다. 최신 내용을 확인해 주세요.";
    if (error.code === "connection_limit") return "추가 앨범 출처는 최대 20개까지 연결할 수 있습니다.";
    if (error.status === 404) return "저장 항목이나 출처 연결을 찾을 수 없습니다. 다른 창에서 삭제 또는 해제했을 수 있습니다.";
    if (error.status === 409) return "다른 곳에서 변경되었습니다. 최신 내용을 확인한 뒤 다시 선택해 주세요.";
    if (error.status === 400) return "직접 지정한 제목과 메모를 확인해 주세요.";
  }
  return errorMessage(error);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "offline") return "오프라인입니다. 연결 후 다시 시도해 주세요. 요청은 자동으로 저장하거나 재전송하지 않습니다.";
    if (error.status === 401) return "로그인이 만료되었습니다. 다시 로그인해 주세요.";
    if (error.status === 429) return "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.";
    if (error.code === "undo_unavailable") return "되돌리기 시간이 지났거나 삭제한 로그인 세션이 아닙니다. 최신 선반을 확인해 주세요.";
    if (error.code === "undo_conflict") return "이미 복원되었거나 같은 주소의 북마크가 있습니다. 기존 내용을 덮어쓰지 않았습니다.";
    if (error.code === "undo_limit") return "최근 삭제의 복구 시간이 끝난 뒤 다시 삭제해 주세요. 삭제 요청은 실행하지 않았습니다.";
    if (error.code === "invalid_archive") return "지원하는 LoopShelf 파일이 아닙니다. 형식 버전, 북마크 내용과 출처 연결을 확인해 주세요.";
    if (error.code === "preview_stale") return "검사 후 선반이나 파일이 바뀌었거나 10분이 지났습니다. 파일을 다시 검사해 주세요.";
    if (error.code === "import_conflict") return "현재 선반과 충돌해 아무것도 가져오지 않았습니다. 다시 검사해 주세요.";
    if (error.code === "archive_too_large") return "파일과 복원 후 선반은 8 MiB, 북마크 5,000개 이하여야 합니다. 큰 라이브러리는 운영자의 DB 백업을 사용해 주세요.";
    if (error.status === 413) return "한 번에 전송할 수 있는 데이터 크기를 초과했습니다.";
    if (error.code === "grouped_bookmark") return "이미 연결된 북마크입니다. 출처 관리에서 연결을 먼저 해제해 주세요.";
    if (error.code === "connection_limit") return "한 항목에는 대표를 포함해 최대 20개의 출처를 연결할 수 있습니다.";
    if (error.code === "invalid_connection") return "북마크 자신에게는 연결할 수 없습니다.";
    if (error.status === 409) return "다른 곳에서 수정되었거나 이미 저장한 주소입니다. 최신 내용을 확인해 주세요.";
    if (error.status === 404) return "이 북마크를 찾을 수 없습니다. 다른 창에서 삭제했을 수 있습니다.";
    if (error.code === "invalid_url") return "KHInsider 또는 Zophar의 HTTPS 앨범 주소를 입력해 주세요.";
    if (error.status === 400) return "입력한 제목과 주소를 확인해 주세요.";
    if (error.status === 403) return "요청이 허용되지 않았습니다. 앱 주소를 확인하고 새로고침해 주세요.";
  }
  return "서버에 연결하지 못했습니다. 연결 상태를 확인하고 다시 시도해 주세요.";
}
