# 소스 독립 카탈로그 저장 계약

갱신일: **2026-10-25**. `src/catalog/`는 네트워크 없이 파서 DTO를 SQLite의 Album·Track·SourceEntity와 관찰 기록으로 저장합니다. **합성 fixture 전용 저장 서비스**이며 수집/운영 HTTP API는 없습니다. 관리 중인 합성 자료의 인증된 탐색·앨범/곡 저장·출처 선택은 [별도 읽기 API와 UI](CATALOG_BROWSE.md)에서 제공합니다. 기존 관리 항목의 계정별 저장·메모·출처 연결은 별도 [개인 API](CATALOG_LIBRARY.md)로 제공합니다. 실제 소스 수집·캐시·표시 허가는 계속 미확인입니다.

## 진입점과 범위

`new CatalogStore(db)`의 공개 메서드는 다음과 같습니다. 초기화·마이그레이션된 연결을 전달합니다.

| 메서드 | 동작 |
| --- | --- |
| `ingestSyntheticInTransaction(result)` | 내부 합성 조합 전용. 호출자가 withDatabase와 동기 트랜잭션을 소유해야 하며 개인 저장과 함께 롤백 가능. HTTP 공개 메서드 아님 |
| `ingestSynthetic(result)` | 성공한 검색/상세 ParseResult를 검증하고 페이지 전체를 원자적으로 저장. 앨범마다 ID·관찰 ID·`applied / duplicate / historical` 반환 |
| `getAlbum(albumId)` | 채택한 제목·현재 트랙 목록·원본 키·관찰 포인터·트랙 검토 상태 반환. 고정된 `sampleKind`, `identity: source-provisional` 표시. 만료/정책 정리 후 조회 |
| `getObservation(observationId)` | 해당 관찰의 정규화 DTO·provenance·경고·검색 페이지의 범위 정보 반환 |
| `removeSource({ sourceEntityId, reason })` | 운영자 전용. 소스 콘텐츠를 원자적으로 제거하고 최소 식별자·개인 내용과 제거 영수증 보존 |
| `getTrackReview(albumId)` | 운영자 전용 읽기 스냅샷. 기존/누락 ID와 최신 상세 행, 두 관찰 사전 조건 반환 |
| `adoptTrackList(plan)` | 운영자가 명시한 전체 위치/ID 대응과 누락 목록을 원자적으로 채택. 요청 UUID로 재시도 처리 |

비동기 공개 메서드는 연결별 `withDatabase` 경계를 스스로 사용하므로 같은 연결의 `withDatabase` 안에서 다시 호출하지 않습니다. `InTransaction` 동기 조합 메서드는 호출자가 DB 경계와 트랜잭션을 소유해야 합니다. [소스 저장 내부 흐름](SOURCE_SAVE.md)은 원래 승인 수명을 함께 기록하는 `ingestRetainedAlbumInTransaction`을 사용하며, 기존 합성 fixture 경로와 관찰/채택 규칙을 유지합니다. 저장·제거는 짧은 동기 immediate 트랜잭션이며 내부에서 네트워크/Promise를 기다리지 않습니다. 생성자나 앱 시작에서 fixture를 자동 적재하지 않습니다.

`sampleKind: live-capture`는 `policy_disabled`, 실패한 파서 결과는 `parse_failure`로 거절합니다. 합성 입력이라는 표시가 실사이트의 이용 허가가 되지는 않습니다. 실제 적재를 켜려면 기능별 정책 검사·보관/삭제·운영 캐시 경로와 합성 자료 격리를 별도로 구현해야 합니다. 0012 SQL은 자료 종류 고정과 live 기한을 표현하지만 기존 ingestSynthetic 입력은 계속 합성 전용입니다. 개인/운영 조회 DTO는 실제 고정 자료 종류를 보존합니다. live를 자동 승격하거나 합성으로 반환하지 않습니다. [보관 수명 계약](CATALOG_RETENTION.md)을 참고합니다.

