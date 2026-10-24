# 소스 앨범 저장 확인·HTTP API

2026-10-25. 상세 응답의 저장 사전확인과 `POST /api/source-album/save`를 연결했습니다. **제품의 수집/보관 정책은 unknown이고 live 저장 guard도 닫혀 있습니다.** 성공 저장은 합성 상세와 실제 임시 로그인 쿠키로만 검증했습니다. React의 저장 버튼/확인 화면은 다음 작업이며, 기존 개인 카탈로그 저장/관리 API는 유지합니다.

## 상세에서 선택 확인

`POST /api/source-album`의 기존 응답에 `save`를 추가합니다. HTTP 초기 입력/동시 한도 실패에는 상세 봉투 자체가 없으며 이 필드도 없습니다. 마지막 실제 세션 확인과 상세 `recheck` 후, 같은 DB 경계에서 읽기 전용 사전확인을 계산합니다. 이 과정은 카탈로그·개인 UUID나 보관 lease를 만들지 않고 별도 네트워크 요청도 하지 않습니다.

```json
{
  "save": {
    "status": "available",
    "expectedFingerprint": "64자리 소문자 SHA-256",
    "validUntil": "2026-10-25T00:01:00.000Z",
    "retainUntil": "2026-10-25T00:02:00.000Z"
  }
}
```

가능한 경우에만 정확한 상세 관찰의 fingerprint를 제공합니다. `validUntil`은 fresh 기한과 원래 보관 기한 중 더 이른 시각입니다. `retainUntil`은 취득 시각과 현재 별도 보관 정책으로 제한한 원래 기한입니다. 새 저장 가능성을 안내하는 값이며 예약·권한 토큰·영구 음악 ID가 아닙니다. 저장 순간의 정책·세션·관찰·기한·제거 검사와 공용 카탈로그 충돌 검사는 별도로 다시 수행합니다.

불가능하면 `{"status":"unavailable","code":"policy_disabled"}` 형태이며 fingerprint/기한을 붙이지 않습니다. stale·갱신 실패·만료·정책 미확인·지원되지 않는 저장소를 저장 가능으로 표시하지 않습니다. 현재 제품의 두 소스는 `policy_disabled`입니다. 시험에서 live 보관 정책만 허용으로 바꾸더라도 `storage_unavailable`이며 합성 저장소로 들어가지 않습니다. 가져온 개인 JSON의 live 표시는 이 판단을 바꾸지 못합니다.

## 저장 요청과 응답

같은 origin의 POST, `Content-Type: application/json`, 실제 세션 쿠키와 `X-LoopShelf-Session`이 필요합니다.

```json
{
  "sourceId": "zophar",
  "externalKey": "nintendo-snes-spc/example",
  "expectedFingerprint": "상세 응답에서 확인한 64자리 SHA-256",
  "titleOverride": null,
  "note": "직접 작성한 개인 메모",
  "favorite": false
}
```

소스/키/fingerprint는 필수이고 나머지는 null/빈 문자열/false가 기본값입니다. UTF-8 본문 32 KiB, 개인 제목 300자·메모 10,000자 상한을 적용합니다. query는 허용하지 않습니다. URL·userId·Entity ID·자료 종류·정책·상세 DTO·오디오·임의 추가 필드는 거절합니다. userId는 현재 쿠키 세션에서 얻으며 fingerprint가 맞아도 인증/정책을 우회할 수 없습니다.

성공은 최초 개인 저장 `201`, 기존 개인 저장 `200`입니다. `{ ok: true, sampleKind, created, item, observationId, trackState }`를 반환합니다. 현재 성공 검증의 `sampleKind`는 synthetic입니다. 개인 항목 형식은 [기존 개인 API](CATALOG_LIBRARY.md)를 따릅니다. 다른 계정의 같은 앨범은 공용 Entity만 공유하고 개인 ID/메모/즐겨찾기는 분리합니다.

동일 계정/Entity 재시도는 원래 개인 ID·제목·메모·즐겨찾기·버전을 반환하고 새 기본값으로 덮어쓰지 않습니다. 변한 관찰은 `snapshot_changed`로 거절하여 새 상세 확인을 요구합니다. 새로 확인한 트랙 목록이 기존 채택과 다르면 `review_required`이며 기존 Track UUID와 채택 순서를 유지합니다. 부분적으로 비슷한 행을 자동 대응하지 않습니다.

모든 응답에 `Cache-Control: no-store`를 적용합니다. 처리 응답은 `Vary: Cookie, X-LoopShelf-Session`을 사용하며 성공에만 마지막 저장 인증의 사용자/세션 헤더를 붙입니다. 내부 `authenticated` 필드는 본문에 노출하지 않습니다. 실패 본문은 `{ code }`이며 일부 저장 결과·보유 상세·다른 계정의 내용은 보내지 않습니다.

