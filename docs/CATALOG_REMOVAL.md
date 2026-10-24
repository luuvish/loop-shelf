# 카탈로그 콘텐츠 제거와 식별자 보존

구현·검증일: **2026-10-22**. 합성 자료로 만든 소스별 임시 앨범에 대한 제거 서비스입니다. 실제 수집·공용 검색·앨범 화면은 아직 없으며 KHInsider·Zophar 자동 수집은 계속 `policy_disabled`입니다. 실제 권리자 요청을 처리하거나 운영 DB의 콘텐츠를 제거한 것은 아닙니다.

## 호출과 권한

서버 내부의 `CatalogStore.removeSource({ sourceEntityId, reason })`와 로컬 운영자 CLI를 제공합니다. `reason`은 `rights_request` 또는 `policy_change`만 허용합니다. 임의 사용자 ID나 자유 형식 요청 사유·이메일을 저장하지 않습니다. ID는 `ingestSynthetic` 결과 또는 `getAlbum`의 **sourceEntityId UUID**이며 Album ID나 URL을 대신 입력하지 않습니다.

```sh
npm run catalog:remove -- --source-entity-id '<SOURCE_ENTITY_UUID>' --reason rights_request
```

`.env` 또는 환경변수의 `DATABASE_PATH`가 대상입니다. 기존 DB와 최신 `0011_source_metadata_cache.sql`이 필요하며 명령이 DB를 새로 만들거나 마이그레이션하지 않습니다. 운영자는 대상 경로·소스 ID를 확인하고 서버를 정상 종료한 뒤 실행합니다. CLI는 DB 파일 접근 권한을 가진 운영자만 사용하며, 사용자 로그인으로 호출하는 HTTP API나 개인 북마크 삭제 경로에 연결하지 않습니다.

성공 시 종료 코드 0과 `{ sourceEntityId, albumId, reason, removedAt, removed }` JSON을 출력합니다. 같은 소스에 다시 실행하면 최초 사유·시각을 유지하고 `removed: false`를 반환합니다. 실패는 종료 코드 1과 오류 코드/설명을 출력합니다. 출력에 제목·메모·원문 URL을 복제하지 않습니다. 이 영수증은 제거 이력을 과거 백업 밖에서도 추적할 수 있도록 별도 운영 기록에 보관합니다.

## 제거 범위와 남기는 데이터

| 대상 | 처리 |
| --- | --- |
| 해당 SourceEntity의 모든 관찰 | 검색/상세 DTO, 주장, 경고, 검색 범위, 관찰 해시와 시각, 검토 대기 목록까지 삭제 |
| Assertion·관찰 포인터·트랙 원본 연결·채택 이력 | 해당 소스의 주장, `catalog_album_state`, `catalog_track_origin`, `catalog_track_binding`, `catalog_track_adoption` 삭제 |
| 원래 메타데이터 | 앨범/트랙 제목을 공통 제거 안내로 대체. 날짜·종류·카탈로그 번호·디스크/표시 번호·길이·녹음 참조를 null로 정리 |
| 이전 URL과 수집 정보 | URL 변경 이력 삭제, SourceEntity의 fetchedAt/parserVersion 제거 |
| 정규화 메타데이터 캐시 | 0011부터 해당 소스 앨범 상세와 그 소스의 모든 검색 캐시를 같은 트랜잭션에서 삭제. 다른 소스는 유지 |
| 안정 식별자 | Entity·Album·Track·SourceEntity UUID 유지. 소스 ID/종류/원본 키/현재 페이지 URL, Track의 앨범 소속과 내부 position, Entity 생성 시각 유지 |
| 제거 상태 | Entity는 unavailable, SourceEntity는 removed. 별도 `catalog_removal`에 소스/앨범 ID·사유·시각 유지 |
| 개인 내용 | LibraryItem UUID·수정 버전·직접 쓴 제목·메모·즐겨찾기·직접 북마크·개인 출처 연결을 그대로 유지 |

사용자가 직접 입력한 내용은 같은 문구나 URL을 포함해도 자동으로 지우지 않습니다. 카탈로그 자료는 개인 북마크 FTS·JSON 이식·PWA 캐시에 들어가지 않으므로 이 경로의 개인 기록을 함께 삭제하지 않습니다. 현재 남기는 키·페이지 URL·구조적 식별 정보까지 제거해야 하는 요청은 이 명령의 범위를 벗어나며 별도 검토가 필요합니다.

`getAlbum`은 같은 ID로 `contentState: removed`, 공통 안내 제목, `tracks: []`, null 관찰 포인터와 제거 영수증을 반환합니다. 보존한 Track 행의 원래 제목/목록을 조회 결과에 되살리지 않습니다. 삭제한 `getObservation`은 `not_found`입니다. SourceEntity의 availability만 수동으로 바꾼 것은 콘텐츠 제거 완료를 뜻하지 않습니다.

[카탈로그 개인 API](CATALOG_LIBRARY.md)도 기존 저장 UUID·직접 지정한 제목·메모·즐겨찾기·출처 연결을 유지하고, 파생된 원본 제목과 길이/순서는 공통 안내/null로 반환합니다. 연결된 다른 앨범이 제거되어도 그 출처의 원래 제목을 검색으로 되살리지 않습니다. 기존 개인 항목은 편집·삭제·출처 해제가 가능하지만 제거된 자료의 새 저장/연결은 거절합니다.

