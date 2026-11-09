# Loop — 링크로 시작하는 영어 통화

휴대폰·PC 브라우저에서 링크로 접속하는 가벼운 영어 말하기 서비스입니다. 이메일 로그인, 음성 역할극, 대화 자동 저장, 개인별 장기 이력, 통화·주간 분석을 제공합니다. 특정 AI 채팅 앱 설치나 사용자별 API 설정은 필요하지 않습니다. 정적 웹 호스팅과 관리형 Supabase를 사용하므로 상시 서버를 직접 운영하지 않습니다.

**현재 상태:** 공개 웹용 소스와 로컬 검증은 준비됐습니다. 공개 URL 배포, 실제 Supabase 로그인·OpenAI 음성 통화, 운영 백업 복구는 아직 검증하지 않았습니다. 실제 서비스 완료로 표시하지 않습니다.

## 구성

- `dist/index.html`: CSS·JavaScript를 포함한 약36KB 정적 웹 페이지. 방문자에게 연결 설정을 요구하지 않으며 운영자가 빌드 시 공개 연결 정보를 한 번 설정합니다.
- `web/`: 한국어 UI, 이메일 코드 로그인, WebRTC 통화, 피드백, 전체 JSON 백업/복원.
- `src/outbox.js`: IndexedDB 복구 대기열. 클라우드 확인 전 삭제하지 않으며 동일 UUID로 재전송.
- `supabase/migrations/`: 사용자별 RLS, 원문 전사, 분석 출처, 중복 방지, 비용 요청 예산, 전체 이력 검색.
- `supabase/functions/coach/`: 인증·허용 이메일·출처 검사, 음성 API 연결, 분석, 기억 검색. 비밀 API 키는 이 함수에서만 사용.

## 모델 티어링

| 기능 | 기본 모델 | 호출 시점 |
| --- | --- | --- |
| 음성 대화 | `gpt-realtime-mini` | 통화 중 |
| 음성 전사 | `gpt-4o-mini-transcribe` | 사용자 발화 |
| 통화 후 교정 | `gpt-4.1-mini` | 저장 후 회차당, 동일 원문은 재사용 |
| 최근 7일 분석 | `gpt-4.1` | 사용자가 요청할 때만, 동일 원문은 재사용 |

음성·교정·분석 모델은 `VOICE_MODEL`, `COACH_MODEL`, `ANALYSIS_MODEL`로 바꿀 수 있습니다. 계정별 실제 모델 접근과 음성 품질은 실연결로 검증해야 합니다. 모델 티어링은 호출 정책이며 실제 절감액을 측정한 결과가 아닙니다. ChatGPT/Claude 구독과 API 과금은 별도입니다.

## 로컬 개발과 검증

Node.js 24, Python3이 필요합니다. 개발 의존성은 lockfile로 고정합니다.

```sh
npm ci --cache /workspace/.npm-cache
npm run check
npm test
npm run test:browser
npm run build
```

브라우저 테스트는 Chromium을 사용합니다. `/usr/bin/chromium`이 아닌 경우 `CHROMIUM_PATH`를 지정하세요. 브라우저 테스트의 음성·외부 API 응답은 모의 값이며 실제 음성 연결을 검증하지 않습니다. DB 테스트는 PGlite PostgreSQL 엔진에서 실제 SQL·RLS·복원·분석 경계를 검사합니다.

`npm run dev`는 내부 개발 검증용 정적 파일 서버입니다. 운영 때 이 서버를 실행할 필요는 없습니다. 각 클라우드 작업은 이미 격리되어 있으므로 기존 체크아웃을 사용하고 별도 Git worktree를 만들지 않습니다.

## 새 Supabase 프로젝트 연결

현재 선택한 프로젝트: `domkmxmwmihcfadophfg`

