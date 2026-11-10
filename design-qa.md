# 모바일 통화·최근 통화·복습 디자인 QA

final result: passed

## 말하기 속도 슬라이더 · 2026-11-10

사용자가 선택한 하단 패널 시안에 슬라이더 요청을 반영했다. 기준 코드는 원격 최신 `50be3e4`이며, 과거의 사람 아바타·연두색 화면은 사용하지 않았다.

- Source visual truth: [슬라이더 수정 시안](docs/design/speech-speed/reference.png), 852×1846px. 390×844 CSS 크기로 정규화했다.
- 구현: [Alex·0.85배 초안](docs/design/speech-speed/sheet-alex.png), [실제 앱 이벤트 연결·Mia](docs/design/speech-speed/sheet-mia.png), [320px 패널](docs/design/speech-speed/compact.png). 구현은 390×844/320×568 CSS px, deviceScaleFactor 1.
- 같은 Alex·02:34·현재 1.0배/초안 0.85배 상태의 [전체 비교](docs/design/speech-speed/comparison.png)와 [패널 확대 비교](docs/design/speech-speed/comparison-sheet.png)를 한 입력으로 열어 대조했다. Alex 비교는 현재 앱 HTML/CSS/렌더러에 합성 상태를 설정한 캡처이며, 통화 연결을 의미하지 않는다. Mia 증거는 실제 앱 코드에 모의 인증·음성 전송을 연결해 캡처했다.
- 글꼴·타이포그래피: 기존 시스템 한글 산세리프, 패널 제목·36px 배속·보조 문구 위계를 보존했다. 줄 잘림 없음.
- 간격·배치: 기존 오브·통화 정보·하단 종료 구조 보존, 음소거와 힌트 사이에 속도 버튼 추가. 44px 이상 입력/버튼 영역, 작은 화면에서는 패널 자체 스크롤 제공. 키보드 포커스 외곽선이 눈금 라벨과 겹치지 않도록 간격 확보.
- 색·토큰: 남색 통화 화면과 글래스 버튼 유지. 파란 진행 트랙·밝은 손잡이·파란 적용 버튼 사용. 감소된 투명도/고대비 설정에는 불투명 패널 제공.
- 이미지: 최신 승인 AI 캐릭터와 기존 아이콘 그대로 사용. 시안의 추가 광택을 가짜 그림으로 재현하지 않았다.
- 문구: ‘말하기 속도’, ‘AI 음성에만 적용돼요’, ‘기본 속도로’, ‘다음 답변부터 적용’. 말투/성격 설정 없음.

비교 이력: 최초 구현에서 네이티브 트랙의 회색 테두리와 작은 손잡이가 시안과 달랐다(P2). 실제 range 입력을 유지하면서 aria-hidden progress로 트랙을 채우고 손잡이를 24px로 조정했다. 재캡처·전체/확대 비교에서 이 불일치를 해소했다. 키보드 포커스와 눈금 라벨 간격도 보완했다. 잔여 P0/P1/P2 없음. 실제 CSS 투명 재질과 생성 시안의 광택 차이는 P3이다.

검증: `npm run check`, `npm test` 120/120, `npm run test:browser`, 설정이 포함된 빌드 통과. 최종 슬라이더 스타일 이후 `node test/browser.mjs`를 반복해 실제 마우스 드래그·화살표/Home/End·취소/기본값·응답 생성 및 재생 종료 대기·서버 확인·실패/재시도·다음 통화 초기 배속·기존 저장/피드백·CSP를 확인했다. JavaScript 오류 없음. 마지막 눈금 간격 조정 후 320px 적용 버튼 노출과 가로 넘침 없음도 재확인했다.

범위: 음성 API는 모의 응답으로 검사했다. 실제 제공자 실연결·iOS Safari 실기기 검사는 별도이며 공개 배포는 하지 않았다. 배포할 때는 선택적인 `speechSpeed`를 받는 함수를 먼저 갱신하고 웹을 게시해야 한다.

## 통화 이후 기능 추가 · 2026-11-10

기존 디자인 패턴에 표현 하나 연습·가리기·미루기·직접 연습 표시·다음 통화 준비를 연결했다. [화면 및 구현·검증 범위](docs/post-call-flow.md)를 기록했다. 390px/320px 합성 데이터 브라우저 검사에서 클라우드 저장 실패·재시도·새로고침 복원·주제 준비 후 마이크 미연결을 확인했다. [게시 파일·DB 검증](docs/design/post-call/deployed-verification.json)을 함께 보존한다.

## 최근 통화·복습 추가 검수 · 2026-11-10

기준은 직전 검수에서 제시한 [최근 통화](docs/design/tabs-refinement/before-history.png)·[복습](docs/design/tabs-refinement/before-review.png), 승인된 통화 홈의 디자인 패턴, 사용자가 진행을 요청한 네 보완 항목이다. 새 브랜드나 새 시각 방향으로 교체하지 않았다.

