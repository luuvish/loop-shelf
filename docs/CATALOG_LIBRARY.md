# 카탈로그의 개인 저장과 출처 연결

구현·검증일: **2026-10-24**. 기존 합성 카탈로그의 Album·Track을 계정별로 저장하고 개인 제목·메모·즐겨찾기와 앨범 출처 연결을 관리하는 API입니다. 기존 저장 항목의 React 관리 화면은 [브라우저 사용법](FRONTEND.md#저장한-카탈로그-관리)에 정리했습니다. 인증된 탐색·새 저장·출처 후보 선택도 제공합니다. [탐색 API와 화면 계약](CATALOG_BROWSE.md) 서버 시작 시 fixture를 적재하지 않으며 실제 외부 요청과 음원 재생은 없습니다.

## 정체성과 개인 내용

공용 `entity.id`와 개인 `LibraryItem.id`는 별도 UUID입니다. 같은 Entity를 두 계정이 저장하면 서로 다른 개인 ID를 받습니다. 같은 계정의 중복 저장은 기존 항목을 반환하고 입력한 제목·메모·즐겨찾기를 덮어쓰지 않습니다. URL이나 표시 트랙 번호로 새 정체성을 추측하지 않습니다.

새 저장 대상은 `CatalogStore`가 관리하는 합성 앨범·트랙이며 기존 저장의 제거 영수증도 조회합니다. JSON에서 복원한 원본 미연결 개인 항목은 같은 개인 관리 API로 읽고 편집·삭제합니다. 수동 북마크·다른 종류의 Entity·서비스 밖에서 만든 카탈로그 매핑은 지원하지 않습니다. 응답은 관리 SourceEntity 또는 개인 미연결 참조의 `sampleKind: synthetic | live-capture`와 `identity: source-provisional`을 표시합니다. live 보관 정책은 미확인이므로 기존 참조의 개인 내용/종류를 보존할 뿐 실제 수집을 허용하지 않습니다.

`titleOverride`는 사용자가 직접 지정한 제목이며 기본값은 null입니다. null이면 조회 시 현재 카탈로그 제목으로 `title`을 계산합니다. 원본 제목을 개인 필드에 자동 복사하지 않으므로 제거한 메타데이터가 개인 저장이나 검색 복사본을 통해 다시 나타나지 않습니다. null로 편집하면 직접 지정한 제목을 해제합니다. 사용자가 명시적으로 입력한 제목·메모는 소스 제거 뒤에도 보존합니다.

Track은 내부 UUID로 저장합니다. 응답의 `sourceEntityId`와 페이지 URL은 **소속 앨범의 출처**이며 트랙의 안정 원본 키를 의미하지 않습니다. 현재 수록 순서 `position`은 채택한 `catalog_track_binding`에서 읽고, 누락한 트랙은 null과 `presence: missing`을 반환합니다. 제거한 항목은 `contentState: removed`, `presence: removed`, 공통 안내 제목과 null 길이/순서로 표시합니다. [트랙 대응](TRACK_ADOPTION.md) · [콘텐츠 제거](CATALOG_REMOVAL.md)

JSON 복원에서 원본을 찾지 못한 개인 항목은 `contentState/presence: unresolved`, 길이·순서 null이며 개인 제목이 없으면 `원본 미연결 앨범/트랙`으로 표시합니다. 출처 참조 ID·개인 판단을 유지하며 자동 재연결하지 않습니다.

누락·제거·차단·미연결 상태의 새 출처 연결은 거절하고 누락·제거·차단 원본의 새 저장도 거절합니다. 기존 개인 항목의 조회·편집·삭제·출처 해제는 가능합니다. 이미 저장한 Entity의 재저장은 기존 항목을 그대로 반환합니다. 카탈로그 갱신·누락·제거는 개인 ID·필드·수정 버전을 바꾸지 않습니다.

## 개인 출처 연결

`entity.sourceEntityId`는 원래 카탈로그 provenance입니다. `sourceLinks`는 사용자가 추가한 별도의 판단이며 항상 `relationship: user-asserted`입니다. 연결은 전역 Entity나 SourceEntity의 매핑을 수정하지 않고 다른 계정에도 영향을 주지 않습니다.

- 앨범 저장 항목에 다른 관리 중인 **앨범 SourceEntity**를 연결합니다. 같은 소스 또는 다른 소스의 앨범을 선택할 수 있으며 제목에 따른 자동 연결은 없습니다.
- 원래 출처를 다시 연결하거나 Track에 앨범 출처를 붙이는 요청은 거절합니다. 안정된 트랙 원본 키가 확인되기 전에는 트랙 출처 연결 API를 제공하지 않습니다.
- 추가 연결은 항목당 최대 20개입니다. 원래 provenance는 이 수에 포함하지 않습니다. 한 계정의 같은 SourceEntity는 추가 연결 한 곳에만 사용하며, 옮기려면 먼저 해제해야 합니다.
- 연결 대상 앨범을 별도 LibraryItem으로 저장해 두어도 그 개인 행을 숨기거나 합치지 않습니다. 수동 북마크 그룹의 대표/멤버 동작과 구분합니다. 다른 계정은 같은 출처를 독립적으로 연결할 수 있습니다.
- 연결·해제는 해당 개인 항목의 최신 `version`을 요구합니다. 이미 연결된 곳으로 현재 버전과 함께 재요청하면 변화 없이 반환합니다. 오래된 버전으로 재시도하면 409이므로 먼저 다시 조회합니다.
- 개인 항목을 삭제하면 그 항목의 추가 연결만 함께 지웁니다. 공용 음악과 다른 계정의 저장은 유지합니다. 이 API의 삭제는 204이며 북마크 UI의 60초 복구 대상이 아닙니다. 명시적 삭제 뒤 재저장하면 새 개인 ID를 받습니다.

소스 상세와 직접 연결하는 저장 흐름은 [내부 계약](SOURCE_SAVE.md)과 [인증된 저장 HTTP](SOURCE_SAVE_API.md)로 분리했습니다. 합성 검증에서는 선택 관찰/정책/현재 세션을 재확인한 뒤 카탈로그 적재와 이 저장소의 `create`를 원자적으로 처리합니다. 기존 HTTP 경로는 유지하며 원래 보관 기한도 같은 트랜잭션에 기록합니다. 제품 live 저장은 닫혀 있습니다.

## HTTP 계약

유효한 Better Auth 세션 쿠키가 필요합니다. 서버가 세션에서 소유자를 얻으며 userId 입력·테스트용 우회 인증은 없습니다. 목록·단건·변경·연결 모두 소유권을 검사합니다. 변경 요청은 정확한 Origin을 요구하고 모든 응답은 `no-store`입니다. 선택적인 `X-LoopShelf-Session` 헤더가 현재 쿠키 세션과 다르면 401입니다. UI는 이 사전 조건을 보내 계정 전환 중 초안의 잘못된 저장을 막아야 합니다.

| 메서드 / 경로 | 입력 / 응답 |
| --- | --- |
| `GET /api/library/catalog` | `q`, `kind=album\|track`, `favorite=true\|false`, `limit`, `offset` → `{ items, nextOffset }` |
| `POST /api/library/catalog` | `{ entityId, titleOverride?, note?, favorite? }` → `{ item, created }`, 신규 201 / 기존 200 |
| `GET /api/library/catalog/:id` | 개인 LibraryItem UUID → `CatalogLibraryItem` |
| `PATCH /api/library/catalog/:id` | `{ version, titleOverride?, note?, favorite? }`, 최소 한 편집 필드 → 최신 항목 |
| `DELETE /api/library/catalog/:id` | `{ version }` → 204 |
| `GET /api/library/catalog/:id/source-candidates` | 소유한 앨범의 최신 개인 상태·출처 후보. [별도 조회 계약](CATALOG_BROWSE.md) |
| `GET /api/library/catalog/:id/sources` | `{ itemId, version, sourceLinks }` |
| `POST /api/library/catalog/:id/sources` | `{ version, sourceEntityId }` → 최신 항목 |
| `DELETE /api/library/catalog/:id/sources` | `{ version, sourceEntityId }` → 최신 항목 |

상세 응답 타입은 [src/shared/catalog-library.ts](../src/shared/catalog-library.ts)에 있습니다. `id`, `entity`, 계산된 `title`, `titleOverride`, `note`, `favorite`, `version`, 생성/수정 시각과 `sourceLinks`를 반환합니다. Entity에는 앨범 ID·종류·현재 메타데이터·원래 출처·가용 상태가 포함됩니다. 새 항목의 기본값은 null 제목, 빈 메모, 즐겨찾기 false입니다.

제목은 공백 제거 후 1–300자, 메모는 최대 10,000자, 검색어는 최대 200자입니다. 버전은 양의 안전한 정수이며 알 수 없는 필드는 거절합니다. 목록과 source-candidates 외 개인 경로에는 쿼리를 받지 않습니다. 본문 상한은 기존 32 KiB입니다. 목록은 기본 50개·최대 100개, offset 0–100,000, 생성 시각 내림차순·ID 내림차순입니다.

검색은 내 저장 항목의 직접 지정 제목·메모·현재 카탈로그 제목과 추가 연결된 앨범 제목의 NFKC 리터럴 부분 검색입니다. 한일문·1–2자와 `%`, `_`, 따옴표를 검색 문법으로 해석하지 않습니다. SQLite `instr`로 현재 행을 읽으며 별도 카탈로그 FTS 복사본은 만들지 않습니다. 합성 1만 앨범/10만 트랙·개인 저장 5천 개의 순차 조회 성능은 [별도 조건](CATALOG_PERFORMANCE.md)에서 측정했습니다.

| 응답 | 의미 |
| --- | --- |
| `400 invalid_input` | UUID·필드·필터·버전 형식 오류 |
| `400 invalid_connection` | 원래 출처 재연결, Track에 앨범 출처 연결 등 지원하지 않는 관계 |
| `401 unauthorized / session_changed` | 유효한 로그인 없음 / 보낸 세션 사전 조건 불일치 |
| `403` | 기존 Origin·Host 검사 거절 |
| `404 not_found` | 내 항목·지원하는 카탈로그 대상·해제할 연결 없음. 다른 계정의 존재 여부는 공개하지 않음 |
| `409 conflict` | 오래된 개인 수정 버전 또는 이미 다른 내 항목에 연결된 출처 |
| `409 catalog_unavailable` | 누락·제거·차단 등 새 저장/연결 불가 상태 |
| `409 connection_limit` | 추가 출처 20개 초과 |

## DB와 백업 경계

`src/library/catalog.ts`의 동기 `CatalogLibraryStore`는 HTTP의 `forUser`가 세션 확인부터 작업 완료까지 확보한 `withDatabase` 안에서 실행합니다. 쓰기는 immediate 트랜잭션이며 읽기는 한 스냅샷에서 개인 행·현재 메타데이터·연결을 조립합니다. 네트워크나 Promise를 트랜잭션 안에서 기다리지 않습니다. 편집·연결·해제마다 개인 버전과 수정 시각을 함께 갱신합니다.

`0009_catalog_library_links.sql`은 연결 조회 인덱스·20개 제한·연결/저장 정체성 변경 금지와 `user_source_link_event`를 추가합니다. 연결은 UPDATE 대신 해제/추가로 바꾸며, 기존 복합 FK가 계정 소유권을 검사합니다. 감사 기록은 사용자/개인 항목/소스 ID·행동·시각만 담고 음악 메타데이터·메모·인증 정보를 복사하지 않습니다. 업그레이드는 기존 저장/연결을 바꾸거나 과거 감사 기록을 만들어내지 않습니다. 지원하는 앨범·소스 범위는 서비스에서 검사합니다.

기존 설치는 [운영 절차](OPERATIONS.md)에 따라 서버를 멈추고 `npm run db:migrate`로 0010까지 적용합니다. 서버가 자동으로 마이그레이션하거나 운영 자료를 적재하지 않습니다.

`0010_catalog_transfer.sql`은 원본 미연결 개인 항목과 출처 판단 테이블을 추가합니다. 일반/미연결 저장 간 ID·Entity 중복과 추가 출처 점유를 검사하고 개인 수정 버전 상한·최소 감사 기록을 공유합니다. 미연결 자료의 검색은 개인 필드·안내 제목만 대상으로 하며 공용 음악 메타데이터를 생성하지 않습니다.

**북마크 JSON과 카탈로그 JSON은 별도 파일입니다.** 카탈로그 JSON은 개인 ID·제목·메모·즐겨찾기·최소 참조와 출처 판단을 보존합니다. 원본이 없는 설치에서는 개인 미연결 항목으로 복원합니다. 전체 SQLite 백업/복원에는 일반/미연결 자료가 모두 포함됩니다. [카탈로그 JSON 계약](CATALOG_TRANSFER.md) · [기존 북마크 포맷](DATA_TRANSFER.md)

## 확인한 범위

`tests/catalog-library.test.ts`의 19개 테스트에서 실제 두 계정 로그인으로 탐색·현재 수록곡·개인 후보·저장 표시 격리, CRUD·소유권·Origin·세션 전환, 중복 저장·버전 충돌·개인 출처 연결/해제·20개 제한, 다국어 검색/필터/페이지 이동, 채택 후 현재 위치와 누락, 제거 후 ID/개인 내용 보존과 원래 제목 비노출, 북마크/JSON 격리, 동시 요청·실패 롤백, 0008 → 최신 스키마 업그레이드·재시작·온라인 백업/복원을 확인했습니다.

카탈로그 이식 10개 테스트의 0009→0010 업그레이드·미연결 백업/복원과 검증 범위는 [이식 계약](CATALOG_TRANSFER.md)에 정리합니다.

전체 strict 타입 검사·빌드·Node 테스트 **152개**와 북마크/PWA/복구·카탈로그 관리 브라우저 시나리오 **11개**를 통과했습니다. 합성 자료와 임시 DB를 사용했으며 기존 저장 항목의 데스크톱/모바일 관리 흐름도 검증했습니다. 합성 자료의 탐색 검증은 [탐색 계약](CATALOG_BROWSE.md)에 정리합니다. 실사이트 연동 검증으로 확대하지 않습니다. 성능 전용 3개 테스트와 대규모 합성 측정은 [별도 문서](CATALOG_PERFORMANCE.md)에 기록합니다.

## 보관 종료 항목

0012 보관 만료/철회 뒤에는 `contentState/presence: expired`, 안내 제목과 null 길이/순서를 반환합니다. 개인 ID·내용·수정 버전은 유지하고 수정/해제/삭제할 수 있지만 새 저장/연결은 거절합니다. 동일 개인 저장/연결의 재시도는 원래 개인 내용을 반환합니다. 목록/단건/쓰기 전 보관 검사와 자료 종류 보존은 [보관 계약](CATALOG_RETENTION.md)을 따릅니다.

2026-10-25: 개인 DTO와 JSON v2/v1 호환·서로 다른 종류의 출처 연결 거절·미연결/제거/만료 후 내용 보존은 [자료 종류 계약](CATALOG_KINDS.md)을 따릅니다.
