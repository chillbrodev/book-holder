# Book Holder — Frontend Visual Scaffold

## Context

`frontend/` was scaffolded with `npm create vite@latest` (React 19.2 + TypeScript, Vite 8.1/Rolldown, React Compiler wired via `@rolldown/plugin-babel`, OxLint via `.oxlintrc.json`, no ESLint). Everything under `src/` is still unmodified Vite boilerplate. Separately, the user designed the brand/visual system in Claude Design ("Book Holder visual prototype" project) and built a full click-through prototype there (6 screens, ~15 components, all in hand-rolled JSX + inline styles). There's also a local `design-system/` folder with a more current, reconciled style guide.

Goal: turn the bare Vite scaffold into a real (but backend-less) React app implementing all 6 Book Holder screens, matching the brand system, with a stub data layer shaped after the actual CockroachDB schema (`infra/cockroachdb/migrations/001_init_schema.sql`) so a real API can drop in later without callers changing. This is visual/frontend work only — no backend exists yet.

**Two source-of-truth conflicts were found and resolved with the user:**
1. The Claude Design prototype's shipped tokens (Cormorant Garamond/Inter, terracotta-mid `#D85A30`, ash-mid `#B4B2A9`, 8/10/12px radii) are *older* than `design-system/book-holder-style-guide.md`, which is the dated "living document" and explicitly documents overriding those exact values → **decision: use style-guide.md's tokens** (DM Serif Display/DM Sans, terracotta-mid `#C56A3C`, ash-mid `#8B6F5B`, 4/8/16px radii). Port the prototype's component *structure and behavior* faithfully, re-skinned with the correct tokens.
2. `docs/FE_PLAN.md` calls for HeroUI/Tailwind v4 eventually, but the prototype and this pass are plain CSS → **decision: plain CSS Modules only for now**, HeroUI deferred.
3. Prototype has no router (local screen-state switch) → **decision: add `react-router-dom` with real routes.**

## Directory structure (`frontend/src/`)

```
src/
  main.tsx                       # imports fonts, tokens.css, motion.css, global.css; mounts App
  App.tsx                        # <BrowserRouter> + routes.tsx
  routes.tsx                     # route table

  styles/
    tokens.css                   # CSS custom properties (--bh-* prefix), from style-guide.md
    global.css                   # reset, body defaults, :focus-visible ring, .bh-display/.bh-h1/.bh-label/.bh-eyebrow utility classes
    motion.css                   # bh-spin / bh-pulse / bh-bar keyframes

  types/
    domain.ts                    # 1:1 schema-mirroring types (Play, Character, Line, LineSpeakers-resolved, StageDirectionEntry, User, RoleInProgress, SessionHistoryEntry, LineMastery, MistakeLogEntry, Recording)
    views.ts                     # UI-shaped types the stub API actually returns (PlaySummary, SceneSummary, DialogueEntry, FlaggedLine, WrapUpSummary, PromptBookSummary)

  data/
    mock/
      plays.ts / characters.ts / lines.ts / stageDirections.ts / scenesSummary.ts / promptBook.ts / roles.ts
    client.ts                    # stub "API" — one async function per data need (see below)
    latency.ts                   # delay() helper, STUB_LATENCY_MS = 250

  hooks/
    useAsync.ts                  # { data, loading, error } wrapper around client.ts calls
    useMicSimulation.ts          # local timer-driven mic state machine

  utils/
    cx.ts                        # tiny classnames joiner
    format.ts                    # formatRelativeTime(), groupScenesByAct()

  components/
    core/       Button, Icon, IdentityTag, Badge
    cards/      PlayCard, StatCard
    lists/      CharacterRow, SceneRow, FlaggedLineRow
    mastery/    MasteryBar
    rehearsal/  MicStateIndicator, DialogueLine, StageDirection
    navigation/ FilterTabs
    layout/     AppLayout (header/wordmark/nav + <Outlet/>)
    # each: ComponentName.tsx + co-located ComponentName.module.css, typed props interface

  pages/
    ShelfPage, RoleSelectPage, ScenePickerPage, RehearsalPage, WrapUpPage, PromptBookPage, NotFoundPage
```

