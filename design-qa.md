# 시시콜콜 승인 캐릭터 구현 QA

final result: passed

## Comparison target and scope

- Source visual truth: `docs/design/approved-characters/reference.png`, the exact Alex/Mia/Juno character family selected by the user; 1488×1058 pixels.
- Implementation: `docs/design/approved-characters/implementation-specimen.png`, rendered using the actual application module and production PNG assets at a 1488×1058 CSS viewport, deviceScaleFactor 1.
- State: light theme, idle, reduced motion enabled for reproducible artwork comparison. No device/browser chrome.
- Full comparison: `docs/design/approved-characters/qa-comparison.png`; both full images shown together at 744px wide, preserving proportions.
- Focused comparison: `docs/design/approved-characters/qa-focused.png`; original artwork regions for all three characters shown beside implementation regions without recoloring. Their native optical sizes differ slightly (approximately 5–7%); this is a minor P3 specimen-scale difference, not a missing or substituted asset.
- Scope: character artwork, persona names/copy, and motion behavior. The approved image is a character specimen sheet, not a replacement mobile screen layout. Existing app navigation, forms and workflows remain the integration context; the specimen heading/footer is not introduced into the app.

## Findings and comparison history

1. Earlier P1: texture uploaded with reversed vertical orientation. The blue/indigo distribution and Juno silhouette were inverted. Fixed decoding to use `imageOrientation: 'flipY'` with non-premultiplied alpha. Post-fix full and focused comparisons show the intended colors, light direction and silhouette.
2. Earlier P2 concern: adding a persona description could push the primary CTA under persistent navigation on short devices. Added a ≤640px-height layout with a smaller AI presence and tighter spacing. Post-fix `home-compact.png` is 320×568 and measured CTA bottom is above the dock top. Secondary content remains accessible by scrolling with existing bottom clearance.
3. No remaining actionable P0/P1/P2 differences in the approved artwork scope. The three textures are generated assets grounded in the selected source, not procedural replacement drawings. Their alpha edges and forms were inspected on the white product background.

## Required fidelity surfaces

| Surface | Result |
|---|---|
| Fonts / typography | App keeps its system Korean stack and readable navy hierarchy. Names and traits agree with the source and underlying character profiles. Specimen sheet display typography is not copied into small mobile controls. |
| Spacing / layout | Same image component is used in home/header/dialog/call. Home captures at 390×844 for each profile, compact home at 320×568. Primary CTA remains reachable above persistent navigation. |
| Colors / tokens | Alex azure/indigo, Mia lavender and warm light, Juno aqua/blue match the approved family. Interface actions retain brand blue. Shapes and labels provide identity beyond hue. |
| Image quality / fidelity | All three approved forms have real transparent raster assets. Their original orientation is preserved; no metallic highlights, rings, emoji or portrait substitutes. GPU failure uses the same artwork as a static image. |
| Copy / content | Alex 차분하고 명료한; Mia 다정하고 사려 깊은; Juno 경쾌하고 호기심 많은. AI identification remains explicit. No prototype/debug labels are introduced into the product. |

## Browser evidence

- `home-alex.png`, `home-mia.png`, `home-juno.png`: authenticated home using isolated synthetic data, 390×844.
- `companion-dialog.png`: real companion selection surface and all three characters.
- `home-compact.png`: short viewport, 320×568.
- `motion.mp4`: same production renderer; controlled synthetic audio and state sequence, not a recording of a provider call.
- Playwright exercised companion changes, navigation, mute/end/save/review, backup/restore flows and built HTML under hashed CSP. Browser page errors: none.
- Dedicated presence tests verified real WebGL texture rendering, distinct profiles, reduced-motion stability, actual generated audio modulating the image, AudioContext reconnection/cleanup, preserved call tracks, and the WebGL fallback.
- Syntax/type checks passed. Actual AI-provider voice behavior was not exercised in these local tests.

## Follow-up polish

- P3: generated asset framing differs slightly from the design specimen's optical sizes. This does not affect character recognition or the app's control layout.

## 단계별 모션 후속 검증

- 사용자 피드백: 내부 움직임과 외곽 반응이 너무 약해 단계 차이를 알아보기 어려움.
- 수정: 입력 음성의 세로 열림, 생각의 수렴, 출력 음성의 부피·기울기·외곽 변형을 상태별로 연결. 대기 외곽은 유지하고, 발화가 없으면 음성 반응이 가라앉는다.
- 중간 P2: 내부 이미지 이동이 바깥 알파 경계를 가로지르며 이중 외곽처럼 보였음. 내부 변형을 실루엣 근처에서 감쇠하도록 수정함.
- 수정 후 증거: `docs/design/approved-characters/stage-comparison.png` 및 `stage-comparison.mp4`의 2×2 동시 비교. 네 상태가 각각 idle/listening/thinking/speaking으로 실행되고 오디오 컨텍스트가 running인 것을 확인함. 페이지 오류 없음.
- 실제 생성 오디오 트랙에 따른 색 변화 및 알파 외곽 변화 검사 통과. reduced-motion 정지와 정적 이미지 대체 표시 유지.
- 모션의 색·형태 기준은 승인된 원본 그대로이며 변경 범위는 동작 표현과 비교 미리보기임.
- final result: passed

## Prior release and logo provenance

[Release42639444223](https://github.com/chungchung234/English/actions/runs/42639444223) passed backend deployment, Pages publication, three real voice calls, actual provider voices cedar/marin/verse, transcript/feedback save, reload persistence, companion memory/evidence boundaries, account isolation and weekly analysis. Synthetic test accounts were cleaned. Opened the downloaded actual deployment [home](docs/design/deployed-home.png), [Mia call](docs/design/deployed-call.png), and [Juno review](docs/design/deployed-review.png): complete all-Korean logo, then-current portraits (replaced by approved AI forms in this release), visible controls and readable feedback. These are isolated synthetic accounts, not real user screenshots. Native iOS-device and public OTP-delivery gaps remain as described above.

## Approved conversation logo refresh

Applied the user-selected empty overlapping speech-bubble logo with the redesigned 콜콜 glyphs and tightened wordmark spacing. `docs/design/approved-logo.png` preserves the approved full-size source; the header uses a whitespace-trimmed WebP export. Replaced the prior negative-offset image crop with a centered, aspect-preserving 170 × 48 px container. The 390 px mobile capture shows the full symbol and wordmark without clipping. `npm run build` and `npm run test:browser` passed (voice responses simulated).

