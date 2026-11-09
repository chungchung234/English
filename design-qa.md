# 시시콜콜 visual QA

final result: passed

## Evidence and comparison target

- Source visual truth: [approved mobile layout](docs/design/approved-mobile.png), 852×1846 pixels; final user-selected [all-Korean logo](docs/design/approved-logo.png), 2172×724 pixels.
- Implementation: [mobile home](docs/design/implementation-home.png), [active call](docs/design/implementation-call.png), [review](docs/design/implementation-review.png), [history](docs/design/implementation-history.png).
- CSS viewport: 390×844, deviceScaleFactor 1; implementation pixels 390×844. Source downsampled to the same 390×844 content area. No device frame or OS chrome is included.
- State: signed-in, light theme, call home, Alex, weekend topic. The real practice expression differs from the illustrative source. Source logo is intentionally superseded by the user's latest all-Korean navy/indigo logo and the selected companion is visible per request.
- Full-view source and implementation were opened together in [qa-comparison.png](docs/design/qa-comparison.png). Focused asset/header comparison was opened together in [qa-logo-comparison.png](docs/design/qa-logo-comparison.png). Final header has the complete, unclipped logo. Source asset is not recreated as text.
- Rendered by Chromium/Playwright. Browser tests exercised navigation, companion selection, scenario dialog, call/mute/end, feedback/history, reload, offline retry, backup, image loading, small-screen hit areas and overflow, desktop responsive layout, and built single-file app under hashed CSP. Test harness checks console/page errors. Provider voice is simulated locally; actual deployed voice acceptance is a separate CI gate.

## Findings and comparison history

Earlier comparison was blocked by the following findings; all received post-fix browser captures and a repeat comparison:

1. **P1 — missing standard icons.** Development server sent SVG as an unknown binary MIME type. Fixed the server MIME table and added visible-image natural-size checks. The final capture shows phone, history, book, and chevrons correctly.
2. **P2 — voice illustration mismatch.** The square library waveform did not match the source's seven soft green bars. Replaced it with an individually generated transparent image asset and corrected size/spacing. Final full-view evidence shows the intended centered waveform.
3. **P2 — compact actions and insufficient green/white contrast.** Increased primary action to 62px with 24px label and darkened semantic greens; companion/profile and tab controls provide generous touch areas. Kept body text dark on a light content surface. Final full-view capture confirms legibility and clear call hierarchy.
4. **P2 — flat dock treatment.** Restored translucent material, a bright rim and soft elevation on the persistent navigation. Final capture shows grouped glass controls without obscuring content.

No actionable P0/P1/P2 findings remain.

## Required fidelity surfaces

- **Typography:** system Korean sans-serif preserves compact readable UI hierarchy, 24px call action and strong topic weight. Brand is the approved generated raster wordmark. No clipping, unexpected wrapping, or text overlays.
- **Spacing/layout:** aligned header, restrained content width, open upper whitespace, waveform/topic stack, full-width call action, separated practice row, and floating three-tab dock follow the accepted layout. Companion chip is an intentional requested addition. At desktop width the mobile content remains centered.
- **Colors/tokens:** white content, dark foreground, green semantic call state, neutral secondary labels and translucent pale dock. Call green is darker than the illustrative source for contrast. No decorative gradient implementation. Navy/indigo logo follows the latest user selection.
- **Assets:** custom generated logo, waveform and three portraits are actual WebP images; standard controls use licensed Phosphor SVG assets. Header source/implementation close-up confirms intact wordmark and symbol. No handcrafted approximation or placeholder remains.
- **Copy:** marketing headline and unnecessary explanatory home text removed. Name is 시시콜콜 throughout visible branding/email template. Topics and practice use real app state; empty/recovery/error states retain concise necessary instructions.

## Open questions and remaining coverage

No design choice blocks this pass. Native iOS Safari microphone permissions and real email delivery require device/provider acceptance; local Chromium does not establish them. Web glass uses CSS material rather than native SwiftUI Liquid Glass rendering.

## Implementation checklist

- [x] Install and preserve requested liquid-glass skill.
- [x] Compare selected source and latest rendered app together.
- [x] Fix P1/P2 image, spacing, touch and contrast issues; recapture and compare.
- [x] Inspect full-Korean logo at rendered header size.
- [x] Exercise primary mobile interactions and production HTML.

## Follow-up polish

P3: native Apple material refraction differs from CSS backdrop blur. This is an expected browser rendering constraint and does not block the approved web design.