**Delete:** `src/App.css`, `src/index.css`, `src/assets/{hero.png,react.svg,vite.svg}`, `public/icons.svg`. Update `index.html` `<title>`.

No barrel files (`index.ts` re-exports) — `verbatimModuleSyntax: true` makes barrels error-prone for marginal benefit at this size; the existing scaffold has none either. Direct imports everywhere.

## Tokens & fonts

`styles/tokens.css` — CSS custom properties on `:root`, `--bh-` prefixed, values from `design-system/book-holder-style-guide.md` (NOT `design.md`, NOT the prototype's own `tokens.css`):
- Base: `--bh-ink: #2B1D14`, `--bh-parchment: #F3E8D8`, `--bh-surface: #FBF4E7`, `--bh-on-primary: #FBF4E7`
- Gold: `#FAEEDA` / `#EF9F27` / `#854F0B` — Terracotta: `#FAECE7` / `#C56A3C` / `#993C1D` — Ash: `#F1EFE8` / `#8B6F5B` / `#444441`
- Radius: sm 4px / md 8px / lg 16px — Spacing: sm 8px / md 16px / lg 32px
- Fonts: `--bh-font-display: 'DM Serif Display', serif`, `--bh-font-sans: 'DM Sans', sans-serif`

Fonts self-hosted via `@fontsource/dm-serif-display` (400) and `@fontsource/dm-sans` (400/500/700), imported once in `main.tsx` — not a Google Fonts CDN `<link>` (the prototype used one, for different fonts; don't carry that pattern over).

`global.css` provides one global `:focus-visible` rule (gold outline) so every interactive element gets visible focus without each component reimplementing it, plus shared typography utility classes (`.bh-display`, `.bh-h1`, `.bh-label`, `.bh-eyebrow`) reused across pages/components instead of duplicating font-size/tracking blocks.

Component styling = CSS Modules (`*.module.css`) reading the global custom properties. The only legitimate inline style is `MasteryBar`'s dynamic fill `width: ${pct}%`.

## Domain types & stub data

`types/domain.ts` mirrors the schema field-for-field (camelCased). Key fidelity points from the schema:
- `Line` has **no `characterId`** — speakers resolve via `line_speakers`, so `Line` exposes `speakerIds: string[]`, never a single speaker.
- `StageDirectionEntry` has no FK to `Line` — positioned via `(act, scene, afterLineNumber)`, matching the migration's own comment.
- `act`/`scene` are free-text labels (no enums) — types them as `string`, not a union.

`types/views.ts` holds what pages actually consume (`PlaySummary`, `SceneSummary`, `DialogueEntry` — generalizing the prototype's `isFord` to `isUserLine` — `FlaggedLine`, `WrapUpSummary`, `PromptBookSummary`).

`data/mock/*.ts` — hand-authored fixtures ported from the prototype's own sample content: the focus play *The Merry Wives of Windsor*, character Mistress Ford + Page/Mistress Page/Shallow/Slender/Falstaff/Quickly, the prototype's 18-entry Act II Scene 1 `LINES` array reshaped into `Line[]`/`StageDirectionEntry[]`, and its 3-act/10-scene structure with mastered/total fractions — kept mutually consistent (same numbers) across `scenesSummary.ts`, `lines.ts`, and `promptBook.ts` so the demo reads coherently.

`data/client.ts` — stub API, one function per need: `getPlays`, `getPlay`, `getCharacters`, `getSelectedRole`, `selectRole`, `getScenesSummary`, `getSceneDialogue`, `getSingleLineDialogue`, `getWrapUpSummary`, `getPromptBookSummary`. **Every function returns a `Promise` resolved via `delay()` (~250ms fixed)** — never synchronously — so pages build real loading states now instead of retrofitting them when the real API (with real latency) arrives; swapping `client.ts` for real `fetch` calls later requires no caller changes.

`selectRole`/`getSelectedRole` persist to `localStorage` (`bh:role:{playId}`) since there's no backend yet to remember the once-per-play role choice — call this out as a stub-only shim to delete once `roles_in_progress` is real.

The mic listening state machine (connecting → listening → processing → captured/can't-hear) is **not** modeled as a stub API call — it's local UI state via `hooks/useMicSimulation.ts` (timers), because the real thing will be a streaming Transcribe/WebSocket integration, not a REST fetch.

## Routing (`react-router-dom`, plain `BrowserRouter`/`Routes`, not a data router)

```
/                                           → redirect to /shelf
/shelf                                      → ShelfPage
/play/:playId/role                          → RoleSelectPage
/play/:playId/scenes                        → ScenePickerPage
/play/:playId/rehearse/:act/:scene          → RehearsalPage (?line=<id> for focused single-line practice)
/play/:playId/wrap-up/:act/:scene           → WrapUpPage
/prompt-book                                → PromptBookPage
*                                           → NotFoundPage
```

All wrapped in one `AppLayout` layout route (header with DM-Serif wordmark linking to `/shelf`, nav to Shelf/Prompt Book with active-state underline, `<Outlet/>` in a max-width-980px main). The "practice one flagged line" entry point from Wrap-Up/Prompt Book reuses the rehearsal route with a `?line=` query param rather than a separate route/page.

## Components & pages — port from the Claude Design prototype

Every component/page's structure, props, and behavior should match what's already built in the "Book Holder visual prototype" Claude Design project (already reviewed in full: Button, Icon, IdentityTag, Badge, PlayCard, StatCard, CharacterRow, SceneRow, FlaggedLineRow, MasteryBar, MicStateIndicator, DialogueLine, StageDirection, FilterTabs, and all 6 screens: Shelf, RoleSelect, ScenePicker, Rehearsal, WrapUp, PromptBook). Convert inline-style objects to CSS Modules using the tokens above; convert the prototype's local screen-state switch to real routes/pages using `useAsync` + `client.ts`. Preserve all the accessibility-driving details already designed: color always paired with icon/text, 44px tap targets, muted/opacity treatment for passed dialogue lines and locked cards, gold→ash border swap on mic error, "Line?" button disappearing once text is shown, fraction-not-percentage on every mastery display.

## package.json additions

```
dependencies: react-router-dom, @fontsource/dm-serif-display, @fontsource/dm-sans
```
No devDependency changes — existing OxLint config (`react`/`typescript`/`oxc` plugins) already covers new `.tsx` files.

## Verification

1. `cd frontend && npm install`
2. `npm run dev` — confirm `/` redirects to `/shelf`
3. Manual click-through of all 6 screens: Shelf (filter tabs, locked vs focus play) → Role Select (single-select, button enable/label) → Scene Picker (identity tag, gold Continue card, grouped act/scene list) → Rehearsal (mic state simulation incl. can't-hear/Try-again branch, Show/Hide text toggle) → Wrap-Up (stat cards, flagged list, Practice/Back actions) → Prompt Book (large mastery bar, sorted needs-another-look list, row → focused rehearsal). Reload mid-flow to confirm role selection persists via localStorage.
4. `npm run build` (`tsc -b && vite build`) — must pass, this is the real gate on `verbatimModuleSyntax`/`noUnusedLocals`/`noUnusedParameters` correctness
5. `npm run lint` (oxlint) — must pass with no config changes
6. Spot-check 200% browser zoom on Shelf and Rehearsal for layout breakage; tab through Role Select and Rehearsal's buttons to confirm the global focus ring appears

### Critical files
- `frontend/src/styles/tokens.css`
- `frontend/src/types/domain.ts`, `frontend/src/types/views.ts`
- `frontend/src/data/client.ts`, `frontend/src/data/mock/*.ts`
- `frontend/src/routes.tsx`, `frontend/src/components/layout/AppLayout.tsx`
- `frontend/src/pages/RehearsalPage.tsx` (core state machine, highest complexity)
