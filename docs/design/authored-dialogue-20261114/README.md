# 작성 대화·버퍼 음성 배포 검증

최종 웹 릴리스는
[`8d3f2a27dac84c1edd75631e5b8cef34ffadbb83`](https://github.com/chungchung234/English/commit/8d3f2a27dac84c1edd75631e5b8cef34ffadbb83)이며,
[CI·Pages 게시 43594165637](https://github.com/chungchung234/English/actions/runs/43594165637)가 성공했다.
공개 파일과 복구 안내 동작까지 확인했다.

2026-11-14 작성 대화 경로를 처음 활성화한 소스는
[`10be1faaec5ec821fcb7b7e39af8380fa188555c`](https://github.com/chungchung234/English/commit/10be1faaec5ec821fcb7b7e39af8380fa188555c)이며,
[CI·Pages 게시 43591361404](https://github.com/chungchung234/English/actions/runs/43591361404)가 성공했다.
이 기록은 배포·프로토콜·재생 검증의 결과이며, 친근함이나 실제 기기 음향의 완료 판정은 아니다.

## 구현한 동작

브라우저 마이크의 입력은 WebRTC로 전사하고, 저장 ACK가 있는 현재 사용자 원문과
적격한 이력으로 내용을 작성한다. 서버에 저장된 문장만 별도 Realtime OOB 합성에
보내며, 전체 PCM·digest·소유권·완료·보고 전사와 작성 원문의 단어열을 검증한 뒤
브라우저의 독립 player/Worklet이 재생한다. 시작 요청의 현재 사용자 발화는 없음으로
전달한다. 페르소나·관점·기억의 입수 경계를 유지하며, 교사 역할이나 필수 연습을 추가하지 않는다.

작은 소리로 발화 후보가 생기면 버퍼 커서와 리샘플 위상을 보존한 채 잠정 정지한다.
빈 전사·잡음 기각에는 같은 위치에서 이어가고, 실제 발화가 채택되면 이전 버퍼를
취소한다. 전사 실패·판단 미확인에는 이어 듣기·답변 멈춤을 제공한다. 중지·계정 변경·
기억 권한 변경 뒤의 지연 완료는 재생이나 공유 기억 근거로 되살리지 않는다.

원문은 보존한다. 긴 통화의 적격한 이력은 checkpoint와 최근 원문으로 전달하며,
10분 경과만으로 정리하거나 종료하지 않는다. 현재 브라우저의 별도 통화 상한은
50분이다. 이 시간 상한은 과거 이력 삭제 정책이 아니다. 제품의 16개 runtime 모듈은
암호화 reasoning·continuation을 저장·재전달하지 않고 적격한 plaintext 이력으로
매 요청의 문맥을 만든다. 앞선 작성기 12응답 실험의 서버 메모리 reasoning 재전달과 구분한다.

## 복구 안내 수정과 최종 배포

초기 `10be1faa` 공개 검수에서 복구 성공 뒤 이전 실패 안내가 잠시 남는 것을
관찰했다. `8d3f2a27`은 안내의 실제 DOM 노드를 소유권으로 보관하고, 같은 통화의
새 권한이 확인된 뒤 그 안내만 즉시 지운다. 복구 실패에는 마이크 차단과 안내를
유지한다. 새 저장·전사 누락 경고가 나타났으면 지우지 않는다. 중복된 연결 이벤트도
자신이 만든 재연결 안내만 닫으며, 이용 한도 안내는 이 복구 경로에서 제외한다.

- [최종 CI](release-notice/ci-success.json)와 [운영 소스·DB 대조](release-notice/production-inspect.json):
  DB 49/49, 서버 102/102 통과. 서버 ESZIP digest와 16개 모듈은 초기 활성화 때와 같다.
- [최종 공개 파일](release-notice/public-exact.json): 원래 CDN HTML/main/Worklet과 정확한
  committed 소스의 재빌드 바이트·SRI·CSP를 대조했다.
- [최종 공개 기능](public-notice/public-results.json): 원래 공개 파일에서 12/12 모의 흐름을
  통과했다. 503 복구 실패·즉시 안내 제거·대기 중 새 경고·연결 이벤트 반복과 모의 끊김·복구를 포함한다.
  320/390px·글자 125% 복구 화면을 직접 열었고 이전 실패 안내가 없는 것을 확인했다.
- [로컬 관련 검사](release-notice/local-checks.json): helper/floor 78개, 작성 통화 12개와
  일반 브라우저 검사가 통과했다. [검증 범위](release-notice/verification-scope.json)는
  실제 승인 계정 통화·실기기 음향을 검증하지 않았음을 명시한다.

기능 플래그는 초기 활성화 기록을 유지하며 이번 UI 수정에서 변경하지 않았다.
추가 모델 생성이나 플래그 검사 함수 호출은 하지 않았다. 최초 활성화와 최종 안내
수정의 증거를 서로 덮어쓰지 않고 보존한다.

## 작성 대화 초기 활성화에서 확인한 범위

| 확인 | 결과와 근거 |
| --- | --- |
| 소스·스키마 | [운영 검사](release/production-inspect.json): DB 메타데이터 49/49, coach 검사 102/102. 16개 원본 TS와 실제 실행 JS, `ws@8.18.3`의 19개 파일·단일 redirect·snapshot·실행 경로를 대조했다 |
| 의존성 출처 | [WS 출처](release/ws-package-provenance.json): 원래 캐시 tarball의 SHA512가 committed lockfile과 같고 19개 파일 바이트가 일치했다. 알 수 없는 모듈·재매핑·실행 코드 변경은 허용하지 않는다 |
| 공개 파일 | [공개 바이트 검사](release/public-exact.json): 원래 HTML/main/Worklet을 정확한 committed 소스로 다시 빌드해 바이트·SRI·Worklet hash와 정확한 CSP URL을 대조했다 |
| 공개 화면·동작 | [공개 빌드 결과](public/public-results.json): 실제 공개 HTML/JS/Worklet에서 모의 인증·DB·RTC·작성·합성 응답을 사용하는 12개 흐름 통과. 실제 운영 계정의 통화 검사는 아니다 |
| 활성화 | [설정 변경](release/feature-activation.json): 소스·스키마·CI·공개 검증 뒤 두 기능 플래그를 활성화했다. 다른 비밀값·앱 데이터를 변경하거나 모델을 호출하지 않았다 |
| capability | [독립 확인](release/flags-observation.json): capability·feature·fidelity·reservation이 모두 true. 한 번의 빈 요청 후 임시 함수 DELETE와 별도 목록 조회로 부재를 확인했다. 공유 프로젝트 환경 확인이며 실제 승인 계정의 전체 통화 증거는 아니다 |

원문·음성·비밀값을 포함하지 않는 [검증 범위](release/verification-scope.json),
[CI 기록](release/ci-success.json), [검증기 부정 테스트](release/verifier-offline-checks.json)와
[실제 배포 형식 검토](release/parser-profile-note.json)를 보존한다.
runtime tree는 `9080f39f63615fd7ec6a913cc737199fe83f953eb28c6f29eec851cd5cfc336a`,
SQL migration은 `1eb83b05228c62d4b4f0c12b47726011ba4bf381a6379a2cbb0db3a48622d296`다.

## 실제 생성과 네이티브 재생

[실제 모델 평가](../../companion-model-evaluation-20261114.md)와
[통합 helper 검사](combined-probe-evidence.json)는 UI fixture와 별도의 증거다.
제품의 plaintext 경로로 Alex의 독립 startup/reply 두 사례에서 작성 2회·합성 2회를
완료했고, 보고 전사와 원문 단어열이 일치했다. 같은 브라우저 시계의 요청 시작부터
post-gain 참조의 첫 유효 샘플까지 5255.1ms·5662.8ms로 사전 6000ms engineering
기준을 통과했다. 두 응답을 새로 이어 붙인 연속 통화는 아니며, 이 측정에는 실제
인증·DB·ASR와 앱의 분리된 두 요청 경로가 포함되지 않는다. 실사용 지연 분포나
물리적 스피커에서 소리를 들은 시각으로 표현하지 않는다.

[로컬 브라우저 검수](client/README.md)는 실제 WebAudio·Worklet·CSP와 모의
RTC/ASR/backend로 취소·잠정 정지·같은 위치 재개·권한 변경·저장·예산 제한을
확인했다. PCM은 합성 tone이며 실제 음성 품질이나 마이크 성능의 근거가 아니다.
출력 timestamp로 확인한 완료도 client report다. 확인되지 않은 `estimated_drain`은
공유 기억·채택된 assistant 이력의 근거로 쓰지 않는다.

## 남은 품질과 기기 검증

- 초기 B 작성 표본에서는 메뉴형 시작이 줄고 구체적인 이유가 나왔지만, 세 캐릭터의
  같은 첫 인사·비슷한 반응 구조와 통화 사이 사고를 암시하는 표현도 남았다.
  현재 plaintext 통합 두 사례도 익숙한 인사·가격표 질문 패턴을 유지했다.
  같은 캐릭터의 반복 통화 다양성·친구 같은 상호성·사용자 선호는 아직 입증하지 않았다.
- 보고 전사 일치는 독립적인 파형 ASR나 실제 청취 검증이 아니다. 브라우저의
  에코·소음 억제 요청, post-gain 참조와 커서 재개는 소프트웨어 동작 검사다.
  실제 PC Chrome/Edge·휴대폰 마이크와 스피커, 방의 잔향·작은 소음의 오탐과
  체감 끊김은 기기별 후속 평가가 필요하다. 즉시 무음이나 물리적 에코 제거를 보장하지 않는다.
- 승인된 실제 계정의 로그인부터 마이크·전체 통화·저장·운영 retrieval까지 이어지는
  실연결은 이 배포 검사로 확인하지 않았다. 학습 효과·완전 회상도 평가하지 않았다.

후속 검증은 같은 캐릭터의 반복 통화와 적응적인 사용자 발화, 실제 기기의 조용한 환경·
스피커 출력·주변 소음 조건, 운영 전체 지연을 각각 구분해 평가한다. 문장 수나 인사 길이를
더 제한한 결과를 자연스러움 개선으로 대신 판정하지 않는다.
구체적인 holdout·맹검·반복 통화 설계는
[친근한 대화 평가 계획](../../research/natural-companion-dialogue-20261113.md#7-비교-실험과-도입-기준)에 있다.
