# 시시콜콜

AI 대화 상대와 영어로 통화하고, 저장한 대화와 학습 노트를 다시 보는 웹 앱입니다.

**[홈페이지 열기](https://chungchung234.github.io/English/)**

## 로그인

이메일 인증 코드와 카카오 로그인을 지원합니다. 운영자가 승인한 이메일 계정만 사용할 수 있습니다. Google 로그인은 별도 설정이 완료된 경우에 활성화됩니다.

## 개발

```sh
npm ci
npm run dev
npm run check
npm test
npm run test:browser
```

운영 사이트는 정적 파일을 제공하며, 인증·저장·AI 요청은 Supabase에서 처리합니다. `web/`은 화면, `src/`는 공통 기능, `supabase/`는 DB와 서버 함수, `test/`는 검증 코드입니다.

## 운영 설정

- 공개 연결 정보: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_KEY`.
- 서버 비밀키: Supabase 함수 Secrets의 `OPENAI_API_KEY`(기존 `OPEN_API_KEY` 이름도 지원).
- 배포 관리 권한: `SUPABASE_ACCESS_TOKEN`, 배포 대상: `SUPABASE_PROJECT_REF`.
- 승인 이메일은 운영 DB의 `loop_private.approved_emails`에서 관리합니다. 개인 이메일을 마이그레이션이나 문서에 넣지 않습니다. 새 설치에서는 승인 계정을 별도로 등록해야 합니다.
- 실제 키·비밀번호는 보안 설정에 저장하고 Git·이슈·로그에 기록하지 않습니다.

```sh
python3 scripts/deploy.py --apply --https-function
npm run build -- --require-config
```

GitHub Pages는 공개 연결 정보만으로 게시합니다. 서버 배포와 복구 작업은 필요한 경우에 수동 실행합니다. Google·카카오 설정은 [로그인 설정 안내](docs/social-login-setup.md)를 참고하세요.

생성된 화면 캡처·진단 로그·과거 배포 보고서는 저장소에 자동 게시하지 않습니다. 코드 테스트의 합성 음성·인증 응답은 실제 사용자 통화나 이메일 수신 검증과 구분합니다.
