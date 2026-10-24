# LoopShelf 백엔드 실행 및 운영

기준일: **2026-10-24** · Node **24.21.0 LTS**, SQLite **3.53.4**. React 화면과 인증된 JSON API, 운영 CLI를 제공합니다. 북마크는 사용자가 입력한 제목·URL·메모이고 외부 메타데이터를 취득하거나 음원을 요청하지 않습니다. [화면·개발·브라우저 검증](FRONTEND.md)

합성 카탈로그의 계정별 저장·검색·메모·즐겨찾기·삭제와 앨범 출처 연결 API도 제공합니다. `/api/library/catalog`의 요청/응답·오류·소유권·보존 규칙은 [카탈로그 개인 API](CATALOG_LIBRARY.md)를 참고합니다. 카탈로그 탐색·앨범/곡 새 저장과 출처 후보 선택 UI도 제공합니다. `/api/catalog/albums`와 후보 API는 [탐색 계약](CATALOG_BROWSE.md)을 참고합니다. 북마크 JSON v1과 카탈로그 JSON v2(v1 입력 호환)는 별도 파일이며 카탈로그는 원본 미연결 복원도 지원합니다. [카탈로그 이식 계약](CATALOG_TRANSFER.md). 60초 복구는 직접 입력 북마크 전용입니다.

## 처음 실행

[통합 검색 서비스](SEARCH_SERVICE.md)를 `POST /api/search`에 연결했습니다. 실제 로그인 쿠키·정확한 Origin·필수 `X-LoopShelf-Session`·JSON 4 KiB 한도를 적용하고 응답 직전 세션과 메타데이터를 재검사합니다. 제품 정책은 `policy_disabled`이며 검색 React 화면은 연결했습니다. 실제 수집은 후속입니다. [검색 API 사용법·오류·취소](SEARCH_API.md)

소스 상세는 `POST /api/source-album`에서 sourceId/externalKey만 받아 조회합니다. 검색과 실제 세션·Origin·4 KiB·12초 대기/최종 재검사를 공유하며 두 경로의 합계 IP 분당 30회/동시 16개 한도를 적용합니다. 제품 수집은 비활성이고 성공 검증은 합성 자료이며 [상세 화면](SOURCE_ALBUM_UI.md)도 연결했습니다. 카탈로그 적재·개인 저장은 후속입니다. [상세 조회 API 계약](SOURCE_ALBUM.md) 소스 저장은 [내부 정책/입력 계약](SOURCE_SAVE.md)만 추가했으며 HTTP 경로는 없습니다. 실제 자료 보관은 비활성이고 합성 적재/개인 저장의 원자성을 임시 세션으로 검증했습니다.

프로젝트 루트에서 실행합니다. `.node-version`에 맞는 Node를 선택하고 의존성을 설치합니다.

```sh
npm ci --ignore-scripts
test -e .env || cp .env.example .env
chmod 600 .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

마지막 명령으로 생성한 값을 `.env`의 `BETTER_AUTH_SECRET`에 넣습니다. `.env`는 최초 설정 때만 복사하고 기존 비밀값을 덮어쓰지 않습니다. 비밀값은 32자 이상이어야 합니다. 계정은 임의의 기본 비밀번호로 자동 생성되지 않습니다.

```sh
npm run db:migrate
npm run account:create -- --email you@example.com --name 'Your name'
npm run build
npm start
```

계정 명령은 터미널에서 비밀번호를 숨겨 입력받습니다. 12–128자를 사용합니다. 자동화에서는 stdin으로 한 줄을 전달할 수 있지만 비밀번호를 명령행 인자나 저장소에 넣지 않습니다. 이름·이메일은 실제 운영자가 선택합니다. 공개 회원가입·메일 발송·소셜 로그인은 제공하지 않습니다.

| 설정 | 기본값 / 역할 |
| --- | --- |
| `DATABASE_PATH` | `.local/loopshelf.sqlite`, 프로젝트 루트 기준 경로 |
| `APP_ORIGIN` | `http://127.0.0.1:3000`, 정확한 앱 origin. 로컬 외에는 HTTPS 필요 |
| `PORT` | `3000`, 실제 listener 포트. 로컬 실행 시 APP_ORIGIN의 포트와 맞춤 |
| `BETTER_AUTH_SECRET` | 기본값 없음. 세션 서명용 비밀값, DB와 별도로 안전하게 보관 |

