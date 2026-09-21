# Manual Section 508 Accessibility Review

**Standard:** Section 508 (36 CFR Part 1194) — Revised standards, WCAG 2.2 Level AA
**Reviewed:** 2026-09-19 · **Owner:** accessibility owner
**Gate:** `GOVERNANCE_MATRIX` → "Accessibility audit" (prelaunch and major UI change)

This is the evidence record for that control. The machine-readable half lives in
[`src/accessibility/accessibility.ts`](../src/accessibility/accessibility.ts) (`SECTION_508_REVIEW`,
`SECTION_508_FINDINGS`, `FOCUS_INDICATORS`, `PALETTE_CONTRAST`) and is checked by
[`tests/widget-accessibility.test.ts`](../tests/widget-accessibility.test.ts), which executes the
shipped `public/widget.js` against a minimal DOM rather than a copy of it.

## Status

| Part of the review                             | State                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Manual code review of the three UI surfaces    | **Complete** — 15 findings (ACC-1 … ACC-15)                                                           |
| Defects fixed                                  | **14 of 15 fixed**; ACC-15 mitigated and recorded                                                     |
| Contrast recomputed from source                | **Complete** — every documented pair recomputed, 12 pairs                                             |
| Focus indicators measured per control          | **Complete** — 4 indicators, 8 boundaries                                                             |
| DOM contract asserted in CI                    | **Green** — 48 assertions, `npx jest tests/widget-accessibility.test.ts`                              |
| Rendered browser verification (`/demo.html`)   | **Complete for geometry, tree, and behaviour** (see below)                                            |
| Walkthrough instrument (checklist + receipt)   | **Runnable** — `npm run a11y:checklist`; results recorded in `docs/accessibility-matrix-receipt.json` |
| Browser + assistive-technology walkthrough × 5 | **Not performed** — 0 of 5 rows; needs a human at the keyboard, see the matrix                        |

The last row is the honest gap. Nothing in this repository can drive NVDA, VoiceOver, or TalkBack,
so the review does not claim those passes. What it does claim is that the gap is now an instrument:
each matrix row in `SECTION_508_MATRIX` is 13 checks from `ACCESSIBILITY_WALKTHROUGH_CHECKS`, each
with the action and the observable pass condition; `npm run a11y:checklist` prints them; and a
reviewer's results go into the committed receipt at `docs/accessibility-matrix-receipt.json`. A
row's status is **derived** from that receipt — it is `pass` only when every check was run and
passed, the browser/AT/OS versions are recorded, and the receipt is signed — and
`auditAccessibilityReview(review, receipt)` refuses a recorded status the receipt does not support.
A test asserts that no row may claim a pass it cannot evidence.

## Scope

| Surface                            | Why it is in scope                                                    |
| ---------------------------------- | --------------------------------------------------------------------- |
| `public/widget.js`                 | The chat UI: every control, message, and announcement a visitor meets |
| `public/elementor-trust-block.css` | The trust/CTA block, including its focus ring and reduced motion      |
| `public/demo.html`                 | The host page that exercises the widget                               |

Out of scope: the API responses themselves (reviewed by the persona and verdict gates) and the
WordPress/Elementor theme around the block, which is not in this repository.

## Method

1. **Manual code review** of every rendered element, attribute, and style — read, not sampled.
2. **Contrast recomputed** from the sRGB hex values with the WCAG relative-luminance formula. The
   palette table claimed every pair was verified; it had never been recomputed in code, and two
   colours the widget actually renders were absent from it (ACC-12).
3. **Keyboard-path walkthrough** traced through the script: where focus starts, where it moves on
   open/close, which regions are reachable, and what a user can and cannot leave.
4. **Reflow arithmetic** at 320 CSS px and at heavy zoom, including flex shrink behaviour, then
   confirmed in a rendered browser.
5. **DOM contract in CI**, so a future edit cannot quietly undo a fix.
6. **Rendered verification** in a real browser against the shipped widget (see "Browser run").

## Findings

Full text, evidence, and resolution for each are in `SECTION_508_FINDINGS`. Summary:

| ID     | Finding                                                                      | Severity | Criteria              | Status    |
| ------ | ---------------------------------------------------------------------------- | -------- | --------------------- | --------- |
| ACC-1  | Focus indicator measured 2.305:1 / 2.945:1 (below 3:1)                       | high     | 1.4.11, 2.4.13 (AAA)  | Fixed     |
| ACC-2  | Nested polite live regions announced every message twice                     | high     | 4.1.3, 1.3.1          | Fixed     |
| ACC-3  | Speaker identity conveyed by bubble colour alone                             | high     | 1.3.1, 1.4.1, 4.1.2   | Fixed     |
| ACC-4  | Scrollable transcript unreachable by keyboard                                | high     | 2.1.1                 | Fixed     |
| ACC-5  | Focus taken on load, stranded on close, no way to reopen                     | high     | 2.4.3, 3.2.1, 2.1.1   | Fixed     |
| ACC-6  | Overflow at 320px width and on short viewports                               | high     | 1.4.10, 1.4.4, 2.4.11 | Fixed     |
| ACC-7  | Typing indicator announced as "…" and could delete a user message            | medium   | 4.1.3, 1.3.1          | Fixed     |
| ACC-8  | Errors announced politely, contradicting `ARIA_LIVE_CONFIG.ERRORS`           | medium   | 4.1.3                 | Fixed     |
| ACC-9  | Widget text had no `lang` of its own                                         | medium   | 3.1.2                 | Fixed     |
| ACC-10 | Accessible name duplicated visible text; label and instructions unassociated | medium   | 2.5.3, 3.3.2, 1.3.1   | Fixed     |
| ACC-11 | Focus bands drawn only as `box-shadow` vanish in forced-colors mode          | medium   | 1.4.11, 508 §502.2    | Fixed     |
| ACC-12 | Two rendered colours absent from the verified palette                        | medium   | 1.4.3                 | Fixed     |
| ACC-13 | A second copy of the script duplicated the dialog and its ids                | low      | 1.3.1, 4.1.2          | Fixed     |
| ACC-14 | Buttons had no `type`; Enter could double-send under IME/voice input         | low      | 2.1.1, 3.3.2          | Fixed     |
| ACC-15 | A fixed overlay can obscure focused page content                             | medium   | 2.4.11                | Mitigated |

### The two findings worth reading in full

**ACC-1 — the indicator that looked fine.** Every control was outlined in `#000000`. That is
17.035:1 against the light widget background and looks deliberate, which is presumably why it
survived review. Against the fills the controls actually have it is **2.305:1** (button green
`#414C32`) and **2.945:1** (hover slate `#485B61`) — both below the 3:1 non-text minimum, and both
below the palette's own stated rule ("Preserve a 3:1 focus indicator against both normal and hover
states"). The same black outline sat in `public/elementor-trust-block.css` on a button that turns
`#485B61` on hover — the CSS contradicted the comment above it.

The fix is per-surface, because **no single colour can work**: the buttons are dark green (a light
band is needed against the fill) while the page behind them is light slate (a dark band is needed
against that).

| Control               | Indicator                             | Measured boundaries                                    |
| --------------------- | ------------------------------------- | ------------------------------------------------------ |
| Chat input            | single dark ring `3px #1a1a1a`        | 17.404:1 vs the white field, 14.118:1 vs the widget bg |
| Transcript            | single dark ring, inset 3px           | 14.118:1 vs the widget bg                              |
| Send button, launcher | white inner band + dark outer band    | 9.112:1 normal, 7.132:1 hover, 14.118:1 vs the page    |
| Close button          | single light ring on the green header | 9.112:1 normal, 7.132:1 hover                          |

Every band is an `outline` (or an outlined pair) rather than a bare shadow, and a
`@media (forced-colors: active)` block restates each ring in the system `ButtonText` colour with the
decorative shadow removed — in Windows High Contrast Mode a `box-shadow` band is not painted at all,
which would have left those controls with no indicator (ACC-11).

