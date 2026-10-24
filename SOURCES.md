# LoopShelf 외부 소스 조사

조사일: **2026-10-18, Asia/Seoul**. 이 문서는 제한된 표본에 대한 기술 조사이며, 전체 카탈로그 연동이나 외부 재생 허가를 확보했다는 의미가 아닙니다.

## 조사 기준

- **문서 확인**: 사이트 자체 문서·정책·운영자 게시물에서 확인했습니다. 오래된 게시물은 날짜를 함께 남깁니다.
- **직접 관찰**: 공개 HTML 또는 HTTP 응답을 소수 요청으로 확인했습니다. 일반 GET과 오디오 1건의 HEAD만 사용했고 음악 본문을 내려받거나 재생하지 않았습니다.
- **미확인**: 공식 허용 범위, 실제 브라우저 동작, 응답을 확보하지 못한 항목입니다. 공개 API를 찾지 못했다는 사실을 API가 없다는 증명으로 취급하지 않습니다.
- `robots.txt`, 저작권/이용 조건, HTTP 접근 성공, CORS는 각각 별도 판단 항목입니다. robots 규칙 자체는 접근 권한을 부여하지 않습니다. [RFC 9309 §1](https://www.rfc-editor.org/rfc/rfc9309#section-1)
- 서비스 내부 JSON이나 제3자 스크레이퍼가 존재해도 공식 공개 API로 분류하지 않습니다. 차단·로그인·유료 다운로드 제한을 우회하지 않습니다.

## 소스별 판단

| 소스 | 검색·메타데이터 경로 | 공식 연동 수단 확인 상태 | 외부 앱 재생 판단 | 계획 |
| --- | --- | --- | --- | --- |
| KHInsider | 검색 HTML, 앨범·곡 페이지 | 공개 API 미확인. 검색 표본 성공, 앨범 표본 403 | 외부 재생 허가·음원 CORS 미확인 | 첫 대상. 검색과 상세 수집을 별도로 검증 |
| Zophar | 사이트 검색의 음악 항목, 플랫폼 목록, 앨범 HTML | 공개 API·자동 수집 허가 미확인. 검색·상세 표본 성공 | MP3 헤더 확인, 외부 재생 허가는 미확인 | 첫 대상. 메타데이터 Adapter 기술 검증 우선 |
| Sitting on Clouds | 앨범·게임 페이지, 사이트 검색 UI 추가 확인 필요 | 공개 API·자동 수집 허가 미확인 | 표본은 외부 파일 호스트 다운로드 링크 | 후속 메타데이터/북마크 후보 |
| VGMRips | 팩·시스템·칩·작곡가 목록 후보 | 2017년 운영자 글에 조건부 수집 안내. 현재 팩 접근 차단 | 운영자 글에서 자체 MP3 이용 제한 | 현재 보류. 최신 정책 확인 필요 |
| OC ReMix | 게임·곡·리믹스 목록, 공식 RSS | RSS 문서 확인. 범용 검색 API 미확인 | 직접 파일 링크·프레이밍 제한 | 후속 피드/페이지 링크 후보 |
| VGMdb | 앨범·게임·아티스트·카탈로그 정보 | 공식 API 미확인. `vgmdb.info`는 별도 파서 서비스 | 음악 제공 소스로 가정하지 않음 | 후속 메타데이터 보강 후보 |
| Rainwave | 공식 API v4의 search/album/song/stations/info | 공식 API 확인. 검색에는 사용자 키 필요 | 라디오 방송 후보. 곡별 온디맨드 재생과 구분 | 플레이어 확장 시 별도 라디오 Adapter |

## 1. KHInsider

**확인한 경로.** [검색 페이지](https://downloads.khinsider.com/search?search=chrono+trigger)는 `GET /search?search=...`이며 HTML의 `table.albumList`에 앨범 링크·플랫폼·유형·연도를 제공합니다. 앨범/곡 검색 전환과 필터 UI도 존재합니다. 첫 MVP의 원격 검색은 앨범으로 제한하고, 곡 검색은 확보한 앨범의 수록곡 인덱스부터 제공합니다. 원격 곡 검색의 페이지 규칙은 아직 검증하지 않았습니다.

**상세 수집.** `/game-soundtracks/album/{slug}`를 상세 경로 후보로 사용합니다. 이번 직접 요청의 `chrono-trigger-2015` 상세는 403 차단이므로 현재 상세 파서와 안정적인 접근을 검증했다고 할 수 없습니다. 표본의 검색 분류가 Arrangement이므로 게임명 일치만으로 원작 OST와 합쳐서도 안 됩니다. [검색 근거](https://downloads.khinsider.com/search?search=chrono+trigger)

**정책.** [robots.txt](https://downloads.khinsider.com/robots.txt)는 조사 당시 모든 에이전트에 `/unavailable`을 Disallow했습니다. [FAQ](https://downloads.khinsider.com/faq)는 대역폭 부담과 앨범 전체 다운로드 조건을 설명하며, 이는 제3자 앱의 자동 수집·스트리밍 허가가 아닙니다. [Blacklist](https://downloads.khinsider.com/blacklist)는 권리자 요청 등에 따른 제외 항목을 관리합니다. 삭제·제한된 음원의 대체 미러를 자동 탐색하지 않습니다.

**재생·브라우저.** 사이트 자체는 MP3 및 무손실 다운로드를 안내합니다. [홈페이지](https://downloads.khinsider.com/) 직접 검색 응답에서 `Content-Security-Policy: frame-ancestors 'none'`을 관찰했습니다. 해당 응답을 iframe에 넣는 방식은 사용할 수 없습니다. HTML 헤더로 음원 CDN의 CORS를 판단할 수 없으며, 이번에 음원 응답은 검사하지 않았습니다.

**다음 판단.** 자동 메타데이터 수집·캐시·표시 범위를 확인하고, 허용된 접근으로 상세 표본을 확보해야 합니다. 이를 통과하기 전에는 검색과 상세를 각각 조건부 기능으로 표시합니다. 차단 시 일반 원문 열기와 사용자가 입력한 북마크를 유지합니다.

## 2. Zophar's Domain

**검색.** [공개 검색](https://www.zophar.net/search?search=chrono+trigger)은 `GET /search?search=...`입니다. 음악 외 에뮬레이터·문서·치트 등이 함께 나오므로 음악 섹션과 검증된 `/music/{system}/{slug}.html` 링크만 받아야 합니다. 같은 게임의 SNES·PlayStation·DS 결과가 따로 존재합니다. [음악 목록](https://www.zophar.net/music)은 플랫폼별 탐색 출발점입니다.

**상세.** [Chrono Trigger 표본](https://www.zophar.net/music/nintendo-snes-spc/chrono-trigger.html)의 HTML에서 제목·표시된 발매일·플랫폼·개발사·배급사·리퍼/태거를 확인했습니다. `#tracklist`의 번호·제목·길이를 파싱할 수 있으며 사이트 스크립트를 실행할 필요가 없습니다. 원본 음악 파일 묶음과 MP3 다운로드, HTML audio 플레이어도 있습니다. 표시된 날짜가 게임 발매일인지 앨범 발매일인지 확인 없이 같은 필드로 옮기지 않습니다.

**식별상 주의.** 표본에 트랙 번호 `102`가 일반 버전과 Looped 버전에 반복됩니다. `(album, track_number)`를 유일 키로 삼을 수 없습니다. 표시 번호, 순서, 원본 항목 키, 녹음 버전을 분리해야 합니다.

**정책.** [Legal Stuff](https://www.zophar.net/legal.html)에서 운영 주체와 연락 경로는 확인했지만 자동 메타데이터 수집·핫링크 허가는 확인하지 못했습니다. `/robots.txt` 직접 요청은 302로 홈페이지에 이동하고 HTML을 반환했습니다. 유효한 robots 파일을 확보한 것으로 간주하지 않습니다.

**재생·브라우저.** 표본 오디오 HEAD 응답은 200, `audio/mpeg`, `Accept-Ranges: bytes`였고 CORS 허용 헤더는 없었습니다. 일반 `<audio>`의 교차 출처 재생 가능성과 `fetch`/Web Audio 사용 가능성을 분리해야 합니다. HEAD는 실제 GET·탐색·모바일 재생 또는 외부 사용 허가를 증명하지 않습니다. MP3와 SPC 등 원본 포맷도 구분합니다.

**다음 판단.** 수집 허용 범위 확인 후 검색/상세/누락/동일 번호/유니코드 사례를 Adapter 계약 테스트로 고정합니다. 스트리밍은 메타데이터 연동과 별도 승인 상태로 유지합니다.

## 단계 1 구현 검증 결과

**2026-10-24 저장 경계 보충:** 캐시/표시와 별도의 카탈로그 보관 정책을 정의했습니다. 두 소스의 보관 허용은 unknown이며, live 저장소도 준비 전에는 거절합니다. 선택한 상세 재검사·실제 세션·공용/개인 원자적 저장은 합성 자료로만 검증했고 외부 요청·허가 근거 변경·운영 적재는 없습니다. [저장 계약](docs/SOURCE_SAVE.md)

**2026-10-24 상세 화면 보충:** 검색 결과의 명시적 선택과 React 상세/수록곡 창을 연결했습니다. 반복 번호·미확인 길이·취득 시각·캐시/실패·세션/취소/만료를 데스크톱/모바일에서 확인했습니다. 성공 응답은 합성 자료이며 제품 정책 비활성을 실제 API로 확인했습니다. 실제 사이트 요청이나 정책 변경, 카탈로그 적재는 없습니다. [화면 계약](docs/SOURCE_ALBUM_UI.md)

**2026-10-24 상세 API 보충:** 소스 앨범 상세 서비스와 인증된 `POST /api/source-album`을 연결했습니다. 서비스 18개·API 15개를 추가해 전체 Node 301개와 기존 브라우저 13개 시나리오를 통과했습니다. 상세 성공·캐시·수록곡은 합성 자료만 사용했고 실제 세션·최종 정책/제거/만료·취소와 검색/상세 공통 제한을 확인했습니다. 실제 사이트 요청이나 허가 근거 변경은 없으며 양 소스의 policy_disabled·KHInsider 상세 파서 미지원은 유지합니다. [상세 계약](docs/SOURCE_ALBUM.md)

**2026-10-24 검색 화면 보충:** React에서 외부 소스를 명시적으로 선택하고 정책 비활성·정상 0건·부분 실패·캐시 자료와 수동 재시도를 구분합니다. 실제 세션의 데스크톱/모바일 검증에 성공/캐시 응답은 합성 자료만 사용했고 제품 정책을 변경하지 않았습니다. 이번 변경에서 외부 사이트 요청과 새로운 허가/가용성 조사는 없습니다. [화면 계약](docs/SEARCH_UI.md)

**2026-10-24 검색 API 보충:** 실제 쿠키 세션을 검증하는 `POST /api/search`를 연결했습니다. 인증/요청 제한·대기/취소·최종 세션과 메타데이터 검사에 API 21개 및 서비스 추가 3개 테스트를 적용했습니다. 연결 종료는 로컬 전용 임시 서버에서 검증했으며 외부 사이트에는 요청하지 않았습니다. 기존 허가 근거와 policy_disabled는 그대로이고 실제 수집/표시 허용이나 실사이트 성공을 의미하지 않습니다. [API 계약](docs/SEARCH_API.md)

**2026-10-24 통합 검색 보충:** 로컬 카탈로그와 소스 Adapter의 결과 구분·시간 예산·취소·부분 실패·정책/만료/제거 재검사를 28개 오프라인 테스트로 검증했습니다. 제품은 합성 카탈로그를 live 검색에 섞지 않으며 양 소스의 `policy_disabled`를 유지합니다. 실제 요청이나 정책/허가 근거 변경은 없습니다. 당시 API·화면은 미연결이었으며 후속 API 검증은 위 항목을 참고합니다. [통합 검색 계약](docs/SEARCH_SERVICE.md)

**2026-10-24 Adapter/캐시 보충:** 검색/상세 Adapter·SQLite 정규화 메타데이터 캐시·정책/버전/TTL·실패 대체·요청 병합/취소·제거 연동을 29개 합성 테스트로 검증했습니다. 제품 정책·허가 근거를 바꾸거나 실사이트에 요청하지 않았습니다. 후속 검색 API·React 검색 화면을 연결했으며 실제 자료 적재는 아직 미연결이고 KHInsider 상세 미지원도 유지합니다. [계약과 검증 범위](docs/SOURCE_ADAPTERS.md)

**2026-10-24 구현 보충:** 공통 전송 계층의 고정 소스 요청·정책 gate·DNS/IP/redirect 검사·취소/timeout·크기/간격/429 제한을 35개 오프라인 테스트로 검증했습니다. 이 작업에서는 KHInsider·Zophar에 실제 요청하지 않았으며 아래 2026-10-18 관찰이나 unknown 정책을 갱신하지 않았습니다. 제품은 DNS 전에 `policy_disabled`를 반환합니다. robots/path/quota 검토와 허용된 실사이트 검증은 남아 있습니다. 후속 Adapter·캐시 구현 범위는 위 보충 항목을 참고합니다. [전송 계약](docs/SOURCE_TRANSPORT.md)

2026-10-18 추가 검증. 기존 임시 응답 4건(KHInsider 검색·차단된 상세, Zophar 영문 검색·SNES 상세)을 재사용하고, Zophar에만 검색 2건·상세 2건을 추가 요청했습니다. KHInsider는 차단 이후 다른 상세 URL·UA·미러로 재시도하지 않았습니다. 이 절의 성공은 **보관된 응답을 파싱한 결과**이며 제품 수집 허가를 의미하지 않습니다.

### 기능별 판정

| 기능 | KHInsider 기술 상태 | Zophar 기술 상태 | 정책/제품 상태 |
| --- | --- | --- | --- |
| 공식 API | 확인 못함 | 확인 못함 | 존재하지 않는다고 단정하지 않음 |
| 앨범 검색 HTML | 1종, 202건 파싱 | 3종, 각각 4·0·0건 파싱 | 두 소스 모두 자동 검색 허가 `unknown`, 제품 `policy_disabled` |
| 앨범 상세 HTML | 기존 403, 상세 파서 `unsupported` | 3종, 92·75·71행 파싱 | 상세 수집 허가 `unknown`, 제품 `policy_disabled` |
| 메타데이터 캐시 | 10/24 오프라인 구현 | 10/24 오프라인 구현 | 보관 기간·재사용 허가 `unknown`, 제품 캐시 비활성 |
| 메타데이터 표시 | DTO 출력만 검증 | DTO 출력만 검증 | 서비스 재표시 범위 `unknown`; 조사 결과 출력을 서비스 허가로 취급하지 않음 |
| 표지 이미지 표시 | 미검증 | 미검증 | `unknown`, 이미지 다운로드·자동 임베드 안 함 |
| 직접 오디오 | 미검증 | 기존 HEAD 1건만 확인 | 외부 재생 허가 `unknown`, 재생 기능 없음 |
| iframe/embed | 검색 CSP가 프레이밍 차단 | 공식 embed와 브라우저 동작 미확인 | 외부 임베드 허가 `unknown` |
| 수동 페이지 URL 참조 | 고정 origin·앨범 경로 검증 구현 | 고정 origin·앨범 경로 검증 구현 | 네트워크 없는 URL 정규화만 구현. 계정별 북마크 저장은 다음 단계 |

정책 근거는 KHInsider [robots](https://downloads.khinsider.com/robots.txt)·[FAQ](https://downloads.khinsider.com/faq)와 Zophar [Legal Stuff](https://www.zophar.net/legal.html)·[Privacy Policy](https://www.zophar.net/privacy-policy.html)를 재확인했습니다. 공개 문서에서 자동 검색·상세 수집·캐시·재표시·오디오 핫링크의 명시적 허가나 공식 요청 quota를 찾지 못했습니다. KHInsider robots의 `/unavailable` 제한과 Zophar robots의 홈페이지 리다이렉트는 앞선 직접 응답 기록을 사용했습니다. 정책 미확인을 허용이나 금지 확정으로 바꾸지 않았습니다. [운영자 문의 초안](docs/OPERATOR_INQUIRY.md)을 작성했으며 발송하지 않았습니다.

### 표본과 재현 가능한 결과

| 소스 / 표본 | HTTP | 파서 결과 | 검증 범위 |
| --- | --- | --- | --- |
| [KHInsider: chrono trigger 검색](https://downloads.khinsider.com/search?search=chrono+trigger) | 200 | 보고 202건 / 추출 202건 | 제목·분류·플랫폼·연도 라벨, 동일 제목의 다른 소스 키 |
| [KHInsider: 상세](https://downloads.khinsider.com/game-soundtracks/album/chrono-trigger-2015) | 403 | `blocked` | 기존 차단 응답의 오류 분류만 확인 |
| [Zophar: chrono trigger 검색](https://www.zophar.net/search?search=chrono+trigger) | 200 | 보고 4건 / 추출 4건 | 음악 섹션만 선택, 다른 카테고리 제외 |
| [Zophar: クロノ 검색](https://www.zophar.net/search?search=%E3%82%AF%E3%83%AD%E3%83%8E) | 200 | 명시적 0건 | 일본어 요청 처리만 확인; 일본어 메타데이터 검색 품질을 보장하지 않음 |
| [Zophar: 불일치 문자열 검색](https://www.zophar.net/search?search=loopshelf-no-match-20261018) | 200 | 명시적 0건 | `No search results found!` 표식 확인 |
| [Zophar: SNES 상세](https://www.zophar.net/music/nintendo-snes-spc/chrono-trigger.html) | 200 | 92행, 반복 표시 번호 27개 | 일반·루프 버전 별도 행, 순서·길이 유지 |
| [Zophar: PlayStation 상세](https://www.zophar.net/music/playstation-psf/chrono-trigger.html) | 200 | 75행 | SNES와 다른 소스 키; 리퍼/태거 필드 없음 |
| [Zophar: DS 상세](https://www.zophar.net/music/nintendo-ds-2sf/chrono-trigger.html) | 200 | 71행 | 같은 게임의 다른 플랫폼 자료, 미제공 선택 필드 허용 |

추가 요청 시각은 **23:34:17–23:34:29 KST**, User-Agent는 `LoopShelfResearch/0.1 (+https://github.com/luuvish/loop-shelf)`였습니다. `Origin: http://localhost:5173`을 넣었고 쿠키·Referer·인증 없이 HTTPS GET만 사용했습니다. 요청은 직렬로, 각 응답 후 최소 3초 간격, 연결 5초/전체 10초 제한, 본문 최대 5 MiB, redirect 자동 추적 없이 수행했습니다. 401/403/429 또는 전송 오류 시 중단하도록 했고 4건 모두 200이었습니다. 이 제한은 자체 조사 예산이며 사이트 공식 quota가 아닙니다.

추가 4개 HTML 응답 모두 CORS 허용 헤더가 없었습니다. 서버 요청의 성공으로 브라우저 fetch 가능성을 주장하지 않습니다. 오디오 요청·다운로드·브라우저 재생 검증은 추가하지 않았습니다. 앞선 HEAD 결과의 한계도 그대로 유지합니다.

[증거 JSON](docs/evidence/2026-10-18-source-feasibility.json)에 URL, 확인 시각과 시각의 근거, 요청 조건, 선택한 응답 헤더, 정상 본문의 SHA-256, 파서 버전, 행 개수와 경고를 보관했습니다. raw HTML·전체 곡 목록·표지·음원 URL은 버전 관리하지 않습니다. 합성 fixture와 로컬 검사 명령은 [README](README.md#개발-및-오프라인-검증)에 있습니다. 원문을 확보하는 기능이 없는 오프라인 도구이며, live-capture 표본 재검증에는 허용된 조사에서 별도로 얻은 응답이 필요합니다.

### DTO와 파서에 반영한 결정

- KHInsider 앨범 참조 키는 `/game-soundtracks/album/{slug}`의 slug, Zophar는 `/music/{system}/{slug}.html`의 system/slug입니다. 이는 현재 경로에서 얻은 출처 키이며 내부 UUID 또는 영구 불변 ID가 아닙니다.
- KHInsider 분류와 연도는 `sourceCategory`, `sourceYearLabel`에 원문 의미로 보존합니다. 검색의 Arrangement 항목을 원작 OST로 자동 병합하지 않습니다.
- Zophar 검색 라벨에는 플랫폼 괄호가 붙습니다. 애매하게 문자열을 잘라 게임명·플랫폼을 추정하지 않고 `source-display-label`로 저장하며 상세의 제목·Console 필드로 보완합니다.
- Zophar 트랙 번호는 반복 가능하므로 `position`/`displayNumber`/문서 내 `snapshotLocator`를 구분합니다. 안정적인 트랙 원본 키는 확인하지 못해 null입니다. 행 순서나 음원 경로를 영구 식별자로 사용하지 않습니다.
- `Release date`는 원문 주장으로 보관하고 canonical `releaseDate`는 null로 둡니다. `101` 같은 번호에서 디스크를 추론하지 않습니다. 누락/해석 불가 길이도 null로 보존합니다.
- 페이지네이션 링크는 실제 검색 표본에서 발견하지 못했습니다. 다음 링크 추출과 호스트 검사는 합성 테스트로만 확인했습니다. 결과 상한은 `null`, 전 카탈로그 완전성은 미확인입니다. `reported-count-matches`는 현재 페이지 보고 개수와 추출 개수가 같다는 뜻에 한정합니다.
- HTTP 403/401, 429, 404/410, 기타 오류, HTTP 200의 challenge를 각각 분류합니다. 필수 목록이 사라지면 `parse_changed`이며 0건으로 저장하지 않습니다. 현재 Zophar에서 음악 섹션도 전체 0건 표식도 없는 페이지는 보수적으로 `parse_changed` 처리합니다. 음악 외 결과만 있는 경우의 추가 표본이 필요합니다.
- KHInsider의 0건 분기와 미확인 페이지네이션·누락 길이 처리는 합성 테스트만 통과했습니다. 해당 실사이트 응답이 검증되었다고 표시하지 않습니다.

**검증:** Node 26.8.2에서 strict 타입 검사와 오프라인 테스트 **23개 통과**. 기존/추가 실제 응답 8건 중 7건 파싱 성공, 1건 KHInsider 상세는 예상한 `blocked` 반환. 실제 자료는 같은 게임 중심의 제한된 표본이므로 다른 게임·다중 디스크·서버별 마크업까지 일반화할 수 없습니다.

**단계 1 판정: 부분 완료.** 기술적으로는 KHInsider 검색과 Zophar 검색/상세의 파싱 경로를 확인했습니다. 허가 근거, KHInsider 상세, 결과 상한/페이지 규칙, 더 다양한 표본은 미완료입니다. 제품 자동 수집은 양쪽 모두 비활성으로 두고, 다음에는 독립적인 SQLite 모델·사용자 라이브러리·수동 북마크 기반을 구현할 수 있습니다.

**2026-10-22 로컬 저장 검증 추가:** 합성 파서 DTO의 Album/SourceEntity 반복 적재·관찰 기록·트랙 변경 보류를 구현했습니다. 실제 캡처는 적재 경계에서 거절하며 실사이트의 추가 요청이나 정책 재판단은 수행하지 않았습니다. 트랙 원본 키는 여전히 미확인입니다. [카탈로그 계약](docs/CATALOG.md)

## 3. Sitting on Clouds

[홈페이지](https://www.sittingonclouds.net/)와 [앨범 표본](https://www.sittingonclouds.net/album/7779)에서 다국어 제목, 발매일, 아티스트, 분류, 플랫폼, 게임 연결을 확인했습니다. 앨범 ID 기반 URL은 메타데이터 참조에 유용합니다. 사이트의 검색 요청 형식, 페이지네이션, 상세 수록곡 완전성은 추가 확인 대상입니다.

표본 다운로드는 단축 링크와 외부 파일 호스트로 연결됩니다. 따라서 앨범 URL을 오디오 URL로 사용할 수 없습니다. 호스트별 인증·일회용 링크·접근 정책도 별개입니다. 공식 공개 API, 자동 수집 및 외부 스트리밍 허가는 확인하지 못했습니다. robots 직접 요청은 404 HTML이었습니다.

초기에는 사용자가 넣은 앨범 페이지 북마크 대상으로만 고려합니다. 외부 호스트 링크 해제 자동화나 파일 다운로드는 계획에 포함하지 않습니다. CORS·iframe·음원 응답은 미검증입니다.

## 4. VGMRips

[2017-02-17 Webmaster 답변](https://vgmrips.net/forum/viewtopic.php?t=2598)은 당시 API가 없고 페이지 수집 결과를 서버에 캐시하라는 조건을 제시하며, 사이트 MP3 이용을 제한하고 VGM/ZIP도 자체 캐시하도록 안내합니다. 같은 스레드에 비영리 관련 추가 답변이 있습니다. 이는 날짜가 오래된 운영자 안내이며 현재의 포괄적 허가로 확대 해석하지 않습니다.

[팩 페이지](https://vgmrips.net/packs/)는 이번 웹 조사에서 접근 거부 화면을 반환했습니다. 현재 검색·팩 상세 구조, 공개 API, CORS는 확인하지 못했습니다. 포럼에 등장하는 제3자 Firebase API도 공식 API로 취급하지 않습니다.

메타데이터 캐시 기반 연동은 향후 재검토할 수 있으나, MP3 이용 제한과 파일 자체 보관을 하지 않는 프로젝트 원칙 때문에 재생 대상으로는 우선 제외합니다. 접근 차단 우회나 전체 팩 수집은 수행하지 않습니다.

## 5. OC ReMix

[공식 Feeds 문서](https://ocremix.org/info/Resources_for_Webmasters)는 최근 리믹스 10개의 RSS와 JavaScript 피드를 웹사이트에 사용할 수 있다고 안내합니다. RSS는 전체 아카이브 검색 API가 아니므로 신규 항목 발견에만 이용하는 것이 적합합니다. [홈페이지](https://ocremix.org/)의 게임·리믹스·곡·아티스트 탐색 구조는 관계 모델 참고 대상입니다.

[Content Policy](https://ocremix.org/info/Content_Policy)는 수익·출처 표시·파일 변경 등에 조건을 둡니다. 별도로 [Linking 정책](https://ocremix.org/info/Linking)은 웹페이지와 토렌트 이외의 직접 링크 및 사이트 프레이밍을 제한합니다. 콘텐츠 이용 조건이 있다는 이유로 호스팅 서버의 MP3 핫링크까지 허용된다고 판단하면 안 됩니다. 첫 연동 후보는 페이지 링크와 허용된 피드입니다.

[robots.txt](https://ocremix.org/robots.txt)의 직접 응답에는 ChatGPT-User와 GPTBot 등에 대한 전체 Disallow가 있었습니다. 조사 도중 이 규칙을 확인한 뒤 추가 페이지 수집은 진행하지 않았습니다. 향후 제품의 정직한 User-Agent, 피드 사용 조건, robots와 사이트 정책을 함께 검토해야 하며 에이전트를 바꿔 차단을 우회하지 않습니다. 실제 음원 CORS는 검사하지 않았습니다.

## 6. VGMdb

[앨범 메타데이터 표본](https://vgmdb.net/album/149352)의 검색 서비스에 수록된 사이트 본문에서는 카탈로그 번호, 발매일, 매체, 크레딧, 트랙 목록, 게임·플랫폼 관계를 확인할 수 있었습니다. 그러나 이번 [홈페이지](https://vgmdb.net/) 직접 웹 열기는 403이었고 앨범 직접 열기도 실패했습니다. 현재 실시간 수집 가능성과 허용 범위는 미확인입니다.

[vgmdb.info 자체 설명](https://vgmdb.info/)은 VGMdb.net을 파싱해 JSON 등을 제공하는 별도 서비스라고 설명합니다. 검색에 수록된 문서는 확인했지만 직접 열기는 타임아웃이었습니다. 이를 VGMdb 공식 API나 가용성이 보장된 의존성으로 삼지 않습니다. 공식 API는 이번 조사에서 확인하지 못했습니다.

후속 단계에서 카탈로그 번호·크레딧·외부 ID를 보강하는 메타데이터 소스로 검토합니다. 음원 제공을 가정하지 않으며 재생 상태는 `metadata-only`가 기준입니다. 현재 CORS와 재사용 조건도 미확인입니다.

## 7. Rainwave

[공식 API v4](https://rainwave.cc/api4/)가 있습니다. [search](https://rainwave.cc/api4/help/api4/search)는 아티스트·앨범·곡을 검색하고 사용자 ID, API 키, 방송국 ID가 필요합니다. [album](https://rainwave.cc/api4/help/api4/album)과 [song](https://rainwave.cc/api4/help/api4/song)도 키가 필요합니다. 외부 익명 클라이언트가 사이트 내부의 임시 익명 키를 가져다 쓰는 방식은 채택하지 않습니다.

[stations](https://rainwave.cc/api4/help/api4/stations)와 `info`/`info_all`에는 공식 CORS 지원 안내가 있습니다. stations의 직접 GET에서도 `Access-Control-Allow-Origin: *`를 확인했습니다. 이를 모든 API에 일반화하지 않습니다. 인증 키는 서버의 사용자별 비밀 저장소에 두고 공유 검색 캐시에 섞지 않습니다.

[stations 실제 응답](https://rainwave.cc/api4/stations)은 라디오 스트림 및 HTTPS relay 정보를 제공합니다. `stream` 필드는 HTTP URL이었으므로 HTTPS 앱에서 그대로 사용하는 설계를 피하고 공식 relay의 HTTPS 경로를 검증해야 합니다. 라디오 기능은 곡을 골라 즉시 재생하는 온디맨드 서비스와 다릅니다. 스트림의 오디오 응답과 브라우저 재생은 이번에 검사하지 않았습니다.

방송국의 현재 곡 정보나 방송 이력은 사용자의 청취 증거가 아닙니다. 향후 앱의 재생 세션과 방송 시간·버퍼 지연을 함께 확인할 수 있는 범위에서만 기록합니다.

## HTTP 표본 관찰 기록

시각: 2026-10-18 약 23:06–23:09 KST. curl 기본 User-Agent, 로그인·쿠키·Referer 없음. 아래 Origin 표기는 `http://localhost:5173` 헤더 사용 여부이며, 브라우저를 실행해 시험했다는 의미가 아닙니다. raw HTML은 조사용 임시 파일로만 읽고 이 저장소에는 복제하지 않았습니다.

| 요청 | 방법 / Origin | 관찰 | 해석 한계 |
| --- | --- | --- | --- |
| [KHInsider 검색](https://downloads.khinsider.com/search?search=chrono+trigger) | GET / 없음 | 200 HTML, `frame-ancestors 'none'`, ACAO 미관찰 | 검색 HTML 표본만 성공 |
| [KHInsider 앨범](https://downloads.khinsider.com/game-soundtracks/album/chrono-trigger-2015) | GET / 있음 | 403, Cloudflare 차단 문서 | Origin이 원인인지는 판별하지 않음. 우회 재시도 없음 |
| [Zophar 검색](https://www.zophar.net/search?search=chrono+trigger) | GET / 없음 | 200 HTML | 음악 이외 결과 포함 |
| [Zophar 앨범](https://www.zophar.net/music/nintendo-snes-spc/chrono-trigger.html) | GET / 있음 | 200 HTML, ACAO 미관찰 | 서버 수집 가능 표본. 브라우저 fetch 성공은 아님 |
| [Zophar 오디오 표본](https://fi.zophar.net/soundfiles/nintendo-snes-spc/chrono-trigger/101%20Presentiment.mp3) | HEAD / 있음 | 200, `audio/mpeg`, `Accept-Ranges: bytes`, ACAO 미관찰 | 본문·206 응답·재생 미검증 |
| [Zophar robots](https://www.zophar.net/robots.txt) | GET / 없음 | 302 → 홈페이지 200 HTML | 유효한 robots 지침 미확보 |
| [Sitting on Clouds robots](https://www.sittingonclouds.net/robots.txt) | GET / 없음 | 404 HTML | 허가 의미 없음 |
| [OC ReMix robots](https://ocremix.org/robots.txt) | GET / 없음 | 200 text/plain, 특정 봇 전체 Disallow | 제품의 정책 검토에 반영 |
| [Rainwave stations](https://rainwave.cc/api4/stations) | GET / 있음 | 200 JSON, ACAO `*`, HTTPS relay 정보 | API CORS만 확인. 스트림 CORS와 별개 |

ACAO = `Access-Control-Allow-Origin`. 응답은 지역·시점·요청 조건·CDN에 따라 달라질 수 있습니다.

## CORS와 재생의 공통 설계 기준

| 동작 | 필요한 조건 / 처리 |
| --- | --- |
| 브라우저 `fetch`로 외부 HTML/JSON 읽기 | 올바른 CORS 허용 필요. `no-cors` 응답은 본문 파싱 해법이 아님. 메타데이터는 정책을 준수하는 자체 서버 Adapter에서 취득. [MDN CORS](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS) |
| 일반 `<audio src>` 재생 | CORS 없는 교차 출처 재생이 가능할 수 있으나 핫링크·쿠키·MIME·HTTPS·브라우저 정책을 별도 검증. `crossorigin`을 무조건 붙이지 않음. [MDN audio](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/audio) |
| Web Audio 파형·분석·효과 | 일반 재생과 요구 조건이 다름. CORS-cross-origin 미디어를 연결한 MediaElementAudioSourceNode는 무음을 출력하도록 규정됨. [W3C Web Audio](https://www.w3.org/TR/webaudio/#MediaElementAudioSourceNode-security) |
| iframe으로 원본 플레이어 표시 | 대상의 `frame-ancestors`/X-Frame-Options와 임베드 이용 조건을 모두 확인. 프레임을 띄울 수 있어도 원본 재생 상태를 마음대로 읽을 수는 없음. [MDN frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors) |
| 탐색·재개·모바일 재생 | Range/206, URL 만료, 코덱, 사용자 제스처, 백그라운드 동작을 실제 브라우저에서 확인. HEAD 성공만으로 완료 처리하지 않음. [MDN Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests) |

음원 프록시를 CORS 또는 사이트 차단 해결책으로 사용하지 않습니다. 첫 MVP의 서버는 음악 파일을 저장·중계·변환하지 않습니다.

## 구현 전에 남은 확인

1. KHInsider·Zophar의 자동 검색, 상세 취득, 메타데이터 캐시·표시 허용 범위와 요청 제한. 필요하다면 운영자 문의 문안을 준비하되 실제 연락은 사용자 지시 후에만 합니다.
2. KHInsider 상세의 허용된 접근 경로. 해결 전에는 두 소스 모두의 상세 연동이 가능하다고 약속하지 않습니다.
3. 검색 페이지네이션, 0건, 다국어, 다중 디스크, 변경·삭제·부분 메타데이터 등 추가 표본.
4. 후속 플레이어 단계에서만 소스별 외부 재생 허가와 실제 HTTPS 오디오 GET·Range·브라우저 동작 검증.
5. 한 소스가 실패하면 다른 소스와 저장된 개인 항목을 계속 이용할 수 있는지 검증.

## 2026-10-24 보관 모델 검증 추가

자료 종류 격리와 보관 기한·정책 철회 정리 모델을 임시 DB/합성 자료로 검증했습니다. SQL의 live-capture 행 검사는 스키마 시뮬레이션이며 실제 사이트 자료를 적재한 결과가 아닙니다. 이번 작업에서 외부 사이트를 호출하거나 허용 상태를 변경하지 않았습니다. 양 소스 제품 자동 수집/저장은 계속 비활성입니다. [모델과 남은 live 경계](docs/CATALOG_RETENTION.md)

## 2026-10-25 개인 참조·저장 수명 확장

개인 DTO/JSON v2에 자료 종류를 유지하고 내부 합성 저장에 승인된 원래 기한을 연결했습니다. live 참조 검증은 생성한 스키마 시뮬레이션/개인 파일이며 실제 수집이나 허가의 증거가 아닙니다. 이번에도 사이트 호출이나 정책 변경은 없고 양 소스 제품 수집/live 저장은 계속 비활성입니다. [현재 경계](docs/CATALOG_KINDS.md)