## 정체성과 채택한 값

동일 `(sourceId, album, externalKey)`는 동일 SourceEntity·Album UUID를 사용합니다. 다른 플랫폼 키, 다른 소스, 다른 앨범 키는 제목이 같아도 별도 UUID입니다. 기존에 이 서비스 밖에서 만든 SourceEntity 매핑은 `unmanaged_source`로 거절하고 자동으로 재지정하지 않습니다. 관리 중인 source의 소스 ID·원본 키·대상 Entity는 SQL에서도 변경을 금지합니다.

검색 표시명은 `source-display-label` 상태를 유지합니다. 상세를 한 번 확보하면 이후 검색 표시명이 상세 제목을 덮어쓰지 않습니다. 검색과 상세 각각의 최신 관찰은 **capturedAt** 순서로 선택하며, 처리 완료 순서나 parsedAt을 최신 기준으로 삼지 않습니다. 늦게 도착한 과거 자료는 근거로 보관하지만 현재 값을 되돌리지 않습니다. 같은 소스·종류·capturedAt에 서로 다른 앨범 DTO가 들어오면 과거 관찰도 포함해 `observation_conflict`로 거절합니다.

원본 키가 URL 경로에서 바뀌면 새 소스 레코드로 취급합니다. 제목으로 이전 항목을 찾아 합치거나 URL 별칭으로 확정하지 않습니다. 기존 ID와 개인 저장은 남으며 명시적 URL 이전·별칭 검토는 후속 기능입니다.

날짜 원문, 플랫폼, 분류, 개발사 등의 주장은 관찰 기록과 Assertion에 남깁니다. 원문 연도를 확정 발매일로 바꾸거나 게임·작곡·녹음 관계를 추측하지 않습니다. Album의 `release_date / album_kind / catalog_number`와 Track의 `recording_id / disc_label`은 확인 근거가 없으면 null입니다. 음악 파일·Resource는 만들지 않습니다.

## 안정 키가 없는 트랙

현재 KHInsider·Zophar DTO의 `SourceTrack.externalKey`는 null입니다. 첫 상세 목록에는 각 수록 위치를 표현하는 별도의 Track UUID를 부여하고 원래 관찰 ID·문서 내 locator를 보관합니다. 표시 번호가 반복되거나 모든 값이 같은 행이 여러 개여도 서로 다른 UUID입니다. locator나 오디오 URL을 전역 식별자로 사용하지 않습니다.

| `trackState` | 의미 / 저장 동작 |
| --- | --- |
| `not_loaded` | 검색 요약만 있고 채택한 상세 목록 없음 |
| `unchanged` | 최신 상세의 순서·제목·표시 번호·길이 원문/값 등이 현재 채택 목록과 모두 같음. 기존 UUID 유지 |
| `review_required` | 최신 상세 목록이 다름. 새 관찰 전체를 보관하고 기존 Track 행·UUID·개인 저장은 변경하지 않음 |
| `removed` | 운영자가 콘텐츠를 제거함. 조회는 공통 안내 제목·빈 트랙 목록·null 관찰 포인터와 제거 영수증 반환 |

비교에서 문서 내 `snapshotLocator`만 제외합니다. DOM locator가 바뀌었다는 이유로 내부 UUID를 재발급하지 않습니다. 순서·추가·누락·제목·길이·표시 번호가 달라지면 부분적으로 비슷한 행도 자동 연결하지 않습니다. `latestDetailObservationId`로 새 목록을, `tracksObservationId`로 현재 목록의 근거를 읽을 수 있습니다. `getAlbum().tracks`는 검토 대기 중에도 **기존 채택 목록**이므로 상태와 함께 사용해야 합니다.

