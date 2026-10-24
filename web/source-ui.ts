import type { SearchFailure } from "../src/shared/search.ts";
import type { SourceAlbumFailure } from "../src/shared/source-album.ts";

export const sourceRetriable = (failure: SearchFailure | SourceAlbumFailure) => ["timeout", "network_error", "rate_limited", "queue_full", "parse_changed", "invalid_response", "response_too_large",
  "result_expired", "policy_changed", "cache_error", "database_error", "source_error"].includes(failure.code) || failure.code === "http_error" && (failure.httpStatus ?? 0) >= 500;
export function sourceMessage(failure: SearchFailure | SourceAlbumFailure): string {
  switch (failure.code) {
    case "policy_disabled": return "이용 조건 확인 중입니다. 자동 조회를 제공하지 않습니다.";
    case "sample_kind_unavailable": return "실제 수집 자료를 조회하는 로컬 카탈로그는 아직 준비 중입니다. 결과가 0건이라는 뜻은 아닙니다.";
    case "blocked": return "출처의 접근 제한으로 조회할 수 없습니다.";
    case "unsupported": return "아직 지원하지 않는 조회입니다.";
    case "content_removed": return "제거된 자료가 포함되어 이 출처의 결과를 표시하지 않습니다.";
    case "not_found": return "출처 페이지를 찾을 수 없습니다.";
    case "parse_changed": return "출처의 페이지 구성이 달라 내용을 확인하지 못했습니다.";
    case "rate_limited": return "출처의 요청 제한에 도달했습니다. 안내된 시간 이후 다시 조회해 주세요.";
    case "queue_full": return "다른 조회를 처리 중입니다. 잠시 후 다시 조회해 주세요.";
    case "timeout": return "출처의 응답이 늦어 이번 조회를 마쳤습니다.";
    case "result_expired": return "기다리는 동안 자료의 보관 기한이 지나 결과를 표시하지 않습니다.";
    case "policy_changed": return "출처의 이용 조건이 변경되었습니다. 다시 확인해 주세요.";
    default: return "자료를 확인하지 못했습니다. 결과 없음으로 처리하지 않았습니다.";
  }
}
export function sourceTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date) : "시각 미확인";
}