**ACC-6 — the header could leave the screen.** The panel was `max-height: 600px` with a message area
that could not shrink below `min-height: 200px` and no `min-height: 0` on the flex child, so on a
short viewport the panel grew past the window and pushed the header — which holds the AI-identity
disclosure and the only close control — off the top. At the same time the input carried
`min-width: 200px`, which with the send button, gap, and 24px of padding needed ~312px inside a
panel capped at 90vw (288px at 320px viewport), and no `box-sizing: border-box` meant padding and
borders added to the width on top of that. The panel is now `min(360px, 100vw)` and
`calc(100vh - 16px)` (with a `100dvh` override where it exists), the input is `flex: 1 1 auto` with
`min-width: 0`, and the transcript is `flex: 1 1 auto` with `min-height: 0`.

## Contrast, recomputed

Every pair below is recomputed by `auditAccessibilityReview()`, which fails the gate if a documented
number disagrees with the formula by more than 0.001. Two rows were added by this review (marked).

| Pair                                    | Ratio    | Normal text          |
| --------------------------------------- | -------- | -------------------- |
| `#CC0700` headline on `#E2E8F0`         | 4.735:1  | Pass AA              |
| `#485B61` border on `#E2E8F0`           | 5.785:1  | Pass AA              |
| White on `#414C32` button               | 9.112:1  | Pass AAA             |
| `#414C32` on `#E2E8F0`                  | 7.392:1  | Pass AAA             |
| White on `#485B61` hover                | 7.132:1  | Pass AAA             |
| `#1a1a1a` on `#E2E8F0` widget body      | 14.118:1 | Pass AAA             |
| `#1a1a1a` on `#F0F0F0` assistant bubble | 15.272:1 | Pass AAA **(added)** |
| `#1a1a1a` on `#FFF3CD` privacy banner   | 15.708:1 | Pass AAA **(added)** |
| `#1a1a1a` on `#FFFFFF` input            | 17.404:1 | Pass AAA             |
| `#485B61` banner rule on `#FFF3CD`      | 6.437:1  | Pass AA              |
| `#CC0700` on `#485B61`                  | 1.222:1  | **FAIL** — never use |
| `#000000` on `#414C32` (old focus ring) | 2.305:1  | **FAIL** (ACC-1)     |

The gate also fails if the widget renders a colour that no documented pair covers, which is how
ACC-12 stays fixed.

## Browser + assistive-technology matrix

The five pairs in `ACCESSIBILITY_TEST_MATRIX` each have a row in `SECTION_508_MATRIX` stating what
CI covers and the procedure a human must run. The procedure is not prose: it is 13 checks
(`ACCESSIBILITY_WALKTHROUGH_CHECKS`, ids `AT-01`…`AT-13`) — tab order and visible focus, the dialog
announcement, the disclosure and privacy banner, one announcement per message and per error, the
"…" case, close/Escape focus return, re-open, 320px and 400% zoom reflow, reduced motion, and (on
Windows, optional) High Contrast focus. Each check states the action and the observation that
counts as a pass.

### Running it

```bash
# The whole checklist, per row, with current status and any gaps
npm run a11y:checklist

# One session — the row you are about to run
npm run a11y:checklist -- --row "Chrome / NVDA"

# Machine-readable status (same data the gate reads)
npm run a11y:checklist -- --json

# Validate a filled-in receipt
npm run a11y:checklist -- --receipt docs/accessibility-matrix-receipt.json

# Rewrite the blank template after the check library changes
npm run a11y:checklist -- --init [--force]
```

Record results in `docs/accessibility-matrix-receipt.json`: one `result` per check per row
(`pass`, `fail`, `not_performed`; `not_applicable` is allowed only on the optional Windows check),
the row's `browserVersion`/`atVersion`/`os`, and the receipt's `reviewer` and `reviewedAt`. A
recorded `fail` must carry a note — it is the evidence for the remediation.

### What the gate refuses

`auditSection508Walkthrough()` (the CLI and the test suite both call it) fails when the receipt is
missing, malformed, or does not cover exactly the current rows and checks; when a `fail` has no
note; when a row claims a pass without its environment or the signature; when a check marked
required is recorded `not_applicable`; when a recorded failure is left unaddressed; or when
`WALKTHROUGH_RECORDED_STATUS` (in `src/accessibility/accessibility.ts`) disagrees with what the
receipt derives. A row is signed off by setting that status to the value the receipt supports — a
one-line edit the gate verifies, not a sentence a reviewer can type and walk away from.

## Browser run (this review)

