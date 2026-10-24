# 소스 앨범 상세 서비스·API

2026-10-24. 기존 `getAlbum` Adapter를 상세 조회 서비스와 인증 API에 연결했습니다. **제품의 자동 수집은 계속 비활성**입니다. Zophar의 성공/캐시/수록곡 흐름은 합성 자료로 검증했으며, KHInsider 상세 파서 미지원도 유지합니다. [React 상세/수록곡 화면](SOURCE_ALBUM_UI.md)도 연결했으며 실제 자료의 카탈로그 적재·개인 저장은 후속 범위입니다.

## 요청과 응답

`POST /api/source-album`은 다음처럼 소스와 정확한 앨범 식별명만 받습니다. 아래는 형식 예시이며 실제 앨범의 가용성을 의미하지 않습니다.

```json
{ "sourceId": "zophar", "externalKey": "nintendo-snes-spc/example-album" }
```

- 실제 로그인 쿠키, 앱과 정확히 일치하는 Host/Origin, 현재 세션 ID의 `X-LoopShelf-Session` 조건을 요구합니다. 조건 헤더만으로 인증하거나 사용자를 선택할 수 없습니다.
- JSON 본문은 4 KiB 이하입니다. `sourceId`는 `khinsider | zophar`, `externalKey`는 1–1,024자입니다. 키의 유니코드·공백은 보존하며 제목이나 URL로 다시 매칭하지 않습니다.
- KHInsider는 앨범 slug 한 부분, Zophar는 시스템/앨범 두 부분을 받습니다. 전송 계층의 고정 주소 생성·검증을 재사용하며 URL·순회 경로·인코딩 우회·제어 문자 등을 거절합니다.
- GET/HEAD/OPTIONS, URL query, 임의 URL·userId·검색 제목·sampleKind·정책/전송 옵션·추가 필드는 받지 않습니다. 검색 후 자동 상세 취득은 없습니다.

HTTP 200은 처리된 결과 봉투이며 상세 성공을 뜻하지 않습니다. `src/shared/source-album.ts`의 구조는 다음과 같습니다.

| 필드 | 의미 |
| --- | --- |
| `ref` | 요청한 sourceId·externalKey·고정 원문 pageUrl. 공용 UUID가 아님 |
| `sampleKind` | 제품은 `live-capture`, 내부 오프라인 검증은 `synthetic` |
| `status` | `complete`, 이전 자료/갱신 실패가 있는 `partial`, 실패 `failed` |
| `termination` | `settled` 또는 시간 예산에 도달한 `deadline` |
| `completedAt`, `elapsedMs` | 마지막 결과 확인 시각과 비동기 처리 경과 |
| `policy` | 수집·캐시·표시의 별도 판단과 revision |
| `result` | 상세 data/provenance/warnings/delivery 또는 code/stage/httpStatus?/retryAt? 실패 |

현재 실제 제품 응답은 두 소스 모두 `status: failed`, `result.code: policy_disabled`입니다. 이를 빈 앨범이나 수록곡 0개로 바꾸지 않습니다. 정책 허용을 주입한 합성 Adapter 계약에서도 KHInsider 상세는 전송 전에 `unsupported`입니다. 접근 차단·페이지 없음·파서 변경·제거·만료도 서로 다른 실패입니다.

성공 상세는 출처의 **앨범 제목**, 원문 주장, 플랫폼, 수록 순서, 반복 가능한 표시 번호, 길이 원문/미확인 값과 취득 근거를 보존합니다. `sourceClaims`는 출처의 주장이고 확인된 게임/발매일 관계로 자동 채택하지 않습니다. Track의 `snapshotLocator`와 `position`은 해당 관찰의 위치이며 안정적인 트랙 ID가 아닙니다. 성공 상세의 빈 트랙 목록, 다른 소스/키/페이지·자료 종류, 임의 ID/음원 URL·잘못된 보관 시각은 거절합니다. `playback: unverified`를 유지합니다.

`delivery.from`, `freshness`, `freshUntil`, `expiresAt`과 `refreshFailure`는 [Adapter 계약](SOURCE_ADAPTERS.md)을 유지합니다. 이전 자료를 반환해도 취득 시각과 만료 기한을 연장하지 않습니다. 캐시 제공만 허용하면 캐시를 사용할 수 있으나 수집 허용 없는 전송 결과는 제공하지 않습니다.

## 인증·수명·제한

`src/server/source-read.ts`는 검색·상세·저장의 공통 HTTP 경계입니다. 세 경로는 **실제 연결 IP당 합계 분당 30회·서버 인스턴스당 합계 동시 16개**를 공유합니다. 경로·쿠키를 번갈아 사용하거나 프록시 IP 헤더를 보내도 한도를 늘리지 못합니다. 인증과 개인 북마크 CRUD의 한도는 별개입니다. 이 제한은 사이트가 허가한 quota가 아니며 재시작/다중 프로세스의 영속 제한은 미구현입니다.

| HTTP | 의미 |
| --- | --- |
| 200 | 상세 결과 봉투. 내부 실패·정책 비활성도 포함 |
| 400 | JSON/입력/query/Host 오류 |
| 401 | 쿠키 없음·만료·폐기 또는 세션 조건 불일치 |
| 403 | Origin 불일치·누락 |
| 413 / 415 | 본문 상한 / JSON Content-Type 위반 |
| 428 | 필수 세션 조건 누락 |
| 429 | 공통 IP 횟수 제한 또는 동시 요청 초과 |
| 503 / 504 | 서버 종료 / 전체 HTTP 대기 `album_timeout` |
| 500 | 내부 예외. 원문 예외·보유한 자료는 비노출 |