서버는 **127.0.0.1에만** 바인딩합니다. 모든 요청의 Host가 APP_ORIGIN과 일치해야 하므로 `localhost`와 `127.0.0.1`을 섞지 않습니다. TLS 역방향 프록시 배포는 아직 검증하지 않았습니다. 프록시 헤더를 신뢰하지 않으므로 프록시를 붙이면 로그인 제한이 프록시 IP 단위로 묶이며, 별도의 명시적 신뢰 설정 검토가 필요합니다.

서버는 시작 시 마이그레이션 이력을 검사합니다. DB 변경을 자동 적용하지 않으므로 스키마가 없거나 오래되면 먼저 `db:migrate`를 실행해야 합니다. DB 파일은 0600, 새 저장 디렉터리는 0700으로 생성합니다. DB·WAL·환경 파일은 Git에서 제외합니다.

## 계정 관리

```sh
npm run account:reset-password -- --email you@example.com
```

운영자가 로컬 파일 접근 권한으로 수행하는 복구 명령입니다. Better Auth의 요청/재설정 API를 사용하고 재설정 토큰은 프로세스 메모리 안에서만 전달합니다. 메일을 보내지 않으며 모든 기존 세션을 폐기합니다. 개인 북마크는 유지합니다. 인증 테이블의 비밀번호 값을 직접 편집하지 않습니다.

HTTP에서 계정 생성·재설정·계정 삭제 endpoint는 노출하지 않습니다. 로컬 CLI가 사용하는 가입 허용 설정은 HTTP 인증 인스턴스와 분리되어 있습니다.

## HTTP API

변경 요청에는 `Content-Type: application/json`과 정확한 `Origin: http://127.0.0.1:3000`이 필요합니다. 로그인 후 받은 세션 쿠키를 다음 요청에 전달합니다. body/query의 `userId`로 사용자를 선택할 수 없습니다. 개인 API 응답은 `Cache-Control: no-store`입니다. 브라우저의 `X-LoopShelf-Session` 조건이 존재하면 현재 인증 세션 ID와도 일치해야 합니다. 조건만으로 인증할 수 없고, 불일치 시 쓰기 전에 401 `session_changed`를 반환합니다. 사용자 응답에는 세션에서 확인한 `X-LoopShelf-User`를 추가합니다.

| 메서드 / 경로 | 입력 / 응답 |
| --- | --- |
| `GET /api/health` | `{ "status": "ok" }`, 인증 불필요 |
| `POST /api/auth/sign-in/email` | `{ "email": "...", "password": "..." }`, 세션 쿠키 발급 |
| `POST /api/auth/sign-out` | `{}`, 세션 폐기 |
| `GET /api/auth/get-session` | Better Auth 세션 조회 |
| `GET /api/me` | 로그인 사용자 `{ "userId": "UUID" }` |
| `GET /api/library/export` | 현재 계정의 북마크 전체 JSON v1 다운로드 |
| `GET /api/library/catalog/export` | 현재 계정의 카탈로그 개인 자료 JSON v2 다운로드 |
| `POST /api/library/import/preview` | `{ archive }`, 북마크/카탈로그 포맷별 추가·동일·충돌 검사와 토큰 |
| `POST /api/library/import` | `{ archive, token }`, 원자적 추가 복원. [상세 계약](DATA_TRANSFER.md) |
| `POST /api/bookmarks` | `title`, `url`, 선택 `note`, `favorite`. `{ item, created }`; 생성 201, 중복 200 |
| `GET /api/bookmarks` | 선택 `q`, `favorite=true/false`, `standalone=true`(연결되지 않은 단독 항목만), `limit=1..100`(기본 50), `offset`(기본 0). `{ items, nextOffset }` |
| `GET /api/bookmarks/:id` | 로그인 사용자의 북마크 한 건 |
| `PATCH /api/bookmarks/:id` | 필수 `version`, 변경할 `title`/`url`/`note`/`favorite` 중 하나 이상 |
| `POST /api/bookmarks/:id/deletion` | `{ version, operationId }`, 60초 세션 소유 복구 영수증 반환 |
| `POST /api/bookmark-deletions/:id/restore` | `{}`, 같은 세션의 영수증 복구, `{ bookmarkId, restored }` |
| `DELETE /api/bookmarks/:id` | `{ "version": 1 }`, 연결된 항목은 409, 성공 204, 복구 영수증 없음 |
| `GET /api/bookmarks/:id/connections` | `{ root, members }`, 연결된 멤버 ID로 조회해도 해당 대표와 멤버 반환 |
| `POST /api/bookmarks/:id/connections` | 대표 ID 경로에 `{ version, memberId, memberVersion }`, 성공 200 `{ root, members }` |
| `DELETE /api/bookmarks/:id/connections` | 동일 입력으로 멤버 해제, 성공 200 `{ group: { root, members }, detached }` |

