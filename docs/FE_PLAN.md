# Frontend Plan — `frontend`

Companion to `PROJECT_PLAN.md`. This doc covers the React + Vite frontend in enough detail to build
against: screens, the older-user usability bar (treated as a requirement, not a week-3 polish pass), the
"fun/quirky" brand layer, and the tools needed to build and check it.

---

## 0. Status

**Built and on real data**: `/shelf` → `/play/:playId` (part step, then scene step) → `/play/:playId/rehearse/
:act/:scene`, reading the live API and playing cached Polly audio per block. Opt-in username + PIN auth
(`src/auth`), surfaced as a "Save Progress" affordance and never as a gate in front of rehearsing. The
parchment/ink identity is in place as CSS custom properties (`src/styles/tokens.css`) with CSS Modules per
component.

**Rendering, but on mock data**: `WrapUpPage` and `PromptBookPage` (`src/data/mock/*`). They need mastery
rows that don't exist server-side yet, and their fabricated line ids drift further from real data with every
change — move them as the transactional write lands, not before.

**Simulated**: the mic. `useMicSimulation` is a timer-driven state machine
(`connecting → listening → processing → captured`, plus `cantHear`), deliberately not a stubbed REST call,
because the real thing is a streaming integration. It exists to get the *interaction* design right ahead of
Transcribe.

**Local-only**: `/preview/blocks`, a segmentation-review page driven by importer fixtures. Delete it once the
rehearsal screen is the better place to judge segmentation.

---

## 1. Scope

- Play → role → act/scene picker. **Built as one page with two steps** — part, then the scenes that part is
  actually in — rather than three separate pages. The old `/play/:id/role` and `/play/:id/scenes` URLs
  redirect to it so bookmarks, the back stack, and the wrap-up's `?back=` param don't 404.
- Rehearsal surface: block display, Polly playback controls, mic recording, mistake feedback
- Session history + coaching-note view (the agent's read-decide-act-write loop made visible to her)
- Recording playback (from S3, via the API — no direct client-to-S3 calls)
- Opt-in accounts, so progress can persist — never a gate in front of the app

**No component library.** HeroUI was the plan (React Aria + Tailwind v4, accessibility for free); it isn't
what got built. The app is hand-built components with CSS Modules over a design-token layer
(`src/styles/tokens.css`), with `@fontsource` DM Serif Display / DM Sans and no Tailwind. Worth stating
plainly because the trade came with a bill: **the accessibility primitives HeroUI would have supplied —
focus management, keyboard handling, ARIA wiring — are now ours to get right**, and §2's requirements stop
being partly free. `--bh-tap-target-min: 44px` is in the tokens; the rest needs the audit in §5, which
hasn't happened.

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

- Parchment/ink visual identity (serif display type, ink-accent details) — built, as tokens rather than
  ad-hoc values: ink on parchment, plus three semantic accents (candlelight gold for featured/favourite,
  terracotta for in-progress and mastery, ash for not-started). `src/styles/tokens.css`.
- Warm, theatrical microcopy instead of generic SaaS tone (e.g., loading/empty states written in voice,
  not "Loading…").
- Small personality touches: a distinct icon/color per character voice, a bit of ceremony around starting a
  session ("The Book Holder opens the script...").
- Keep it light-touch: personality in copy, color, and small motion details — not at the cost of the
  usability requirements in §2.

---

## 4. Screens, in build order

Matches the week-by-week sequence in `ORCHESTRATION_PLAN.md`.

1. ~~**Picker**~~ — **done**. Play (fixed to Merry Wives for MVP) → part → scene. Built against fixtures
   first, then moved to the real API.
2. **Rehearsal surface** — **half done**. Blocks render from real data and the other characters' speeches
   play from the Polly cache; the mic half is simulated. This is the core demo screen — most design and
   testing time goes here. Note the display unit is the **block** (one speech), not the beat: beats are what
   get scored, and they cross-cut verse lines, which is why highlighting one is unsolved (§6).
3. **Session summary / coaching note** — renders, on mock data. What the agent decided to emphasize next
   time, written in plain, encouraging language (not a raw score dump).
4. **History / recordings playback** — not started; needs the write path.

---

## 5. Tools

- **Typecheck and lint**: `npx tsc -b` and `npx oxlint` (the `lint` script). Both run clean today.
- **Accessibility auditing**: axe DevTools browser extension, Lighthouse accessibility score, manual
  contrast check on the final parchment/ink palette values. **None of this has been run yet**, and it now
  matters more than it did when HeroUI was going to cover the primitives (§1).
- **Component testing**: React Testing Library. **No frontend tests exist.** Everything is hand-built, so
  there's no upstream a11y coverage to lean on — the rehearsal surface and the auth modal are where tests
  would earn the most.
- **Cross-browser mic check**: manual checklist for `MediaRecorder`/mic-permission behavior — support and
  permission prompts vary meaningfully across Chrome/Safari/Firefox, worth a real device pass, not just one
  browser.
- **Visual pass (optional)**: Figma, only if there's time for a dedicated design pass on the parchment/ink
  system — not required to hit MVP.

## 6. Open items to verify while building

- ~~HeroUI's theming API~~ — moot; no component library was used (§1).
- `MediaRecorder` support/permission-prompt differences across target browsers, confirmed on a real device,
  not just desktop Chrome.
- **Highlighting the active beat inside verse is unsolved.** Beats cross-cut verse lines — a boundary usually
  falls mid-line — so "highlight the active beat" and "keep the lineation" fight each other: you cannot box a
  beat without either breaking the layout or highlighting partial lines. The "Line?" prompt sidesteps it by
  rendering the revealed beat *below* the block, but a flubbed-beat marker won't be able to. Likely answer is
  an inline span with a background, which flows across line breaks naturally, but it needs beat text
  pre-split at verse-line boundaries. `OPEN_ITEMS.md` §3.
- **Copy says "lines" where the data means beats** — `CharacterTile.tsx`, the wrap-up's `linesRun`, and
  `listScenes`' `totalLines`. Merry Wives went 2,610 → 1,705, so the number changed meaning as well as
  value. A copy pass, but the wrong word teaches the user the wrong model.
- **Whether she can ask to hear her own lines.** `RehearsalPage.tsx` skips Polly entirely for `isUserLine`,
  which is right for a run-through and may be wrong for learning a speech cold.
- **Whether trivially short beats get rolled up in the Prompt Book.** 237 beats in Merry Wives are under 20
  characters — all complete short *speeches* like `"Go."`. A mastery row for `"Ha!"` is noise in a "needs
  another look" list. A surfacing decision, not a parser one.
- `selectRole` is still localStorage-only — `roles_in_progress` exists in the schema but isn't wired up, so
  the chosen part doesn't follow her to another device even once she has an account.
