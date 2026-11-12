# 무발화 오응답과 잡음 중단 수정

2026년 11월 12일 KST. 기준 main 소스 `77be373699ad22c870613c210554037c4e2dd8aa`, 수정 전 공개 앱 `e72320c9e74833808284946fe235d88f150da551`. 이번 변경은 [이전 설계](quality-and-opening-design-20261112.md)의 발화 제어 후속 구현이다. 이전 페르소나·AEC/NS·서버 필터 배포만으로 이번 VOC가 해결됐다고 판단하지 않는다.

## 확인한 근거

읽기 전용 운영 자료의 최신 통화는 11월 12일 19:26:50–19:29:10 KST다. 사용자 첫 전사보다 assistant 첫 전사가 약 27.8초 먼저 수신됐으며, 첫 내용도 중립적인 인사를 넘어 이미 요청을 받은 듯한 설명이었다. 수신 시차만으로 실제 음향 순서 전체를 복원할 수는 없지만 첫 응답 문제를 뒷받침한다. 해당 브라우저는 오래된 `git:1900a608` 빌드였고, 서버에는 앞선 페르소나와 소음 필터 정책이 적용돼 있었다. 따라서 구형 탭만을 원인으로 단정하지 않는다.

기존 클라이언트는 연결 후 별도 목적 없이 `response.create`를 보냈고 과거 대화가 같은 지침에 들어갔다. 서버는 `interrupt_response:true`로 감지된 입력에 자동 중단했다. `semantic_vad.eagerness:low`는 발화 종료 판단을 바꾸며 작은 소음의 시작 감지를 차단하는 설정은 아니다. 당시 실효 오디오 설정·중단 원인 진단이 없어 실제 에코/잡음별 오탐률은 알 수 없다. 저장 원문·실제 식별자는 이 문서에 싣지 않는다.

## 시작과 응답 소유권

새 서버는 config에 `manual_turns_v1` capability를 보낸다. 새 브라우저가 이를 요청하면 세션을 처음부터 `create_response:false`, `interrupt_response:false`로 생성한다. 실효 정책 ACK 후에만 앱이 응답을 만든다. 구형 브라우저는 기존 provider VAD 동작을 유지한다.

시작 응답은 `input:[]`와 별도의 전체 인사 지침을 사용한다. 이 지침은 페르소나·언어·안전·현재 시간 정책을 유지하되 과거 전사·사용자 사실·학습 목표·준비 주제를 넣지 않는다. 사용자가 새로 말하지 않았는데 이전 질문에 답하거나 이미 설명을 들은 듯 감사하지 않도록 목적을 명시한다. 첫 유효 발화가 먼저 들어오면 시작 인사를 생략한다. 잡음으로 열린 provider candidate는 혼자서 시작 인사를 무기한 지연시키지 못한다.

일반 응답은 인정된 사용자 입력과 생성·재생을 모두 마친 assistant item만 `item_reference`로 넣는다. 원래 전체 대화 기록을 자동 입력으로 다시 읽지 않는다. 응답 생성 nonce·purpose, response ID, 취소 ACK와 출력 종료를 각각 확인하며 중복 전사·재연결로 응답을 다시 만들지 않는다. 생성 완료와 음성 재생 완료를 구분한다.

## 마이크와 중단

브라우저에는 기존 `echoCancellation:true`, `noiseSuppression:true`를 계속 요청하고 실제 보고값을 진단한다. 서버에는 기본 `far_field`를 요청한다. 장치의 출력 경로나 휴대폰 모드를 자동 감지했다고 표시하지 않는다.

추가 판별은 브라우저 안의 고정 버전 libfvad WASM으로 한다. 16kHz/20ms 프레임과 여러 프레임의 지속성, 약한 에너지 하한, 높은 zero-crossing 잡음 패턴을 함께 사용한다. 출력 오디오와 강하게 일치하는 지연 파형은 에코 후보로 제외한다. 원격 출력 자체가 있다는 이유만으로 사용자 말을 차단하지 않는다. 판별 그래프는 0만 출력하며 원래 마이크 전송을 대신하지 않는다. 오디오·특징 벡터를 서버나 저장소로 추가 전송하지 않고 최대 약 360ms 분석 버퍼만 메모리에 둔다.

provider의 speech candidate와 최근 로컬 음성 근거가 함께 있을 때만 진행 중 답변을 취소한다. 정상 후속 응답은 commit과 비어 있지 않은 최종 전사까지 기다린다. 단순 speech_started, 잡음 전사, 진폭 상승 하나로 응답을 끊거나 새 답변을 만들지 않는다. `답변 멈춤`은 명시적 중단이며, 판별 실패·놓친 발화는 말을 마친 뒤 `답변 요청`으로 복구한다. 이 버튼은 현재 경계의 최신 전사만 인정하며 예전 미확인 잡음을 다시 승인하지 않는다.

## 저장과 긴 통화

원래 사용자 전사는 저장·부분 기록 회계에 그대로 남긴다. 실시간 응답에 쓰지 않은 입력을 삭제하거나 전사 실패를 숨겨 성공으로 표시하지 않는다. checkpoint에는 별도 `qualifiedEventIds`로 인정된 전사 UUID만 보낸다. 서버는 같은 계정·통화의 부분집합인지 확인하고 이 자료로만 현재 통화 검색 질의와 요약을 만든다. 구형 전체 전사 checkpoint와 캐시를 격리한다. 실시간 item 삭제 후에도 이미 인정된 저장 전사의 자격은 유지한다.