모든 응답은 `Cache-Control: no-store`입니다. 처리 응답은 `Vary: Cookie, X-LoopShelf-Session`을 사용합니다. 마지막 인증을 통과한 응답에만 사용자·세션 헤더를 붙입니다. 인증 실패에는 보유한 상세나 사용자/세션 헤더를 보내지 않습니다. 향후 UI는 [검색 화면](SEARCH_UI.md)과 같이 응답 헤더와 현재 쿠키의 실제 세션을 재확인해야 합니다. 다른 창의 새 로그인만으로 이전의 유효한 세션이 폐기된다고 가정하지 않습니다.

HTTP의 12초 대기는 최초/최종 인증 DB 큐와 서비스 대기를 포함합니다. 내부 서비스도 전체 12초, 소스 대기 11초를 적용하며 마지막 DB 검사를 위한 시간을 남깁니다. 네트워크 대기 중 DB 경계를 점유하지 않습니다. 결과 전송 직전 같은 DB 경계에서 실제 세션을 확인하고 동기 `service.recheck`로 정책·만료·제거를 다시 확인합니다. FastifyReply를 DB callback에서 반환하지 않습니다.

정상 POST 본문 수신 완료를 연결 취소로 오인하지 않습니다. 클라이언트 연결 종료/서버 종료/timeout은 해당 구독을 취소하며 늦은 응답을 재검사·전송·캐시 저장에 사용하지 않습니다. 병합된 Adapter 요청에서 한 호출자가 취소해도 다른 구독은 유지됩니다. 마지막 구독자가 취소하면 늦은 자료를 저장하지 않습니다. 동기 JavaScript/SQLite 실행과 HTTP 본문 수신 자체를 선점하는 12초 제한은 아닙니다.

## 구현과 데이터 경계

- `src/source-album.ts`: DB 연결별 제품 서비스. 고정 live Adapter·상세 정책을 사용하며 HTTP/env에서 교체할 수 없습니다.
- `src/source-album/input.ts`: 공통 입력 검증. 임의 URL fetch를 제공하지 않습니다.
- `src/source-album/service.ts`: 내부 합성 의존성 주입 경계, 요청 전 정책/제거 검사, Adapter 응답 검증, 취소/시간 예산과 최종 재검사.
- `src/server/search.ts`: 제품 검색/상세 서비스를 공통 인증 경계에 등록합니다. 검색의 기존 요청/응답 계약은 유지하고 횟수/동시 한도만 상세와 공유합니다.

읽은 상세를 `Album`/`Track`/`SourceEntity`·개인 저장·재생 Resource로 적재하지 않습니다. 개인 북마크·메모·즐겨찾기·저장 여부도 조회하지 않습니다. 정책에 따른 정규화 메타데이터 캐시만 기존 Adapter가 관리합니다. 캐시/표시 허용이 철회되면 해당 소스 캐시를 정리합니다. 제거된 소스 키는 조회 전과 응답 전에 확인하며 원래 개인 ID/내용을 삭제하거나 다시 적재하지 않습니다. 최종 DB 확인에 실패하면 보유 자료를 반환하지 않습니다.

상세 성공을 선택 사전 조건으로 사용하는 저장 입력·별도 보관 정책·원자적 내부 흐름은 [소스 저장 계약](SOURCE_SAVE.md)에 정리했습니다. 상세 HTTP 응답에는 최종 재검사한 `save` 가능 여부/선택 fingerprint를 추가했고 [인증된 저장 API](SOURCE_SAVE_API.md)도 연결했습니다. 선택 안내는 UUID나 저장 권한을 만들지 않으며 제품 정책은 계속 닫혀 있습니다. React 저장 UI는 후속입니다.

## 검증

`tests/source-album-service.test.ts`의 **18개**와 `tests/source-album-api.test.ts`의 **15개** 테스트를 추가했습니다. 전체 **301개 Node 테스트·strict 타입 검사·프로덕션 빌드**를 통과했습니다.

서비스는 반복 번호·원문 주장·미확인 값·UUID 비생성, 입력/응답 검증, 실제 오프라인 파서/캐시, 정책·제거·만료 재검사, 초기/최종 DB 대기·취소·요청 병합·늦은 캐시 쓰기 차단을 확인합니다. API는 실제 임시 두 계정의 쿠키 세션·조건/Origin·본문/요청 제한, 공통 검색/상세 한도, 대기 중 북마크 쓰기·로그아웃/만료/비밀번호 재설정, 유효한 별도 세션 유지, 최종 메타데이터 재검사와 실제 loopback 연결 종료를 검증합니다. 합성 성공은 테스트의 내부 서비스 교체만 사용하며 인증을 우회하지 않습니다. 제품이 합성 봉투를 잘못 반환하면 거절하는 검사도 포함합니다.

운영 DB·계정·스키마·인증 패키지·실제 소스 정책은 변경하지 않았고 외부 사이트에 요청하지 않았습니다. 공통 HTTP 경계 변경 후 기존 검색·북마크·카탈로그·PWA·복구를 포함한 전체 **13개 브라우저 시나리오**도 다시 통과했습니다. 당시 검증은 서비스/API 범위였습니다. 이후 추가한 React 화면과 응답/취소/만료 검증은 [상세 화면 계약](SOURCE_ALBUM_UI.md)에 별도로 기록했습니다. 실사이트 성공·표시/수집 허가·실제 TLS/CORS·음원 재생 검증을 의미하지 않습니다.
