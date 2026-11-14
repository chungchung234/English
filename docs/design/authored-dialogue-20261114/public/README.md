# 공개 원본 자산의 통화 기능 검증

배포 `10be1faaec5ec821fcb7b7e39af8380fa188555c`, CI `43591361404` 성공 후
공개 사이트의 원본 HTML·main JS·Worklet으로 **12/12 흐름**을 통과했다.
로컬 자산으로 대체하거나 공개 자산을 fulfill/수정하지 않았다.

| 원본 자산 | SHA-256 |
| --- | --- |
| HTML | `c89ef678b3816e6023005da244c9df9eaf2d7ecd6a98042a286abb35e3e28b6c` |
| main JS | `8cf91e284679cef888d9c0a90620a75db33bff9f4d9f6d0cc62cad119ef37902` |
| Worklet | `41f9726d8d2bd7a8fe992aa17888f45a3ba7633092d30b2a2d687b3f6f7856ea` |

배포 build/SRI/해시 CSP/Worklet descriptor를 대조했다. 실제 브라우저가 읽은
HTML/main bytes도 별도 GET한 원본 hash와 일치했다. Worklet은 원래 CDN URL로
native `addModule`을 실행했고 실제 processor 동작과 native WASM을 확인했다.
Worklet의 브라우저 응답 body는 관찰되지 않아 그 응답 자체의 byte hash까지
검증했다고 주장하지 않는다. Worklet hash는 별도 원본 CDN GET에 근거한다.

12개 흐름은 초기 policy ACK, 빈 ASR의 동일 커서 재개, 실패 ASR의 직접 이어
듣기, 실제 caller로 분류한 합성 입력의 취소·raw 저장 ACK·provider prune,
페이지 lifecycle, SDK의 탭 간 로그아웃, 잘못된 PCM 차단·권한 복구, native
출력 위치 receipt, 이미 기억을 제외한 상태의 재복구와 현재 caller만의 receipt,
두 budget code의 생성 차단·raw 저장·종료, 약한 출력 위치가 strong receipt를
만들지 않는 경우다. 정확한 결과는 [public-results.json](public-results.json)에 있다.

인증·DB·writer·합성·RTC·ASR은 고정 모의 자료다. 응답 PCM은 음성이 아닌 tone이다.
모의 config의 authored capability=true로 공개 클라이언트를 실행했으며 실제 서버
플래그·실계정·모델·DB 동작을 이 결과로 입증하지 않는다. 실제 마이크·WebRTC·
음향 에코/소음·친근함·운율·실제 통화 지연 분포도 검증 범위에 포함되지 않는다.
추가 실제 모델 요청이나 DB/승인 목록 변경은 없었다.

320×568·390×844, 통화 글자 125%에서 PNG 9개를 직접 열었다. 이어 듣기·응답 중지·
다시 연결·통화 종료는 표시·hit test를 통과했고, 320px의 도움말·대화문은 스크롤로
접근했다. budget은 마이크/속도/힌트/재시도를 막고 raw 저장과 종료를 유지했다.

알려진 작은 UI 관찰: 복구 직후에는 “듣고 있어요”와 직전 실패 안내가 잠시 함께
보인다. 일반 실패 안내는 persistent=false이며 원래 생성 시점부터 **6000ms** 뒤
자동으로 지우는 코드다. 성공 복구가 기존 안내를 즉시 지우지는 않는다. 이번
캡처는 복구 직후라 이 겹침을 보였고, 실제 6초 뒤 사라지는 시점까지 기다려
관찰한 것은 아니다. 해당 경로는 모달/네이티브 alert가 아니며 통화를 종료하지
않는다. 지속적인 종료 경고로 분류하지 않았고 제품 수정이나 추가 실행도 하지
않았다. [notice-observation.json](notice-observation.json)에 코드 근거와 한계를 남겼다.

이 폴더에는 안전하게 줄인 결과·CI·준비/독립 검토 metadata와 PNG만 있다.
원본 공개 HTML/JS/Worklet bytes는 scratch에 보존하고 여기에는 복사하지 않았다.
원래 서비스 설정 값과 private 경로도 제외했다. JSON을 줄인 경우 원본 hash를
남겼으며 PNG는 원본과 byte가 같다.