트랙 목록을 명시적으로 채택한 경우도 현재·누락 트랙 전체에 같은 제거 규칙을 적용합니다. 이전 대응과 요청 영수증까지 삭제하고, 과거 성공 요청의 재시도 역시 `source_suppressed`로 거절합니다. [트랙 채택과 제거 통합](TRACK_ADOPTION.md)

## 원자성·재노출 차단·충돌

`withDatabase` 경계와 한 immediate 트랜잭션 안에서 사전 검사 → 영수증 → 자료 제거 → 상태 변경을 수행합니다. 중간 실패는 영수증을 포함해 전부 롤백합니다. 재시도·동시 요청은 같은 소스 ID로 수렴합니다. 이미 제거한 소스 키는 과거 DTO 재시도와 새 관찰 모두 `source_suppressed`로 거절하며 새 Album UUID로 다시 만들지 않습니다.

SQL 제약은 제거 영수증의 수정/삭제, 소스 정체성 변경/재활성화, 관찰·채택값·주장·URL 이력 재입력, 기존 트랙 ID 삭제를 막습니다. 앱에 제거 취소 경로는 없습니다. 이는 현재 DB의 정확한 `(sourceId, externalKind, externalKey)`에 대한 억제입니다. 다른 URL 키·별칭·다른 사이트에 있는 같은 음악을 추측해 차단하지 않으며 소스 전체 차단이나 후속 통합 검색 계층의 제거를 대신하지 않습니다. 0011의 캐시 정리와 Adapter 읽기/쓰기/실패 대체 시 제거 검사는 [캐시 계약](SOURCE_ADAPTERS.md)을 따릅니다. 진행 중이던 응답에 제거된 앨범이 포함되어도 저장하거나 제공하지 않습니다.

| 오류 | 의미 |
| --- | --- |
| `invalid_input` | UUID·사유 또는 strict 요청 구조가 잘못됨 |
| `not_found` | 해당 SourceEntity가 없음 |
| `unmanaged_source` | 이 저장 서비스가 관리하는 임시 앨범이 아님 |
| `removal_conflict` | 다른 소스 매핑, 관찰 근거 없는/수동 주장, 이 서비스가 채택하지 않는 앨범 필드, 게임/녹음 관계 또는 관리되지 않는 트랙이 있음 |

공유·수동 자료는 삭제할 소유 범위를 추측하지 않고 전체 작업을 거절합니다. 이 경우 명시적인 provenance 검토가 필요하며 에러를 무시하거나 제약을 해제하는 방법으로 진행하지 않습니다. 파싱 실패·403·404나 검색 0건이 제거 명령을 자동으로 실행하지 않습니다.

## 백업·복구의 경계

이 기능은 **현재 DB의 논리적 콘텐츠 제거**입니다. 과거 백업, SQLite 파일의 미사용 페이지·WAL, 디스크 잔존 데이터의 물리적 소거까지 보장하지 않습니다. 기존 파일을 자동 덮어쓰거나 지우지 않으며 보관/폐기 정책은 별도입니다. 제거 전의 자동 마이그레이션 백업에도 과거 자료가 있을 수 있습니다.

제거 후 백업에는 제거 영수증과 최소 행이 포함되어 복원·재시작 후에도 같은 소스의 재적재를 거절합니다. **제거 전 백업에는 이후 제거 결정이 없습니다.** 그런 백업을 새 경로에 복원하면 현재 코드로 마이그레이션한 후 별도로 보관한 제거 기록의 sourceEntityId/사유를 재적용하고, 제거 상태를 확인한 뒤 서버를 시작합니다. 반복 명령은 안전하지만 과거 백업에 아예 없는 ID는 `not_found`이므로 성공으로 기록하지 않습니다. 현재 restore 명령이 외부 제거 이력을 자동 합치는 기능은 없습니다. [전체 복구 절차](OPERATIONS.md#새-db-경로로-복구)

## 검증

`tests/catalog-removal.test.ts`의 10개 테스트에서 검색 전용/상세/검토 대기 관찰 제거, 두 사용자의 원래 ID·내용·연결 보존, 다른 앨범 보존, 재적재·SQL 재노출 거절, 잘못된 입력·공유 관계 충돌, 중간 실패 전체 롤백, 동시 요청 직렬화, 0006 → 0007 업그레이드, 재시작·제거 후 백업 복원, 실제 CLI의 재시도와 출력 범위를 확인했습니다. 임시 DB와 합성 fixture만 사용합니다.

## 보관 기한과의 구분

[0012 보관 수명](CATALOG_RETENTION.md)의 expired/policy_revoked는 관찰 내용을 지우되 ID와 채택 포인터를 남기므로 새 관찰을 받을 수 있습니다. 본 문서의 영구 제거는 계속 같은 소스 키의 재적재를 차단합니다. 보관 만료 후에도 영구 제거를 적용할 수 있으며 `catalog_source_kind`는 제거 이후에도 남습니다.