북마크 생성 예시:

```json
{
  "title": "나중에 살펴볼 음악",
  "url": "https://www.zophar.net/music/nintendo-snes-spc/chrono-trigger.html",
  "note": "사용자가 직접 작성한 메모",
  "favorite": true
}
```

지원 URL은 KHInsider `/game-soundtracks/album/{slug}`, Zophar `/music/{system}/{slug}.html`의 정확한 HTTPS origin입니다. 쿼리·fragment는 정규 참조에서 제거합니다. 오디오 URL·다른 호스트·로그인 정보가 포함된 URL·경로 우회는 거절합니다. URL의 실제 존재 여부나 재생 가능 여부를 확인한 북마크가 아니며, 응답에 `provenance: user-entered`를 표시합니다.

각 응답에는 별도의 `id`(LibraryItem UUID), `entityId`(Bookmark Entity UUID), 제목·출처 참조·메모·즐겨찾기·`version`·생성/수정 시각과 `rootId`(대표 LibraryItem UUID), `sourceCount`(대표 포함 출처 수)가 있습니다. 같은 사용자가 같은 정규 소스 키를 재전송하면 기존 항목을 반환하고 개인 내용을 덮어쓰지 않습니다. 같은 제목의 다른 URL이나 다른 사용자의 같은 URL은 별도 항목입니다.

PATCH/DELETE에는 마지막으로 읽은 `version`을 보냅니다. 오래된 버전이나 기존 다른 북마크 URL과의 충돌은 409이므로 다시 조회하고 사용자의 의도를 반영해 재시도합니다. 다른 사용자의 항목과 존재하지 않는 항목은 모두 404입니다. 입력 오류는 400, 인증 없음/만료는 401, Origin 위반은 403, 본문 32 KiB 초과는 413, 로그인 제한은 429입니다. 로그인은 socket IP 기준 분당 5회이며 위조 전달 헤더로 우회할 수 없습니다.

제목은 1–300자, 메모는 최대 10,000자, 검색어는 최대 200자입니다. 개인 검색은 제목·메모의 NFKC 정규화 부분 검색입니다. 3자 이상은 FTS5 trigram의 리터럴 구문, 1–2자는 소유자 범위 내 `instr` 조회를 사용합니다. 사용자 SQL/FTS 구문을 실행하지 않습니다. 현재 합성 카탈로그의 1만 앨범/10만 트랙·개인 저장 5천 개 성능은 [별도 측정](CATALOG_PERFORMANCE.md)을 참고합니다. 별칭/외부 곡 검색은 후속 범위입니다.

## 개인 북마크 연결 계약

연결은 기존 LibraryItem/Bookmark 행을 유지한 채 `bookmark_connection` 관계만 추가합니다. `:id`는 대표 북마크 ID이며 `memberId`는 같은 사용자의 단독 북마크여야 합니다. 양쪽 소유권을 검사하고 다른 사용자 ID는 404로 처리합니다. 자기 자신 연결은 400 `invalid_connection`, 중첩/이미 연결된 후보는 409 `grouped_bookmark`, 대표 포함 20개 초과는 409 `connection_limit`입니다. 같은 소스의 다른 URL도 사용자가 직접 선택할 수 있으며 제목으로 자동 병합하지 않습니다.