1. https://supabase.com/dashboard/project/domkmxmwmihcfadophfg 에서 연결합니다.
2. **API / Connect**에서 Project URL과 publishable 또는 anon 공개 키를 확인합니다. service_role/secret 키를 프런트 화면에 넣지 마세요.
3. **Authentication → Email**에서 이메일 OTP를 켜고 이메일 템플릿에 `{{ .Token }}` 코드가 표시되게 설정합니다. 실제 메일 전달·코드 로그인은 직접 검증해야 합니다. 공개 사용자 가입을 위해 운영용 SMTP를 구성하고 운영자 외 이메일로 코드가 전달되는지 검증해야 합니다. 기본 이메일 발송만으로 모든 방문자에게 전달된다고 가정하지 않습니다.
4. **Edge Functions → Secrets**에서 아래 항목을 저장합니다.
   - `OPENAI_API_KEY`: 실제 OpenAI API 키. 여기에 직접 안전하게 입력합니다.
   - `ACCESS_MODE=public`: 기본값. 누구나 이메일을 인증해 가입할 수 있습니다. 초대제로 운영할 때만 `ACCESS_MODE=invite`와 `ALLOWED_EMAILS`를 설정합니다.
   - `ALLOWED_ORIGINS`: 배포한 웹사이트의 정확한 origin. GitHub Pages 기본 도메인을 사용한다면 `https://chungchung234.github.io`입니다. 경로나 마지막 `/` 없이 입력합니다.
   - 선택: `VOICE_MODEL`, `COACH_MODEL`, `ANALYSIS_MODEL`.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`는 Supabase 런타임 기본 바인딩을 사용합니다. 브라우저에 노출하지 않습니다.
5. 관리 토큰은 https://supabase.com/dashboard/account/tokens 에서 발급하고, 채팅 대신 클라우드의 `SUPABASE_ACCESS_TOKEN` 보안 항목에 저장합니다. 프로젝트와 DB 쓰기, 함수 배포 권한이 필요합니다. Supabase CLI 3 기준 `database_write`, `edge_functions_write`, `projects_read` 등 작업에 필요한 범위만 부여하세요.
6. `SUPABASE_PROJECT_REF=domkmxmwmihcfadophfg` 환경 설정을 적용한 후 배포합니다.

```sh
python3 scripts/deploy.py
python3 scripts/deploy.py --apply
```

첫 명령은 권한·연결을 검증하지 않는 로컬 필수 변수 검사입니다. 두 번째 명령은 HTTPS Management API로 원자적 DB 마이그레이션을 적용하고 고정된 CLI로 함수를 배포합니다. DB 포트나 로컬 Docker 서비스는 필요하지 않습니다. 배포 스크립트의 관리 API 요청은 아직 실제 계정으로 검증하지 않았습니다. 같은 마이그레이션은 체크섬으로 재적용을 막습니다.

`verify_jwt=false`는 최신 publishable 키와의 게이트웨이 호환을 위한 설정입니다. 함수 자체는 모든 요청의 실제 사용자 JWT를 Supabase Auth에서 검증하고, 이메일 인증과 정확한 origin을 검사합니다. 초대 모드에서만 이메일 allowlist도 검사합니다. 인증 없는 AI 호출을 허용하지 않습니다.

## 공개 웹 배포 (운영자만 한 번 설정)

기존 저장소의 GitHub Pages를 기본 정적 호스팅으로 사용합니다. 다른 정적 호스트에도 `dist/`를 그대로 올릴 수 있습니다.

1. 저장소 **Settings → Secrets and variables → Actions → Variables**에 공개 빌드 변수를 저장합니다.
   - `PUBLIC_SUPABASE_URL=https://domkmxmwmihcfadophfg.supabase.co`
   - `PUBLIC_SUPABASE_KEY`: Supabase의 publishable 또는 anon 공개 키. OpenAI 키나 service_role 키를 넣지 않습니다. 빌드가 비밀 키를 거부합니다.
2. 저장소 **Settings → Pages → Source**를 **GitHub Actions**로 지정합니다.
3. 소스를 `main`에 반영하면 `.github/workflows/pages.yml`이 공개 연결 정보를 포함한 정적 페이지를 빌드·게시합니다. GitHub에 소스 반영 및 Pages 활성화는 아직 수행하지 않았습니다.
4. Actions 배포 결과에 표시된 실제 URL에서 이메일 로그인과 마이크 허용을 검증합니다. HTTPS가 필요합니다.

직접 빌드하려면 같은 `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_KEY` 환경 변수를 설정한 뒤 실행합니다.

