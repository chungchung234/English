# 복습 목록 디자인 검수 — 2026-11-11

final result: passed

## 기준과 범위

- 시작 코드: `a19ddc0`. 사용자가 최종 선택한 **수정 3안**과 추가 지시 ‘어제와 날짜를 중복 표시하지 말 것’을 기준으로 구현했다.
- source visual truth path: [날짜 문구만 수정한 최종 시안](docs/research/review-boundaries-20261111/images/04-selected-final.png). 원래 선택 이미지는 같은 폴더의 `03-expression-boundaries.png`다. 별도 시안으로 방향을 바꾸지 않았다.
- implementation screenshot path: [날짜별 목록](docs/research/review-boundaries-20261111/verification/date-list.png).
- 상태: 날짜별 탭, 2026년 11월, 11월 10일의 Alex 표현 2개와 Mia 표현 1개, 가상 통화·표현 데이터. 원문의 길이와 표현별 타입 개수는 생성 할당량을 뜻하지 않는다.
- 기준 이미지는 853×1844px. 실제 Chromium 캡처는 390×844 CSS px, deviceScaleFactor 2, 780×1688px. 둘을 각각 폭 390px로 표시해 밀도를 정규화한 뒤 비교했다. 생성 시안의 종횡비에 따른 높이 차이는 약 1 CSS px다.
- full-view comparison evidence: [최종 전체 비교](docs/research/review-boundaries-20261111/verification/comparison-full.png).
- focused region comparison evidence: [날짜·통화·표현 구획 비교](docs/research/review-boundaries-20261111/verification/comparison-phrases.png).

## 비교 이력과 수정

첫 비교는 `blocked`였다. [수정 전 전체](docs/research/review-boundaries-20261111/verification/comparison-before.png)와 [수정 전 구획](docs/research/review-boundaries-20261111/verification/phrases-before.png)을 보존했다.

- P2: 선택된 탭의 밑줄이 시안보다 길게 화면 절반을 차지했다. 탭을 내용 너비 기준으로 바꾸고, 작은 화면·큰 글자에서는 줄바꿈할 수 있게 했다.
- P2: 표현 내부의 라벨·문장·뜻 사이 간격 때문에 첫 표현 영역이 과도하게 높았다. 내부 패딩·간격과 짧은 타입 표식을 줄여 여러 표현을 훑는 밀도를 맞췄다.
- 수정 후 같은 390×844 상태를 재캡처하고 전체·구획 비교 이미지를 다시 열어 확인했다. 해결되지 않은 P0/P1/P2는 없다.

## 필수 검토 항목

| 항목 | 결과 |
| --- | --- |
| 글꼴·활자 | 기존 한국어 시스템/Pretendard 계열을 유지했다. 영어 표현은 실제 텍스트, 17px 상당 굵기 650, 뜻은 14px 상당이다. 새 복습 영역은 rem 단위로 글자 확대를 지원한다. 생성 이미지의 글꼴 렌더링과 픽셀 단위 완전 일치를 주장하지 않는다. |
| 간격·정렬 | 날짜 제목 바깥에 상대·시각을 두고, 각 표현에 독립적인 중립 테두리를 적용했다. 같은 통화 안 표현 간격과 통화 간 간격이 구별된다. 통화를 다시 외곽선 카드로 묶지 않았다. |
| 색·상태 | 기존 네이비·블루·흰색과 중립 토큰을 사용한다. 기본 경계를 파란 포커스처럼 만들지 않았다. 버튼 뒤 별도 연보라색 고정 패널을 흰 캔버스로 바꿨다. |
| 자산 | 기존 브랜드 로고·하단 메뉴를 보존했다. 책갈피·달력은 기존 Phosphor 라이브러리 SVG, 진입 화살표는 공급된 기존 자산이다. 운영 빌드에서 아이콘을 HTML에 내장해 하위 경로에서도 누락되지 않는지 검사했다. |
| 문구·내용 | 날짜 제목은 ‘11월 10일’만 표시한다. 기본 목록의 ‘다시 쓸 표현’ 반복 라벨을 생략하고 ‘교정/대안’만 짧게 남겼다. 실제 교정 여부는 상세에서도 구분한다. 안내문·관리 메뉴를 기본 목록에 추가하지 않았다. |

## 동작 및 추가 화면

- 표현 B를 눌러도 해당 통화의 표현 A·B를 함께 표시하며 B에 초점·스크롤을 이동한다. 다른 통화의 표현 C는 섞지 않는다. [통화 학습 노트](docs/research/review-boundaries-20261111/verification/call-note.png).
- 원문에서 해당 발화를 표시하고, 돌아오면 읽던 학습 노트 위치를 복구한다. 목록 복귀 시에도 기존 날짜·위치·표현 초점을 복구한다.
- 책갈피는 서버 확인 후 상태를 바꾼다. 응답을 잃으면 완료로 표시하거나 같은 토글을 반복하지 않고 최신 상태를 먼저 읽는다. [저장한 표현](docs/research/review-boundaries-20261111/verification/saved.png).
- 320px·글자 크기 200%에서 가로 넘침이 없고 마지막 표현을 하단 메뉴 위로 완전히 스크롤해 읽을 수 있음을 검사했다. [작은 화면·큰 글자](docs/research/review-boundaries-20261111/verification/small-large-text.png).
- [1024px 화면](docs/research/review-boundaries-20261111/verification/desktop.png)에서도 기존 최대 폭을 유지했다. 날짜 이동·이전 기록 조회·빈 목록·늦은 계정 응답·재로그인 후 과거 저장 응답을 별도로 검사했다.
- `pageerror`와 콘솔 error를 수집해 새 복습 흐름에서 둘 다 0건임을 확인했다.

## 한계와 P3 후속 사항

공유 브라우저 연결 실패 후 실행 환경의 Chromium으로 실제 HTML/CSS를 렌더링하고 조작했다. 캡처의 인증·음성·학습 내용은 제어된 가상 입력이다. 실제 승인 계정의 운영 통화, 음성 품질·학습 효과·전체 WCAG 준수 검증으로 보고하지 않는다. 선택한 시안은 목록의 시각 기준이고, 통화 전체를 담는 상세는 사용자가 승인한 정보 구조와 읽기·이동 동작을 검수했다.

P3: 기존 앱의 22px 여백과 공급된 설정 버튼·하단 메뉴의 표면 효과 때문에 생성 시안과 수 px 및 미세한 광택 차이가 남는다. 기존 브랜드와 자산을 유지하는 범위의 차이이며, 다른 디자인으로 교체하지 않는다.

## 완료 항목

- [x] 선택한 이미지와 사용자 수정 지시 확인
- [x] 같은 데이터·화면 크기로 전체/구획 비교
- [x] P2 발견 → 수정 → 재캡처·재비교
- [x] 날짜·표현·저장·원문·복귀 흐름 검사
- [x] 작은 화면·실제 글자 확대·키보드 복귀·콘솔 검사
