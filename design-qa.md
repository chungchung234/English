# 통화 홈 디자인 QA

final result: passed

## 비교 대상과 상태

- Source visual truth: [수정 시안](docs/design/call-glass/reference.png). 원본 `/workspace/generated_images/exec-c91b090e-a26c-4609-981a-8a82fea76e24.png`에서 그대로 보존했다.
- 최종 사용자 지시: 시안의 발신 버튼 광택·그림자는 제거하고 기존 플랫 녹색으로 유지한다. 이 지시가 정적 시안의 해당 부분보다 우선한다.
- 구현: `web/index.html`, `web/style.css`, `web/app.js`, `web/ai-presence.js`의 실제 Chromium 렌더.
- State: 로그인 후 통화 전, Alex 선택, 정지 모션. 실제 사용자 계정 대신 브라우저에 한정된 합성 인증·API 응답을 사용했다.
- Source pixels: 852×1846. [정규화](docs/design/call-glass/reference-normalized.png): 390×844.
- Implementation pixels/CSS viewport: 390×844, deviceScaleFactor 1. 기기 프레임·브라우저 UI 없이 비교했다. 정규화 비율의 1px 미만 차이를 정밀한 치수 차이로 판정하지 않았다.
- 구현 증거: [Alex](docs/design/call-glass/home-alex.png), [Juno](docs/design/call-glass/home-juno.png), [Mia](docs/design/call-glass/home-mia.png).
- Full-view comparison: [최종 대조](docs/design/call-glass/comparison-final.png).
- Focused comparison: [선택 바·플랫 발신·하단 메뉴](docs/design/call-glass/comparison-controls.png).

## 비교 이력과 수정

1. 초기: [전체 대조](docs/design/call-glass/comparison-initial.png). 선택 이름 버튼의 실제 누름 높이가 38px로 작았다(P2). 선택 바를 48px, 실제 버튼을 44px로 조정했다.
2. 초기 캐릭터 전환: [상태 대조](docs/design/call-glass/comparison-states-initial.png). 첫 Juno 선택에서 이전 Alex 텍스처가 남은 프레임을 확인했다(P2). 새 텍스처가 준비되기 전 동일 캐릭터 포스터로 전환하고 렌더 준비 표시를 초기화했다. 검수와 브라우저 검사도 현재 상대의 실제 렌더 준비 및 선택 캡슐 이동 완료를 기다린다.
3. 수정 후: [상태 대조](docs/design/call-glass/comparison-states.png). Juno의 아쿠아 비대칭 구체와 Mia의 라벤더 구체가 선택 상태와 일치한다. 44px 누름 영역, 작은 화면 발신 버튼 위치, 대비 증가 대체 표면도 확인했다. 최종 전체/확대 대조에서 추가 P0/P1/P2 수정 사항 없음.

## 필수 검수 표면

| 항목 | 결과 |
| --- | --- |
| 글꼴·타이포그래피 | 시스템 한글 산세리프, 선택 이름 18px, 성격 14px, 발신 18px. 이름은 선택 바에서 한 번만 보이고 잘림 없음. 플랫폼별 시스템 폰트 차이는 예상 범위다. |
| 간격·배치 | 기존 120px 로고와 22px 좌우 여백 유지. 중앙 구체·성격·발신의 위계가 시안과 대응한다. 선택 바 48px는 누름 영역 확보를 위한 의도된 차이다. 320×568에서도 버튼/도크 겹침·가로 넘침 없음. |
| 색·재질 | 블루 선택, 네이비 글자, 녹색 발신의 토큰 유지. 상단·설정·하단의 공통 글래스 재질. 발신은 최종 지시대로 그림자 없는 플랫 녹색. |
| 이미지·아이콘 | 승인된 세 WebP와 실제 WebGL 렌더 사용. 로고 비율 유지. 사람 모양 CSS 그림 대신 기존 Phosphor 수화기·이력·책 아이콘을 사용한다. |
| 문구·콘텐츠 | 연락처 제목·검색·명수·AI 배지·통화 전 제한 문구·중복 이름 제거. 성격 한 줄과 간결한 ‘통화’ 행동 유지. |

## 동작·접근성·기존 기능

- 실제 Chromium에서 상대 선택, 화살표/Home 키, 선택 유지, 기억 관리 진입, 통화 시작/실패 복귀, 음소거/힌트/종료, 기록·복습·다시 걸기, 오프라인 재전송 및 배포 CSP를 검사했다.
- 상대 선택은 통화를 시작하지 않는다. 통화 중에는 상대와 계정 변경이 잠긴다. 스크린리더 이름에는 AI 상대와 통화 대상이 남는다.
- 선택 버튼 44px. 키보드 포커스, 동작 줄이기, 대비 증가/투명도 감소 대체 표면을 제공한다.
- [검수 메타데이터](docs/design/call-glass/verification.json): 가로 넘침 false, 발신 그림자 none, 작은 화면 발신 하단 434px < 도크 상단 486px, console errors 0.
- `npm test` 82/82, `npm run check`, `npm run test:presence`, `npm run test:browser` 통과. AI와 OAuth 업스트림은 모의다. 제공자 실계정 통화, 실제 Safari 및 완전한 WCAG 적합성은 이 검수의 주장 범위가 아니다.

## 구현 체크리스트

- [x] 승인된 구조와 최종 플랫 버튼 지시 반영
- [x] 구분선 없는 선택 바와 공통 글래스 조작부
- [x] 세 캐릭터 실제 렌더와 전환 일치
- [x] 390px/320px 및 대비 증가 상태 비교
- [x] 핵심 통화·저장·기억·인증 회귀 검사

## 후속 미세 조정

P3: 플랫폼에 따른 글자 두께와 웹 글래스의 광학적 차이는 실기기 확인 때 조정할 수 있다. 현재 추가 배치를 바꿀 정도의 시각 불일치는 없다.