이 수정은 모든 과거 통화의 ASR 정확도나 이미 생성된 장기 기억을 소급 정정하지 않는다. 원문 보존과 후속 학습 분석의 근거 자격을 영속적으로 구분하는 전체 설계는 별도 범위다.

## 검증과 한계

실제 WASM을 합성 WAV에 적용해 조용한 음성, 44.1/48kHz, 무음·단발 충격·정상 백색잡음, 지연/감쇠된 동일 파형을 확인한다. 브라우저 검사는 provider/API를 fixture로 대체하며 ACK·음성 판별·중단·수동 복구·저장·checkpoint의 연결을 검증한다. native WebAudio 그래프와 배포 형식의 hash CSP/SRI에서도 WASM 동작을 확인한다. 모바일 화면과 큰 글자 조작을 별도로 검수한다.

최종 CI 전체 회귀 393개와 전체 브라우저 검사가 통과했다. 개정 브라우저 5개 시나리오에서는 checkpoint 2회에서 같은 인정된 저장 UUID만 사용하며, 잡음·취소된 AI 원문은 저장 상태로 남고 요약에서 제외됨을 확인했다. 기존 브라우저·통화 신뢰성·오디오 회귀도 통과했다. [390px 재생 화면](design/qualified-voice-turns-20261112/playing-390.png), [320px 큰 글자 복구 화면](design/qualified-voice-turns-20261112/manual-reply-320.png)을 직접 확인했다. [검증 집계](design/qualified-voice-turns-20261112/fixture-results.json)는 실제 음향 효과를 검증하지 않았음을 명시한다.

이 검사는 실제 휴대폰의 잔향·왜곡 에코·방송 음성·속삭임과 모든 잡음의 정확도를 입증하지 않는다. 다른 사람이나 방송의 지속적인 말소리는 사용자 의도와 구분되지 않을 수 있다. 실제 기기에서 잡음 오중단 감소와 짧고 조용한 발화 보존을 함께 비교해야 한다. 새 제어를 쓰려면 진행 중 통화를 종료한 뒤 기존 탭을 새로고침하거나 다시 열어야 한다. 저장소 삭제는 요구하지 않는다.

실제 공급자 계약도 별도로 확인했다. 계정·DB·allowlist를 바꾸지 않는 짧은 임시 함수에서 기존 서버 자격을 재사용했고, API 키를 추출하거나 외부 결과에 넣지 않았다. WebRTC SDP 교환은 HTTP 200이었으나 검사 환경에서 RTC 데이터 채널이 열리지 않아 실제 재생은 미검증이다. 이후 서버 WebSocket 1세션에서 manual false/false·far_field 실효 ACK, 정확히 2회의 `input:[]` 시작 응답과 `item_reference` 후속 응답, 양쪽 metadata·completed·audio.done을 확인했다. 오류는 0이며 WS를 닫고 임시 함수를 삭제한 뒤 관리 목록에서도 부재를 확인했다. [안전 집계](design/qualified-voice-turns-20261112/provider-contract.json)는 WebRTC 재생 버퍼와 실제 기기 음향이 검사 범위가 아님을 구분한다.

## 배포 확인

[PR 17](https://github.com/chungchung234/English/pull/17)을 병합한 앱 커밋은 `47f15298763890a1690446d97f6899656515bece`다. [CI 및 배포](https://github.com/chungchung234/English/actions/runs/43208912117)의 전체 검사·서버·Pages 배포·배포 후 access 검사가 성공했다. 배포 후 CI의 임시 계정은 승인되지 않았으므로 실제 voice 경로는 기존 접근 정책대로 실행하지 않았다. 위 별도 WS 검증과 혼동하지 않는다.

[공개 사이트](https://chungchung234.github.io/English/)의 실제 HTML·JS 바이트와 SRI/hash CSP·런타임 `LOOP_CLIENT_BUILD`가 의도한 앱 커밋과 일치했다. [공개 빌드 근거](design/qualified-voice-turns-20261112/public-artifact.json)와 [공개 번들 회귀 결과](design/qualified-voice-turns-20261112/public-fixture-results.json)를 남겼다. 인증·provider/API만 fixture로 대체하고 공개 HTML·JS는 수정하지 않았다. 같은 5개 흐름과 native WebAudio/WASM이 통과했고 [공개 390px](design/qualified-voice-turns-20261112/public-playing-390.png), [공개 320px 큰 글자](design/qualified-voice-turns-20261112/public-manual-reply-320.png)를 직접 확인했다. 후속 문서 커밋은 앱 동작을 바꾸지 않는다.

운영 함수 본문에서 `greeting-purpose-v2` / `qualified-turns-v3`, capability 협상·처음부터 manual false/false·기억 없는 전체 opening·목적 지침 반환·checkpoint 부분집합 검증과 캐시 격리를 확인했다. 기존 DB migration 체크섬·제약·RLS/RPC 권한도 읽기 전용으로 확인했다. [운영 확인 집계](design/qualified-voice-turns-20261112/production-inspection.json)의 41개 항목이 모두 통과했으며 운영 계정·통화·전사에는 쓰지 않았다.
