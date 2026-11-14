# 복구 안내 수정 — 공개 원본 검증

배포 `8d3f2a27dac84c1edd75631e5b8cef34ffadbb83`, CI `43594165637` 성공 뒤
공개 원본 HTML·main JS·Worklet으로 **확장된 12/12 흐름**을 통과했다.
이전 `public/`의 `10be1faa…` 결과와 당시 6초 안내 겹침 관찰은 그대로 보존한다.

| 원본 자산 | SHA-256 |
| --- | --- |
| HTML | `5a3992057de82b097f1452134032592b61b943837ae43e9c2582c148499ae881` |
| main JS | `2a39113a5fe834c8eee849189c01770dc566737b72d03b5588cd00fd79f83d39` |
| Worklet | `41f9726d8d2bd7a8fe992aa17888f45a3ba7633092d30b2a2d687b3f6f7856ea` |

SRI·정확한 해시 CSP·build·Worklet descriptor를 대조했고 브라우저가 읽은
HTML/main bytes도 별도 GET 원본과 일치했다. 공개 자산을 대체·fulfill·변경하지
않았다. Native Worklet은 실제 CDN URL로 로드되고 실제 WASM이 실행됐다.
Worklet browser-response body는 관찰되지 않았으므로 Worklet hash는 별도 원본
CDN GET과 descriptor/CSP 결속에 근거한다.

같은 case7에서 503 복구 실패 뒤 경고·마이크 차단 유지, 중복 connected의 가짜
복구 차단, 신선한 권한 ACK 뒤 마이크 활성화와 **해당 실패 안내의 즉시 제거**를
확인했다. ACK 대기 중 생긴 더 최신 ASR 경고는 성공·중복 connected·실제 모의
재연결 후에도 유지했고, connected는 자신의 재연결 안내만 지웠다. 실패한 응답의
자동 재생·재시도도 없었다. [notice-verification.json](notice-verification.json)에
검사 범위를 남겼다. 이번에는 6초 타이머를 기다린 결과가 아니라 검증된 복구
직후의 assertion과 화면으로 이전 실패 안내가 없음을 확인했다.

320×568·390×844, 통화 글자 125%의 PNG 9개를 직접 열었다. 복구 직후 두 폭
모두 “듣고 있어요” 상태에서 이전 실패 안내가 보이지 않았고 마이크·종료 조작이
접근 가능했다. 503 실패 상태의 다시 연결과 종료, 이어 듣기·응답 중지,
budget의 종료도 표시·hit test를 통과했다. 320px 도움말·대화문은 스크롤로
접근할 수 있었다. 최신 경고 보존은 확장 case7 assertion으로 검증했다.

인증·DB·writer·합성·RTC·ASR은 고정 모의 자료이며 출력 PCM은 tone이다.
Mock capability=true로 공개 클라이언트를 검사했으므로 이 결과를 실제 서버
플래그나 실계정·모델·DB 검증으로 사용하지 않는다. 실제 마이크·ASR·WebRTC·
음향 에코/소음·친근함·운율·통화 지연 분포도 범위 밖이다. 실제 provider 요청,
계정/DB/allowlist 변경과 추가 모델 품질 검사는 없었다.

안전한 JSON metadata와 PNG만 복사했다. 원본 공개 HTML/JS/Worklet bytes는
scratch에 보존하고 서비스 설정 값·private 경로·인증 상태는 여기에서 제외했다.
줄인 JSON은 원본 hash를 기록했고 PNG는 원본과 byte가 같다. 새 증거는 이
`public-notice/`에만 두며 역사 자료 `public/`을 수정하지 않는다.