The shipped widget was loaded in a browser and driven through its real code paths. What that
established, and what it could not:

**Verified**

- Rendered geometry matched the declarations: panel 360px wide, `max-height` computed to
  `calc(100vh - 16px)`, `box-sizing: border-box` on the field, transcript `min-height: 0`,
  no horizontal document overflow.
- **Reflow**: driving the panel down to 288px and then 240px left the input row with no overflow
  inside it (input shrank to 178px, then 130px; the send button stayed 66px) and the header
  remained on screen.
- **Accessibility tree as the platform exposes it**: one `dialog` named "Life Policy Pilot — AI
  Educational Assistant", a `button "Close chat"`, a focusable `log "Conversation"` whose content
  reads "Assistant said: …", a `textbox "Type your question"` labelled by a real `<label>`, and
  `button "Send message"`. The launcher is absent while the panel is open (it is `display: none`).
- **Messages**: a click on Send, and separately a dispatched `keydown` Enter, each appended
  `You said: …` and the reply. With a delayed reply the pending bubble showed "…" to the eye while
  its announced text read "Assistant said: …Assistant is typing", and it was gone once the reply
  landed.
- **Close**: the panel hid, the launcher appeared with `aria-expanded="false"` and the accessible
  name "Chat with the Life Policy Pilot AI Educational Assistant", and **focus moved to the
  launcher** rather than being stranded.

**Could not be verified here, and why**

- `:focus`/`:focus-visible` never match in the preview frame — `document.hasFocus()` is `false`, so
  the frame cannot hold focus. The four rings were therefore verified by confirming the browser
  parsed each rule into exactly the intended declarations (`rgb(255,255,255) solid 3px` with
  `0 0 0 6px rgb(26,26,26)` for the send button, and so on) and by painting those same declarations
  to see the two-tone ring render. Whether a _real_ keyboard interaction triggers them remains part
  of the pending human walkthrough.
- No screen reader, mobile device, or Windows High Contrast session.

## Residual risks

- **ACC-15 remains mitigated, not fixed.** A `position: fixed` overlay cannot guarantee that focused
  page content is never obscured at every viewport. Mitigations: the panel is confined to the
  bottom-right, is 360px wide, collapses to a launcher the moment the visitor closes it, and never
  traps focus (it is not a modal dialog). Re-check on any layout change.
- **Focus rings on very old browsers.** The buttons use `:focus-visible` with a
  `@supports not selector(:focus-visible)` fallback to `:focus`. Browsers that understand neither
  (Safari ≤ 14.0) would show no button ring; the input and transcript, which use `:focus`, are
  unaffected.
- **The Elementor block's outer band assumes the `#E2E8F0` section background** the block
  specifies. Against a dark section, swap the outer band for a light one.
- **A units-only statement** ("I am 5 foot 10") remains invisible to any pattern in the chat gate;
  that is a data-capture limit, not an accessibility one, and is recorded where it belongs.

## Re-running this review

```bash
# The DOM contract, against the real widget source
npx jest tests/widget-accessibility.test.ts tests/accessibility-checklist.test.ts

# The walkthrough instrument and the receipt the gate reads
npm run a11y:checklist

# The gate: recomputes every documented contrast and focus ratio
npx tsx -e "import {auditAccessibilityReview} from './src/accessibility/accessibility'; console.log(auditAccessibilityReview())"
```

All must be empty/green. Adding a finding to `SECTION_508_FINDINGS` without a criterion, without
evidence, or leaving a critical/high finding open fails the gate; so does a matrix status the
receipt does not support.

## Sign-off

| Field                   | Value                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code-level review       | complete (this document, 2026-09-19)                                                                                                                                  |
| Automated contract      | green — `npx jest tests/widget-accessibility.test.ts`                                                                                                                 |
| Walkthrough instrument  | green — `npm run a11y:checklist` prints 5 rows × 13 checks, no gaps                                                                                                   |
| AT walkthrough (5 rows) | **outstanding** — 0 of 5 rows. Run `npm run a11y:checklist`, fill `docs/accessibility-matrix-receipt.json`, then set the row's value in `WALKTHROUGH_RECORDED_STATUS` |
| Next review trigger     | any widget layout, control, or message-path change; before launch                                                                                                     |