`version`은 대표의 버전, `memberVersion`은 대상의 버전입니다. 연결/해제는 두 버전을 모두 비교하며 하나라도 오래되면 409 `conflict`입니다. 관계·최소 감사 기록·양쪽 버전 증가를 하나의 immediate 트랜잭션에서 처리합니다. 기존 PATCH로 멤버를 수정해도 대표 버전이 증가합니다. 네트워크 실패 후에는 GET으로 실제 상태를 재확인해야 합니다.

기본 목록은 대표와 단독 항목만 반환합니다. 연결된 원래 제목·메모의 검색 결과를 대표 ID로 치환해 중복을 없앤 뒤 페이지를 나눕니다. 즐겨찾기 필터는 대표 값을 사용합니다. 각 멤버의 원래 즐겨찾기는 그대로 보존합니다. 단건 GET은 멤버도 조회할 수 있고, 같은 URL을 다시 POST하면 원래 항목과 `rootId`를 반환합니다. 자동으로 대표를 교체하거나 내용을 합치지 않습니다.

연결된 대표·멤버 삭제는 모두 거절합니다. 해제 후 원하는 항목을 따로 삭제합니다. 연결 해제와 그 역연산은 기존 UUID·제목·메모·즐겨찾기·생성 시각을 유지하며 `version`과 수정 시각만 갱신합니다. 화면의 직전 작업 되돌리기도 최신 버전을 사용한 같은 API입니다.

## 마이그레이션

`0001_auth.sql`은 Better Auth 1.7.10의 `getMigrations(authOptions)`로 생성했습니다. 라이브러리 요구 스키마와 일치하는지 자동 테스트로 확인합니다. `0002_catalog_library.sql`은 최소 음악 관계, 출처 주장, 개인 북마크·LibraryItem·개인 출처 연결과 검색 트리거를 정의합니다. DB는 UUID를 URL과 별개로 보존하고 타입·외래 키·소유권·유일성 제약을 적용합니다.

마이그레이션은 이름과 SQL SHA-256을 기록합니다. **이미 적용한 SQL은 수정하지 않고 새로운 번호의 파일을 추가합니다.** 미적용 배치는 한 트랜잭션으로 적용하며 실패하면 배치 전체와 이력을 롤백합니다. 기존 DB에 적용할 변경이 있으면 CLI가 먼저 `<DATABASE_PATH>.backups/`에 백업하고 검증합니다. 이력/체크섬 불일치는 백업 뒤에도 오류로 남으며 자동 복구하거나 초기화하지 않습니다.

DB에 등록한 `normalize_search` 함수와 트리거가 개인 검색 인덱스를 함께 갱신합니다. 일반 SQLite 도구로 직접 개인 테이블을 수정하지 않고 저장소 서비스를 사용합니다. 인증의 비동기 트랜잭션과 개인 저장의 동기 트랜잭션은 연결별 큐로 직렬화합니다. 향후 같은 연결을 사용하는 비동기 작업도 이 경계를 따라야 합니다.

`0003_bookmark_connections.sql`은 수동 북마크 전용 연결과 변경 기록을 추가합니다. `0002`의 `user_source_link`는 공용 SourceEntity용이며 이번 수동 북마크 묶기에는 사용하지 않습니다. 기존 설치는 서버를 멈추고 `npm run db:migrate`로 자동 백업·업그레이드를 마친 뒤 다시 실행합니다. 원래 북마크 행과 검색 인덱스는 유지합니다. SQL 제약도 양쪽 소유권·단독 멤버·중첩/순환 금지·최대 20개·연결 중 삭제/식별자 변경 금지를 검사합니다. 감사 기록은 사용자 ID, 두 항목 ID, 연결/해제 구분, 시각만 저장하며 내용이나 인증 정보를 복사하지 않습니다.

`0004_import_revisions.sql`은 로컬 수정 버전의 상한을 유지해 삭제한 UUID를 JSON으로 복원할 때 이전 편집 버전이 재사용되지 않도록 합니다. 기존 북마크 값은 변경하지 않습니다. 연결의 원래 시각을 복원해도 새 감사 기록에는 실제 작업 시각을 남깁니다. 기존 설치는 `npm run db:migrate`로 0011까지 적용해야 합니다. [JSON 이식 계약](DATA_TRANSFER.md)

