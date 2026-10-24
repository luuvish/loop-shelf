# 소스 전송 계층

2026-10-24 구현·오프라인 검증. 실제 KHInsider·Zophar 요청은 활성화하지 않았습니다. 이 문서의 성공은 합성 응답과 교체한 DNS/HTTPS 드라이버를 사용한 계약 검증입니다. 실사이트의 현재 접근 가능성·정책·CORS·음원 재생을 증명하지 않습니다.

## 진입점과 정책

제품 진입점은 `src/sources/transport.ts`의 프로세스 공용 `captureSourcePage(request, signal?)`입니다. 서버 라우트·UI·SQLite 적재에는 아직 연결하지 않았습니다. 입력은 아래 두 종류뿐이며 임의 URL·헤더·쿠키·인증·프록시 옵션을 받지 않습니다.

```ts
type SourceRequest =
  | { sourceId: "khinsider" | "zophar"; kind: "search"; query: string }
  | { sourceId: "khinsider" | "zophar"; kind: "album"; externalKey: string };
```

검색어는 공백 제거 후 비어 있지 않아야 하며 입력 길이 200 UTF-16 code units 이하입니다. 제어 문자와 고립된 surrogate는 거절합니다. 앨범 키는 KHInsider의 `slug`, Zophar의 `system/slug`이며 길이 1,024 이하, URL 구문·경로 탈출을 거절합니다. 안정적인 내부 음악 UUID와 별개인 소스 locator입니다.

| 소스 | 검색 | 상세 |
| --- | --- | --- |
| KHInsider | 고정 origin의 `/search?search=…&type=album` | `/game-soundtracks/album/{slug}` |
| Zophar | 고정 origin의 `/search?search=…` | `/music/{system}/{slug}.html` |

`productAccess`를 큐/DNS/HTTPS보다 먼저 검사합니다. 두 소스의 기존 정책은 모두 `unknown`을 유지합니다. 제품 gate는 향후 해당 정책이 허용으로 바뀌더라도 **현재 robots/path 규칙과 소스별 quota의 검토 계약이 구현되기 전에는 계속 닫혀 있습니다**. 환경 변수나 HTTP 요청으로 열 수 없습니다. KHInsider 상세의 기존 기술 차단·파서 미지원도 유지합니다.

`transport/engine.ts`의 `createTransport`는 내부 의존성 경계입니다. 테스트만 별도의 합성 허용 판정과 가짜 시계·DNS·응답을 주입하며 실제 `sourceAssessments`를 바꾸지 않습니다. 큐 진입 전, 큐/간격 대기 후, DNS 후, 각 redirect와 본문 반환 전 정책을 다시 검사합니다. 캐시/표시 허가는 별도 gate가 필요하며 이 모듈이 부여하지 않습니다.

## 주소와 연결