```sh
npm run build -- --require-config
```

빌드는 외부 JavaScript 런타임 의존성 없이 `dist/index.html` 하나로 앱을 묶고, 인라인 코드에 CSP 해시를 적용합니다. 방문자는 API 설정 화면 없이 이메일 로그인부터 시작합니다. 연결 정보 없이 로컬 빌드를 하면 ‘서비스 준비 중’ 화면이며, CI의 `--require-config`는 설정 누락 시 게시를 중단합니다.

세 키는 용도가 다릅니다: Supabase publishable 키는 공개 앱 연결용, `OPENAI_API_KEY`는 서버의 AI 호출용, `SUPABASE_ACCESS_TOKEN`은 운영자의 배포용입니다. 뒤의 두 키를 웹 빌드에 포함하지 않습니다.

## 저장과 장기 기억의 의미

클라우드 DB는 수신한 최종 전사문을 보존합니다. 브라우저는 먼저 IndexedDB에 원자적으로 저장하고, DB 확인 후에만 대기열을 제거합니다. 네트워크 단절·재접속·중복 전송에서 복구하도록 설계했습니다. 아직 전사되지 않은 음성이나 OS가 이벤트 수신 전에 종료한 구간까지 복원한다고 보장하지 않습니다. 원본 녹음 파일은 보관하지 않습니다.

원문과 분석을 세션별로 보관하며, 오래된 관련 기록까지 전체 이력의 전문 검색으로 찾습니다. 모든 원문을 매 호출마다 모델에 넣는 방식이 아니며, 모델의 무한 기억을 뜻하지 않습니다. 검색은 키워드 기반으로 임베딩 의미검색은 아닙니다. 최신 기록과 관련 기록 최대12건을 조합하고 실제 교정·복습 표현을 다음 통화에 전달합니다. 모델 출력의 인용 ID와 원문 인용을 서버에서 검증합니다. 인용 존재 검증이 모든 해석의 정확성까지 보장하지는 않습니다.

마지막 발화의 전사·저장을 확인하지 못하면 완료나 분석 성공으로 표시하지 않습니다. 미완료 통화는 이력에서 수신된 기록으로 종료할 수 있습니다. 늦게 복구된 발화가 추가되면 원문 해시가 바뀌어 기존 분석 캐시를 재사용하지 않습니다.

최근 30회는 화면에 표시하고 전체 기록은 페이지를 나눠 내보냅니다. 백업 복원은 회차·발화 원문을 복구하며, 분석은 다시 생성합니다. 복원 배치는 개별 원자적이므로 중간 실패 시 앞선 배치는 남고 재시도할 수 있습니다.

## 운영 완료 조건

- 실제 계정의 OTP 로그인, 허용되지 않은 계정 거부 확인.
- 실제 음성 통화와 전사·교정·재접속 이력 복원.
- 브라우저 종료/네트워크 단절 후 대기열 복구, 오래된 기록 검색.
- 다른 계정의 원문·분석 접근 차단을 실제 배포에서도 확인.
- **관리형 DB의 자동 백업과 보관 기간을 설정하고 별도 테스트 대상으로 복원 검증**. 제공자의 요금제·백업 지원에 따라 달라집니다. 무료 프로젝트를 생성한 것만으로 재해 복구가 보장되지는 않습니다.
- 공개 웹 URL에서 휴대폰·PC 마이크 권한, WebRTC, 새 방문자 가입 및 기존 계정의 이력 복원 확인.

현재 이 운영 완료 조건은 모두 통과했다고 보고하지 않습니다.

## 비용과 데이터

사용자당 UTC 일일 요청 제한은 음성30/통화교정20/주간분석3입니다. 동일 원문 재요청은 결과를 재사용합니다. 음성 응답은512토큰으로 제한합니다. 이는 금액 상한이 아니며 OpenAI 프로젝트 사용량·예산 알림도 설정해야 합니다. API 오류·토큰·원문을 서버 로그에 출력하지 않습니다. 사용자의 원음은 음성 처리를 위해 OpenAI로 전송되고, 전사문은 피드백을 위해 전송됩니다. 공용 기기에서는 브라우저에 남는 세션·복구 대기열을 유의하세요.