| HTTP | 코드/의미 |
| --- | --- |
| 200 / 201 | 기존 개인 항목 / 새 개인 저장 |
| 400 | invalid_input 또는 JSON/Host 오류 |
| 401 / 428 | unauthorized·session_changed / session_required |
| 403 / 413 / 415 | Origin 오류 / 본문 초과 / JSON Content-Type 오류 |
| 409 | snapshot_changed·policy_changed·result_expired·refresh_required·content_removed·catalog_unavailable |
| 429 | 공통 rate_limited(Retry-After 포함) 또는 queue_full |
| 408 / 504 | 서비스 cancelled / HTTP save_timeout 또는 서비스 timeout |
| 503 | policy_disabled·storage_unavailable 또는 server_closing |
| 502 / 500 | source_error·invalid_response / database_error 또는 internal_error |

## 요청 예산·인증·커밋

검색·상세·저장은 같은 `createSourceRoutes`의 **실제 연결 IP당 합계 분당 30회·인스턴스당 합계 동시 16개**를 공유합니다. 쿠키/경로를 번갈아 쓰거나 프록시 헤더를 위조해도 한도가 늘지 않습니다. 검색/상세 본문은 기존 4 KiB이며 저장만 32 KiB입니다. 이 제한은 사이트의 허가나 영속 quota를 뜻하지 않으며 재시작/다중 프로세스 제한은 후속입니다.

HTTP의 12초 대기는 최초 인증 DB 큐·서비스·최종 인증 큐를 모두 포함합니다. 초기 실제 인증/조건/입력 검사 뒤 내부 저장 서비스가 쿠키를 다시 확인합니다. 상세를 기다리는 동안 DB 경계를 점유하지 않습니다. 마지막 실제 인증은 쿠키 캐시·세션 갱신 없이 확인하고, 같은 `withDatabase` 경계에서 정책·기한·선택 관찰·제거를 재검사한 뒤 공용 관찰/원래 lease와 개인 저장을 하나의 짧은 동기 트랜잭션으로 반영합니다. 마지막 commit 전 검사나 쓰기가 실패하면 모두 롤백합니다.

읽기 API는 응답 전 재인증하지만, 쓰기는 **commit 직전 인증**의 결과를 사용해 즉시 응답합니다. commit 뒤 다시 비동기 인증을 기다리지 않습니다. 응답 전송은 DB 경계 밖이며 느린 클라이언트가 북마크/다른 DB 작업을 막지 않습니다. 다른 창의 새 로그인만으로 원래 유효 세션이 폐기된다고 가정하지 않습니다. 후속 UI는 응답 헤더와 현재 쿠키의 실제 세션을 재확인한 뒤 개인 결과를 표시해야 합니다.

정상 POST 본문 수신 완료를 취소로 처리하지 않습니다. 연결 종료·서버 종료·시간 제한은 소스 대기와 DB 큐를 취소하며 늦은 응답은 쓰지 않습니다. 이미 commit한 뒤 응답이 유실되면 저장은 남을 수 있습니다. 오류/취소를 미저장의 증거로 해석하지 말고 선반/상세를 확인한 뒤 명시적으로 재시도합니다. 자동 재전송이나 별도 요청 UUID 영수증은 없습니다. 개인 항목을 삭제한 뒤 다시 저장하면 새 개인 ID가 생깁니다. 동기 SQLite·네트워크 전송을 선점하거나 이미 끝난 commit을 취소하는 보장은 아닙니다.

## 검증과 다음 단계

`tests/source-save-api.test.ts`의 **23개** 검사는 제품 비활성·입력/Origin/실제 세션·32 KiB·공통 횟수/동시 한도, 사전확인·변경 관찰·stale/만료, 두 계정/중복 보존·트랙 검토, 대기 중 로그아웃/만료/비밀번호 재설정·독립 로그인, 정책 철회/제거·원자적 롤백, 최초/최종 인증 대기 timeout·서버 종료·실제 loopback 연결 종료와 commit 후 응답 유실을 검증합니다. 인증은 우회하지 않고 테스트 내부 서비스만 합성 자료로 교체합니다.

strict 타입 검사·빌드와 전체 Node **384개**가 통과했습니다. 공통 HTTP 경계 변경 후 기존 브라우저 **15개 시나리오**도 통과했습니다. 새 React 저장 UI의 검증은 포함하지 않습니다. 스키마/인증 패키지·운영 DB/계정·실사이트 정책은 변경하지 않았고 외부 사이트 요청도 없습니다. 다음 단계는 React 상세의 명시적 저장 확인·응답 유실 후 재조회·현재 세션 재확인 화면입니다. 실제 연동 활성화는 허용 근거와 live 저장/공개 조회 검증을 완료한 뒤 별도로 결정합니다.