`0005_bookmark_deletions.sql`은 삭제 후 60초 복구 정보와 재시도 상태를 추가합니다. 같은 사용자·로그인 세션만 복구할 수 있고 만료·세션 삭제 시 제거합니다. 복구된 항목은 원래 ID·내용·시각과 새 수정 버전을 사용합니다. 사용자당 유효 영수증 최대 20개이며 기존 DELETE의 204 계약은 유지합니다. [삭제·복구 API와 보관 기한](DELETION_UNDO.md)

`0006_catalog_observations.sql`은 합성 카탈로그 관찰·채택 근거·트랙 원본 목록과 Assertion의 provenance 연결을 추가합니다. 기존 개인 데이터는 유지하며 운영 앱에 fixture를 적재하지 않습니다. [카탈로그 저장 계약](CATALOG.md)

`0007_catalog_removals.sql`은 독립된 제거 영수증과 재노출 방지 제약을 추가합니다. 로컬 `npm run catalog:remove -- --source-entity-id '<SOURCE_ENTITY_UUID>' --reason rights_request` 명령으로 관리 중인 임시 앨범의 콘텐츠를 제거하고 UUID·개인 내용을 보존합니다. HTTP API는 없으며 사용자 북마크 삭제와 별개입니다. [운영 명령·보존 범위·충돌·백업 한계](CATALOG_REMOVAL.md)

`0008_catalog_track_adoptions.sql`은 관찰별 수록 위치/Track ID 대응과 명시적 채택 영수증을 추가합니다. `npm run catalog:review -- --album-id '<ALBUM_UUID>'`로 검토 후 `npm run catalog:adopt -- --input .local/track-plan.json`으로 전체 대응을 적용합니다. 현재 순서는 binding에서 읽고 누락 ID·개인 내용은 보존합니다. HTTP API는 추가하지 않았습니다. [JSON 계약·오래된 요청·재시도](TRACK_ADOPTION.md)

`0009_catalog_library_links.sql`은 카탈로그 개인 출처 연결의 인덱스·20개 상한·정체성 불변 제약과 ID/행동/시각만 포함하는 감사 기록을 추가합니다. 기존 개인 저장과 연결은 보존하며 과거 감사 기록을 생성하지 않습니다. 앨범끼리의 연결과 누락/제거 항목 처리, 개인 수정 버전은 서비스에서 검사합니다. [개인 API와 이전 데이터 보존](CATALOG_LIBRARY.md)

`0010_catalog_transfer.sql`은 JSON 복원용 미연결 개인 항목·출처 판단 테이블을 추가합니다. 공용 Entity/Source를 생성하지 않으며 계정별 소유권·ID/출처 충돌·수정 버전 상한·최소 감사 기록을 유지합니다. 기존 데이터는 변환하지 않습니다. [미연결 보존과 이식 검증](CATALOG_TRANSFER.md)

`0011_source_metadata_cache.sql`은 소스 메타데이터 캐시와 카탈로그 제거 시 관련 캐시를 정리하는 트리거를 추가합니다. 소스 Adapter는 내부 서비스로만 제공되며 HTTP route·UI에는 연결하지 않았습니다. 정책 미확인 상태에서 제품 수집·캐시 제공은 비활성입니다. [캐시/취소/제거 계약](SOURCE_ADAPTERS.md)

## 백업과 복원

```sh
npm run db:backup -- --output .local/backups/manual-20261022.sqlite
npm run db:restore -- --input .local/backups/manual-20261022.sqlite --output .local/loopshelf-restored-20261022.sqlite
```

출력은 새 파일이어야 합니다. 실행 중 DB도 온라인 백업으로 커밋된 WAL을 포함하고, DELETE journal 형식의 단독 스냅샷에 integrity/FK 검사를 수행합니다. 백업에는 모든 사용자의 인증·개인 자료가 포함되므로 접근을 제한합니다.

복구 시 서버를 멈추고 새 경로에 복원한 뒤 `DATABASE_PATH`를 바꾸고 `db:migrate`를 수행합니다. 백업 이후의 카탈로그 제거 결정을 재적용한 뒤 서버를 시작합니다. 복원본의 과거 세션·임시 인증 토큰·세션 소유 삭제 복구 영수증은 제거하므로 **모든 사용자가 다시 로그인**해야 합니다. 북마크 ID·개인 내용·출처 연결은 보존하고 원본 DB/백업은 변경하지 않습니다. 계정·비밀번호도 백업 시점으로 돌아가므로 이후 변경은 별도로 재적용해야 합니다. 일반 서버 재시작은 세션을 유지합니다.

