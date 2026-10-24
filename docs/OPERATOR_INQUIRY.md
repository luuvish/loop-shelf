# KHInsider·Zophar 운영자 문의 초안

상태: **미발송** · 작성일: 2026-10-18. 사용자가 발송을 명시적으로 지시한 경우에만 실제 연락합니다. 아래 문안은 허가를 받았다는 근거가 아닙니다.

문의 경로는 KHInsider의 [FAQ](https://downloads.khinsider.com/faq)·사이트 Contact Me 메뉴, Zophar의 [Legal Stuff](https://www.zophar.net/legal.html)에서 운영자가 안내하는 연락 경로를 확인해 사용합니다. 개인정보나 회신 이메일은 사용자가 선택합니다. 사이트별로 아래 공통 문안과 해당 추가 질문만 보냅니다.

## 공통 문안

Subject: Permission request: limited metadata integration for LoopShelf

Hello,

I am developing LoopShelf, a small self-hosted personal game-music catalog. The initial scope is user-initiated album search, album/track browsing, and private bookmarks with links back to the original source. There is no planned bulk crawl or audio hosting, proxying, transcoding, or offline audio cache.

Before enabling integration, could you clarify the following?

1. Is there an official API, feed, licensed dataset, or other integration route you recommend?
2. May the application request your public album search and album detail HTML to extract titles, platforms, track names, durations, and displayed credits? Are automated requests permitted for this use?
3. What request rate, concurrency, User-Agent identification, robots requirements, and shared limits should it follow? A possible starting limit is one request at a time, at least three seconds apart, with no periodic catalog sweep. This is a proposal, not an assumption about your policy.
4. May normalized metadata be cached and displayed in a private installation? What retention, attribution, canonical-link, refresh and removal requirements apply? Do cover images have different conditions? We can leave them out.
5. Does publishing an open-source client or operating a multi-user private installation change the permitted scope?
6. Separately, for a future phase, is playback directly from your audio host in an external web application's audio element allowed? Is an official embed available? We will keep playback disabled unless it is explicitly permitted and technically verified.

If any part is not permitted, we can limit that functionality to manually entered bookmarks and normal source-page links. We will not bypass access controls, bot challenges, login requirements, or download restrictions.

Project: https://github.com/luuvish/loop-shelf

Thank you for helping us choose an appropriate integration approach.

## KHInsider에 추가할 질문

A small research request to a public album detail page returned HTTP 403. We stopped rather than attempting a bypass. Is there an approved way to obtain album metadata for this use? If not, we will leave automated detail retrieval disabled. Are album search results paginated or capped, and is there a documented stable album/track identifier?

## Zophar에 추가할 질문

The public search combines music with other sections. Is the music section suitable for a permitted metadata integration, and are its results capped or paginated? Some track lists repeat displayed numbers for regular and looped versions; is there a stable track identifier? Does “Release date” refer to the game's release, a platform edition, or the music collection? A robots.txt request redirected to the homepage during research; is there another documented automation policy we should follow?

## 답변 후 기록할 항목

검색·상세·캐시·메타데이터 표시·표지·오디오·임베드를 각각 `allowed / denied / unknown`으로 판정하고 회신 날짜·적용 대상·조건·공개 가능한 근거를 남깁니다. 비공개 회신 전문이나 개인정보는 저장소에 넣지 않습니다. 정책이 허용되어도 KHInsider 상세 접근, 결과 완전성, 실제 브라우저 재생은 별도 기술 검증을 거칩니다.
