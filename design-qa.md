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

### 속도 기능 공개 배포 확인

[배포 실행 42807866662](https://github.com/chungchung234/English/actions/runs/42807866662)이 성공했다. 배포 소스는 `7f08a1956a422df4d1bc3b6110044f99105e7b9a`이며, 관리 API에서 coach 함수 버전 68의 ACTIVE 상태를 확인했다. [공개 사이트](https://chungchung234.github.io/English/)에서 실제 게시 HTML·해시 번들을 로드해 [패널](docs/design/speech-speed/deployed-sheet.png)·[통화](docs/design/speech-speed/deployed-call.png)·[320px](docs/design/speech-speed/deployed-compact.png)를 캡처했다. [검증 결과](docs/design/speech-speed/deployed-verification.json)에 0.85배 선택, 생성/재생 종료 대기, 확인 응답 후 반영, 작은 화면 적용 버튼과 JavaScript 오류 0건을 기록했다.

게시 번들 기능 검증의 인증·음성 전송은 모의 값이다. 실제 CI는 임시 비승인 계정의 데이터/API 접근 차단을 통과했으며, 승인 계정이 필요한 실제 AI 통화는 수행하지 않았다. 승인 목록을 변경하지 않았다.

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


## 원문 우선·별도 피드백 2안 · 2026-11-11

**Findings**

- 첫 비교의 P2: 헤더 76px와 제목 위 20px 여백 때문에 시안보다 내용이 아래로 밀렸고 영어 본문 16px가 작았다. 헤더 64px, 제목 위 12px, 영어 17px로 수정했다. [수정 전 비교](docs/design/post-call-dual-review-20261111/implementation/comparison-feedback-before.png), [수정 후 전체 비교](docs/design/post-call-dual-review-20261111/implementation/comparison-feedback.png).
- 첫 비교의 P2: 닫힌 ‘다시 쓸 표현’ 영역에 시안의 내용 미리보기가 없었다. 첫 두 표현의 2줄 미리보기를 추가하고, 펼치면 전체 목록을 표시한다. 학습할 개수는 제한하지 않는다. [수정 후 확대 비교](docs/design/post-call-dual-review-20261111/implementation/comparison-feedback-detail.png).
- 큰 글자 검수의 P2: 320px·200%에서 ‘피드백’ 제목이 글자 중간에서 나뉘었다. 제목에 단어 줄바꿈을 적용했다. [수정 후 큰 글자](docs/design/post-call-dual-review-20261111/implementation/09-feedback-large-text-320.png)에서 ‘이번 대화 / 피드백’으로 표시되며 가로 넘침이 없다.
- 비동기 검수: 처음 생성 요청 직전 재시도 버튼이 잠깐 나타나 예약 영역이 불필요하게 커지는 문제, 주간 분석까지 숨기는 선택자, 늦은 출처 조회의 잘못된 이동, 다른 회차 재시도 버튼 잠김, 무효화된 피드백 노출을 수정했다. 반복 수용/상태/원문 테스트로 확인했다.
- 최종 비교에서 남은 실행 가능한 P0/P1/P2 없음.

**비교 조건과 증거**

- Source visual truth: [선택한 2안](docs/design/post-call-dual-review-20261111/async-states/02-separate-feedback.png), 1424×1105px 이미지 보드. 가운데 원문 프레임 438×864px, 오른쪽 피드백 프레임 440×864px를 잘라 폭390px로 비례 축소했다. 생성 보드의 프레임 높이는 약766–769px여서 비교 캔버스 하단을 흰색으로 채워390×844에 맞췄다. 원본에 정확한 CSS 폰 크기는 없으므로 하단 위치 차이를 구현 오차로 판정하지 않았다.
- 구현: [13-aligned-ready-390.png](docs/design/post-call-dual-review-20261111/implementation/13-aligned-ready-390.png), [14-aligned-feedback-390.png](docs/design/post-call-dual-review-20261111/implementation/14-aligned-feedback-390.png). 실제 앱 렌더,390×844 CSS px/픽셀,deviceScaleFactor1. 같은6발화·4분32초·저장완료·사용자가 연 피드백. 통화 길이/서비스 전송은 합성 입력임을 명시했다.
- [원문 전체 비교](docs/design/post-call-dual-review-20261111/implementation/comparison-ready.png)와 [피드백 전체 비교](docs/design/post-call-dual-review-20261111/implementation/comparison-feedback.png)는 출처와 구현을 같은 이미지에 나란히 놓아 실제로 열어 확인했다. 교정/표현 영역은 같은 비교에서340px높이를 잘라1.5배 확대했다.
- 320×568,200% 루트 글자,지연/실패/빈 상태/복귀를 별도로 캡처하고 [측정값](docs/design/post-call-dual-review-20261111/implementation/metrics.json)을 남겼다.

| 필수 표면 | 최종 판단 |
| --- | --- |
| 글꼴·타이포그래피 | 기존 시스템 한글 산세리프와 영문 폴백 사용. 원문17px/1.55,주제목24/28px,피드백 항목18px. 생성 이미지의 미확정 폰트를 베끼지 않고 기존 제품과 일치시켰다. 200%에서 한글 단어 줄바꿈·영문 넘침을 확인했다. |
| 간격·배치 | 좌우22px,최소44px 터치,56px 주 버튼,하단96px+safe-area를 기본으로 한다. 시안의 읽기/준비완료/직접열기 구조 유지. 상단은 스크롤 중에도 뒤로/마치기에 접근하도록 고정했다. |
| 색·토큰 | 화이트 #fff,남색 #081744,보조 #59647c,주 버튼 #252bb5. 시안의 래스터 광택 대신 현재 앱의 단색 토큰을 사용한 의도적 차이. |
| 자산·이미지 | 새 장식이나 가짜 기기 프레임 없음. 기존 Phosphor chevron을 뒤로 아이콘으로 재사용. 생성 이미지 전체를 앱에 붙이지 않았다. |
| 문구·내용 | 원문·피드백·출처 연결을 유지. 기존 분석 스키마에 별도 교정 제목이 없으므로 짧은 이유를 제목으로 쓰고 중복 본문은 생략한다. 기록 정보/피드백 관리는 안전한 복구·제외를 위한 닫힌 보조 영역이다. |

**Implementation Checklist**

- 원문/피드백이 동시에 펼쳐져 과밀해지지 않음.
- 준비완료 자동이동 없음; 원문/피드백/출처 읽기 위치 보존.
- 마치기에 연습·미루기 쓰기 없음; 실제 피드백 화면을 연 경우만 열람 기록.
- 원문 늦은 도착,잘못된 저장ACK,생성실패,원문부족,재방문,계정/상대 전환 검증.
- 브라우저 오류0,타입·228단위/SQL테스트·12브라우저스위트·빌드·캐릭터/합성 평가 통과.

**Open Questions / Follow-up Polish**

실제 승인 계정 음성 연결과 iOS Safari 실기기,실사용자 관찰은 이번 검증 범위 밖이다. 사람의 학습 효과나 교정 품질을 통과했다고 주장하지 않는다. 별도의 잔여 디자인 수정은 없다.

final result: passed


## 학습 노트 명칭 적용 · 2026-11-11

사용자가 선택한 `학습 노트`를 제목/진입/준비/오류/복귀/보관함에 적용했다. 기존 레이아웃과 정보 구조를 유지하며 제목은 더 짧게 정리했다. [실제 390px 화면](docs/design/learning-note-copy-20261111/note-390.png), [320px·200% 큰 글자](docs/design/learning-note-copy-20261111/note-320-large.png), [긴 복귀 버튼](docs/design/learning-note-copy-20261111/source-return-320-large.png)을 열어 확인했다. 큰 글자에서 복귀 버튼의 ‘돌아가기’가 중간에서 나뉘는 문제를 단어 줄바꿈으로 수정하고 같은 조건으로 재캡처했다. [측정값](docs/design/learning-note-copy-20261111/long-copy-check.json): 276px 버튼 폭, 320×568 CSS px, 200% 글자, deviceScaleFactor1, 잘림/넘침/페이지 오류 없음. 기존 상태·통화 후 수용 검증 통과. 남은 P0/P1/P2 없음.

final result: passed
# First-use guidance and recovery — 2026-11-11

final result: passed

Scope: incremental first-visit improvements on the deployed `6c49728` design, following the reviewed recommendation to make guidance optional. The welcome sheet is intentionally replaced with inline first-call copy and an explicit two-step guide; it is not a pixel clone of all three exploration images.

- Visual sources: `docs/design/first-use-20261111/reference-home.png`, `reference-guide.png`, `reference-loading.png`.
- Implementation: `02-first-home.png`, `03-friend-guide.png`, `04-call-guide.png`, `01-history-loading.png` in the same directory. Full paired evidence: `qa-comparison.png`; focused typography/control comparison: `qa-guide-detail.png`.
- Viewport/density: implementation 390×844 CSS/pixels, deviceScaleFactor 1. Current home source is 390×844. Generated guide/loading sources were 852×1846 and normalized to 390×844; generated concepts establish hierarchy and tokens rather than measured browser geometry. Compact captures are 320×568 CSS/pixels.
- Fonts/typography: preserve system Korean sans, navy hierarchy and readable 14–15px guidance. The implementation uses larger accessible close controls than the exploration image; this is intentional.
- Spacing/layout: preserve the current header, character, segmented selector and dock. Guidance adds a short first-use line. Coachmarks remain associated with their actual target and clear the primary call action. Compact layout keeps the primary call action above the dock.
- Colors/tokens: reuse brand blue, navy, lavender skeleton/selection and flat green call action. Error recovery uses the existing soft surface; no new brand palette.
- Images: existing logo and WebGL character assets are retained. Existing close/phone/settings icons are reused. No replacement character assets were generated.
- Copy: first-use, microphone, permission recovery, invite access, first-note and optional help copy are production Korean. Guide completion never initiates a call or microphone request.

Comparison history:

1. Initial browser inspection found a P2 recovery layout issue: the full character pushed microphone instructions/retry beneath the fixed dock. The error state now hides the decorative identity and places persistent instructions and the retry action near the selector. Post-fix evidence: `06-microphone-recovery.png`; browser assertions confirm the retry remains above the dock.
2. Compact home inspection found permission copy could sit behind the dock. On short viewports the microphone note precedes the call button and first-use spacing is reduced. Post-fix evidence: `10-first-home-compact.png`; assertions confirm the call button remains above navigation.
3. Full and focused comparisons show no remaining actionable P0/P1/P2 visual issues. The tooltip omits the generated arrow and uses an exact target spotlight, a larger close action and native dialog focus behavior. Static skeletons intentionally avoid shimmer. These differences preserve the current design and motion/accessibility constraints.

Primary browser verification: optional guide/skip/replay, Escape/focus return, account-specific browser persistence, initial loading/confirmed empty/error recovery, retained history during refresh, permission denial/retry, cancellation during a pending microphone grant and voice response, immediate retry isolation, and first-learning-note acknowledgement. Actual voice providers and auth are fixtures; no claim of real-device microphone or AI voice quality verification is made.

Release limitation: Google-hosted OAuth app/domain branding requires the provider console and is not changed by this frontend release. Invite/approval policy and backend authorization remain intact. Guidance preferences are scoped per account in this browser and do not claim cross-device sync.

## 전체 사용자 문구·보조 기능 검수 — 2026-11-11

기준은 `origin/main b2e91c179560a96893efdc30506cc235f77680a2`이다. 로그인부터 통화 종료·최근 통화·학습 노트·복습·기억·계정·백업 복원까지 점검했다. 내부 저장 방식/연구 용어/모델명/연결 진단 ID를 사용자 행동과 결과로 바꾸고, 사용할 수 없는 로그인 연결 영역은 숨겼다. 검색 업데이트는 선택적으로 펼치는 영역에 배치했다. 저장 대기·실패·부분 기록·개인정보 고지·명시적 충돌 해결은 유지한다.

[전후 비교](docs/design/product-copy-20261111/comparison.png)를 실제로 열어 확인했다. 각 화면은 320×568 CSS px, DPR1이고 위는 수정 전, 아래는 수정 후다. 계정/개인정보/기억 관리의 동일한 fixture 상태를 비교했다. [상세 범위·검증 경계](docs/design/product-copy-20261111/review.txt)에 기록했다. 기존 시스템 글꼴·남색/블루/연녹색 토큰·캐릭터 자산·44px 이상 주요 컨트롤과 내비게이션은 유지했다. 문구 삭제로 계정 화면의 스크롤을 줄이고 개인정보 안내가 작은 화면에 들어온다.

브라우저 검증에는 첫 방문·빈 상태·지연·실패·재시도·권한 거부/취소, 통화 종료와 부분 기록, 복습 선택/보류/재제안, 정확한 주간 기간, 계정 분리, 백업 중단/재시도가 포함된다. 인증·음성 전송은 fixture이며 실제 승인 계정 음성이나 학습 효과를 검증했다고 주장하지 않는다.

최종 확인: 문법/타입 검사, 255개 단위·DB 테스트, 기존 13개 브라우저 스위트 모두 통과했다. 문구가 바뀐 기존 검증은 새 문구와 연결했고 저장 ACK·원문 보존·계정 격리·정확한 기간 검증은 유지했다. ‘기록 정보’의 기본 마커가 기존 화살표와 겹치는 시각 문제는 공통 disclosure 스타일을 적용한 뒤 재캡처해 해결했다. 검수한 범위에서 남은 실행 가능한 P0/P1/P2 없음.

final result: passed
