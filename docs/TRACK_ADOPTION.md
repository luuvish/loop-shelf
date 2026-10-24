# 변경된 트랙 목록의 명시적 대응·채택

구현·검증일: **2026-10-22**. 합성 카탈로그의 `review_required` 목록을 운영자가 검토하고 채택하는 로컬 서비스입니다. 자동 매칭, 실제 수집, 사용자용 HTTP API·검토 화면은 포함하지 않습니다. 사용자 개인 출처 연결과 다른 공용 카탈로그 관리 작업이며, 녹음·작품의 동일성을 확정하지 않습니다.

## 운영 명령

현재 DB 경로를 확인하고 서버를 정상 종료한 뒤 최신 `0009_catalog_library_links.sql`까지 마이그레이션합니다. CLI는 `.env`/환경변수의 `DATABASE_PATH`를 사용하며 기존 DB 파일 접근 권한이 있는 운영자만 실행합니다. 명령이 fixture를 자동 적재하거나 외부 사이트를 호출하지 않습니다.

```sh
npm run catalog:review -- --album-id '<ALBUM_UUID>'
npm run catalog:adopt -- --input .local/track-plan.json
```

`review`는 읽기 전용입니다. 한 SQLite 읽기 스냅샷에서 현재 채택 관찰 ID, 최신 상세 관찰 ID, 기존 트랙 ID·현재 위치·보존된 누락 트랙과 새 관찰의 전체 행을 반환합니다. 대응 후보를 자동 지정하지 않습니다. 현재 목록의 `currentPosition`은 1부터 시작하고, 이전에 빠져 보존 중인 트랙은 null입니다. 원본 표시 번호는 반복될 수 있으므로 행 위치와 구분합니다.

`track-plan.json`은 다음 필드만 받습니다. 아래 UUID 표시는 실제 검토 결과로 바꿔야 합니다.

```json
{
  "requestId": "<새 요청 UUID>",
  "albumId": "<review.albumId>",
  "expectedTracksObservationId": "<review.expectedTracksObservationId>",
  "observationId": "<review.observationId>",
  "assignments": [
    { "position": 1, "trackId": "<명시적으로 대응한 기존 Track UUID>" },
    { "position": 2, "trackId": null }
  ],
  "missingTrackIds": ["<현재 목록에서 빠지는 Track UUID>"]
}
```

예시는 새 목록이 2행인 경우입니다. 실제 요청에는 새 목록의 **모든 행을 1부터 순서대로** 넣습니다. `trackId: null`은 별도 트랙 ID 생성을 명시한 것이며, 제목·길이가 같아도 기존 ID를 추측해 재사용하지 않습니다. 기존 ID는 해당 앨범의 관리되는 트랙만 허용하고 한 ID를 두 행에 배정하지 않습니다. 누락되어 보존 중인 ID도 명시적으로 재선택할 수 있습니다.

현재 채택 목록에서 재사용하지 않는 ID는 모두 `missingTrackIds`에 명시합니다. 재사용·누락의 중복, 빠진 ID, 다른 앨범의 ID, 중복 위치·부분 목록은 거절합니다. 요청은 최대 1 MiB, 새 목록과 누락 ID 각각 최대 5,000개이며 userId·임의 제목/길이 등의 추가 필드는 받지 않습니다. 실제 채택 값은 저장된 관찰에서만 가져옵니다.

성공은 종료 코드 0과 영수증 JSON입니다. 영수증에는 요청/앨범/소스/관찰 ID·채택 시각·각 위치의 결과 Track ID·신규 생성 여부·누락 ID·`applied`를 반환하고 제목·메모를 복제하지 않습니다. 읽기용 `review` 출력에는 검토에 필요한 합성 메타데이터가 포함됩니다. 파일·검토 출력은 공개 디렉터리나 저장소에 넣지 않습니다.

## ID와 수록 순서

`0008`은 기존 Track UUID와 첫 출처를 변경하지 않고 다음 테이블을 추가합니다.

- `catalog_track_binding`: 채택한 관찰의 `(observation_id, position)`과 Track UUID의 대응. 같은 관찰에 같은 ID를 두 번 배정하지 않으며, 과거 대응도 보존합니다.
- `catalog_track_adoption`: 요청 UUID·입력 해시·이전/새 관찰 ID·결과 영수증·채택 시각. 명시적 운영자 판단과 원본의 주장을 구분합니다.

기존 `track.position`은 앨범 내 **내부 할당 순번**으로 남겨 누락 ID와 충돌 없이 보존합니다. 새 트랙은 마지막 할당 순번 다음을 사용합니다. 현재 수록 순서를 읽을 때는 `catalog_album_state.tracks_observation_id`의 binding을 사용해야 하며 raw `track.position`으로 정렬하지 않습니다. `getAlbum().tracks[].position`은 이 현재 수록 위치입니다. 0007의 첫 목록은 마이그레이션에서 기존 ID/위치 그대로 binding으로 옮깁니다.

