# Frontend Plan — `apps/web`

Companion to `PROJECT_PLAN.md`. This doc covers the React + Vite + HeroUI frontend in enough detail to build
against: screens, the older-user usability bar (treated as a requirement, not a week-3 polish pass), the
"fun/quirky" brand layer, and the tools needed to build and check it.

---

## 1. Scope

- Play → role → act/scene picker
- Rehearsal surface: line display, Polly playback controls, mic recording, mistake feedback
- Session history + coaching-note view (the agent's read-decide-act-write loop made visible to her)
- Recording playback (from S3, via the API — no direct client-to-S3 calls)

Structural chrome (pickers, modals, buttons, forms) uses HeroUI (React Aria + Tailwind v4) for accessibility
for free. The rehearsal surface itself — the line display, the "listening" state, the coaching note — is
hand-built for the Shakespearean identity, per the split already called out in `README.md`. Don't fight
HeroUI's accessibility primitives to chase the visual identity; layer the identity on top (fonts, color,
copy, motion) rather than reimplementing focus/keyboard handling from scratch.

---

## 2. Usability for an older user base — hard requirements

These are load-bearing, not nice-to-haves. Bake them in from the first screen built, not as a week-3 pass.

- **Type & contrast**: body text ≥18–20px, generous line-height (1.5+), palette contrast validated at WCAG
  AA minimum (parchment/ink can still hit this — check it, don't assume it).
- **Targets**: interactive elements ≥44px touch target, generous spacing between adjacent controls so a
  mis-tap doesn't trigger the wrong action.
- **No hover-only affordances**: every action must be reachable and legible without hovering — this is a
  touch/click-first app.
- **One primary action per screen**: avoid stacked or nested modals; if a flow needs a decision, surface it
  as a single clear screen, not a dialog-on-a-dialog.
- **Voice-first interaction**: minimize required reading/typing. The dominant interaction is "listen, then
  tap to speak your line" — not scanning menus or filling forms.
- **Forgiving pacing**: no countdown timers, no time-limited prompts. Always-visible "play that again" and
  an obvious way back to the previous screen.
- **Plain-language labels**: "Act 2, Scene 1" is fine as flavor, but always paired with plain context (which
  characters, what's happening) rather than relying on the raw label alone.
- **Shallow navigation**: a persistent, large back/home control; no menu tree deeper than one level from the
  picker.

## 3. Fun, quirky brand layer

Sits on top of the above, never in tension with it.

- Parchment/ink visual identity (serif display type, ink-accent details) — per `README.md`'s existing
  description of the visual pass.
- Warm, theatrical microcopy instead of generic SaaS tone (e.g., loading/empty states written in voice,
  not "Loading…").
- Small personality touches: a distinct icon/color per character voice, a bit of ceremony around starting a
  session ("The Book Holder opens the script...").
- Keep it light-touch: personality in copy, color, and small motion details — not at the cost of the
  usability requirements in §2.

---

## 4. Screens, in build order

Matches the week-by-week sequence in `ORCHESTRATION_PLAN.md`.

1. **Picker** — play (fixed to Merry Wives for MVP) → role → act/scene. Works first against mock/stub data.
2. **Rehearsal surface** — line-by-line flow: hear the other characters (Polly), see/hear her cue, record
   her line, get feedback. This is the core demo screen — most design and testing time goes here.
3. **Session summary / coaching note** — what the agent decided to emphasize next time, written in plain,
   encouraging language (not a raw score dump).
4. **History / recordings playback** — past sessions, pull recordings back from S3 via the API.

---

## 5. Tools

- **Accessibility auditing**: axe DevTools browser extension, Lighthouse accessibility score, manual
  contrast check on the final parchment/ink palette values.
- **Component testing**: React Testing Library (HeroUI components already have their own a11y test
  coverage upstream — focus tests on the hand-built rehearsal surface).
- **Cross-browser mic check**: manual checklist for `MediaRecorder`/mic-permission behavior — support and
  permission prompts vary meaningfully across Chrome/Safari/Firefox, worth a real device pass, not just one
  browser.
- **Visual pass (optional)**: Figma, only if there's time for a dedicated design pass on the parchment/ink
  system — not required to hit MVP.

## 6. Open items to verify while building

- HeroUI's theming API — confirm how far a custom parchment/ink palette can go without fighting the
  component library's defaults.
- `MediaRecorder` support/permission-prompt differences across target browsers, confirmed on a real device,
  not just desktop Chrome.
