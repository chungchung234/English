# 고정 합성 입력의 작성→낭독→native PCM 검사

동일 제품 helper를 연결한 독립 Alex 시작·후속 사례 2개에서 실제 작성 2개와
낭독 2개가 완료됐다. 승인 manifest는
`6272ece2601fdab3e903181695b2edaf2226bf04380bbae7385549afc348002f`,
backend 16모듈 동결 tree는
`9080f39f63615fd7ec6a913cc737199fe83f953eb28c6f29eec851cd5cfc336a`다.
추론 재시도·조건 수정·재실행은 없고 미확인 생성 수 상한은 0이다.

| 독립 고정 사례 | 요청→첫 nonzero native reference | 사전 6초 기준 | 전사·PCM·출력 완료 |
| --- | ---: | --- | --- |
| 시작 | 5255.1ms | 통과 | 통과 |
| 후속 | 5662.8ms | 통과 | 통과 |

이는 같은 브라우저 performance 시계의 직접 차이다. 앞선 작성/합성 검사 시간을
합한 값이 아니다. 전체 버퍼 검증 뒤 제품 player와 실제 Worklet을 실행했고,
각각 `played_through` 1회, CSP 오류·page error 0을 확인했다. 기본 제품
`createRealtimeReader()`가 주입된 대체 socket 없이 서버에서 실행돼 literal
`npm:ws@8.18.3` 경로가 작동했다. 전체 source provenance는 16모듈이며,
이번 helper bundle이 실제로 읽은 product input은 9개다.

측정은 local fixture relay와 임시 서버 helper pipeline, Worklet load/준비,
post-gain reference 관찰을 포함한다. 256프레임 native observer의 큐·스케줄링을
포함한 관찰 시각이며 실제 스피커에서 사람이 들은 시각은 아니다. 원래 앱의
별도 두 route/controller·인증·DB RPC·ASR은 실행하지 않았다. 실제 마이크와
WebRTC·음향 에코/소음·독립 파형 전사·통화 지연 분포·사용자 선호도 확인하지
않았다. 6초는 이 실험 전에 정한 engineering gate이며 사용자 전체의 SLO가 아니다.

두 입력은 독립돼 있고 후속은 기존 B의 plaintext 기록을 그대로 받았다. 새 시작
결과를 이어받은 연속 통화가 아니며, encrypted include/replay를 썼던 앞선 B12와
현재 plaintext writer 조건도 구분한다. 고정 과거 시작 3개가 있는 재접속 자료를
유지했고 결과를 보고 입력을 바꾸지 않았다.

Root가 실제 출력 2개를 읽었을 때 메뉴형 시작은 0개였으나 일반적인 기존 인사와
종이 달·가격표를 되짚은 뒤 가격을 묻는 구조는 남았다. 새 caller 발화를
지어내거나 오프라인 경험을 주장한 사례는 이 작은 표본에서 보지 못했다.
친근함과 동일 캐릭터 반복 통화의 시작 다양성이 해결됐다는 뜻은 아니다.
세부 범위는 [관찰 기록](quality-observations.json)에 있다.

임시 함수 2개는 삭제했고 별도 목록 GET HTTP200으로 부재를 확인했다. 실제
계정·DB·allowlist·운영 플래그는 변경하지 않았다. 원문·전사·PCM은 접근 제한된
scratch의 0600 파일에만 보존했다. 이 폴더에는 안전한 결과와 hash metadata,
owner 식별자를 hash로 바꾼 native snapshot만 있다. private fixture·원문·오디오·
인증 상태·배포 source는 포함하지 않는다. 추가 실제 추론은 승인되지 않았다.