- 두 소스의 정확한 HTTPS origin·443 포트만 허용합니다. 사용자 정보·타 호스트·HTTP downgrade·다른 포트를 거절합니다.
- redirect는 최대 2회입니다. 같은 앨범의 정규 표기나 같은 검색어/파라미터의 표현 차이만 허용하고, 매 hop마다 정책·DNS·IP를 다시 검사합니다. 로그인·홈페이지·다른 앨범·추가 query·다음 페이지·미러·오디오 경로는 따라가지 않습니다. 경로의 점 세그먼트·인코딩 우회와 루프도 거절합니다. 페이지네이션 계약은 아직 없습니다.
- 요청마다 전용 Node DNS `Resolver`로 A/AAAA를 조회합니다. 반환된 주소 중 하나라도 금지 주소이면 전체 응답을 거절합니다. 빈 결과·일부 family의 실제 DNS 실패도 임의 fallback으로 숨기지 않습니다. 없는 family의 ENODATA/ENOTFOUND만 비어 있는 목록으로 처리합니다.
- IPv4 사설·loopback·link-local·공유 주소·문서/벤치마크·멀티캐스트·예약 대역을 제외합니다. IPv6는 `2000::/3` 안에서 특수 대역을 추가 제외합니다. IPv4-mapped·NAT64·6to4·Teredo·zone ID 등 우회/전환 주소를 허용하지 않습니다. 일부 특수 대역의 공용 예외까지 보수적으로 제외하므로 이것은 모든 공용 IP를 지원한다는 보장이 아닙니다. [IANA IPv4](https://www.iana.org/assignments/iana-ipv4-special-registry), [IANA IPv6](https://www.iana.org/assignments/iana-ipv6-special-registry)
- 검사한 한 IP를 HTTPS `lookup`에 고정하고 재조회·주소 fallback·소켓 재사용을 하지 않습니다. Host와 SNI는 원래 소스 호스트이며 인증서 검증을 유지합니다. `agent: false`, `family`, `autoSelectFamily: false`를 지정합니다. 전역 Agent/프록시·기존 연결을 사용하지 않습니다. [검증 버전 Node HTTPS](https://nodejs.org/download/release/v24.21.0/docs/api/https.html#httpsrequesturl-options-callback)
- 고정 User-Agent는 `LoopShelf/0.1 (+https://github.com/luuvish/loop-shelf)`입니다. Accept는 HTML, Accept-Encoding은 identity입니다. 쿠키·Authorization·Referer를 보내거나 Set-Cookie를 보관하지 않습니다.

## 시간·크기·요청 제한

| 항목 | 현재 값과 의미 |
| --- | --- |
| 동시 실행 | 소스별 1개; 두 소스는 별도 큐 |
| 큐 상한 | 실행 중 1개 외 최대 대기 8개; 초과는 `queue_full` |
| 간격 | DNS/HTTPS 시도 종료 후 다음 DNS 시작까지 최소 3초; 실패와 redirect에도 적용 |
| 전체 deadline | 호출 시점부터 10초; 큐·간격·DNS·연결/TLS·헤더·본문·redirect를 모두 포함 |
| redirect | 최대 2회; 같은 호출의 10초 예산 공유 |
| 헤더 | 네이티브 HTTPS `maxHeaderSize` 16 KiB; 관련 제어 헤더 중복 거절 |
| 본문 | 최대 5 MiB; Content-Length와 실제 스트림 바이트 수 모두 검사 |
| 응답 형식 | 200 HTML/XHTML, UTF-8(또는 선언 없는 UTF-8/US-ASCII); 잘못된 UTF-8 거절 |
| 압축 | identity만 지원. gzip/br 등은 본문을 읽기 전에 `invalid_response`; 압축 해제 미구현 |
| 자동 재시도 | 없음. DNS/연결/5xx에도 한 번만 시도 |

본문은 고정 크기 버퍼에 모아 작은 chunk가 많아도 배열 오버헤드가 누적되지 않게 합니다. 본문 길이 불일치·초과·끊김은 실패입니다. 서버 파일·DB·PWA에는 저장하지 않으며 HTML·스크립트·이미지를 실행하거나 추가 취득하지 않습니다.

호출자 취소와 전체 deadline은 별도 오류입니다. 대기 취소 시 즉시 큐에서 빠지고, DNS는 해당 Resolver를 cancel하며 HTTP는 AbortSignal과 응답/요청 destroy로 닫습니다. 늦게 도착한 DNS 결과는 새 요청을 시작하지 않고, 늦은 HTTP 응답도 닫습니다. 대기/본문이 끝나면 타이머와 이벤트 리스너를 정리합니다. [Node DNS Resolver](https://nodejs.org/docs/latest-v24.x/api/dns.html#class-dnspromisesresolver)

429는 소스 전체의 cooldown을 갱신합니다. Retry-After의 초 단위와 HTTP 날짜 세 형식은 UTC로 해석하고, 없거나 잘못됐거나 이미 지난 날짜이면 60초를 적용합니다. 아주 긴 delta는 안전한 최대 숫자 시각으로 보류하여 짧게 잘라 자동 재시도하지 않습니다. cooldown 중 새 요청/기존 대기 요청은 네트워크 없이 `rate_limited`와 `retryAt`(epoch ms)을 반환합니다. 다른 소스에는 영향을 주지 않습니다. 클라이언트 자체 기본값이며 **사이트의 공식 허용 quota가 아닙니다**.

제한 상태는 단일 프로세스 메모리에만 있습니다. 재시작 뒤 cooldown 보존·여러 프로세스/설치의 공통 quota·같은 운영 기반의 그룹 제한은 미구현이며 활성화 전 검토 대상입니다. 현재 전체 검색의 12초 시간 예산이나 실제 인터넷 지연을 검증한 것으로 확대하지 않습니다.

## 결과와 후속 경계

성공은 `{ ok: true, page: CapturedPage }`이며 HTML 취득을 뜻합니다. 파서 성공·검색 성공·이용 허가는 별도입니다. `page`에는 본문·최종 URL·취득 시각·Content-Type과 캐시 제한 판단에 필요한 Cache-Control/Expires/Date/Age/Vary만 포함합니다. 쿠키나 불필요한 응답 헤더를 반환하지 않습니다. 제품 드라이버의 sampleKind는 `live-capture`, 합성 검증은 `synthetic`입니다. HTTP Date는 캐시 수명 제한에만 사용하며 취득 시각을 대신하지 않습니다.

오류는 `{ ok: false, code, httpStatus?, retryAt? }`입니다. upstream 예외 메시지·본문·개인 정보는 포함하지 않습니다.

| 코드 | 의미 |
| --- | --- |
| `invalid_input` | 지원하지 않는 소스·종류·검색어·앨범 키 |
| `policy_disabled` / `blocked` | 정책 미확인/비활성, 기술 차단 또는 HTTP 401/403/407/451 |
| `unsafe_address` / `redirect_rejected` | DNS/IP 또는 redirect 검증 실패 |
| `queue_full` / `rate_limited` | 대기열 초과 또는 429/cooldown |
| `cancelled` / `timeout` | 호출자 취소 또는 호출 전체 deadline |
| `not_found` | HTTP 404/410 |
| `http_error` / `network_error` | 나머지 비정상 HTTP 상태 또는 DNS/TLS/연결/스트림 실패 |
| `invalid_response` / `response_too_large` | 헤더·인코딩·길이 불일치 또는 본문 상한 초과 |

HTTP 200 challenge/변경된 HTML은 전송 성공일 수 있으나 반드시 기존 `inspectCapturedPage`를 거쳐 `blocked`/`parse_changed`로 분류해야 합니다. 실패를 0건으로 저장하지 않습니다. [상위 Adapter·SQLite 캐시·요청 병합](SOURCE_ADAPTERS.md)은 후속 구현과 합성 검증을 마쳤고 제품 정책은 유지합니다. 카탈로그 적재·로컬/원격 통합 검색·UI·허용된 실사이트 검증은 아직 남아 있습니다.

## 검증

`node --test tests/source-transport.test.ts tests/source-node-driver.test.ts`의 **35개 테스트**를 통과했습니다. 가짜 시계로 deadline/간격/cooldown을 진행하고, 합성 async body와 Node 드라이버의 request/Resolver 대체를 사용합니다. 실사이트나 loopback listener를 열지 않습니다.

- 제품 두 소스/검색·상세가 정책 미확인으로 DNS 전에 중단되고 정책 객체가 변하지 않음.
- 입력/redirect/특수 IP·혼합 DNS·리바인딩·Host/SNI/TLS/IP 고정 계약.
- 동일 소스 직렬 실행·대기 상한·소스 격리·오류 뒤 간격·큐/DNS/헤더/본문 취소와 timeout·늦은 결과 정리.
- 429 초/날짜/누락/잘못된 값/큰 값, 대기 중 cooldown 변경, 타 소스 영향 없음.
- 헤더 중복·MIME·인코딩·잘못된 UTF-8·본문 크기/길이/끊김·403/5xx 무재시도.
- 합성 본문에서 기존 파서로 이어지는 provenance 및 challenge/파서 변경 오류 확인.

전체 타입 검사·빌드·Node 회귀 결과는 README와 PLAN에 기록합니다. 화면/DB 스키마는 변경하지 않았으며 이 단위에서 Playwright나 실브라우저 CORS 검증을 새로 수행한 것은 아닙니다.