선택한 기존 트랙은 ID를 유지하며 제목·표시 번호·길이 등 채택값과 해당 관찰의 Assertion을 갱신/추가합니다. `catalog_track_origin`의 최초 관찰/locator는 바꾸지 않습니다. 조회의 `originObservationId`/`snapshotLocator`는 첫 근거, `adoptedObservationId`/`adoptedSnapshotLocator`는 현재 목록의 근거입니다.

누락 트랙은 삭제하지 않습니다. 원래 ID·마지막 메타데이터·근거를 보존하고 lifecycle을 unavailable로 바꿉니다. 현재 앨범 목록에서는 제외하되 이후 검토의 기존 ID 목록에 남깁니다. 재선택하면 같은 ID를 active로 복귀시킵니다. LibraryItem·사용자 제목·메모·즐겨찾기·버전·개인 연결은 어느 경우에도 수정하지 않습니다. 저장한 카탈로그 화면은 누락한 개인 항목의 ID·메모를 유지해 표시하고 현재 순서는 binding에서 읽습니다. 운영자의 트랙 대응 검토 화면은 후속 범위입니다.

## 오래된 요청·재시도·충돌

채택은 연결별 `withDatabase`와 한 immediate 트랜잭션에서 실행합니다. 현재 채택 관찰과 최신 상세 관찰이 요청의 두 ID와 정확히 같아야 합니다. 새 상세가 도착하거나 다른 검토가 먼저 채택되면 `stale_review`로 거절하고 다시 검토합니다. 검색 요약만 추가된 것은 트랙 검토를 무효화하지 않습니다.

같은 requestId와 같은 내용의 재시도는 최초 영수증에 `applied: false`를 반환하고 UUID를 추가하지 않습니다. 이후 다른 목록이 채택되었어도 과거 성공을 보고할 뿐 현재 목록을 되돌리지 않습니다. 같은 requestId의 다른 내용은 `adoption_conflict`입니다. 이미 채택값과 같은 목록에는 `review_not_required`를 반환하며, 현재 관찰에 다른 매핑을 덮어쓰는 기능은 제공하지 않습니다. 같은 목록으로 돌아오는 새 관찰도 별도 ID 대응을 자동 추측하지 않습니다.

다른 소스의 전역 매핑, 수동/관찰 근거 없는 트랙 주장, Recording 연결, 관리되지 않는 트랙이 있으면 provenance 검토가 필요하므로 `adoption_conflict`로 전체 작업을 거절합니다. 자동 병합·분할이나 다른 앨범으로의 이동은 지원하지 않습니다. 존재하지 않는 앨범은 `not_found`, 잘못된 요청 구조는 `invalid_input`, 불완전·모순된 대응은 `invalid_mapping`입니다.

중간 실패는 신규 Entity·Track·binding·Assertion·채택 포인터·영수증까지 전부 롤백합니다. 관찰/제거된 소스의 과거 요청도 별도 예외로 살리지 않습니다. blocked/not_found/removed 소스는 `source_suppressed`이며 제거 영수증이 있으면 검토·재시도·채택 모두 거절합니다.

## 콘텐츠 제거·복구

소스 콘텐츠 제거는 현재·누락 트랙 전체에 적용됩니다. 해당 소스의 binding 이력과 채택 영수증도 관찰과 함께 제거하되 Track·LibraryItem ID는 유지합니다. [제거 계약](CATALOG_REMOVAL.md)

전체 DB 백업은 채택 결과·누락 트랙·영수증을 포함합니다. 새 경로 복원과 재시작 후 ID·현재 목록·재시도 결과를 유지합니다. 제거 전 백업의 복원에는 이후 제거 결정을 재적용해야 하며, 과거 매핑 이력이 콘텐츠 제거를 무효화하지 않습니다. [운영 절차](OPERATIONS.md)

## 검증 범위

`tests/catalog-adoption.test.ts`의 13개 테스트에서 읽기 전용 검토, 순서/추가/누락/재등장, 같은 값의 별도 행, 두 계정의 개인 내용 보존, 오래된 검토·재시도·새 관찰, 잘못된 매핑·공유 관계 충돌, 중간 실패 전체 롤백, 동시 요청 직렬화, SQL 제약, 제거 통합, 0007 → 0008 업그레이드·백업 복원·실제 CLI를 검증했습니다. 합성 fixture와 임시 DB만 사용했으며 실제 음악 동일성 판단, 운영 DB 변경, 대규모 성능은 검증하지 않았습니다.

## 만료된 baseline

[보관 수명](CATALOG_RETENTION.md)에 따라 지워진 baseline은 새 목록과 해시가 같아도 자동 대응하지 않습니다. 신선한 상세가 생기면 모든 현재/누락 ID를 다시 명시적으로 선택해야 합니다. 최초 관찰 ID는 유지하되 만료된 DOM locator는 트랙 UUID로 정리합니다. 최신 상세가 만료된 검토와 만료된 대상의 채택 재시도는 거절하며, 오래된 최초 근거의 만료가 새 채택 메타데이터를 지우지는 않습니다.