- 구현 증거: [최근 통화](docs/design/tabs-refinement/01-history.png), [복습](docs/design/tabs-refinement/03-review.png), [통화 상세](docs/design/tabs-refinement/call-detail.png).
- 전체 비교: [최근 통화 전후](docs/design/tabs-refinement/comparison-history.png), [복습 전후](docs/design/tabs-refinement/comparison-review.png).
- 확대/추가 상태: [문장 대비](docs/design/tabs-refinement/comparison-contrast.png), [320px·상세·긴 대화문·빈 상태](docs/design/tabs-refinement/comparison-states.png).
- Source/implementation: 390×844 px/CSS px, deviceScaleFactor 1, 로그인 후 동일한 합성 기록·피드백. 추가 320×568. 기기 프레임 없음. 대비 영역만 1.5배로 확대했으며 새로운 화면 요소를 그리지 않았다.

| 필수 표면 | 결과 |
| --- | --- |
| 글꼴·타이포그래피 | 시스템 한글 산세리프와 기존 위계 유지. 320px 첫 화면에 교정 문장 표시. 원문 대비 5.93:1. |
| 간격·배치 | 목록의 행당 최대 5개 버튼을 상세/다시 걸기 두 진입으로 정리. 긴 대화문은 본문만 스크롤하고 닫기 버튼은 유지. 작은 화면 가로 넘침 없음. |
| 색·토큰 | 승인된 블루·네이비·녹색과 글래스 조작부 유지. 통화 홈의 발신 및 목록의 다시 걸기는 플랫. |
| 자산·아이콘 | 기존 승인 AI WebP와 Phosphor 아이콘. 새로 사용한 새로고침 아이콘은 기존 패키지의 regular/arrow-clockwise다. |
| 문구·내용 | 교정/연습 우선, 부가 분석 접기, 이름/안내 반복 감소. 검색에는 대상 상대를 표시하며 검색 범위를 넓히지 않았다. |

비교 이력: 최초 P2는 목록 조작 과밀, 교정이 뒤로 밀림, 3.61:1 원문 대비, 데이터 없이 활성화된 분석 버튼이었다. 각각 통화 상세로 분리, 교정/연습 우선 배치, 5.93:1 토큰, 상대별 7일 종료 통화 확인으로 수정했다. 수정 후 전체/확대/작은 화면 비교에서 남은 P0/P1/P2 없음.

검증은 실제 Chromium·배포 구조 CSP 검사와 합성 API 데이터로 수행했다. 실행 오류 0건. 전체 브라우저 회귀 검사, 추가 탭 검사, 타입/문법, 서버/DB/빌드 테스트 82/82 통과. 느린 대화문의 다른 통화 유입 방지, 선택 상대 보존, 주간 결과 표시·중복 방지·빈 상태·30개 밖의 대상도 확인했다. 목록 재조회 응답을 일부러 늦춰 상세를 먼저 연 뒤 목록 항목을 교체하는 조건에서도 피드백 전환이 유지되는 것을 재현 검사했다. [상세 기록](docs/design/tabs-refinement/README.md), [메타데이터](docs/design/tabs-refinement/verification.json).

게시 검증: 앱 릴리스 `e353757c5d95c37941ea6d39db088def2bc6f427`의 [배포 검사](https://github.com/chungchung234/English/actions/runs/42761308461)가 성공했다. 공개 HTML은 동일 설정의 릴리스 빌드와, 세 AI 이미지는 승인 원본과 바이트 단위로 일치한다. 게시 파일을 변경 없이 렌더링한 [최근 통화](docs/design/tabs-refinement/deployed-01-history.png), [320px 복습](docs/design/tabs-refinement/deployed-04-review-compact.png) 및 상세·빈 상태를 확인했다. 보호 API만 합성 응답으로 대체했다. 가로 넘침 없음, 실행 오류 0건, 원문 대비 5.93:1이다. [전체 게시 증거](docs/design/tabs-refinement/README.md#게시-확인).

이하 통화 홈의 기존 검수와 게시 파일 기록을 보존한다.

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

## 게시 파일 확인

[배포 검사](https://github.com/chungchung234/English/actions/runs/42755922694) 성공. 앱 릴리스 `caabb35fff8285d8f7cbd77669282490643d3564`의 공개 HTML과 세 AI 이미지의 검증된 HTTPS 다운로드를 확인했다. 세 이미지는 저장소의 승인 원본과 바이트 단위로 동일하다. 다운로드한 HTML과 이미지를 변형 없이 게시 URL·CSP에서 렌더링한 [390px 홈](docs/design/call-glass/deployed-home.png), [320px 홈](docs/design/call-glass/deployed-compact.png)을 직접 열어 확인했다. 보호 API만 합성 응답으로 대체했으며 가로 넘침 없음, 플랫 발신 버튼, Mia 선택, 실행 오류 0건이다. [메타데이터](docs/design/call-glass/deployed-verification.json).
