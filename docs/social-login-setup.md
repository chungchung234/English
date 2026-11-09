# Google·카카오 로그인 연결

앱의 소셜 로그인, 인증 후 복귀, 로그인 유지, 기존 계정 연결을 구현했다. **실제 개발자 키 등록과 Google·카카오 동의 화면 검증은 아직 완료되지 않았다.**

[로그인 화면 시안](auth/login-preview.png)과 [계정 연결 시안](auth/account-link-preview.png)은 두 제공자가 활성화됐다고 가정한 합성 테스트 화면이다. 실제 제공자 키 등록 완료를 뜻하지 않는다.

## 준비된 범위

Supabase 공식 `@supabase/auth-js` SDK를 앱에 묶어 외부 JavaScript CDN 없이 실행한다. 기존 `loop.auth:<프로젝트 URL>` 세션을 이어 쓰며 자동 갱신·탭 간 상태 공유를 적용한다. 명시적 로그아웃, 서버 세션 해제, 브라우저 저장 데이터 삭제 후에는 다시 로그인해야 한다.

같은 탭에서 시작한 10분 이내 PKCE 요청만 처리하고 인증 코드·오류 파라미터를 주소에서 지운다. Google·카카오 API용 토큰은 앱의 영구 세션 저장에서 제외한다. 로그인된 기존 사용자에게 다른 이메일의 소셜 계정을 연결할 수 있으며, 연결 전후 사용자 ID가 같아야 한다. 기존 이메일 인증·승인 목록·사용자별 데이터 정책을 유지하며 승인 확인 뒤에만 기록·전송 대기열을 읽는다.

Supabase의 정확한 앱 복귀 주소와 인증된 사용자 계정 연결 기능을 준비했다. SMTP·이메일 한도·승인 목록은 바꾸지 않았다. [설정 스냅샷](auth/configuration.json)에는 키나 계정 주소를 포함하지 않는다. 미등록 제공자 버튼은 준비 상태로 표시하고 이메일 코드를 보조 경로로 유지한다. 제공자 활성화 후 앱을 다시 열면 버튼도 활성화된다.

## 콘솔에 입력할 값

| 항목 | 값 |
|---|---|
| 서비스 이름 | 시시콜콜 |
| 서비스 URL / Supabase Site URL | `https://chungchung234.github.io/English/` |
| Google JavaScript Origin / 카카오 웹 도메인 | `https://chungchung234.github.io` |
| Google 리디렉션 URI / 카카오 Redirect URI | `https://domkmxmwmihcfadophfg.supabase.co/auth/v1/callback` |
| Supabase Redirect URLs | `https://chungchung234.github.io/English/` |

제공자 콘솔에는 **Supabase callback 주소**, 사용자에게 보여 줄 서비스에는 **GitHub Pages 주소**를 입력한다. 광범위한 `*` 복귀 URL은 필요하지 않다.

## Google 등록