코드·비밀값 보관, 업그레이드 순서, 실패 시 대응과 실제 브라우저 복구 확인은 [운영 절차](OPERATIONS.md)에 정리했습니다.

## 성능 측정

`npm run bench:catalog -- --output /tmp/loopshelf-catalog-report.json`은 새로운 임시 DB에 합성 1만 앨범·10만 트랙과 두 테스트 계정의 개인 자료를 만들고 p50/p95·실행 계획을 기록합니다. 현재 DB/환경 파일을 읽는 운영 명령과 분리되어 있으며 종료 시 임시 자료를 정리합니다. 초기 앨범/수록곡 후보 조회 개선은 마이그레이션 없이 적용했습니다. 0012 보관 모델의 부분 인덱스는 별도 비용 측정 후 추가했으며 24개 조회를 재검증했습니다. [환경·전후 결과·한계](CATALOG_PERFORMANCE.md)

## 검증과 남은 범위

`npm run check`의 **361개 Node 테스트**는 인증된 두 사용자의 데이터 격리, 세션 만료·로그아웃·재설정, 동시 요청, 버전 충돌, 계정 전환 중 오래된 초안의 쓰기 거절, 마이그레이션 실패 롤백, 재시작·백업 복원 뒤 실제 API 조회와 정적 파일 제공을 포함합니다. **15개 브라우저 E2E 시나리오**도 실제 로컬 listener와 쿠키 로그인을 사용합니다. 테스트 계정·DB는 임시 파일이며 운영 계정은 만들지 않았습니다.

개인 북마크 연결/해제의 사용자 격리, 양쪽 버전 검사·동시 변경, 제약 위반·쓰기 실패 시 롤백, 0002 → 0003 업그레이드와 연결 포함 백업/복원도 검증했습니다. JSON v1 이식은 사용자 격리·원본 보존·검사 후 변경·동시 요청·한도·실패 롤백·응답 유실 재시도를 검증했습니다. 기본 PWA와 삭제 후 되돌리기, 실제 서버 프로세스의 백업·복원·브라우저 재접속도 검증했습니다. 합성 DTO의 카탈로그 upsert·관찰 기록·콘텐츠 제거·트랙 목록의 명시적 채택과 실제 세션의 카탈로그 개인 저장/출처 연결을 추가했습니다. 카탈로그 개인 관리 UI의 데스크톱·모바일 검증도 완료했습니다. 합성 자료의 탐색/새 저장·출처 선택 UI와 인증된 읽기 API도 검증했습니다. 카탈로그 개인 JSON의 같은/다른 설치 복원·미연결 관리·충돌·동시 요청·원자적 롤백·한도와 0010 업그레이드/백업 복원도 검증했습니다. 실제 수집은 후속 작업입니다. 외부 자동 수집은 계속 `policy_disabled`이며 북마크 기능과 분리됩니다.

기술 근거: [Better Auth Fastify 통합](https://better-auth.com/docs/integrations/fastify), [인증 DB·마이그레이션](https://better-auth.com/docs/concepts/database), [이메일/비밀번호](https://better-auth.com/docs/authentication/email-password), [better-sqlite3 API](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md), [SQLite FTS5](https://sqlite.org/fts5.html#the_trigram_tokenizer).

## 카탈로그 보관 모델

보관 스키마 `0012_catalog_retention.sql`은 관찰 수명과 SourceEntity별 자료 종류를 고정합니다. 시작/조회/이식/정리 주기·백업/새 경로 복원에 수명 검사를 적용합니다. 새로운 DB 타입이 실제 live 쓰기를 허용하지는 않습니다. 개인/운영 DTO와 JSON v2는 자료 종류를 보존하고 내부 저장에는 원래 수명을 연결했습니다. 최신 0013은 새 참조의 명시적 종류와 이전 앱의 시작 제한을 추가합니다. 실제 live guard는 유지하며 [지원 범위](CATALOG_KINDS.md)에 기록합니다.