`unchanged`는 관찰값이 같다는 뜻이며 실제 녹음의 동일성을 확정하지 않습니다. 구별할 수 없는 동일 행의 교환은 감지할 수 없습니다. 새 관찰이 현재 채택 목록과 다시 같아지면 차이 상태는 해제되지만, 관찰 이력은 남습니다. 사용자용 검토 UI·안정 원본 키를 가진 트랙 경로는 후속 기능입니다.

명시적 채택은 운영자 CLI `catalog:review`/`catalog:adopt`로 제공합니다. 새 목록의 모든 위치에 기존 Track ID 또는 신규 생성을 지정하고 누락되는 현재 ID도 명시합니다. 같은 제목·번호·길이로 대응을 추측하지 않습니다. 누락 ID는 마지막 값과 개인 저장을 유지하며 이후 명시적으로 재선택할 수 있습니다. 오래된 검토·잘못된 매핑·공유 관계는 거절하고 모든 변경을 롤백합니다. [입력 JSON·재시도·충돌 계약](TRACK_ADOPTION.md)

`0008_catalog_track_adoptions.sql`은 `catalog_track_binding`과 `catalog_track_adoption`을 추가합니다. `track.position`은 보존용 내부 할당 순번이며 현재 수록 순서는 state의 채택 관찰에 속한 binding에서 읽습니다. 최초 origin/locator를 유지하고 현재 채택의 근거는 `adoptedObservationId`/`adoptedSnapshotLocator`로 구분합니다. 이력은 소스 콘텐츠 제거 시 함께 지웁니다.

## 관찰과 재시도

`0006_catalog_observations.sql`은 다음을 추가합니다. 이전 마이그레이션은 변경하지 않습니다.

- `catalog_observation`: source, 종류, 정규화 DTO, 페이지 URL, 수집/파싱 시각, 파서 버전, 제공받은 원문 SHA-256, DTO/트랙 해시, 합성 구분, 경고. 검색 관찰에는 reportedCount·coverage·nextPageUrl·resultLimit도 보관합니다. 이것은 해당 검색 페이지의 주장이고 전체 사이트의 완전성을 뜻하지 않습니다.
- `catalog_album_state`: 각 앨범의 최신 요약/상세·전체 관찰·채택한 제목·트랙 목록 포인터. 첫 상세에서 설정하며 이후 명시적 채택으로 변경합니다. 복합 FK로 다른 소스의 관찰을 붙이지 못하게 합니다.
- `catalog_track_origin`: Track UUID와 첫 관찰의 문서 내 locator 관계. 해당 앨범의 목록이어야 합니다.
- `assertion.observation_id`: 원문 주장과 해당 관찰의 연결. Assertion의 소스·대상 Album/Track이 일치해야 합니다.

같은 정규화 내용·수집 시각·페이지/파서/원문 해시·경고·검색 범위의 재입력은 같은 관찰 ID를 반환합니다. parsedAt만 달라진 재파싱은 중복을 만들지 않으며 먼저 저장한 파싱 시각을 유지합니다. 나중 시각에 같은 목록을 관찰한 것은 새로운 근거입니다. 기존 관찰은 적재 과정에서 수정하거나 삭제하지 않습니다. 명시적 운영자 제거는 해당 소스의 과거 관찰까지 삭제합니다. HTML·스크립트·오디오 본문은 저장하지 않습니다.

현재 성공 저장 범위는 합성 개발 자료입니다. 소스별 콘텐츠 제거와 0012의 관찰 보관 기한 검사를 구현했습니다. 전체 보관량 제한·공유 자료의 제거 판단·URL 별칭은 후속 범위이며 영구적인 실사이트 캐시로 사용하지 않습니다. `0007_catalog_removals.sql`의 영수증과 최소 식별자를 남겨 삭제한 관찰의 재적재를 막습니다. [제거 범위·충돌·운영 명령·과거 백업 처리](CATALOG_REMOVAL.md)

## 오류와 보호