1. [Google Auth Platform](https://console.cloud.google.com/auth/clients)에서 프로젝트와 동의 화면을 구성한다. 테스트 상태라면 사용할 계정을 테스트 사용자에 추가한다.
2. OAuth 클라이언트를 **웹 애플리케이션**으로 만들고 위 표의 Origin·리디렉션 URI를 등록한다.
3. [Supabase Auth Providers](https://supabase.com/dashboard/project/domkmxmwmihcfadophfg/auth/providers)의 Google에 **Client ID와 Client Secret**을 입력하고 활성화한다. 기본 로그인·이메일·프로필만 사용하며 Gmail·Drive 권한은 요청하지 않는다.

## 카카오 등록

1. [Kakao Developers](https://developers.kakao.com/console/app)에서 앱과 웹 플랫폼을 만들고 위 표의 웹 도메인·Redirect URI를 등록한다.
2. 카카오 로그인을 활성화하고 **REST API 키와 Kakao Login Client Secret**을 확인한다. Client Secret도 카카오 콘솔에서 활성화한다. JavaScript 키나 Admin 키를 대신 넣지 않는다.
3. `account_email` 동의 항목을 구성한다. 공식 가이드상 이 항목은 **비즈앱**에서 제공되므로 메뉴가 없으면 카카오의 비즈앱 전환·본인 확인 절차를 먼저 완료한다. `profile_nickname`, `profile_image` 기본 프로필 동의 항목도 공식 가이드에 맞춘다.
4. Supabase Kakao 제공자에 REST API 키(Client ID)·Client Secret을 입력하고 활성화한다. 현재 서비스는 승인된 이메일을 검사하므로 **Allow users without an email은 끈다.** 일반 방문자에게 공개할 때는 콘솔에서 요구하는 앱 상태·동의 권한 심사도 확인한다.

**키·시크릿·인증 코드를 채팅이나 저장소에 보내지 않는다.** 키는 Supabase 대시보드 보안 입력란에 직접 저장한다. 현재 환경에는 Google·카카오 개발자 권한이나 키가 없고, 공유 브라우저도 초기화 도구 오류로 열리지 않아 등록 단계는 진행할 수 없었다.

## 기존 기록 유지

기존 계정과 이메일이 같은 소셜 계정은 Supabase의 자동 연결 대상이다. 실제 동의·인증 후 연결 여부를 확인한다. **이메일이 다르면 기존 계정으로 먼저 로그인한 뒤 내 계정 → Google 연결 / 카카오 연결을 사용한다.** 연결한 뒤에는 같은 사용자 ID와 기존 대화·기억을 사용한다. 별도 계정의 기록을 임의로 합치거나 승인 목록을 늘리지 않는다.

현재 SMTP 오류로 기존 계정에 들어갈 수 없고 저장된 세션도 없다면 [메일 로그인 복구](email-login-recovery.md)를 먼저 완료하거나 기존 계정과 같은 검증된 이메일의 제공자를 사용해야 한다. 관리자 권한으로 사용자의 로그인 세션을 만드는 우회는 구현하지 않았다.

## 상태 확인과 검증

```sh
node scripts/configure-social-login.mjs
node scripts/configure-social-login.mjs --prepare
node scripts/configure-social-login.mjs --prepare --enable-configured
```

기본 명령은 읽기 전용이다. 마지막 명령도 Client ID·Secret이 모두 있는 제공자만 활성화한다. 값·원시 제공자 오류는 출력하지 않는다. 보안 환경 변수에 키를 설정했다면 `--configure-from-env`를 추가해 `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`에서 읽을 수 있다. 클라우드 프록시 환경에서는 명령 앞에 `NODE_USE_ENV_PROXY=1`을 붙인다.

단위·브라우저 검사는 실제 SDK와 합성 제공자 응답으로 PKCE proof 일치, 요청 없는 callback·취소·만료 거부, URL 정리, 제공자 토큰 미보관, 새로고침·탭 재접속·갱신, 같은 사용자에게 카카오 연결, 탭 간 로그아웃, 승인 전 기록·대기열 접근 차단을 확인한다. **실제 제공자 동의·로그인 성공은 키 등록 후 별도 확인해야 한다.**

## 게시 검증

`f45356430ab33d3d17fb5a4595dbb6631b9e7d2c`를 [배포](https://github.com/chungchung234/English/actions/runs/42676645925)했다. 자동 테스트 80개, 소셜 인증·이메일·기존 앱 브라우저 검사, 렌더링·메모리 평가와 배포 검사가 통과했다. 현재 비승인 테스트 계정은 실제 서비스에서 차단을 확인하며 승인 계정의 음성 통화 검사는 수행하지 않는다.

게시 HTML은 약282KB다. 실제 HTTPS로 가져온 파일을 서비스 origin과 원래 CSP에서 렌더링하고, 인증 응답만 합성해 PKCE 코드 교환과 승인 차단을 재확인했다. [검증 기록](auth/published-verification.json), [실제 준비 상태 화면](auth/published-current-state.png), [합성 callback 검사 화면](auth/published-callback-check.png)을 보존한다. 공개 인증 설정에서도 Google·카카오 비활성을 확인했으므로, 이 결과는 실제 제공자 로그인 완료를 뜻하지 않는다.

참고: [Google 설정](https://supabase.com/docs/guides/auth/social-login/auth-google), [카카오와 이메일 동의 조건](https://supabase.com/docs/guides/auth/social-login/auth-kakao), [계정 연결](https://supabase.com/docs/guides/auth/auth-identity-linking), [세션 유지](https://supabase.com/docs/guides/auth/sessions).

버튼은 Google FirebaseUI의 [공식 로고](https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg)와 Kakao Developers의 [공식 한국어 버튼](https://developers.kakao.com/tool/images/resource/preview/login-complete-ko.svg)을 그대로 사용한다. 로고·상표는 각 제공자에 속한다. [Google 브랜딩](https://developers.google.com/identity/branding-guidelines), [카카오 디자인 가이드](https://developers.kakao.com/docs/ko/kakaologin/design-guide)를 따른다.