입력은 UTF-8 JSON 기준 8 MiB, 검색 앨범 1,000개, 상세 트랙 5,000개, 원문 주장·경고 각 100개까지입니다. strict DTO 검증, URL/원본 키/소스/페이지 종류 일치, 연속 position·유일한 문서 내 locator를 검사합니다. 빈 상세 목록은 실패이며, 검색 0건은 기존 카탈로그를 삭제하지 않습니다. 개인 userId·원문 HTML 등의 추가 필드는 받지 않습니다.

실패한 파싱, 차단 응답, 잘못된 DTO는 마지막 정상 자료를 바꾸지 않습니다. 기존 SourceEntity가 blocked/not_found/removed 상태이거나 제거 영수증이 있으면 `source_suppressed`로 거절하고 자동으로 되살리지 않습니다. availability 변경만으로 자료가 제거되지는 않으며, 콘텐츠 제거에는 별도 `removeSource` 명령을 사용합니다. 그 후 `getAlbum`은 `contentState: removed`, 삭제한 관찰 조회는 `not_found`를 반환합니다.

한 검색 페이지의 일부 저장이나 Assertion/Track 쓰기가 실패하면 Entity·관찰·상태·주장까지 전부 롤백합니다. 저장 서비스는 LibraryItem·사용자 메모·즐겨찾기·직접 북마크·개인 연결을 변경하지 않습니다. 공용 카탈로그는 기존 개인 북마크 검색 인덱스에도 들어가지 않습니다.

## 검증

```sh
node --test tests/catalog.test.ts
node --test tests/catalog-removal.test.ts
node --test tests/catalog-adoption.test.ts
npm run check
```

카탈로그 전용 12개 테스트에서 파서 fixture → 저장/상세 승격, 소스 간 분리, 재시도, 반복 번호·동일 행·0초/미상, 변경 목록 보류, 지연 관찰·동시각 충돌, 잘못된 입력·live 거절, 배치/쓰기 실패 롤백, 연결 큐·동시 재시도, SQL 제약, 개인 저장 보존, 0005 → 0006 업그레이드와 백업 복원을 확인했습니다. 테스트는 메모리 또는 임시 DB만 사용합니다.

추가 제거 테스트 10개는 원자적 제거·개인 내용/ID 보존·재적재 차단·공유 자료 충돌·운영 CLI·0006 → 0007 업그레이드와 제거 후 백업 복원을 검증합니다. 실사이트 통합 검색·앨범/곡 수집과 권리자 대응, 트랙 검토/채택 UI, 대규모 성능은 이번 완료 범위에 포함하지 않습니다.

명시적 채택 테스트 13개에서 순서/추가/누락/재등장, 개인 내용 보존, 오래된 검토·재시도·동시 요청·중간 실패, 잘못된 매핑·공유 관계·제거된 소스 거절, SQL 제약, 제거 통합, 0007 → 0008 업그레이드·백업 복원·실제 CLI를 확인했습니다.

카탈로그 개인/탐색 API 테스트 19개는 실제 로그인 세션의 저장/검색/편집/삭제와 앨범 출처 연결, 누락/제거 후 ID·내용 유지, 다른 계정·공용 카탈로그·북마크/JSON 격리, 동시 요청·롤백·0009 업그레이드·백업 복원, 앨범 탐색/현재 수록곡·계정별 저장 표시·개인 후보 조회·제거/차단 비노출을 확인합니다. [개인 API 계약](CATALOG_LIBRARY.md)

## 승인 수명 연결

`ingestRetainedAlbumInTransaction(input, lease)`는 호출자 소유 동기 트랜잭션에서 검증된 앨범과 원래 policyRevision/expiresAt을 함께 기록합니다. live 입력에는 별도의 고정 제품 정책 검사가 있으며 현재 거절합니다. 합성 자료 종류를 바꾸지 않고 기한 변경 재시도를 거절합니다. [지원 범위·검증](CATALOG_KINDS.md)
